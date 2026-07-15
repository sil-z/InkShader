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
export class SpatialGrid {
    constructor(cellSize = 10) {
        this.cellSize = cellSize;
        /** Map<"cx,cy", Map<markerId, {worldX,worldY,node,curve,refId,seqIdx,groupId}>> */
        this._cells = new Map();
        /** Map<markerId, "cx,cy"> — reverse lookup for O(1) remove/update */
        this._nodeToCell = new Map();
        /** Map<groupId, Set<markerId>> — group-index for O(1) per-group grid eviction */
        this._groupIndex = new Map();
        /** Map<markerId, groupId> — reverse index for O(1) group lookup on remove() */
        this._markerToGroup = new Map();
    }

    _key(cx, cy) {
        return `${cx},${cy}`;
    }

    /**
     * Add a node at its world coordinates.
     * @param {object|string|number} markerId - marker object ({id}) or string/number
     * @param {number} worldX - X in world coords (includes seq offset + matrix)
     * @param {number} worldY - Y in world coords
     * @param {object} meta - { node, curve, refId, seqIdx }
     */
    add(markerId, worldX, worldY, meta = {}) {
        const id = markerId?.id ?? String(markerId);
        const cx = Math.floor(worldX / this.cellSize);
        const cy = Math.floor(worldY / this.cellSize);
        const key = this._key(cx, cy);
        if (!this._cells.has(key)) {
            this._cells.set(key, new Map());
        }
        this._cells.get(key).set(id, { worldX, worldY, ...meta });
        this._nodeToCell.set(id, key);
        // Track groupId for per-group eviction
        const gid = meta.groupId;
        if (gid) {
            if (!this._groupIndex.has(gid)) this._groupIndex.set(gid, new Set());
            this._groupIndex.get(gid).add(id);
            this._markerToGroup.set(id, gid);
        }
    }

    /**
     * Remove a node from the grid.
     */
    remove(markerId) {
        const id = markerId?.id ?? String(markerId);
        const key = this._nodeToCell.get(id);
        if (!key) return;
        const cell = this._cells.get(key);
        if (cell) cell.delete(id);
        this._nodeToCell.delete(id);
        const gid = this._markerToGroup.get(id);
        if (gid !== undefined) {
            const markers = this._groupIndex.get(gid);
            if (markers) markers.delete(id);
            this._markerToGroup.delete(id);
        }
    }

    /**
     * Update a node's position without knowing its old position.
     * Equivalent to remove() + add().
     */
    update(markerId, worldX, worldY, meta = {}) {
        this.remove(markerId);
        this.add(markerId, worldX, worldY, meta);
    }

    /**
     * Query all entries in cells overlapping the given rectangle.
     * @param {number} x - left
     * @param {number} y - top
     * @param {number} w - width
     * @param {number} h - height
     * @returns {Array<{worldX,worldY,node,curve,refId,seqIdx}>}
     */
    queryRect(x, y, w, h) {
        const minCx = Math.floor(x / this.cellSize);
        const maxCx = Math.floor((x + w) / this.cellSize);
        const minCy = Math.floor(y / this.cellSize);
        const maxCy = Math.floor((y + h) / this.cellSize);
        const results = [];
        // Iterate only populated cells, not all cell indices in the bounding box.
        // At low zoom the viewport covers a huge world-space area — scanning all
        // indices would visit millions of empty cells and freeze the browser.
        for (const [key, cell] of this._cells) {
            const comma = key.indexOf(',');
            const cx = parseInt(key.slice(0, comma), 10);
            const cy = parseInt(key.slice(comma + 1), 10);
            if (cx >= minCx && cx <= maxCx && cy >= minCy && cy <= maxCy) {
                for (const entry of cell.values()) {
                    results.push(entry);
                }
            }
        }
        return results;
    }

    /**
     * Query all entries within `threshold` distance of (x, y).
     * Uses a bounding-box pre-filter (expanded by threshold on each axis).
     */
    queryProximity(x, y, threshold) {
        return this.queryRect(x - threshold, y - threshold, threshold * 2, threshold * 2);
    }

    /**
     * Get world coordinates of a specific node.
     * @returns {{x:number, y:number} | null}
     */
    getPosition(markerId) {
        const id = markerId?.id ?? String(markerId);
        const key = this._nodeToCell.get(id);
        if (!key) return null;
        const cell = this._cells.get(key);
        if (!cell) return null;
        const entry = cell.get(id);
        return entry ? { x: entry.worldX, y: entry.worldY } : null;
    }

    /** Check whether a marker is indexed. */
    has(markerId) {
        const id = markerId?.id ?? String(markerId);
        return this._nodeToCell.has(id);
    }

    /**
     * Iterate all entries in the grid (for global XY alignment queries).
     * @param {function} callback - called with each entry {worldX,worldY,node,curve,refId,seqIdx}
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
     * Used for incremental spatial grid rebuild: remove stale data for dirty groups,
     * then re-add current state via add().
     */
    removeGroup(groupId) {
        const markers = this._groupIndex.get(groupId);
        if (!markers) return;
        for (const id of markers) {
            const key = this._nodeToCell.get(id);
            if (!key) continue;
            const cell = this._cells.get(key);
            if (cell) cell.delete(id);
            this._nodeToCell.delete(id);
            this._markerToGroup.delete(id);
        }
        this._groupIndex.delete(groupId);
    }

    /** Remove all entries. */
    clear() {
        this._cells.clear();
        this._nodeToCell.clear();
        this._groupIndex.clear();
        this._markerToGroup.clear();
    }

    /** Number of indexed nodes. */
    get size() {
        return this._nodeToCell.size;
    }
}
