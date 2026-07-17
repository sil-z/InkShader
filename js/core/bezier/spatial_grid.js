// js/core/bezier/spatial_grid.js — 2D spatial index for fast proximity queries
//
// Cell-based spatial grid (not quadtree). Optimal for font editor layout where
// nodes are uniformly distributed along X (one glyph per advance width).
// Grid cell size = 10 logical units (= snap threshold 5 * 2).
//
// Lifecycle:
//   - Rebuilt on command boundaries (mousedown/before interaction, after commit).
//   - NEVER updated during per-frame interaction (drag, transform preview).
//   - Non-dragged nodes stay at committed positions, so grid queries during drag
//     return accurate snap candidates for the static nodes.
//
// World coordinates: includes sequence offset + matrix transform.
// Control handles are NOT indexed (only main nodes participate in point snapping).
//
// Instance key: markerId|curveId|seqIdx|refId — the same master node can appear at multiple
// world positions (repeated sequence glyphs, nested refs). Indexing by markerId alone
// left orphan cells at stale positions after rebuild → hit-test offset from render.
// curveId also prevents malformed/legacy duplicate marker IDs from evicting each other.
export class SpatialGrid {
    constructor(cellSize = 10) {
        this.cellSize = cellSize;
        /** Map<"cx,cy", Map<instanceKey, entry>> */
        this._cells = new Map();
        /** Map<instanceKey, "cx,cy"> — reverse lookup for O(1) remove/update */
        this._nodeToCell = new Map();
        /** Map<groupId, Set<instanceKey>> — group-index for O(1) per-group grid eviction */
        this._groupIndex = new Map();
        /** Map<instanceKey, groupId> — reverse index for O(1) group lookup on remove() */
        this._markerToGroup = new Map();
        /** Curve AABB index: Map<"cx,cy", Map<curveInstanceKey, entry>> */
        this._curveCells = new Map();
        /** Map<curveInstanceKey, Set<"cx,cy">> */
        this._curveToCells = new Map();
        /** Map<groupId, Set<curveInstanceKey>> */
        this._curveGroupIndex = new Map();
        /** Map<curveInstanceKey, groupId> */
        this._curveToGroup = new Map();
    }

    _key(cx, cy) {
        return `${cx},${cy}`;
    }

    _markerId(markerId) {
        return markerId?.id ?? String(markerId);
    }

    /**
     * Unique key for one on-canvas instance of a marker.
     * @param {string} id
     * @param {{curve?:object,seqIdx?:number,refId?:string|null}} meta
     */
    _instanceKey(id, meta = {}) {
        const curve = meta.curve?.id ?? "";
        const seq = meta.seqIdx != null ? meta.seqIdx : "";
        const ref = meta.refId != null ? meta.refId : "";
        return `${id}|${curve}|${seq}|${ref}`;
    }

    _removeInstanceKey(instanceKey) {
        const key = this._nodeToCell.get(instanceKey);
        if (!key) return;
        const cell = this._cells.get(key);
        if (cell) cell.delete(instanceKey);
        this._nodeToCell.delete(instanceKey);
        const gid = this._markerToGroup.get(instanceKey);
        if (gid !== undefined) {
            const markers = this._groupIndex.get(gid);
            if (markers) markers.delete(instanceKey);
            this._markerToGroup.delete(instanceKey);
        }
    }

    /**
     * Add a node at its world coordinates.
     * @param {object|string|number} markerId - marker object ({id}) or string/number
     * @param {number} worldX - X in world coords (includes seq offset + matrix)
     * @param {number} worldY - Y in world coords
     * @param {object} meta - { node, curve, refId, seqIdx, groupId, matrix, seqOffsetX }
     */
    add(markerId, worldX, worldY, meta = {}) {
        const id = this._markerId(markerId);
        const instanceKey = this._instanceKey(id, meta);
        // Replace prior entry for this instance (never leave orphan cells).
        this._removeInstanceKey(instanceKey);

        const cx = Math.floor(worldX / this.cellSize);
        const cy = Math.floor(worldY / this.cellSize);
        const key = this._key(cx, cy);
        if (!this._cells.has(key)) {
            this._cells.set(key, new Map());
        }
        this._cells.get(key).set(instanceKey, {
            worldX,
            worldY,
            markerId: id,
            ...meta
        });
        this._nodeToCell.set(instanceKey, key);

        const gid = meta.groupId;
        if (gid) {
            if (!this._groupIndex.has(gid)) this._groupIndex.set(gid, new Set());
            this._groupIndex.get(gid).add(instanceKey);
            this._markerToGroup.set(instanceKey, gid);
        }
    }

