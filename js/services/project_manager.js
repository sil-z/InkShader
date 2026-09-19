// js/services/project_manager.js
import { StorageUtils } from "./storage.js";
import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { desktopApi, isDesktop } from "../app/app_mode.js";

/** Translation shorthand: table first, English literal as the fallback. */
const t = (key, fallback) => (window.I18n ? window.I18n.t(key, fallback) : fallback);

export class ProjectManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.activeProjectName = null;
        /** 桌面模式：当前项目对应的磁盘文件路径（新建/导入项目为 null）。 */
        this.openedFilePath = null;
        /** 未保存判定（栈顶标记法，现代编辑器通用做法）：保存点 = 保存那一刻
         *  撤回栈的栈顶命令 id + 深度。撤回/重做会真实移动栈，因此「改了又撤回
         *  到保存点」会自然回到干净状态；盲看「保存后是否编辑过」做不到这一点。 */
        this._dirty = false;
        /** 保存点的撤回栈标记（undoTopId + undoLen）。 */
        this._savedStackToken = { undoTopId: null, undoLen: 0 };
        /** 撤回系统之外的文档修改（原位导入/原位布尔等不走命令的路径）。
         *  这类修改没有命令条目，栈顶法检测不到，必须用粘性标志：保存时清除。 */
        this._outOfBandModified = false;
        /** 切换项目临界区深度：加载/新建过程中 canvas 名字与活动项目名短暂不一致，
         *  期间禁止把上一个项目的缓存槽重命名/覆盖成新项目名（缓存丢失根因）。 */
        this._loadingProject = 0;
        appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, (e) => this._onStoreStateChanged(e));
    }

    // ---- 切换项目临界区 ----
    _beginProjectSwitch() { this._loadingProject++; }

    _endProjectSwitch() { this._loadingProject = Math.max(0, this._loadingProject - 1); }

    /** 切换/保存前清掉挂起的 120ms 自动保存定时器并立即落盘当前文档。
     *  防止切换过程中定时器触发，把「加载一半的新文档」写进旧项目的缓存槽。 */
    _flushPendingAutoSave() {
        const c = this.canvas;
        if (c?.history && typeof c.history._flushRuntimeStateSave === "function") {
            c.history._flushRuntimeStateSave();
        }
    }

    // ---- 未保存状态（desktop 模式的标题星号 / 关闭警告依据；浏览器模式同样维护） ----
    /** 当前撤回栈标记：优先读 Store 镜像（reactive），退化直读 commandStack。
     *  保存点 = 栈顶命令 id + 深度；文档状态 == 撤回栈当前内容对应的文档。 */
    _currentStackToken() {
        const st = this.canvas?.editorStore?.getState?.();
        if (st && st.historyTopCommandId !== undefined) {
            return { undoTopId: st.historyTopCommandId ?? null, undoLen: st.commandStackSize ?? 0 };
        }
        const stack = this.canvas?.commandStack || [];
        return {
            undoTopId: stack.length ? (stack[stack.length - 1]?.id ?? null) : null,
            undoLen: stack.length
        };
    }

    _stackTokensEqual(a, b) {
        return a.undoLen === b.undoLen && a.undoTopId === b.undoTopId;
    }

    /** 撤回/重做/提交都会改变栈结构，据此重算脏标记。 */
    _recomputeDirty() {
        const clean = !this._outOfBandModified
            && this._stackTokensEqual(this._savedStackToken, this._currentStackToken());
        this._setDirty(!clean);
    }

    _onStoreStateChanged(e) {
        // documentRevision 仅在真实文档修改（含 undo/redo）时递增；
        // 纯视图操作（选中/平移/缩放/工具切换）不触发。
        const rev = e?.detail?.afterState?.documentRevision;
        if (rev === undefined || rev === null) return;
        this._recomputeDirty();
    }

    _setDirty(dirty) {
        if (this._dirty === !!dirty) return;
        this._dirty = !!dirty;
        this._pushDesktopState();
    }

    _pushDesktopState() {
        if (!isDesktop()) return;
        try { desktopApi()?.set_dirty(this._dirty); } catch (e) { /* 桥未就绪忽略 */ }
        this._updateTitle();
    }

    /** 撤回系统之外的文档修改后调用（原位操作等；由调用方显式触发）。
     *  粘性标志：撤回无法撤销这类修改，保存时清除。 */
    markModified() {
        this._outOfBandModified = true;
        this._setDirty(true);
    }

    /** save / save as json 成功后调用：把保存点钉在当前撤回栈顶并清除粘性标志。
     *  ufo/svg 导出不调此方法。 */
    markSaved() {
        this._savedStackToken = this._currentStackToken();
        this._outOfBandModified = false;
        this._setDirty(false);
    }

    isDirty() { return this._dirty; }

    /** 桌面模式：窗口标题带星号（未保存）。同步到 document.title 与原生窗口标题。
     *  标题格式：项目名在前、应用名在后（Inkscape 式），如 "New Font 1 - InkShader"。 */
    _updateTitle() {
        if (!isDesktop()) return;
        const name = (this.canvas?.fontSettings?.project_name || "").trim();
        const title = name
            ? `${name}${this._dirty ? " *" : ""} - InkShader`
            : "InkShader";
        document.title = title;
        try { desktopApi()?.set_title(title); } catch (e) { /* 桥未就绪忽略 */ }
    }

    // ---- 磁盘文件路径（desktop 模式） ----
    getOpenedFilePath() { return this.openedFilePath; }

    setOpenedFilePath(path) {
        this.openedFilePath = path || null;
        this._updateTitle();
    }

    generateProjectName() {
        return "New Font";
    }

    /**
     * 下一个新建项目名（"New Font N"）。
     * 优先向本地后端申请编号（所有窗口/标签共用一个计数器，多开互不冲突）；
     * 无后端（场景1 静态部署）时退回按 IndexedDB 缓存查重的旧方案。
     */
    async _nextNewProjectName() {
        let number = null;
        try {
            const res = await fetch("/api/new_project_number", { method: "POST" });
            if (res.ok) {
                const data = await res.json();
                const n = Number(data?.number);
                if (Number.isInteger(n) && n > 0) number = n;
            }
        } catch (e) { /* 静态部署无后端：走缓存查重方案 */ }
        if (number !== null) {
            if (isDesktop()) return `New Font ${number}`;
            // 浏览器模式：后端计数与已有缓存项目名可能冲突，再查重递增
            let candidate = `New Font ${number}`;
            while (await StorageUtils.projectExists(candidate)) {
                number++;
                candidate = `New Font ${number}`;
            }
            return candidate;
        }
        return this.ensureUniqueName("New Font");
    }

    async ensureUniqueName(name, startCounter = 1) {
        let counter = startCounter;
        while (true) {
            const candidate = `${name} ${counter}`;
            if (!await StorageUtils.projectExists(candidate)) {
                return candidate;
            }
            counter++;
        }
    }

    _deepClone(obj) {
        try { return JSON.parse(JSON.stringify(obj)); }
        catch (_) { return obj; }
    }

    _buildSnapshotData() {
        const c = this.canvas;
        const historyService = c.history;
        const state = historyService.getHistoryState();
        // Deep-clone to prevent shared-reference contamination:
        // commandStack entries hold snapshotPatches that mutate during undo/redo
        return {
            latestSnapshot: this._deepClone(state.snapshotObj),
            commandStack: this._deepClone(c.commandStack || []),
            redoCommandStack: this._deepClone(c.redoCommandStack || [])
        };
    }

    _isEmptyProject() {
        const c = this.canvas;
        const cm = c.curve_manager;
        if (!cm) return true;
        if (cm.treeItems && cm.treeItems.size > 0) return false;
        if (cm.curves && cm.curves.length > 0) return false;
        return true;
    }

    /** True when the project has no content AND no command history — i.e. never actually modified by the user. */
    isProjectPristine() {
        if (!this._isEmptyProject()) return false;
        const c = this.canvas;
        if (c.commandStack && c.commandStack.length > 0) return false;
        if (c.redoCommandStack && c.redoCommandStack.length > 0) return false;
        return true;
    }

    async saveToCache(projectName) {
        // 桌面模式：文件即权威存储，禁用浏览器缓存（及其相关逻辑）
        if (isDesktop()) return;
        const name = projectName || this.activeProjectName;
        if (!name) return;
        // Never persist a pristine (empty, never-modified) project to cache.
        // Prevents auto-created "New Font 1" from lingering as garbage when
        // the user switches to another project before making any edits.
        if (this.isProjectPristine()) return;
        const data = this._buildSnapshotData();
        await StorageUtils.saveProject(name, data);
        // Persist the active project name to localStorage now that
        // real (non-pristine) content has been saved to IndexedDB.
        // This ensures the project can be found on next page load even
        // if it was created as a pristine (not-yet-saved) new project.
        StorageUtils.saveActiveProject(name);
    }

    async ensureMaxCacheLimit() {
        // Delegate to storage which enforces the limit on saveProject
    }

    async createNewProject() {
        // Only guard against concurrent in-flight creation (not "already have a project").
        if (this._creatingProject) return this._creatingProject;
        this._creatingProject = (async () => {
            this._beginProjectSwitch();
            try {
                this._flushPendingAutoSave();
                const pristine = this.isProjectPristine();

                if (!pristine) {
                    // Save current work before creating new project
                    if (this.activeProjectName) {
                        await this.saveToCache(this.activeProjectName);
                    } else {
                        // Unnamed canvas content — save with a generated name first
                        const tempName = await this.ensureUniqueName("New Font");
                        await this.saveToCache(tempName);
                    }
                } else if (this.activeProjectName && await StorageUtils.projectExists(this.activeProjectName)) {
                    // Current project was never modified (e.g. auto-created "New Font 1").
                    // Delete its cache entry to prevent empty-project garbage from accumulating.
                    await StorageUtils.deleteProject(this.activeProjectName);
                }

                // Find an unused numbered name (e.g. "New Font 1", "New Font 2")：
                // 桌面模式/有后端时用进程内计数（多窗口唯一）；否则按缓存查重
                const name = await this._nextNewProjectName();

                // Show brand title IMMEDIATELY with the new project name,
                // before loadSnapshotCommand and IndexedDB save which can take ~1s.
                // loadSnapshotCommand below sets fontSettings from the snapshot
                // (which includes the same project_name), so this early write
                // is overwritten with the same value — no flash or inconsistency.
                this.canvas.fontSettings.project_name = name;
                this._updateBrandTitle();

                const c = this.canvas;

                const emptySnapshot = JSON.stringify({
                    version: "1.0",
                    editor_guidelines: [],
                    editor_sequence: "", editor_active_indices: [],
                    family_name: "InkShader_Default_Font",
                    project_name: name,
                    basic_spacing: 1000,
                    font_style: "Regular",
                    postscript_name: "",
                    preferred_family: "",
                    preferred_subfamily: "",
                    copyright: "",
                    designer: "",
                    designer_url: "",
                    manufacturer: "",
                    manufacturer_url: "",
                    license: "",
                    license_url: "",
                    trademark: "",
                    description: "",
                    sample_text: "",
                    upm: 1000,
                    weight_class: 400,
                    width_class: 5,
                    ascender: 800,
                    descender: -200,
                    x_height: 500,
                    cap_height: 700,
                    font_version: "1.0",
                    editor_root_order: [],
                    glyphs: {}
                });

                await c.commands.loadSnapshotCommand(emptySnapshot);
                c.commandStack = [];
                c.redoCommandStack = [];
                c.currentStateObj = c.history.getHistoryState();

                // Clear stale selection state (activeGroupId, node/curve selections) that
                // carried over from the previous project — loadSnapshotCommand does NOT
                // reset the SelectionState's activeGroupId.
                c.curve_manager.clearAllSelection();
                c.curve_manager.activeGroupId = null;

                this.activeProjectName = name;
                // 新建项目：与磁盘无关联，清空打开路径；作为全新保存点（不脏）
                this.openedFilePath = null;

                // Sync editor store to the new (empty) canvas state so stale activeGroupId
                // from the previous project doesn't leak into handleMouseDown.
                c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
                c.bumpEditorStoreTreeRevision?.();

                c.is_dirty = true;
                c.notifyPropertiesUpdate();
                this.markSaved();
                return name;
            } finally {
                this._endProjectSwitch();
                this._creatingProject = null;
            }
        })();
        return this._creatingProject;
    }

    async loadFromCache(projectName) {
        // 桌面模式：禁用「从浏览器缓存加载」
        if (isDesktop()) throw new Error("load from browser cache is disabled in desktop mode");
        this._beginProjectSwitch();
        try {
        // 先把当前项目完整写入缓存（并清掉挂起自动保存），再切换
        this._flushPendingAutoSave();
        if (this.activeProjectName && this.activeProjectName !== projectName) {
            await this.saveToCache(this.activeProjectName);
        }

        const data = await StorageUtils.loadProject(projectName);
        if (!data) throw new Error(`Project "${projectName}" not found in cache`);

        const c = this.canvas;
        let snapshotStr = "";

        if (data.latestSnapshot) {
            snapshotStr = JSON.stringify(data.latestSnapshot);
        } else if (typeof data === 'string') {
            snapshotStr = data;
        } else {
            snapshotStr = JSON.stringify(data);
        }

        await c.commands.loadSnapshotCommand(snapshotStr);
        c.commandStack = Array.isArray(data.commandStack) ? data.commandStack : [];
        c.redoCommandStack = Array.isArray(data.redoCommandStack) ? data.redoCommandStack : [];
        c.currentStateObj = c.history.getHistoryState();

        // MUST set active project name BEFORE _flushRuntimeStateSave / _saveRuntimeState,
        // because _saveRuntimeState reads getActiveProjectName() to decide which project
        // to write to. If we set it after, the auto-save would overwrite the OLD project's
        // IndexedDB entry with the new project's canvas content, corrupting it.
        this.setActiveProjectName(projectName);

        // Reset stale selection state from the previous project so that seedFromCanvas
        // (called below) reads a null activeGroupId from the curve manager, which
        // prevents handleMouseDown from using an invalid group id for the new project.
        c.curve_manager.clearAllSelection();
        c.curve_manager.activeGroupId = null;

        if (typeof c.history._flushRuntimeStateSave === 'function') {
            c.history._flushRuntimeStateSave();
        }
        c.history.saveCurrentViewState(true);
        c.is_dirty = true;
        c.notifyPropertiesUpdate();
        c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
        c.bumpEditorStoreTreeRevision?.();
        this.markSaved();
        return projectName;
        } finally {
            this._endProjectSwitch();
        }
    }

    /**
     * Load a project from a JSON string (e.g. from file).
     * Before loading, saves the current project to cache.
     * If the loaded project's name conflicts with a cached project,
     * prompts the user for overwrite confirmation.
     * Returns the project name used, or null if cancelled.
     *
     * @param {string} jsonStr - 项目 JSON 内容
     * @param {object} [options]
     * @param {string|null} [options.filePath] - 桌面模式：来源文件路径（Ctrl+S 直接写回）
     */
    async loadFromFile(jsonStr, options = {}) {
        const desktop = isDesktop();
        // Parse the JSON to get the project name
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            console.warn("[ProjectManager] Failed to parse project file JSON:", e);
            data = null;
        }
        this._beginProjectSwitch();
        try {
        // Save current project before switching（桌面模式 saveToCache 为 no-op）
        this._flushPendingAutoSave();
        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }

        // Use the project name from the file, or generate a unique fallback
        let targetName = data?.project_name || await this._nextNewProjectName();
        if (!desktop && await StorageUtils.projectExists(targetName)) {
            const msg = t("dialog.cache_overwrite", 'Project "{name}" already exists in cache. Overwrite?')
                .replace('{name}', targetName);
            if (!confirm(msg)) {
                return null; // User cancelled
            }
            // Overwrite: delete the existing one first
            await StorageUtils.deleteProject(targetName);
        }

        const c = this.canvas;
        try {
            await c.commands.loadSnapshotCommand(jsonStr);
            c.commandStack = [];
            c.redoCommandStack = [];
            c.currentStateObj = c.history.getHistoryState();

            // Reset stale selection state before seedFromCanvas so the store
            // gets a clean activeGroupId (null) that reflects the loaded project.
            c.curve_manager.clearAllSelection();
            c.curve_manager.activeGroupId = null;

            // Set active project BEFORE _flushRuntimeStateSave so that _saveRuntimeState
            // writes to the correct project key, not the old project's key.
            this.setActiveProjectName(targetName);
            // 记录来源文件路径：桌面模式 Ctrl+S 直接写回该文件
            this.setOpenedFilePath(options.filePath || null);
            if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
            c.history.saveCurrentViewState(true);
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
        } catch (err) {
            if (err) {
                alert(t("err.critical_load", "Critical error during file loading: ") + err.message);
            }
            return null;
        }

        // Save to cache under the project name（桌面模式缓存已禁用）
        if (!desktop) {
            const saveData = this._buildSnapshotData();
            await StorageUtils.saveProject(targetName, saveData);
        }
        this.markSaved();
        return targetName;
        } finally {
            this._endProjectSwitch();
        }
    }

    async listCachedProjects() {
        if (isDesktop()) return [];
        const all = await StorageUtils.listProjects();
        if (!this.activeProjectName) return all;
        return all.filter(name => name !== this.activeProjectName);
    }

    async deleteFromCache(projectName) {
        await StorageUtils.deleteProject(projectName);
        if (this.activeProjectName === projectName) {
            this.activeProjectName = null;
            StorageUtils.saveActiveProject("");
        }
    }

    getActiveProjectName() {
        return this.activeProjectName;
    }

    setActiveProjectName(name) {
        this.activeProjectName = name;
        // 桌面模式无浏览器缓存：不写 localStorage（临时 profile 的写入毫无意义）
        if (!isDesktop()) StorageUtils.saveActiveProject(name || "");
        this._updateBrandTitle();
        this._updateTitle();
    }

    async syncActiveProjectNameFromCanvas() {
        const nextName = (this.canvas?.fontSettings?.project_name || "").trim();
        if (!nextName || nextName === this.activeProjectName) {
            this._updateBrandTitle();
            this._updateTitle();
            return true;
        }

        if (this._loadingProject > 0) {
            // 正在加载/新建另一个项目：canvas 名字先于 activeProjectName 变化是
            // 正常流程，绝不能把上一个项目的缓存槽改名/覆盖成新项目名。
            this._updateBrandTitle();
            this._updateTitle();
            return true;
        }

        if (isDesktop()) {
            // 桌面模式无缓存：只同步内存中的活动项目名（品牌标题/窗口标题）
            this.setActiveProjectName(nextName);
            return true;
        }

        const previousName = this.activeProjectName;
        if (previousName) {
            await this.saveToCache(previousName);
            const renamed = await StorageUtils.renameProject(previousName, nextName);
            if (!renamed) return false;
        } else if (await StorageUtils.projectExists(nextName)) {
            return false;
        }

        this.setActiveProjectName(nextName);
        await this.saveToCache(nextName);
        return true;
    }

    /** Update the top-left brand title from canvas.fontSettings.project_name */
    _updateBrandTitle() {
        const el = document.getElementById('brand_title');
        if (!el) return;
        const name = this.canvas?.fontSettings?.project_name?.trim() || '';
        el.textContent = name ? `${name} - InkShader` : 'InkShader';
    }

    async init(freshStart = false) {
        StorageUtils.migrateIfNeeded();
        // 桌面模式 / ?new=1 新标签：不恢复浏览器缓存（含活动项目记忆），
        // 启动即为全新项目（initialize() 随后自动创建唯一命名的新项目）。
        if (isDesktop() || freshStart) {
            this.activeProjectName = null;
            this.openedFilePath = null;
            return;
        }
        // 恢复 beforeunload 的 localStorage 兜底（同步写入、必不丢）：
        // 覆盖 live-reload 中途打断时被 Chrome 中止的 IndexedDB 事务。
        // 仅当比 IndexedDB 缓存更新时才生效，防止多标签下旧兜底覆盖新编辑。
        await StorageUtils.recoverUnloadFallback();
        const active = StorageUtils.loadActiveProject();
        if (active && await StorageUtils.projectExists(active)) {
            this.activeProjectName = active;
        } else {
            // 活动项目槽位已不存在（被改名/清理/其他标签覆盖）：
            // 回退到缓存项目栈顶（MRU，最后保存/加载的项目）。
            this.activeProjectName = await StorageUtils.latestCachedProject();
        }
        // Brand title will be updated from canvas.fontSettings.project_name
        // once restoreState() loads the snapshot.
        // Do NOT call _updateBrandTitle here — canvas.fontSettings is not yet
        // populated, so we'd show the IndexedDB cache key instead of the file field.
    }

    async saveCurrentProject() {
        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }
    }
}
