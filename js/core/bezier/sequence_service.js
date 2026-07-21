// js/core/bezier/sequence_service.js — Sequence text parsing, character mapping, offset calculation
import { getSequenceDisplayChar } from '../../domain/sequence/sequence_display.js';
import { parseSequenceTokens } from '../../domain/sequence/sequence_tokenizer.js';

/**
 * SequenceService: manages sequence text, token parsing, character→group mapping, offset calculation.
 * Depends on TreeStore for group lookup and creation.
 */
export class SequenceService {
    /** @type {import('./tree_store.js').TreeStore} */
    _treeStore = null;

    sequenceText = "";
    sequenceTokens = [];
    activeSequenceIndices = new Set();
    defaultGlyphs = new Map();
    sequenceOffsets = [];

    /** @private Cache for incremental syncTreeWithSequence */
    _prevInTextIds = null;   // Set of group IDs that were in sequence text at last sync (null = first call, do full sweep)
    _prevRootIds = null;     // Set of rootChildren IDs at last sync

    constructor(treeStore) {
        this._treeStore = treeStore;
    }

    // =========================================================================
    // AGL (Adobe Glyph List) name mapping
    // =========================================================================

    _getDisplayChar(char) {
        return getSequenceDisplayChar(char);
    }

    getAGLName(charStr) {
        if (!charStr) return null;
        const aglMap = {
            ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand', '\'': 'quotesingle', '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'hyphen', '.': 'period', '/': 'slash',
            '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
            ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at',
            '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', '_': 'underscore', '`': 'grave',
            '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde'
        };
        let chars = Array.from(charStr);
        let names = chars.map(c => {
            if (aglMap[c]) return aglMap[c];
            if (/^[a-zA-Z]$/.test(c)) return c;
            let cp = c.codePointAt(0);
            let hex = cp.toString(16).toUpperCase();
            if (cp <= 0xFFFF) return "uni" + hex.padStart(4, '0');
            else return "u" + hex.padStart(5, '0');
        });
        return names.join('_');
    }

    // =========================================================================
    // Parsing + character mapping
    // =========================================================================

    parseSequence(text) {
        const tokens = parseSequenceTokens(text, {
            resolveGroupByName: (name) => this._treeStore.getGroupByName(name),
            getDisplayChar: (char) => this._getDisplayChar(char)
        });
        // Post-process: merge consecutive character tokens that form a known
        // ligature charCode (multi-character string) in defaultGlyphs.
        // This allows sequence text like "fi" to resolve to a single group
        // whose charCode is "fi" instead of two separate groups for "f" and "i".
        return this._mergeLigatureTokens(tokens);
    }

    /**
     * Merge consecutive isChar tokens whose combined string matches a
     * ligature entry in defaultGlyphs. Picks the LONGEST possible match
     * so that if both "f" and "fi" exist as charCodes, "fi" wins.
     * @param {Array} tokens
     * @returns {Array}
     */
    _mergeLigatureTokens(tokens) {
        if (this.defaultGlyphs.size === 0) return tokens;
        const result = [];
        let i = 0;
        while (i < tokens.length) {
            if (tokens[i].isChar) {
                // Try to match the longest consecutive character sequence
                // that forms a known ligature charCode.
                let bestMatch = null;   // { composite, length }
                let composite = tokens[i].value;
                let j = i + 1;

                // Extend with consecutive isChar tokens
                while (j < tokens.length && tokens[j].isChar) {
                    composite += tokens[j].value;
                    if (this.defaultGlyphs.has(composite)) {
                        bestMatch = { composite, length: j - i + 1 };
                    }
                    j++;
                }

                if (bestMatch) {
                    result.push({
                        isChar: true,
                        value: bestMatch.composite,
                        raw: tokens.slice(i, i + bestMatch.length).map(t => t.raw).join(''),
                        display: bestMatch.composite
                    });
                    i += bestMatch.length;
                    continue;
                }
            }
            result.push(tokens[i]);
            i++;
        }
        return result;
    }

    rebuildDefaultGlyphs() {
        this.defaultGlyphs.clear();
        for (let [id, item] of this._treeStore.treeItems.entries()) {
            if (item.type === 'group' && item.parentId === null && !item.isRef && item.charCode) {
                this.defaultGlyphs.set(item.charCode, item.id);
            }
        }
    }

    getDefaultGroupForChar(char) {
        if (this.defaultGlyphs.has(char)) {
            let id = this.defaultGlyphs.get(char);
            if (this._treeStore.treeItems.has(id)) return id;
        }

        let aglName = this.getAGLName(char);
        let newId = this._treeStore.ensureUniqueName(aglName);
        this._treeStore.treeItems.set(newId, {
            id: newId, type: 'group', name: newId, charCode: char,
            parentId: null, children: [], isRef: false, refId: null, collapsed: false,
            hidden_by_sequence: false, advance: 1000, is_modified: false
        });
        this._treeStore.rootChildren.push(newId);
        this.defaultGlyphs.set(char, newId);
        return newId;
    }

