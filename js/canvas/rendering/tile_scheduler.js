/**
 * Priority tile scheduler: scene uploaded once per epoch; paint jobs are coord-only.
 * Mid-gesture must not serialize geometry on the main thread.
 */
import {
    makeTileKey,
    scaleToKey,
    worldTileSize,
    tilesCoveringWorldRect,
    TILE_CSS_SIZE
} from "./tile_cache.js";
import {
    iterateActivePathPaintItems,
    serializePathsForWorldRect
} from "./path_tile_serializer.js";
import { paintTilePaths } from "./tile_paint_core.js";
import { getCanvasTheme } from "./canvas_theme.js";

export class TileScheduler {
    /**
     * @param {object} opts
     * @param {import("./tile_cache.js").TileCache} opts.cache
     * @param {() => object} opts.getHost
     * @param {() => string} opts.getEpoch
     * @param {() => number} opts.getDpr
     * @param {() => void} [opts.requestFrame]
     */
    constructor({ cache, getHost, getEpoch, getDpr, requestFrame }) {
        this.cache = cache;
        this.getHost = getHost;
        this.getEpoch = getEpoch;
        this.getDpr = getDpr;
        this.requestFrame = requestFrame || (() => {});
        /** @type {Map<string, { tx:number, ty:number, scale:number, scaleKey:string, epoch:string, priority:number }>} */
        this._queue = new Map();
        /** @type {Set<string>} */
        this._inflight = new Set();
        this._worker = null;
        this._workerFailed = false;
        this._sceneEpoch = null;
        this._sceneReady = false;
        this._sceneUploading = false;
        this._sceneIterator = null;
        /** @type {object[]|null} main-thread fallback scene */
        this._localScene = null;
        this._initWorker();
    }

