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

    /** Format identifier — written on every save, checked on every load to distinguish InkShader project entries from foreign data. */
    static PROJECT_SIGNATURE = "InkShader V1 Project";

    /** Ensures migration from old projects map runs at most once */
    static _migrated = false;

    /** Cached IndexedDB connection — reused across all _idb* calls */
    static _dbPromise = null;

    static async initDB() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => {
                this._dbPromise = null; // allow retry on failure
                reject(e.target.error);
            };
        });
        return this._dbPromise;
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

    // ── Multi-project API (individual keys to avoid read-modify-write races) ──

    /** Prefix for per-project IndexedDB keys */
    static _PROJ_PREFIX = "proj::";

    static async _getProjectOrder() {
        return (await this._idbGet(this.PROJECT_ORDER_KEY)) || [];
    }

    static async _setProjectOrder(order) {
        return this._idbPut(this.PROJECT_ORDER_KEY, order);
    }

    /** Push projectName to end of order list (most recent) */
    static async _touchProjectOrder(projectName) {
        let order = await this._getProjectOrder();
        const idx = order.indexOf(projectName);
        if (idx !== -1) order.splice(idx, 1);
        order.push(projectName);
        await this._setProjectOrder(order);
        return order;
    }

    static async _ensureMigrated() {
        if (this._migrationPromise) return this._migrationPromise;
        if (this._migrated) return;
        this._migrationPromise = (async () => {
            const oldMap = await this._idbGet(this.PROJECTS_KEY);
            if (!oldMap || typeof oldMap !== 'object') {
                this._migrated = true;
                return;
            }
            // Migrate each entry from the old projects map to individual keys
            for (const [name, data] of Object.entries(oldMap)) {
                const key = this._PROJ_PREFIX + name;
                const existing = await this._idbGet(key);
                if (!existing) {
                    await this._idbPut(key, data);
                    await this._touchProjectOrder(name);
                }
            }
            // Remove old map after migration
            await this._idbDelete(this.PROJECTS_KEY);
            this._migrated = true;
        })();
        return this._migrationPromise;
    }

    /**
     * Check whether a raw value loaded from IndexedDB looks like a valid InkShader project entry.
     * Non-project entries (e.g. stale keys from other applications or corrupted data) are silently ignored.
     */
    static _isValidProjectData(value) {
        if (!value || typeof value !== "object") return false;
        return value._signature === this.PROJECT_SIGNATURE;
    }

    static async saveProject(projectName, data) {
        await this._ensureMigrated();
        const key = this._PROJ_PREFIX + projectName;
        const existing = await this._idbGet(key);
        const stamped = { _signature: this.PROJECT_SIGNATURE, ...data };
        const isNew = !existing;
        await this._idbPut(key, stamped);
        const order = await this._touchProjectOrder(projectName);
        // Enforce max cache limit: evict oldest non-current project
        if (isNew && order.length > this.MAX_CACHED_PROJECTS) {
            const activeName = this.loadActiveProject();
            while (order.length > this.MAX_CACHED_PROJECTS) {
                const evictCandidate = order[0];
                if (evictCandidate === projectName || evictCandidate === activeName) {
                    order.splice(0, 1);
                    continue;
                }
                const evicted = order.shift();
                await this._idbDelete(this._PROJ_PREFIX + evicted);
            }
            await this._setProjectOrder(order);
        }
    }

    static async loadProject(projectName) {
        await this._ensureMigrated();
        const data = await this._idbGet(this._PROJ_PREFIX + projectName);
        if (!data) return null;
        if (!this._isValidProjectData(data)) {
            console.warn(`[Storage] Project "${projectName}" has invalid format (expected _signature="${this.PROJECT_SIGNATURE}"). Skipping.`);
            return null;
        }
        await this._touchProjectOrder(projectName);
        return data;
    }

    static async listProjects() {
        await this._ensureMigrated();
        const allKeys = await this._idbKeys();
        const projectKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(this._PROJ_PREFIX));
        const results = [];
        for (const key of projectKeys) {
            const name = key.slice(this._PROJ_PREFIX.length);
            // Quick validation: try loading the key — _isValidProjectData filters bad entries
            const data = await this._idbGet(key);
            if (data && this._isValidProjectData(data)) {
                results.push(name);
            } else {
                console.warn(`[Storage] Skipping invalid project entry "${name}" (key=${key})`);
            }
        }
        return results;
    }

    static async deleteProject(projectName) {
        await this._ensureMigrated();
        await this._idbDelete(this._PROJ_PREFIX + projectName);
        // Also remove from order tracking
        let order = await this._getProjectOrder();
        const idx = order.indexOf(projectName);
        if (idx !== -1) {
            order.splice(idx, 1);
            await this._setProjectOrder(order);
        }
    }

    static async renameProject(oldName, newName) {
        await this._ensureMigrated();
        const oldKey = this._PROJ_PREFIX + oldName;
        const newKey = this._PROJ_PREFIX + newName;
        const existing = await this._idbGet(oldKey);
        if (!existing) return false;
        if (await this._idbGet(newKey)) return false;
        await this._idbPut(newKey, existing);
        await this._idbDelete(oldKey);
        // Update order: replace old name with new name
        let order = await this._getProjectOrder();
        const idx = order.indexOf(oldName);
        if (idx !== -1) {
            order[idx] = newName;
            await this._setProjectOrder(order);
        }
        return true;
    }

    static async projectExists(projectName) {
        await this._ensureMigrated();
        const data = await this._idbGet(this._PROJ_PREFIX + projectName);
        return data !== undefined && data !== null;
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