    /** Remove a tree item's charCode mapping from defaultGlyphs, if any */
    _removeDefaultGlyphById(id) {
        const item = this._treeStore.treeItems.get(id);
        if (item && item.charCode) this.defaultGlyphs.delete(item.charCode);
    }

    // =========================================================================
    // Sequence update + offsets
    // =========================================================================

    updateSequenceParsing(activeSequenceIndices, syncTreeFn) {
        this.sequenceTokens = this.parseSequence(this.sequenceText);
        let newActive = new Set();
        for (let i of this.activeSequenceIndices) {
            if (i < this.sequenceTokens.length) newActive.add(i);
        }
        this.activeSequenceIndices = newActive;
        this.cleanupUnusedEmptyGroups();
        this.calculateSequenceOffsets();
        if (syncTreeFn) syncTreeFn();
    }

    cleanupUnusedEmptyGroups() {
        let referencedIds = new Set();
        for (let t of this.sequenceTokens) {
            if (t.isChar) {
                let id = this.defaultGlyphs.get(t.value);
                if (id) referencedIds.add(id);
            } else {
                referencedIds.add(t.value);
            }
        }

        for (let i = this._treeStore.rootChildren.length - 1; i >= 0; i--) {
            let id = this._treeStore.rootChildren[i];
            let item = this._treeStore.treeItems.get(id);

            if (item && item.type === 'group' && !item.isRef && item.children.length === 0) {
                if (!referencedIds.has(id) && !item.is_modified) {
                    if (item.charCode) this.defaultGlyphs.delete(item.charCode);
                    this._treeStore.treeItems.delete(id);
                    this._treeStore.rootChildren.splice(i, 1);
                }
            }
        }
    }

    setSequence(text) {
        this.sequenceText = text;
    }

    setSequenceState({ text, activeIndices } = {}) {
        const hasText = typeof text === 'string';
        const hasActive = activeIndices !== undefined;
        if (!hasText && !hasActive) return false;

        let changed = false;
        if (hasText && this.sequenceText !== text) {
            this.sequenceText = text;
            changed = true;
        }
        if (hasActive) {
            const nextSet = new Set(Array.isArray(activeIndices) ? activeIndices : Array.from(activeIndices || []));
            const prevSet = this.activeSequenceIndices || new Set();
            const sameSize = prevSet.size === nextSet.size;
            const sameItems = sameSize && Array.from(nextSet).every(i => prevSet.has(i));
            if (!sameItems) {
                this.activeSequenceIndices = nextSet;
                changed = true;
            }
        }
        return changed;
    }

    setActiveIndices(indicesSet) {
        this.activeSequenceIndices = indicesSet;
    }

    calculateSequenceOffsets() {
        this.sequenceOffsets = new Array(this.sequenceTokens.length).fill(0);
        let currentOffset = 0;
        for (let i = 0; i < this.sequenceTokens.length; i++) {
            this.sequenceOffsets[i] = currentOffset;
            let t = this.sequenceTokens[i];
            let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
            let group = this._treeStore.treeItems.get(gid);
            currentOffset += (group && group.advance !== undefined) ? group.advance : 1000;
        }
    }

    getSeqOffset(seqIndex) {
        if (seqIndex < 0 || seqIndex >= this.sequenceOffsets.length) return 0;
        return this.sequenceOffsets[seqIndex];
    }

    // =========================================================================
    // Sequence ↔ tree sync
    // =========================================================================