    _initWorker() {
        try {
            if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
                this._workerFailed = true;
                return;
            }
            this._worker = new Worker(
                new URL("./tile_paint_worker.js", import.meta.url),
                { type: "module" }
            );
            this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
            this._worker.onerror = () => {
                this._workerFailed = true;
                try { this._worker?.terminate(); } catch (_) { /* ignore */ }
                this._worker = null;
                this.requestFrame();
            };
        } catch (_) {
            this._workerFailed = true;
            this._worker = null;
        }
    }

    get pendingCount() {
        return this._queue.size + this._inflight.size + (this._sceneUploading ? 1 : 0);
    }

    get hasPending() {
        return this.pendingCount > 0;
    }

    get sceneReady() {
        return this._sceneReady;
    }

    clear() {
        this._queue.clear();
    }

    /** Drop Worker/local scene so the next ensureScene re-uploads. */
    invalidateScene() {
        this._sceneEpoch = null;
        this._sceneReady = false;
        this._sceneUploading = false;
        this._sceneIterator = null;
        this._localScene = null;
        try {
            this._worker?.postMessage({ type: "clearScene" });
        } catch (_) { /* ignore */ }
    }

    dispose() {
        this.clear();
        this._inflight.clear();
        try { this._worker?.terminate(); } catch (_) { /* ignore */ }
        this._worker = null;
    }

    /**
     * Start a budgeted Worker scene upload for the current geometry epoch.
     * Geometry serialization is advanced later by pump().
     */
    ensureScene() {
        const epoch = this.getEpoch();
        if (this._sceneEpoch === epoch && this._sceneReady) return true;
        if (this._sceneUploading) return false;

        const host = this.getHost();
        if (!host) return false;
        const theme = getCanvasTheme() || {};
        const themePayload = {
            path_fill_color: theme.path_fill_color,
            path_stroke_color: theme.path_stroke_color
        };

        this._sceneUploading = true;
        try {
            this._sceneIterator = iterateActivePathPaintItems(host);
            this._localScene = [];
            this._sceneEpoch = epoch;

            if (this._worker && !this._workerFailed) {
                this._sceneReady = false;
                this._worker.postMessage({
                    type: "beginScene",
                    epoch,
                    theme: themePayload
                });
            }
            this.requestFrame();
            return true;
        } catch (_) {
            this._sceneUploading = false;
            this._sceneIterator = null;
            return false;
        }
    }

    /**
     * Serialize a bounded number of path instances for the Worker scene.
     *
     * @param {number} [maxMs=3] - Main-thread time budget
     * @param {number} [maxItems=64] - Maximum items per transfer
     * @returns {boolean} Whether scene construction is complete
     */
    advanceSceneBuild(maxMs = 3, maxItems = 64) {
        if (!this._sceneUploading || !this._sceneIterator) return this._sceneReady;
        if (this._sceneEpoch !== this.getEpoch()) {
            this.invalidateScene();
            return false;
        }

        const started = performance.now();
        const batch = [];
        let done = false;
        while (batch.length < maxItems && performance.now() - started < maxMs) {
            const next = this._sceneIterator.next();
            if (next.done) {
                done = true;
                break;
            }
            batch.push(next.value);
        }

        if (batch.length > 0) {
            this._localScene.push(...batch);
            if (this._worker && !this._workerFailed) {
                this._worker.postMessage({
                    type: "appendScene",
                    epoch: this._sceneEpoch,
                    items: batch
                });
            }
        }

        if (done) {
            this._sceneIterator = null;
            if (this._worker && !this._workerFailed) {
                this._worker.postMessage({
                    type: "commitScene",
                    epoch: this._sceneEpoch
                });
            } else {
                this._sceneReady = true;
                this._sceneUploading = false;
            }
        } else {
            this.requestFrame();
        }
        return done && this._sceneReady;
    }

    /**
     * @param {number} scale
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldVisible
     * @param {number} [marginTiles=1]
     */
    syncView(scale, worldVisible, marginTiles = 1) {
        const epoch = this.getEpoch();
        const scaleKey = scaleToKey(scale);
        const wts = worldTileSize(scale);
        const margin = marginTiles * wts;
        const expanded = {
            minX: worldVisible.minX - margin,
            minY: worldVisible.minY - margin,
            maxX: worldVisible.maxX + margin,
            maxY: worldVisible.maxY + margin
        };
        const wanted = tilesCoveringWorldRect(scale, expanded);
        this.cache.ensureCapacity(wanted.length + 16);
        const wantedKeys = new Set();
        const cx = (worldVisible.minX + worldVisible.maxX) / 2;
        const cy = (worldVisible.minY + worldVisible.maxY) / 2;

        for (const { tx, ty } of wanted) {
            const key = makeTileKey(scaleKey, tx, ty, epoch);
            wantedKeys.add(key);
            if (this.cache.has(key) || this._inflight.has(key)) continue;
            const tileCx = (tx + 0.5) * wts;
            const tileCy = (ty + 0.5) * wts;
            const dist = Math.hypot(tileCx - cx, tileCy - cy);
            const inCore =
                tileCx >= worldVisible.minX && tileCx <= worldVisible.maxX &&
                tileCy >= worldVisible.minY && tileCy <= worldVisible.maxY;
            const priority = (inCore ? 0 : 1000) + dist;
            const existing = this._queue.get(key);
            if (!existing || priority < existing.priority) {
                this._queue.set(key, { tx, ty, scale, scaleKey, epoch, priority });
            }
        }

        for (const [key, job] of [...this._queue.entries()]) {
            if (job.epoch !== epoch || job.scaleKey !== scaleKey || !wantedKeys.has(key)) {
                this._queue.delete(key);
            }
        }
    }

    /**
     * @param {{ maxJobs?: number }} [opts]
     * @returns {number}
     */
    pump(opts = {}) {
        const maxJobs = opts.maxJobs != null ? opts.maxJobs : 1;
        if (this._sceneUploading) {
            this.advanceSceneBuild();
            this.requestFrame();
            return 0;
        }
        const epoch = this.getEpoch();
        if (this._sceneEpoch !== epoch || (!this._sceneReady && !this._localScene)) {
            // Scene missing — do not serialize here on the hot path.
            this.requestFrame();
            return 0;
        }

        const capacity = Math.max(0, maxJobs - this._inflight.size);
        if (capacity <= 0 || this._queue.size === 0) return 0;

        const jobs = [...this._queue.values()].sort((a, b) => a.priority - b.priority);
        let started = 0;
        for (const job of jobs) {
            if (started >= capacity) break;
            const key = makeTileKey(job.scaleKey, job.tx, job.ty, job.epoch);
            if (!this._queue.has(key)) continue;
            if (this.cache.has(key) || this._inflight.has(key)) {
                this._queue.delete(key);
                continue;
            }
            this._queue.delete(key);
            if (this._dispatch(job, key)) started++;
        }
        if (this._queue.size > 0 || this._inflight.size > 0) this.requestFrame();
        return started;
    }

    flushVisible(maxMs = 24) {
        const started = performance.now();
        this.ensureScene();
        while (this._queue.size > 0 && performance.now() - started < maxMs) {
            if (this.pump({ maxJobs: 1 }) === 0) break;
            if (this._worker && !this._workerFailed) break;
        }
    }

    _dispatch(job, key) {
        const dpr = this.getDpr() || 1;
        const wts = worldTileSize(job.scale);
        const worldMinX = job.tx * wts;
        const worldMinY = job.ty * wts;
        const world = {
            minX: worldMinX,
            minY: worldMinY,
            maxX: worldMinX + wts,
            maxY: worldMinY + wts
        };
        const offsetX = -worldMinX * job.scale;
        const offsetY = -worldMinY * job.scale;

        if (this._worker && !this._workerFailed) {
            if (!this._sceneReady) {
                this.requestFrame();
                return false;
            }
            this._inflight.add(key);
            try {
                this._worker.postMessage({
                    type: "paint",
                    key,
                    cssSize: TILE_CSS_SIZE,
                    dpr,
                    scale: job.scale,
                    offsetX,
                    offsetY,
                    world,
                    epoch: job.epoch
                });
                return true;
            } catch (_) {
                this._inflight.delete(key);
                this._workerFailed = true;
            }
        }

        return this._paintOnMain(job, key, world, offsetX, offsetY, dpr);
    }

    _paintOnMain(job, key, world, offsetX, offsetY, dpr) {
        try {
            const host = this.getHost();
            const el = host?.env?.createDOMElement?.("canvas");
            if (!el) return false;
            el.width = Math.max(1, Math.round(TILE_CSS_SIZE * dpr));
            el.height = Math.max(1, Math.round(TILE_CSS_SIZE * dpr));
            const ctx = host.env.getCanvasContext(el, "2d");
            if (!ctx) return false;
            const theme = getCanvasTheme() || {};
            // Prefer spatial serialize for one tile (main-thread fallback only).
            const items = serializePathsForWorldRect(host, world);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            paintTilePaths(ctx, {
                scale: job.scale,
                offsetX,
                offsetY,
                items,
                theme: {
                    path_fill_color: theme.path_fill_color,
                    path_stroke_color: theme.path_stroke_color
                },
                cssSize: TILE_CSS_SIZE
            });
            this.cache.put(key, {
                canvas: el,
                width: TILE_CSS_SIZE,
                height: TILE_CSS_SIZE,
                dpr,
                scale: job.scale,
                scaleKey: job.scaleKey,
                tx: job.tx,
                ty: job.ty,
                epoch: job.epoch
            });
            this.requestFrame();
            return true;
        } catch (_) {
            return false;
        }
    }

    _onWorkerMessage(data) {
        if (!data) return;
        if (data.type === "sceneReady") {
            if (data.epoch !== this.getEpoch() || data.epoch !== this._sceneEpoch) return;
            this._sceneReady = true;
            this._sceneUploading = false;
            this._sceneEpoch = data.epoch;
            this.requestFrame();
            if (this._queue.size > 0) this.pump({ maxJobs: 1 });
            return;
        }
        if (!data.key) return;
        this._inflight.delete(data.key);
        if (data.type === "error") {
            // no-scene: retry after ensureScene
            if (data.error === "no-scene") {
                this._sceneReady = false;
            }
            this.requestFrame();
            return;
        }
        if (data.type !== "done" || !data.bitmap) return;
        const epoch = this.getEpoch();
        const parts = String(data.key).split("|");
        const scaleKey = parts[0];
        const tx = Number(parts[1]);
        const ty = Number(parts[2]);
        const jobEpoch = parts.slice(3).join("|");
        if (jobEpoch !== epoch) {
            try { data.bitmap.close?.(); } catch (_) { /* ignore */ }
            this.requestFrame();
            return;
        }
        this.cache.put(data.key, {
            canvas: data.bitmap,
            bitmap: data.bitmap,
            width: data.cssSize || TILE_CSS_SIZE,
            height: data.cssSize || TILE_CSS_SIZE,
            dpr: data.dpr || 1,
            scale: data.scale,
            scaleKey,
            tx,
            ty,
            epoch: jobEpoch
        });
        this.requestFrame();
        if (this._queue.size > 0) this.pump({ maxJobs: 1 });
    }
}
