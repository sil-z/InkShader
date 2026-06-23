// js/core/bezier/snapshot_serializer.js — 快照序列化/反序列化（JSON I/O）
import { Curve } from './curve.js';
import { CurveNode } from './node.js';
/**
 * SnapshotSerializer：负责文件格式的导入/导出、快照对象的反序列化重建。
 * 依赖 CurveStore（节点重建）和 TreeStore（树结构重建）。
 */
export class SnapshotSerializer {
    /** @type {import('./curve_store.js').CurveStore} */
    _curveStore = null;
    /** @type {import('./tree_store.js').TreeStore} */
    _treeStore = null;
    /** @type {import('./sequence_service.js').SequenceService} */
    _sequenceService = null;
    constructor(curveStore, treeStore, sequenceService) {
        this._curveStore = curveStore;
        this._treeStore = treeStore;
        this._sequenceService = sequenceService;
    }
    _reportMessage(level, message, messageReporter) {
        if (messageReporter) {
            messageReporter(level, message);
            return;
        }
        if (level === 'error') console.error(message);
        else console.warn(message);
    }
    // =========================================================================
    // 导入
    // =========================================================================
    async loadFromJSON(jsonStr, messageReporter) {
        if (!jsonStr) return;
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            this._reportMessage('warn', "Warning: The JSON file format appears corrupted. The editor will attempt a relaxed parse to recover your data.", messageReporter);
            try {
                let relaxedJson = jsonStr.replace(/,\s*([\]}])/g, '$1');
                data = JSON.parse(relaxedJson);
            } catch (e2) {
                this._reportMessage('error', "Critical Error: The file is completely unreadable or severely damaged.", messageReporter);
                return;
            }
        }
        await this.loadFromSnapshotObject(data, messageReporter);
    }
    async loadFromSnapshotObject(data, messageReporter) {
        if (!data) return;
        this._treeStore.initTree();
        this._curveStore.curves = [];
        this._curveStore.domMap.clear();
        this._sequenceService.sequenceText = data.editor_sequence || '';
        if (data.editor_active_indices) {
            this._sequenceService.activeSequenceIndices = new Set(data.editor_active_indices);
        }
        this._sequenceService.defaultGlyphs.clear();
        if (data.editor_default_glyphs) {
            for (let [charCode, groupName] of Object.entries(data.editor_default_glyphs)) {
                this._sequenceService.defaultGlyphs.set(charCode, groupName);
            }
        }
        let hasPartialErrors = false;
        if (data.components) {
            for (let compKey in data.components) {
                try {
                    let comp = data.components[compKey];
                    let gid = comp.name || compKey;
                    this._reconstructGroup(gid, comp, null, comp.char_code || null);
                } catch (e) {
                    hasPartialErrors = true;
                }
            }
        }
        if (data.ch) {
            for (let charKey in data.ch) {
                try {
                    let charData = data.ch[charKey];
                    let gid = charData.name || charKey;
                    let charCode = charData.char_code !== undefined ? charData.char_code : charKey;
                    this._reconstructGroup(gid, charData, null, charCode);
                } catch (e) {
                    hasPartialErrors = true;
                }
            }
        }
        if (hasPartialErrors) this._reportMessage('warn', "Notice: Some parts of the file were corrupted and have been skipped.", messageReporter);
        if (Array.isArray(data.editor_root_order)) {
            this._treeStore.applyTreeChildOrder(null, data.editor_root_order);
        }
        this._sequenceService.rebuildDefaultGlyphs();
        this._sequenceService.updateSequenceParsing();
        this._sequenceService.syncTreeWithSequence(null, null, null, () => this._treeStore.notifyTreeUpdate());
    }
    _reconstructGroup(gid, gData, parentId, charCode = null) {
        this._treeStore.treeItems.set(gid, {
            id: gid, type: 'group', name: gData.name || gid, charCode: charCode, parentId: parentId,
            children: [], isRef: false, advance: gData.advance !== undefined ? gData.advance : 1000,
            locked: gData.locked === true,
            visible: gData.visible !== false,
            is_modified: true
        });
        if (!parentId) this._treeStore.rootChildren.push(gid);
        if (charCode !== null && !gData.isRef) {
            if (!this._sequenceService.defaultGlyphs.has(charCode)) {
                this._sequenceService.defaultGlyphs.set(charCode, gid);
            }
        }
        if (gData.paths) {
            for (let pathName in gData.paths) {
                try {
                    const pData = gData.paths[pathName];
                    const uniqueCurveId = this._treeStore.ensureUniqueName(pathName);
                    this._curveStore.reconstructCurveFromSnapshotData(uniqueCurveId, pData, gid);
                    const itemId = uniqueCurveId;
                    this._treeStore.treeItems.set(itemId, {
                        id: itemId, type: 'curve', curveId: uniqueCurveId, name: uniqueCurveId, parentId: gid,
                        locked: pData.locked === true,
                        visible: pData.visible !== false
                    });
                    this._treeStore.treeItems.get(gid).children.push(itemId);
                } catch (e) { /* skip corrupted path */ }
            }
        }
        if (gData.components) {
            for (let refName in gData.components) {
                try {
                    const rData = gData.components[refName];
                    const matrix = Array.isArray(rData.transform) ? new DOMMatrix(rData.transform) : new DOMMatrix();
                    const uniqueRefName = this._treeStore.ensureUniqueName(refName);
                    this._treeStore.treeItems.set(uniqueRefName, {
                        id: uniqueRefName, type: 'group', name: uniqueRefName, parentId: gid,
                        children: [], isRef: true, refId: rData.component_id, transform: matrix,
                        locked: rData.locked === true,
                        visible: rData.visible !== false
                    });
                    this._treeStore.treeItems.get(gid).children.push(uniqueRefName);
                } catch (e) { /* skip corrupted ref */ }
            }
        }
        this._treeStore.applyTreeChildOrder(gid, gData.tree_child_order);
    }
    // =========================================================================
    // 增量替换（undo/redo 补丁）
    // =========================================================================
    replacePathFromSnapshotData(groupName, pathName, pData) {
        const group = this._treeStore.getGroupByName(groupName);
        if (!group || !pData) return false;
        const gid = group.id;
        for (const childId of [...(group.children || [])]) {
            const child = this._treeStore.treeItems.get(childId);
            if (child?.type === "curve" && child.name === pathName) {
                this._treeStore.deleteSingleObject(childId);
            }
        }
        try {
            const uniqueCurveId = this._treeStore.ensureUniqueName(pathName);
            this._curveStore.reconstructCurveFromSnapshotData(uniqueCurveId, pData, gid);
            const itemId = uniqueCurveId;
            this._treeStore.treeItems.set(itemId, {
                id: itemId, type: "curve", curveId: uniqueCurveId, name: pathName, parentId: gid,
                locked: pData.locked === true,
                visible: pData.visible !== false
            });
            group.children.push(itemId);
            this._treeStore.groupFlatCache.clear();
            return true;
        } catch (e) {
            return false;
        }
    }
    // =========================================================================
    // 导出
    // =========================================================================
    exportJSON(editorState) {
        let file = {
            "version": "1.0", "canvas_size_width": editorState.canvas_size_width, "canvas_size_height": editorState.canvas_size_height,
            "editor_guideline_h": editorState.guidelines_h || [], "editor_guideline_v": editorState.guidelines_v || [],
            "editor_guideline_lock": editorState.guideline_lock || false,
            "editor_user_guidelines": (editorState.user_guidelines || []).map(g => ({ id: g.id, type: g.type, x: g.x, y: g.y, angle: g.angle || 0 })),
            "editor_sequence": this._sequenceService.sequenceText,
            "editor_active_indices": Array.from(this._sequenceService.activeSequenceIndices),
            "editor_fill_color": editorState.fill_color, "editor_stroke_color": editorState.stroke_color,
            "family_name": "InkShader_Default_Font", "project_name": "", "basic_spacing": 1000, "ch": {}, "components": {}
        };
        const serializeCurve = (curve) => {
            let pathData = {
                "closed": curve.closed, "stroke_width": curve.stroke_width, "smart_stroke": curve.smart_stroke,
                "smart_stroke_clockwise": curve.smart_stroke_clockwise !== false,
                "show_skeleton": curve.show_skeleton, "visible": curve.visible !== false, "locked": curve.locked === true,
                "render_mode": "auto", "vertices": {}
            };
            let current = curve.startNode; let order = 0;
            while (current) {
                let cleanNodeId = current.node_id || `n_${Date.now().toString(36)}_${Math.floor(Math.random() * 10000)}`;
                pathData.vertices[cleanNodeId] = {
                    "order": order, "node_id": cleanNodeId, "x": current.x, "y": current.y,
                    "start": current === curve.startNode, "end": current === curve.endNode,
                    "smooth": current.control_mode === 1 || current.control_mode === 2, "control_mode": current.control_mode,
                    "relate_last": null, "relate_next": null,
                    "control_1": { "active": current.control1 !== null, "x": current.control1 ? current.control1.x : current.x, "y": current.control1 ? current.control1.y : current.y },
                    "control_2": { "active": current.control2 !== null, "x": current.control2 ? current.control2.x : current.x, "y": current.control2 ? current.control2.y : current.y }
                };
                order++; current = current.nextOnCurve;
            }
            return pathData;
        };
        const serializeGroup = (groupItem) => {
            let result = {
                "original_id": groupItem.name, "name": groupItem.name, "char_code": groupItem.charCode,
                "advance": groupItem.advance !== undefined ? groupItem.advance : 1000, "paths": {}, "components": {},
                "locked": groupItem.locked === true,
                "visible": groupItem.visible !== false,
                "tree_child_order": groupItem.children
                    .map((cid) => this._treeStore.treeItems.get(cid)?.name || cid)
                    .filter(Boolean)
            };
            for (let childId of groupItem.children) {
                let child = this._treeStore.treeItems.get(childId);
                if (!child) continue;
                if (child.type === 'curve') {
                    let curve = this._curveStore.curves.find(c => c.id === child.curveId);
                    if (curve) result.paths[child.name] = serializeCurve(curve);
                } else if (child.type === 'group') {
                    if (child.isRef) {
                        let targetGroup = this._treeStore.treeItems.get(child.refId);
                        result.components[child.name] = {
                            "component_id": targetGroup ? targetGroup.name : child.refId,
                            "transform": [1, 0, 0, 1, child.transform.e, child.transform.f],
                            "visible": child.visible !== false, "locked": child.locked === true
                        };
                    } else {
                        result.components[child.name] = { "component_id": child.name, "transform": [1, 0, 0, 1, 0, 0] };
                    }
                }
            }
            return result;
        };
        file.editor_root_order = this._treeStore.rootChildren
            .map((cid) => this._treeStore.treeItems.get(cid)?.name || cid)
            .filter(Boolean);
        for (let [id, item] of this._treeStore.treeItems.entries()) {
            if (item.type === 'group' && !item.isRef && item.parentId === null) {
                let serializedData = serializeGroup(item);
                if (item.charCode !== null && item.charCode !== undefined) file.ch[item.name] = serializedData;
                else file.components[item.name] = serializedData;
            }
        }
        return JSON.stringify(file, null, 4);
    }
}
