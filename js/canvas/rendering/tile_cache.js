/**
 * LRU tile cache for path-layer bitmaps (world-aligned at a given scale).
 */
export const TILE_CSS_SIZE = 256;
export const TILE_MAX_ENTRIES = 128;

export function makeTileKey(scaleKey, tx, ty, epoch) {
    return `${scaleKey}|${tx}|${ty}|${epoch}`;
}

/** Stable scale key — enough precision to keep world tile grids aligned. */
export function scaleToKey(scale) {
    if (!Number.isFinite(scale) || scale <= 0) return "0";
    return scale.toFixed(5);
}

export function worldTileSize(scale) {
    return TILE_CSS_SIZE / scale;
}

/**
 * @param {number} scale
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldRect
 * @returns {{tx:number, ty:number}[]}
 */
export function tilesCoveringWorldRect(scale, worldRect) {
    const wts = worldTileSize(scale);
    if (!Number.isFinite(wts) || wts <= 0) return [];
    const tx0 = Math.floor(worldRect.minX / wts);
    const ty0 = Math.floor(worldRect.minY / wts);
    const tx1 = Math.floor((worldRect.maxX - 1e-9) / wts);
    const ty1 = Math.floor((worldRect.maxY - 1e-9) / wts);
    const out = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            out.push({ tx, ty });
        }
    }
    return out;
}

export class TileCache {
    /**
     * @param {{ maxEntries?: number }} [opts]
     */
    constructor(opts = {}) {
        this.maxEntries = opts.maxEntries ?? TILE_MAX_ENTRIES;
        /** @type {Map<string, { canvas:*, bitmap?:ImageBitmap, width:number, height:number, dpr:number, scale:number, scaleKey:string, tx:number, ty:number, epoch:string }>} */
        this._map = new Map();
        /** @type {string[]} */
        this._lru = [];
    }

    get size() {
        return this._map.size;
    }

    has(key) {
        return this._map.has(key);
    }

    get(key) {
        const entry = this._map.get(key);
        if (!entry) return null;
        this._touch(key);
        return entry;
    }

    /** Grow the cap so the current view's tiles never thrash each other. */
    ensureCapacity(n) {
        if (n > this.maxEntries) this.maxEntries = n;
    }

    /**
     * @param {string} key
     * @param {object} entry
     */
    put(key, entry) {
        if (this._map.has(key)) {
            const prev = this._map.get(key);
            if (prev?.bitmap && prev.bitmap !== entry.bitmap) {
                try { prev.bitmap.close?.(); } catch (_) { /* ignore */ }
            }
            this._map.set(key, entry);
            this._touch(key);
            return;
        }
        while (this._map.size >= this.maxEntries && this._lru.length) {
            const victim = this._lru.shift();
            if (victim && victim !== key) {
                const old = this._map.get(victim);
                if (old?.bitmap) {
                    try { old.bitmap.close?.(); } catch (_) { /* ignore */ }
                }
                this._map.delete(victim);
            }
        }
        this._map.set(key, entry);
        this._lru.push(key);
    }

    invalidateAll() {
        for (const entry of this._map.values()) {
            if (entry?.bitmap) {
                try { entry.bitmap.close?.(); } catch (_) { /* ignore */ }
            }
        }
        this._map.clear();
        this._lru.length = 0;
    }

    invalidateEpoch(epoch) {
        for (const [key, entry] of [...this._map.entries()]) {
            if (entry.epoch !== epoch) {
                if (entry.bitmap) {
                    try { entry.bitmap.close?.(); } catch (_) { /* ignore */ }
                }
                this._map.delete(key);
                const i = this._lru.indexOf(key);
                if (i >= 0) this._lru.splice(i, 1);
            }
        }
    }

    invalidateScaleKey(scaleKey) {
        for (const [key, entry] of [...this._map.entries()]) {
            if (entry.scaleKey !== scaleKey) {
                if (entry.bitmap) {
                    try { entry.bitmap.close?.(); } catch (_) { /* ignore */ }
                }
                this._map.delete(key);
                const i = this._lru.indexOf(key);
                if (i >= 0) this._lru.splice(i, 1);
            }
        }
    }

    _touch(key) {
        const i = this._lru.indexOf(key);
        if (i >= 0) this._lru.splice(i, 1);
        this._lru.push(key);
    }
}