    /**
     * Remove all instances of a marker (any seq/ref), or one instance when meta given.
     */
    remove(markerId, meta = null) {
        const id = this._markerId(markerId);
        if (meta && (meta.seqIdx != null || meta.refId != null)) {
            this._removeInstanceKey(this._instanceKey(id, meta));
            return;
        }
        const prefix = `${id}|`;
        for (const instanceKey of [...this._nodeToCell.keys()]) {
            if (instanceKey === id || instanceKey.startsWith(prefix)) {
                this._removeInstanceKey(instanceKey);
            }
        }
    }

    /**
     * Update a node's position without knowing its old position.
     * Equivalent to remove() + add() for that instance.
     */
    update(markerId, worldX, worldY, meta = {}) {
        this.remove(markerId, meta);
        this.add(markerId, worldX, worldY, meta);
    }

    /**
     * Choose whether to scan query AABB cells or only occupied cells.
     * Zoomed-out views make world AABBs huge; empty-cell walks then dominate (regression).
     */
    _shouldScanOccupied(minCx, maxCx, minCy, maxCy, occupiedCount) {
        const spanX = maxCx - minCx + 1;
        const spanY = maxCy - minCy + 1;
        if (spanX <= 0 || spanY <= 0) return true;
        const cellSpan = spanX * spanY;
        // Prefer AABB walk for small queries; otherwise occupied walk is O(G) not O(span).
        return cellSpan > 256 && cellSpan > occupiedCount * 2;
    }

    _parseCellKey(key) {
        const comma = key.indexOf(",");
        return {
            cx: parseInt(key.slice(0, comma), 10),
            cy: parseInt(key.slice(comma + 1), 10)
        };
    }

