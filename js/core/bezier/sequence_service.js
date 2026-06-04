// js/core/bezier/sequence_service.js — 序列文本解析、字符映射、偏移计算
import { getSequenceDisplayChar } from '../../domain/sequence/sequence_display.js';
import { parseSequenceTokens } from '../../domain/sequence/sequence_tokenizer.js';

/**
 * SequenceService：管理序列文本、token 解析、字符→分组映射、偏移量计算。
 * 依赖 TreeStore 做分组查找与创建。
 */
export class SequenceService {
    /** @type {import('./tree_store.js').TreeStore} */
    _treeStore = null;

    sequenceText = "";
    sequenceTokens = [];
    activeSequenceIndices = new Set();
    defaultGlyphs = new Map();
    sequenceOffsets = [];

    constructor(treeStore) {
        this._treeStore = treeStore;
    }

    // =========================================================================
    // AGL（Adobe Glyph List）名称映射
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
    // 解析 + 字符映射
    // =========================================================================

    parseSequence(text) {
        return parseSequenceTokens(text, {
            resolveGroupByName: (name) => this._treeStore.getGroupByName(name),
            getDisplayChar: (char) => this._getDisplayChar(char)
        });
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

    // =========================================================================
    // 序列更新 + 偏移
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

        let deletedAny = false;
        for (let i = this._treeStore.rootChildren.length - 1; i >= 0; i--) {
            let id = this._treeStore.rootChildren[i];
            let item = this._treeStore.treeItems.get(id);

            if (item && item.type === 'group' && !item.isRef && item.children.length === 0) {
                if (!referencedIds.has(id) && !item.is_modified) {
                    this._treeStore.treeItems.delete(id);
                    this._treeStore.rootChildren.splice(i, 1);
                    deletedAny = true;
                }
            }
        }

        if (deletedAny) this.rebuildDefaultGlyphs();
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
        if (seqIndex <= 0 || seqIndex >= this.sequenceOffsets.length) return 0;
        return this.sequenceOffsets[seqIndex];
    }

    // =========================================================================
    // 序列 ↔ 树同步
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

        let toDelete = [];
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
        toDelete.forEach(id => this._treeStore.deleteTreeItem(id));

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
        return null;
    }
}