    syncTreeWithSequence(validateSelectionFn, syncTreeSelectionFn, notifySelectionInvalidatedFn, notifyTreeUpdateFn) {
        let activeReferencedIds = new Set();
        let allInTextIds = new Set();

        for (let i = 0; i < this.sequenceTokens.length; i++) {
            let t = this.sequenceTokens[i];
            let groupId = null;
            if (t.isChar) {
                groupId = this.getDefaultGroupForChar(t.value);
            } else {
                if (t.value !== null) {
                    groupId = t.value;
                } else {
                    let existing = this._treeStore.getGroupByName(t.name);
                    if (existing) {
                        groupId = existing.id;
                        t.value = groupId;
                    } else if (this.activeSequenceIndices.has(i)) {
                        let newName = this._treeStore.ensureUniqueName(t.name);
                        this._treeStore.treeItems.set(newName, {
                            id: newName, type: 'group', name: newName, charCode: null,
                            parentId: null, children: [], isRef: false, refId: null, collapsed: false,
                            hidden_by_sequence: false, advance: 1000, is_modified: false
                        });
                        this._treeStore.rootChildren.push(newName);
                        groupId = newName;
                        t.value = newName;
                    }
                }
            }

            if (groupId) {
                allInTextIds.add(groupId);
                if (this.activeSequenceIndices.has(i)) activeReferencedIds.add(groupId);
            }
        }

        // --- Incremental sync: diff against previous sync state ---
        // First call (_prevInTextIds === null): full sweep over all root groups.
        // Subsequent calls: only process entered/left groups + newly created groups.
        let toDelete = [];
        if (this._prevInTextIds === null) {
            // First sync — full sweep (happens once, typically on file load)
            for (let [id, item] of this._treeStore.treeItems.entries()) {
                if (item.type === 'group' && item.parentId === null) {
                    if (allInTextIds.has(item.id)) {
                        item.hidden_by_sequence = false;
                    } else {
                        item.hidden_by_sequence = true;
                        if (item.children.length === 0 && !item.isRef && !item.is_modified) toDelete.push(id);
                    }
                }
            }
        } else {
            // Incremental: process only groups that changed
            const prevInText = this._prevInTextIds;

            // Groups that entered the text → unhide
            for (const id of allInTextIds) {
                if (!prevInText.has(id)) {
                    const item = this._treeStore.treeItems.get(id);
                    if (item) item.hidden_by_sequence = false;
                }
            }

            // Groups that left the text → hide, maybe delete
            for (const id of prevInText) {
                if (!allInTextIds.has(id)) {
                    const item = this._treeStore.treeItems.get(id);
                    if (item && item.type === 'group' && item.parentId === null) {
                        item.hidden_by_sequence = true;
                        if (item.children.length === 0 && !item.isRef && !item.is_modified) toDelete.push(id);
                    }
                }
            }

            // Handle newly created root groups (none in prev nor current text)
            const rootLen = this._treeStore.rootChildren.length;
            if (this._prevRootIds === null || this._prevRootIds.size !== rootLen) {
                const prevRoot = this._prevRootIds ?? new Set();
                for (const id of this._treeStore.rootChildren) {
                    if (!prevRoot.has(id) && !allInTextIds.has(id)) {
                        const item = this._treeStore.treeItems.get(id);
                        if (item && item.type === 'group' && !item.isRef) {
                            item.hidden_by_sequence = true;
                            if (item.children.length === 0 && !item.is_modified) toDelete.push(id);
                        }
                    }
                }
            }
        }
        toDelete.forEach(id => { this._removeDefaultGlyphById(id); this._treeStore.deleteTreeItem(id); });

        // Update caches for next incremental call (after toDelete so _prevRootIds reflects current rootChildren)
        this._prevInTextIds = new Set(allInTextIds);
        this._prevRootIds = new Set(this._treeStore.rootChildren);

        const newActiveIndices = new Set();
        for (let i of this.activeSequenceIndices) {
            const token = this.sequenceTokens[i];
            if (!token) continue;
            const gid = token.isChar ? this.getDefaultGroupForChar(token.value) : token.value;
            const gitem = gid ? this._treeStore.treeItems.get(gid) : null;
            if (!gitem || gitem.locked === true) continue;
            newActiveIndices.add(i);
        }
        this.activeSequenceIndices = newActiveIndices;

        if (validateSelectionFn && validateSelectionFn()) {
            if (syncTreeSelectionFn) syncTreeSelectionFn();
            if (notifySelectionInvalidatedFn) notifySelectionInvalidatedFn();
        }
        if (notifyTreeUpdateFn) notifyTreeUpdateFn();
    }

    ensureActiveGroup(activeGroupId) {
        if (activeGroupId && this._treeStore.treeItems.has(activeGroupId)) {
            let rootId = this._treeStore.getRootGroupId(activeGroupId);
            let rootItem = this._treeStore.treeItems.get(rootId);
            if (rootItem && !rootItem.hidden_by_sequence) return activeGroupId;
        }

        if (this.activeSequenceIndices.size > 0) {
            let sortedActive = Array.from(this.activeSequenceIndices).sort((a, b) => a - b);
            let firstIdx = sortedActive.find(i => i < this.sequenceTokens.length);
            if (firstIdx !== undefined) {
                let token = this.sequenceTokens[firstIdx];
                let gid = token.isChar ? this.getDefaultGroupForChar(token.value) : token.value;
                return gid;
            }
        }

        // No active indices — fall back to first non-locked group in sequence tokens
        for (let i = 0; i < this.sequenceTokens.length; i++) {
            let token = this.sequenceTokens[i];
            let gid = token.isChar ? this.getDefaultGroupForChar(token.value) : token.value;
            if (gid) {
                let item = this._treeStore.treeItems.get(gid);
                if (item && !item.locked) {
                    this.activeSequenceIndices.add(i);
                    return gid;
                }
            }
        }

        // Last resort: any non-locked group in the tree
        for (let item of this._treeStore.treeItems.values()) {
            if (item.type === 'group' && !item.locked && !item.isRef) {
                let rootId = this._treeStore.getRootGroupId(item.id);
                let rootItem = this._treeStore.treeItems.get(rootId);
                if (rootItem && !rootItem.hidden_by_sequence) return item.id;
            }
        }
        return null;
    }
}
