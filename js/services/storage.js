// js/services/storage.js

export class StorageUtils {
    static DB_NAME = "InkShaderEditorDB";
    static STORE_NAME = "AppState";
    static SAVE_KEY = "last_edit_state";
    static PROJECTS_KEY = "projects";
    static PROJECT_ORDER_KEY = "project_order";
    static ACTIVE_PROJECT_KEY = "active_project";
    static VIEW_SAVE_KEY = "last_view_state";
    static MAX_CACHED_PROJECTS = 5;

    static async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    static async _idbPut(key, value) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readwrite");
            tx.objectStore(this.STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    static async _idbGet(key) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readonly");
            const req = tx.objectStore(this.STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    static async _idbDelete(key) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readwrite");
            tx.objectStore(this.STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    static async _idbKeys() {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readonly");
            const req = tx.objectStore(this.STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // ── Legacy single-project API (backward compat) ──

    static async save(jsonData) {
        return this._idbPut(this.SAVE_KEY, jsonData);
    }

    static async load() {
        return this._idbGet(this.SAVE_KEY);
    }

    // ── Multi-project API ──

    static async _getProjectsMap() {
        return (await this._idbGet(this.PROJECTS_KEY)) || {};
    }

    static async _setProjectsMap(map) {
        return this._idbPut(this.PROJECTS_KEY, map);
    }

    static async _getProjectOrder() {
        return (await this._idbGet(this.PROJECT_ORDER_KEY)) || [];
    }

    static async _setProjectOrder(order) {
        return this._idbPut(this.PROJECT_ORDER_KEY, order);
    }

    static async _touchProjectOrder(projectName) {
        let order = await this._getProjectOrder();
        // Remove if exists, then push to end (most recent)
        const idx = order.indexOf(projectName);
        if (idx !== -1) order.splice(idx, 1);
        order.push(projectName);
        await this._setProjectOrder(order);
        return order;
    }

    static async saveProject(projectName, data) {
        const map = await this._getProjectsMap();
        const isNew = !(projectName in map);
        map[projectName] = data;
        await this._setProjectsMap(map);
        const order = await this._touchProjectOrder(projectName);
        // Enforce max cache limit: evict oldest non-current project
        if (isNew && order.length > this.MAX_CACHED_PROJECTS) {
            const activeName = this.loadActiveProject();
            while (order.length > this.MAX_CACHED_PROJECTS) {
                const evictCandidate = order[0];
                if (evictCandidate === projectName || evictCandidate === activeName) {
                    // Never evict the project just saved or the active project
                    order.splice(0, 1);
                    continue;
                }
                const evicted = order.shift();
                delete map[evicted];
            }
            await this._setProjectsMap(map);
            await this._setProjectOrder(order);
        }
    }

    static async loadProject(projectName) {
        const map = await this._getProjectsMap();
        const data = map[projectName] || null;
        if (data) {
            await this._touchProjectOrder(projectName);
        }
        return data;
    }

    static async listProjects() {
        const map = await this._getProjectsMap();
        return Object.keys(map);
    }

    static async deleteProject(projectName) {
        const map = await this._getProjectsMap();
        if (projectName in map) {
            delete map[projectName];
            await this._setProjectsMap(map);
        }
        // Also remove from order tracking
        let order = await this._getProjectOrder();
        const idx = order.indexOf(projectName);
        if (idx !== -1) {
            order.splice(idx, 1);
            await this._setProjectOrder(order);
        }
    }

    static async renameProject(oldName, newName) {
        const map = await this._getProjectsMap();
        if (oldName in map && !(newName in map)) {
            map[newName] = map[oldName];
            delete map[oldName];
            await this._setProjectsMap(map);
            // Update order: replace old name with new name
            let order = await this._getProjectOrder();
            const idx = order.indexOf(oldName);
            if (idx !== -1) {
                order[idx] = newName;
                await this._setProjectOrder(order);
            }
            return true;
        }
        return false;
    }

    static async projectExists(projectName) {
        const map = await this._getProjectsMap();
        return projectName in map;
    }

    // ── Active project (localStorage) ──

    static saveActiveProject(projectName) {
        try { localStorage.setItem(this.ACTIVE_PROJECT_KEY, projectName); }
        catch (e) { console.error("[Storage] saveActiveProject failed:", e); }
    }

    static loadActiveProject() {
        try { return localStorage.getItem(this.ACTIVE_PROJECT_KEY); }
        catch (e) { return null; }
    }

    // ── Migration: old single-project → multi-project ──

    static async migrateIfNeeded() {
        const active = this.loadActiveProject();
        if (active) return;

        const oldData = await this.load();
        if (!oldData) return;

        const projectName = "InkShader_migrated";
        const data = typeof oldData === 'string'
            ? { latestSnapshot: JSON.parse(oldData), commandStack: [], redoCommandStack: [] }
            : oldData;

        await this.saveProject(projectName, data);
        this.saveActiveProject(projectName);
    }

    // ── Persistence / ViewState ──

    static async requestPersistence() {
        if (navigator.storage && navigator.storage.persist) {
            try {
                const isPersisted = await navigator.storage.persist();
                if (!isPersisted) {
                    console.warn("Persistent storage request denied by browser.");
                } else {
                    console.info("[Storage] Persistent storage request succeeded.");
                }
            } catch (error) {
                console.warn("Persistent storage API error:", error);
            }
        }
    }

    static async saveViewState(viewData) {
        try {
            localStorage.setItem(this.VIEW_SAVE_KEY, JSON.stringify(viewData));
        } catch (e) {
            console.error(" [Storage] LocalStorage save failed:", e);
        }
    }

    static async loadViewState() {
        try {
            const data = localStorage.getItem(this.VIEW_SAVE_KEY);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            console.error(" [Storage] LocalStorage load failed:", e);
            return null;
        }
    }
}
