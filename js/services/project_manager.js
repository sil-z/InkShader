// js/services/project_manager.js
import { StorageUtils } from "./storage.js";

export class ProjectManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.activeProjectName = null;
    }

    generateProjectName() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const base = `InkShader_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        return base;
    }

    async ensureUniqueName(name) {
        let candidate = name;
        let counter = 1;
        while (await StorageUtils.projectExists(candidate)) {
            candidate = `${name}_${counter}`;
            counter++;
        }
        return candidate;
    }

    _buildSnapshotData() {
        const c = this.canvas;
        const historyService = c.history;
        const state = historyService.getHistoryState();
        return {
            runtimeVersion: 2,
            latestSnapshot: state.snapshotObj,
            commandStack: c.commandStack || [],
            redoCommandStack: c.redoCommandStack || []
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

    async createNewProject() {
        if (this._isEmptyProject()) return null;

        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }

        const name = await this.ensureUniqueName(this.generateProjectName());
        const c = this.canvas;

        const emptySnapshot = JSON.stringify({
            version: "1.0",
            canvas_size_width: c.canvas_size_width || 1000,
            canvas_size_height: c.canvas_size_height || 1000,
            editor_guideline_h: [], editor_guideline_v: [],
            editor_guideline_lock: false, editor_user_guidelines: [],
            editor_sequence: "", editor_active_indices: [],
            editor_fill_color: "#000000", editor_stroke_color: "#000000",
            family_name: "InkShader_Default_Font",
            project_name: name,
            basic_spacing: 1000, ch: {}, components: {}
        });

        await c.commands.loadSnapshotCommand(emptySnapshot);
        c.commandStack = [];
        c.redoCommandStack = [];
        c.currentStateObj = c.history.getHistoryState();

        const data = {
            runtimeVersion: 2,
            latestSnapshot: c.currentStateObj.snapshotObj,
            commandStack: [],
            redoCommandStack: []
        };
        await StorageUtils.saveProject(name, data);
        this.setActiveProjectName(name);
        c.is_dirty = true;
        c.notifyPropertiesUpdate();
        return name;
    }

    async loadFromCache(projectName) {
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

        if (typeof c.history._reconcileRuntimeHistoryStacks === 'function') {
            c.history._reconcileRuntimeHistoryStacks();
        }
        if (typeof c.history._flushRuntimeStateSave === 'function') {
            c.history._flushRuntimeStateSave();
        }
        c.history.saveCurrentViewState(true);

        this.setActiveProjectName(projectName);
        c.is_dirty = true;
        c.notifyPropertiesUpdate();
        c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
        return projectName;
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
    }

    async init() {
        StorageUtils.migrateIfNeeded();
        const active = StorageUtils.loadActiveProject();
        if (active) {
            this.activeProjectName = active;
        }
    }
}
