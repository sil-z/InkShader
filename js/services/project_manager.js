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

    async ensureMaxCacheLimit() {
        // Delegate to storage which enforces the limit on saveProject
    }

    async createNewProject() {
        if (this._isEmptyProject()) return null;

        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }

        // Find an unused numbered name (e.g. "New Font 1", "New Font 2")
        const name = await this.ensureUniqueName("New Font");

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
            if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
            c.history.saveCurrentViewState(true);
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
        } catch (err) {
            alert("Critical error during file loading: " + err.message);
            return null;
        }

        // Save to cache under the project name
        const saveData = this._buildSnapshotData();
        await StorageUtils.saveProject(targetName, saveData);
        this.setActiveProjectName(targetName);
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
        this._updateBrandTitle(name);
    }

    /** Update the top-left brand title to "project_name - InkShader" */
    _updateBrandTitle(name) {
        const el = document.getElementById('brand_title');
        if (el) {
            el.textContent = name ? `${name} - InkShader` : 'InkShader';
        }
    }

    async init() {
        StorageUtils.migrateIfNeeded();
        const active = StorageUtils.loadActiveProject();
        if (active) {
            this.activeProjectName = active;
        }
        this._updateBrandTitle(this.activeProjectName);
    }

    async saveCurrentProject() {
        if (this.activeProjectName) {
            await this.saveToCache(this.activeProjectName);
        }
    }
}
