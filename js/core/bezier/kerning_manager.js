// js/core/bezier/kerning_manager.js — Kerning pair + class management
//
// Stores glyph kerning in two forms:
//   1. Exact pairs: Map<leftGlyphName, Map<rightGlyphName, number>>
//   2. Classes: left_classes/right_classes Map<className, Set<glyphName>>
//      + class_values Map<leftClassName, Map<rightClassName, number>>
//
// Lookup order: exact pair → class pair → 0
// All values in UPM units (default 1000 UPM), matching OpenType font units.

export class KerningManager {
    constructor() {
        /** @type {Map<string, Map<string, number>>} */
        this._pairs = new Map();

        /** @type {Map<string, Set<string>>} Left kern classes: className → glyph names */
        this.left_classes = new Map();
        /** @type {Map<string, Set<string>>} Right kern classes: className → glyph names */
        this.right_classes = new Map();
        /** @type {Map<string, Map<string, number>>} Class-to-class kerning: leftClass → rightClass → value */
        this.class_values = new Map();

        /** @type {Map<string, Map<string, number>>} Mixed: leftClass → rightGlyph → value */
        this.mixed_class_left = new Map();
        /** @type {Map<string, Map<string, number>>} Mixed: leftGlyph → rightClass → value */
        this.mixed_class_right = new Map();
    }

    // =========================================================================
    // Exact pair API
    // =========================================================================

    /**
     * Get kerning value between two glyphs (exact pair).
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     * @returns {number} Kerning value in UPM units (0 if not set)
     */
    getPair(leftName, rightName) {
        return this._pairs.get(leftName)?.get(rightName) ?? 0;
    }