    /**
     * Query all entries in cells overlapping the given rectangle.
     * Small queries: walk cells in AABB. Huge queries (zoomed out): walk occupied only.
     * @returns {Array<{worldX,worldY,node,curve,refId,seqIdx}>}
     */
    queryRect(x, y, w, h) {
        const minCx = Math.floor(x / this.cellSize);
        const maxCx = Math.floor((x + w) / this.cellSize);
        const minCy = Math.floor(y / this.cellSize);
        const maxCy = Math.floor((y + h) / this.cellSize);
        const results = [];
        if (this._shouldScanOccupied(minCx, maxCx, minCy, maxCy, this._cells.size)) {
            for (const [key, cell] of this._cells) {
                const { cx, cy } = this._parseCellKey(key);
                if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) continue;
                for (const entry of cell.values()) {
                    results.push(entry);
                }
            }
            return results;
        }
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const cell = this._cells.get(this._key(cx, cy));
                if (!cell) continue;
                for (const entry of cell.values()) {
                    results.push(entry);
                }
            }
        }
        return results;
    }

    /**
     * Query all entries within `threshold` distance of (x, y).
     */
    queryProximity(x, y, threshold) {
        const t = Math.max(0, threshold);
        return this.queryRect(x - t, y - t, t * 2, t * 2);
    }

    _curveInstanceKey(curveId, meta = {}) {
        const seq = meta.seqIdx != null ? meta.seqIdx : "";
        const ref = meta.refId != null ? meta.refId : "";
        return `c:${curveId}|${seq}|${ref}`;
    }

    _removeCurveInstanceKey(instanceKey) {
        const cells = this._curveToCells.get(instanceKey);
        if (cells) {
            for (const cellKey of cells) {
                const cell = this._curveCells.get(cellKey);
                if (cell) cell.delete(instanceKey);
            }
            this._curveToCells.delete(instanceKey);
        }
        const gid = this._curveToGroup.get(instanceKey);
        if (gid !== undefined) {
            this._curveGroupIndex.get(gid)?.delete(instanceKey);
            this._curveToGroup.delete(instanceKey);
        }
    }

    /**
     * Index a curve instance by its world-space AABB (for object hit-test candidates).
     */
    addCurve(curveId, minX, minY, maxX, maxY, meta = {}) {
        if (!curveId) return;
        const instanceKey = this._curveInstanceKey(curveId, meta);
        this._removeCurveInstanceKey(instanceKey);

        const pad = Number.isFinite(meta.pad) ? meta.pad : 0;
        let minCx = Math.floor((minX - pad) / this.cellSize);
        let maxCx = Math.floor((maxX + pad) / this.cellSize);
        let minCy = Math.floor((minY - pad) / this.cellSize);
        let maxCy = Math.floor((maxY + pad) / this.cellSize);
        // Guard corrupt/huge bounds — never index tens of thousands of cells per curve.
        const MAX_CURVE_CELLS = 4096;
        const span = (maxCx - minCx + 1) * (maxCy - minCy + 1);
        if (span > MAX_CURVE_CELLS) {
            const cx = Math.floor(((minX + maxX) / 2) / this.cellSize);
            const cy = Math.floor(((minY + maxY) / 2) / this.cellSize);
            minCx = maxCx = cx;
            minCy = maxCy = cy;
        }
        const cellKeys = new Set();
        const entry = {
            curveId,
            minX,
            minY,
            maxX,
            maxY,
            ...meta
        };
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const cellKey = this._key(cx, cy);
                cellKeys.add(cellKey);
                if (!this._curveCells.has(cellKey)) this._curveCells.set(cellKey, new Map());
                this._curveCells.get(cellKey).set(instanceKey, entry);
            }
        }
        this._curveToCells.set(instanceKey, cellKeys);

        const gid = meta.groupId;
        if (gid) {
            if (!this._curveGroupIndex.has(gid)) this._curveGroupIndex.set(gid, new Set());
            this._curveGroupIndex.get(gid).add(instanceKey);
            this._curveToGroup.set(instanceKey, gid);
        }
    }

    /**
     * Curves whose AABB overlaps the query rect (deduped by instance key).
     * @returns {Array<object>}
     */
    queryCurvesRect(x, y, w, h) {
        const minCx = Math.floor(x / this.cellSize);
        const maxCx = Math.floor((x + w) / this.cellSize);
        const minCy = Math.floor(y / this.cellSize);
        const maxCy = Math.floor((y + h) / this.cellSize);
        const seen = new Set();
        const results = [];
        const pushEntry = (instanceKey, entry) => {
            if (seen.has(instanceKey)) return;
            if (
                entry.maxX < x ||
                entry.minX > x + w ||
                entry.maxY < y ||
                entry.minY > y + h
            ) {
                return;
            }
            seen.add(instanceKey);
            results.push(entry);
        };
        if (this._shouldScanOccupied(minCx, maxCx, minCy, maxCy, this._curveCells.size)) {
            for (const [key, cell] of this._curveCells) {
                const { cx, cy } = this._parseCellKey(key);
                if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) continue;
                for (const [instanceKey, entry] of cell) {
                    pushEntry(instanceKey, entry);
                }
            }
            return results;
        }
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const cell = this._curveCells.get(this._key(cx, cy));
                if (!cell) continue;
                for (const [instanceKey, entry] of cell) {
                    pushEntry(instanceKey, entry);
                }
            }
        }
        return results;
    }

    /**
     * Build a Set of "curveId|seqIdx|refId" keys overlapping a world-space rect.
     * Used by the renderer to skip off-screen curves without per-curve getBounds.
     */
    buildCurveInstanceKeySet(x, y, w, h) {
        const keys = new Set();
        for (const entry of this.queryCurvesRect(x, y, w, h)) {
            const id = entry.curveId || entry.curve?.id;
            if (!id) continue;
            keys.add(`${id}|${entry.seqIdx ?? ""}|${entry.refId ?? ""}`);
        }
        return keys;
    }

    /**
     * Get world coordinates of a marker (first instance if several).
     * @returns {{x:number, y:number} | null}
     */
    getPosition(markerId) {
        const id = this._markerId(markerId);
        const prefix = `${id}|`;
        for (const [instanceKey, cellKey] of this._nodeToCell) {
            if (instanceKey !== id && !instanceKey.startsWith(prefix)) continue;
            const cell = this._cells.get(cellKey);
            const entry = cell?.get(instanceKey);
            if (entry) return { x: entry.worldX, y: entry.worldY };
        }
        return null;
    }

    /** Check whether any instance of a marker is indexed. */
    has(markerId) {
        const id = this._markerId(markerId);
        if (this._nodeToCell.has(id)) return true;
        const prefix = `${id}|`;
        for (const instanceKey of this._nodeToCell.keys()) {
            if (instanceKey.startsWith(prefix)) return true;
        }
        return false;
    }

    /**
     * Iterate all entries in the grid.
     */
    forEach(callback) {
        for (const cell of this._cells.values()) {
            for (const entry of cell.values()) {
                callback(entry);
            }
        }
    }

    /**
     * Remove all nodes belonging to a group from the grid.
     */
    removeGroup(groupId) {
        const markers = this._groupIndex.get(groupId);
        if (markers) {
            for (const instanceKey of markers) {
                const key = this._nodeToCell.get(instanceKey);
                if (!key) continue;
                const cell = this._cells.get(key);
                if (cell) cell.delete(instanceKey);
                this._nodeToCell.delete(instanceKey);
                this._markerToGroup.delete(instanceKey);
            }
            this._groupIndex.delete(groupId);
        }
        const curves = this._curveGroupIndex.get(groupId);
        if (curves) {
            for (const instanceKey of [...curves]) {
                this._removeCurveInstanceKey(instanceKey);
            }
            this._curveGroupIndex.delete(groupId);
        }
    }

    /** Remove all entries. */
    clear() {
        this._cells.clear();
        this._nodeToCell.clear();
        this._groupIndex.clear();
        this._markerToGroup.clear();
        this._curveCells.clear();
        this._curveToCells.clear();
        this._curveGroupIndex.clear();
        this._curveToGroup.clear();
    }

    /** Number of indexed instances. */
    get size() {
        return this._nodeToCell.size;
    }
}
