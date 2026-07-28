// js/core/bezier/kerning_manager.js — Kerning pair management
//
// Stores glyph pair kerning values as a nested Map:
//   Map<leftGlyphName, Map<rightGlyphName, number>>
//
// All values in UPM units (default 1000 UPM), matching OpenType font units.

export class KerningManager {
    constructor() {
        /** @type {Map<string, Map<string, number>>} */
        this._pairs = new Map();
    }

    /**
     * Get kerning value between two glyphs.
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     * @returns {number} Kerning value in UPM units (0 if not set)
     */
    getPair(leftName, rightName) {
        return this._pairs.get(leftName)?.get(rightName) ?? 0;
    }

    /**
     * Set kerning value between two glyphs.
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     * @param {number} value - Kerning value in UPM units (negative = closer)
     */
    setPair(leftName, rightName, value) {
        const numVal = Number(value);
        if (!Number.isFinite(numVal)) return false;
        if (!this._pairs.has(leftName)) {
            this._pairs.set(leftName, new Map());
        }
        this._pairs.get(leftName).set(rightName, numVal);
        return true;
    }

    /**
     * Remove a kerning pair.
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     */
    removePair(leftName, rightName) {
        const rightMap = this._pairs.get(leftName);
        if (!rightMap) return false;
        const had = rightMap.has(rightName);
        rightMap.delete(rightName);
        if (rightMap.size === 0) {
            this._pairs.delete(leftName);
        }
        return had;
    }

    /**
     * Update all keys (left and right) when a glyph is renamed.
     * @param {string} oldName
     * @param {string} newName
     */
    renameGlyph(oldName, newName) {
        if (oldName === newName) return;
        // Update left-side keys
        if (this._pairs.has(oldName)) {
            this._pairs.set(newName, this._pairs.get(oldName));
            this._pairs.delete(oldName);
        }
        // Update right-side keys
        for (const [left, rightMap] of this._pairs) {
            if (rightMap.has(oldName)) {
                rightMap.set(newName, rightMap.get(oldName));
                rightMap.delete(oldName);
            }
        }
    }

    /**
     * Get all kerning pairs as an array.
     * @returns {Array<{left:string, right:string, value:number}>}
     */
    getAllPairs() {
        const result = [];
        for (const [left, rightMap] of this._pairs) {
            for (const [right, value] of rightMap) {
                result.push({ left, right, value });
            }
        }
        return result;
    }

    /**
     * Get number of distinct left entries.
     * @returns {number}
     */
    get leftCount() {
        return this._pairs.size;
    }

    /**
     * Get total number of kerning pairs.
     * @returns {number}
     */
    get totalPairs() {
        let count = 0;
        for (const rightMap of this._pairs.values()) {
            count += rightMap.size;
        }
        return count;
    }

    /**
     * Serialize to JSON-compatible object.
     * Format: { "A": { "V": -50, "W": -30 }, "T": { "o": -20 } }
     * @returns {Object}
     */
    toJSON() {
        const obj = {};
        // Sort left keys for deterministic output
        const leftKeys = [...this._pairs.keys()].sort();
        for (const left of leftKeys) {
            const rightMap = this._pairs.get(left);
            if (rightMap && rightMap.size > 0) {
                const sorted = {};
                const rightKeys = [...rightMap.keys()].sort();
                for (const right of rightKeys) {
                    sorted[right] = rightMap.get(right);
                }
                obj[left] = sorted;
            }
        }
        return obj;
    }

    /**
     * Deserialize from JSON data.
     * @param {Object|null} data
     */
    fromJSON(data) {
        this._pairs.clear();
        if (!data || typeof data !== 'object') return;
        for (const [left, rightMap] of Object.entries(data)) {
            if (typeof rightMap !== 'object' || rightMap === null) continue;
            const inner = new Map();
            for (const [right, value] of Object.entries(rightMap)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    inner.set(right, value);
                }
            }
            if (inner.size > 0) {
                this._pairs.set(left, inner);
            }
        }
    }

    /**
     * Remove all kerning pairs.
     */
    clear() {
        this._pairs.clear();
    }
}