    /**
     * Set kerning value between two glyphs (exact pair).
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     * @param {number} value - Kerning value in UPM units (negative = closer)
     * @returns {boolean} Whether the value was actually set
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
     * @param {string} leftName
     * @param {string} rightName
     * @returns {boolean} Whether the pair existed
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

    // =========================================================================
    // Class API
    // =========================================================================

    /**
     * Create an empty kern class (allows zero members for later population).
     * @param {"left"|"right"} side
     * @param {string} className
     * @returns {boolean} Whether the class was actually created
     */
    createClass(side, className) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        if (!className || typeof className !== 'string') return false;
        if (classes.has(className)) return false;
        classes.set(className, new Set());
        return true;
    }

    /**
     * Create or update a kern class.
     * @param {"left"|"right"} side
     * @param {string} className
     * @param {string[]} members - Glyph names belonging to this class
     * @returns {boolean} Whether the class was actually changed
     */
    setClass(side, className, members) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        if (!className || typeof className !== 'string') return false;
        const memberSet = new Set(members.filter(m => typeof m === 'string' && m));
        if (memberSet.size === 0) {
            // Empty class — remove it
            return this.removeClass(side, className);
        }
        const existing = classes.get(className);
        if (existing && existing.size === memberSet.size && [...memberSet].every(m => existing.has(m))) {
            return false; // No change
        }
        classes.set(className, memberSet);
        return true;
    }

    /**
     * Remove a kern class and its associated values.
     * @param {"left"|"right"} side
     * @param {string} className
     * @returns {boolean} Whether the class existed
     */
    removeClass(side, className) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        const had = classes.delete(className);
        if (had) {
            // Clean up class_values referencing this class
            if (side === 'left') {
                this.class_values.delete(className);
                this.mixed_class_left.delete(className);
            } else {
                for (const [left, rightMap] of this.class_values) {
                    rightMap.delete(className);
                    if (rightMap.size === 0) this.class_values.delete(left);
                }
                this.mixed_class_right.delete(className);
            }
        }
        return had;
    }

    /**
     * Get members of a kern class.
     * @param {"left"|"right"} side
     * @param {string} className
     * @returns {string[]} Member glyph names (empty if class doesn't exist)
     */
    getClassMembers(side, className) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        const s = classes.get(className);
        return s ? [...s] : [];
    }

    /**
     * Get all class names for a side.
     * @param {"left"|"right"} side
     * @returns {string[]}
     */
    getAllClasses(side) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        return [...classes.keys()].sort();
    }

    /**
     * Get all classes with their members.
     * @param {"left"|"right"} side
     * @returns {Array<{name:string, members:string[]}>}
     */
    getAllClassesWithMembers(side) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        return [...classes.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, members]) => ({ name, members: [...members] }));
    }

    /**
     * Check if a glyph belongs to a class.
     * @param {"left"|"right"} side
     * @param {string} className
     * @param {string} glyphName
     * @returns {boolean}
     */
    isGlyphInClass(side, className, glyphName) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        return classes.get(className)?.has(glyphName) ?? false;
    }

    /**
     * Get the class name a glyph belongs to (first match).
     * @param {string} glyphName
     * @param {"left"|"right"} side
     * @returns {string|null}
     */
    getGlyphClass(glyphName, side) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        for (const [className, members] of classes) {
            if (members.has(glyphName)) return className;
        }
        return null;
    }

    /**
     * Assign a glyph to a class (replacing any previous class assignment on that side).
     * @param {string} glyphName
     * @param {"left"|"right"} side
     * @param {string|null} className - null to unassign
     * @returns {boolean} Whether anything changed
     */
    assignGlyphToClass(glyphName, side, className) {
        const classes = side === 'left' ? this.left_classes : this.right_classes;
        // Remove from any existing class on this side
        for (const [cn, members] of classes) {
            if (members.has(glyphName)) {
                members.delete(glyphName);
                if (members.size === 0) classes.delete(cn);
            }
        }
        // Add to new class
        if (className) {
            if (!classes.has(className)) classes.set(className, new Set());
            classes.get(className).add(glyphName);
            return true;
        }
        return true; // Removed from class
    }

    /**
     * Set kerning value between two classes.
     * @param {string} leftClass
     * @param {string} rightClass
     * @param {number} value
     * @returns {boolean}
     */
    setClassValue(leftClass, rightClass, value) {
        const numVal = Number(value);
        if (!Number.isFinite(numVal)) return false;
        if (!this.class_values.has(leftClass)) {
            this.class_values.set(leftClass, new Map());
        }
        this.class_values.get(leftClass).set(rightClass, numVal);
        return true;
    }

    /**
     * Get kerning value between two classes.
     * @param {string} leftClass
     * @param {string} rightClass
     * @returns {number}
     */
    getClassValue(leftClass, rightClass) {
        return this.class_values.get(leftClass)?.get(rightClass) ?? 0;
    }

    /**
     * Remove kerning value between two classes.
     * @param {string} leftClass
     * @param {string} rightClass
     * @returns {boolean}
     */
    removeClassValue(leftClass, rightClass) {
        const rightMap = this.class_values.get(leftClass);
        if (!rightMap) return false;
        const had = rightMap.has(rightClass);
        rightMap.delete(rightClass);
        if (rightMap.size === 0) this.class_values.delete(leftClass);
        return had;
    }

    /**
     * Get all class kerning values as an array.
     * @returns {Array<{leftClass:string, rightClass:string, value:number}>}
     */
    getAllClassValues() {
        const result = [];
        for (const [left, rightMap] of this.class_values) {
            for (const [right, value] of rightMap) {
                result.push({ leftClass: left, rightClass: right, value });
            }
        }
        return result;
    }

    // =========================================================================
    // Mixed pair API (class↔glyph)
    // =========================================================================

    /**
     * Set kerning between a class on one side and a glyph on the other.
     * @param {"leftClass"|"rightClass"} type - Which side is the class
     * @param {string} className
     * @param {string} glyphName
     * @param {number} value
     * @returns {boolean}
     */
    setMixedPair(type, className, glyphName, value) {
        const numVal = Number(value);
        if (!Number.isFinite(numVal)) return false;
        const map = type === 'leftClass' ? this.mixed_class_left : this.mixed_class_right;
        if (!map.has(className)) map.set(className, new Map());
        map.get(className).set(glyphName, numVal);
        return true;
    }

    /**
     * Get kerning value for a mixed pair.
     * @param {"leftClass"|"rightClass"} type
     * @param {string} className
     * @param {string} glyphName
     * @returns {number}
     */
    getMixedPair(type, className, glyphName) {
        const map = type === 'leftClass' ? this.mixed_class_left : this.mixed_class_right;
        return map.get(className)?.get(glyphName) ?? 0;
    }

    /**
     * Remove a mixed pair.
     * @param {"leftClass"|"rightClass"} type
     * @param {string} className
     * @param {string} glyphName
     * @returns {boolean}
     */
    removeMixedPair(type, className, glyphName) {
        const map = type === 'leftClass' ? this.mixed_class_left : this.mixed_class_right;
        const inner = map.get(className);
        if (!inner) return false;
        const had = inner.has(glyphName);
        inner.delete(glyphName);
        if (inner.size === 0) map.delete(className);
        return had;
    }

    /**
     * Get all mixed pairs as an array.
     * @returns {Array<{type:string, className:string, glyphName:string, value:number}>}
     */
    getAllMixedPairs() {
        const result = [];
        for (const [cn, inner] of this.mixed_class_left) {
            for (const [glyph, value] of inner) {
                result.push({ type: 'leftClass', className: cn, glyphName: glyph, value });
            }
        }
        for (const [cn, inner] of this.mixed_class_right) {
            for (const [glyph, value] of inner) {
                result.push({ type: 'rightClass', className: cn, glyphName: glyph, value });
            }
        }
        return result;
    }

    // =========================================================================
    // Lookup (used by SequenceService)
    // =========================================================================

    /**
     * Get kerning value for a pair. Follows the UFO kerning.plist lookup
     * algorithm and exception conflict resolution:
     *   1. exact pair (glyph+glyph — Level 3)
     *   2. glyph + group  (Level 2; higher priority than group+glyph)
     *   3. group + glyph  (Level 2)
     *   4. group + group  (Level 1)
     * An explicitly stored 0 is a valid exception value (it overrides a
     * non-zero class value), so presence is checked, not truthiness.
     * @param {string} leftName - Left glyph name
     * @param {string} rightName - Right glyph name
     * @returns {number} Kerning value in UPM units
     */
    getKerning(leftName, rightName) {
        // 1. Exact pair (presence check: explicit 0 must win over classes)
        const rightMap = this._pairs.get(leftName);
        if (rightMap && rightMap.has(rightName)) return rightMap.get(rightName);
        // 2. Mixed pairs. UFO: glyph+group (class on the right) is given
        //    higher priority than group+glyph (class on the left) when both
        //    could apply.
        const leftClass = this.getGlyphClass(leftName, 'left');
        const rightClass = this.getGlyphClass(rightName, 'right');
        if (rightClass) {
            const inner = this.mixed_class_right.get(rightClass);
            if (inner && inner.has(leftName)) return inner.get(leftName);
        }
        if (leftClass) {
            const inner = this.mixed_class_left.get(leftClass);
            if (inner && inner.has(rightName)) return inner.get(rightName);
        }
        // 3. Class pair (both sides in classes)
        if (leftClass && rightClass) {
            return this.getClassValue(leftClass, rightClass);
        }
        return 0;
    }

    // =========================================================================
    // Rename propagation
    // =========================================================================

    /**
     * Update all keys (pairs + classes) when a glyph is renamed.
     * @param {string} oldName
     * @param {string} newName
     */
    renameGlyph(oldName, newName) {
        if (oldName === newName) return;
        // Update pair keys
        if (this._pairs.has(oldName)) {
            this._pairs.set(newName, this._pairs.get(oldName));
            this._pairs.delete(oldName);
        }
        for (const [left, rightMap] of this._pairs) {
            if (rightMap.has(oldName)) {
                rightMap.set(newName, rightMap.get(oldName));
                rightMap.delete(oldName);
            }
        }
        // Update class members
        for (const classes of [this.left_classes, this.right_classes]) {
            for (const [cn, members] of classes) {
                if (members.has(oldName)) {
                    members.delete(oldName);
                    members.add(newName);
                }
            }
        }
        // Update mixed pairs (glyph side keys)
        for (const [cn, inner] of this.mixed_class_left) {
            if (inner.has(oldName)) {
                inner.set(newName, inner.get(oldName));
                inner.delete(oldName);
            }
        }
        for (const [cn, inner] of this.mixed_class_right) {
            if (inner.has(oldName)) {
                inner.set(newName, inner.get(oldName));
                inner.delete(oldName);
            }
        }
    }

    // =========================================================================
    // Stats
    // =========================================================================

    /** @returns {number} Number of distinct left entries in pairs */
    get leftCount() { return this._pairs.size; }

    /** @returns {number} Total number of exact pairs */
    get totalPairs() {
        let count = 0;
        for (const rightMap of this._pairs.values()) count += rightMap.size;
        return count;
    }

    /** @returns {number} Total number of class-to-class kerning values */
    get totalClassValues() {
        let count = 0;
        for (const rightMap of this.class_values.values()) count += rightMap.size;
        return count;
    }

    // =========================================================================
    // Serialization
    // =========================================================================

    /**
     * Serialize exact pairs to JSON-compatible object.
     * Format: { "A": { "V": -50, "W": -30 } }
     * @returns {Object}
     */
    toJSON() {
        const obj = {};
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
     * Serialize classes to JSON-compatible object.
     * Format: { "left": { "UC": ["A","B"] }, "right": { "UC": ["V","W"] },
     *           "values": { "UC/UC": -50 } }
     * @returns {Object|null}
     */
    classesToJSON() {
        if (this.left_classes.size === 0 && this.right_classes.size === 0 && this.class_values.size === 0
            && this.mixed_class_left.size === 0 && this.mixed_class_right.size === 0) {
            return null;
        }
        const result = {};
        if (this.left_classes.size > 0) {
            result.left = {};
            for (const [cn, members] of this.left_classes) {
                result.left[cn] = [...members].sort();
            }
        }
        if (this.right_classes.size > 0) {
            result.right = {};
            for (const [cn, members] of this.right_classes) {
                result.right[cn] = [...members].sort();
            }
        }
        if (this.class_values.size > 0) {
            result.values = {};
            const leftKeys = [...this.class_values.keys()].sort();
            for (const lc of leftKeys) {
                const rightMap = this.class_values.get(lc);
                const rightKeys = [...rightMap.keys()].sort();
                for (const rc of rightKeys) {
                    result.values[`${lc}/${rc}`] = rightMap.get(rc);
                }
            }
        }
        // Mixed pairs: class↔glyph
        if (this.mixed_class_left.size > 0 || this.mixed_class_right.size > 0) {
            result.mixed = {};
            for (const [cn, inner] of this.mixed_class_left) {
                for (const [glyph, value] of inner) {
                    result.mixed[`${cn}/${glyph}`] = value;
                }
            }
            for (const [cn, inner] of this.mixed_class_right) {
                for (const [glyph, value] of inner) {
                    result.mixed[`>>${cn}/${glyph}`] = value;
                }
            }
        }
        return result;
    }

    /**
     * Deserialize exact pairs from JSON data.
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
     * Deserialize classes from JSON data.
     * @param {Object|null} data - { left: { name: [members] }, right: {...}, values: { "L/R": num } }
     */
    classesFromJSON(data) {
        this.left_classes.clear();
        this.right_classes.clear();
        this.class_values.clear();
        this.mixed_class_left.clear();
        this.mixed_class_right.clear();
        if (!data || typeof data !== 'object') return;
        if (data.left && typeof data.left === 'object') {
            for (const [cn, members] of Object.entries(data.left)) {
                if (Array.isArray(members)) {
                    const s = new Set(members.filter(m => typeof m === 'string' && m));
                    if (s.size > 0) this.left_classes.set(cn, s);
                }
            }
        }
        if (data.right && typeof data.right === 'object') {
            for (const [cn, members] of Object.entries(data.right)) {
                if (Array.isArray(members)) {
                    const s = new Set(members.filter(m => typeof m === 'string' && m));
                    if (s.size > 0) this.right_classes.set(cn, s);
                }
            }
        }
        if (data.values && typeof data.values === 'object') {
            for (const [key, value] of Object.entries(data.values)) {
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                const idx = key.indexOf('/');
                if (idx <= 0) continue;
                const lc = key.substring(0, idx);
                const rc = key.substring(idx + 1);
                if (!this.class_values.has(lc)) this.class_values.set(lc, new Map());
                this.class_values.get(lc).set(rc, value);
            }
        }
        // Mixed pairs: class↔glyph
        if (data.mixed && typeof data.mixed === 'object') {
            for (const [key, value] of Object.entries(data.mixed)) {
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                if (key.startsWith('>>')) {
                    // rightClass: >>className/glyphName
                    const inner = key.substring(2);
                    const idx = inner.indexOf('/');
                    if (idx <= 0) continue;
                    const cn = inner.substring(0, idx);
                    const glyph = inner.substring(idx + 1);
                    if (!this.mixed_class_right.has(cn)) this.mixed_class_right.set(cn, new Map());
                    this.mixed_class_right.get(cn).set(glyph, value);
                } else {
                    // leftClass: className/glyphName
                    const idx = key.indexOf('/');
                    if (idx <= 0) continue;
                    const cn = key.substring(0, idx);
                    const glyph = key.substring(idx + 1);
                    if (!this.mixed_class_left.has(cn)) this.mixed_class_left.set(cn, new Map());
                    this.mixed_class_left.get(cn).set(glyph, value);
                }
            }
        }
    }

    /**
     * Remove all kerning data (pairs + classes).
     */
    clear() {
        this._pairs.clear();
        this.left_classes.clear();
        this.right_classes.clear();
        this.class_values.clear();
        this.mixed_class_left.clear();
        this.mixed_class_right.clear();
    }
}
