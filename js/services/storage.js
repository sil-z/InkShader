// js/services/storage.js

export class StorageUtils {
    static DB_NAME = "AntumbraEditorDB";
    static STORE_NAME = "AppState";
    static SAVE_KEY = "last_edit_state";
    static VIEW_SAVE_KEY = "last_view_state";

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

    static async save(jsonData) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readwrite");
            const store = tx.objectStore(this.STORE_NAME);
            store.put(jsonData, this.SAVE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    static async load() {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readonly");
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.get(this.SAVE_KEY);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    static async requestPersistence() {
        if (navigator.storage && navigator.storage.persist) {
            try {
                const isPersisted = await navigator.storage.persist();
                if (!isPersisted) {
                    console.warn("Persistent storage request denied by browser.");
                } else {
                    console.log("Persistent storage request succeeded.");
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