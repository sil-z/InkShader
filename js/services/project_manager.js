// js/services/project_manager.js
import { StorageUtils } from "./storage.js";

export class ProjectManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.activeProjectName = null;
    }

    generateProjectName() {
        return "New Font";
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

    async saveToCache(projectName) {
        const name = projectName || this.activeProjectName;
        if (!name) return;
        const data = this._buildSnapshotData();
        await StorageUtils.saveProject(name, data);
    }

    async ensureMaxCacheLimit() {
        // Delegate to storage which enforces the limit on saveProject
    }

    async createNewProject() {
        // Only guard against concurrent in-flight creation (not "already have a project").
        if (this._creatingProject) return this._creatingProject;
        this._creatingProject = (async () => {
            try {
                const hasContent = !this._isEmptyProject();

                // Save current work before creating new project
                if (hasContent) {
                    if (this.activeProjectName) {
                        await this.saveToCache(this.activeProjectName);
                    } else {
                        // Unnamed canvas content — save with a generated name first
                        const tempName = await this.ensureUniqueName("New Font");
                        await this.saveToCache(tempName);
                    }
                }

                // Find an unused numbered name (e.g. "New Font 1", "New Font 2")
                const name = await this.ensureUniqueName("New Font");

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

                const data = {
                    // Deep-clone snapshot to avoid shared-ref corruption via history service's _saveRuntimeState
                    latestSnapshot: this._deepClone(c.currentStateObj.snapshotObj),
                    commandStack: [],
                    redoCommandStack: []
                };
                await StorageUtils.saveProject(name, data);
                this.setActiveProjectName(name);

                // Sync editor store to the new (empty) canvas state so stale activeGroupId
                // from the previous project doesn't leak into handleMouseDown.
                c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
                c.bumpEditorStoreTreeRevision?.();

                c.is_dirty = true;
                c.notifyPropertiesUpdate();
                return name;
            } finally {
                this._creatingProject = null;
            }
        })();
        return this._creatingProject;
    }

    async loadFromCache(projectName) {
        // Save current project before switching
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
        return projectName;
    }

    /**
     * Load a project from a JSON string (e.g. from file).
     * Before loading, saves the current project to cache.
     * If the loaded project's name conflicts with a cached project,
     * prompts the user for overwrite confirmation.
     * Returns the project name used, or null if cancelled.
     */
    async loadFromFile(jsonStr) {
        // Parse the JSON to get the project name
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            console.warn("[ProjectManager] Failed to parse project file JSON:", e);
            data = null;
        }
        // Save current project before switching
        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }

        // Use the project name from the file, or generate a unique fallback
        let targetName = data?.project_name || await this.ensureUniqueName("New Font");
        if (await StorageUtils.projectExists(targetName)) {
            const msg = `Project "${targetName}" already exists in cache. Overwrite?`;
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
            if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
            c.history.saveCurrentViewState(true);
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
        } catch (err) {
            if (err) {
                alert("Critical error during file loading: " + err.message);
            }
            return null;
        }

        // Save to cache under the project name
        const saveData = this._buildSnapshotData();
        await StorageUtils.saveProject(targetName, saveData);
        return targetName;
    }

    async listCachedProjects() {
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
        StorageUtils.saveActiveProject(name || "");
        this._updateBrandTitle();
    }

    async syncActiveProjectNameFromCanvas() {
        const nextName = (this.canvas?.fontSettings?.project_name || "").trim();
        if (!nextName || nextName === this.activeProjectName) {
            this._updateBrandTitle();
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

    async init() {
        StorageUtils.migrateIfNeeded();
        const active = StorageUtils.loadActiveProject();
        if (active) {
            this.activeProjectName = active;
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
