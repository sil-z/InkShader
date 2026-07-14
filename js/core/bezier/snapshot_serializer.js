// js/core/bezier/snapshot_serializer.js — Snapshot serialization/deserialization (JSON I/O)
import { Curve } from './curve.js';
import { CurveNode } from './node.js';

const CONTROL_MODE_TO_STR = { 0: "corner", 1: "smooth", 2: "symmetric" };
const CONTROL_MODE_FROM_STR = Object.fromEntries(
    Object.entries(CONTROL_MODE_TO_STR).map(([k, v]) => [v, Number(k)])
);
/**
 * SnapshotSerializer: handles file format import/export, snapshot object deserialization and reconstruction.
 * Depends on CurveStore (node reconstruction) and TreeStore (tree structure reconstruction).
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
    // Import
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
        let hasPartialErrors = false;
        if (data.glyphs) {
            for (let groupName in data.glyphs) {
                if (Object.prototype.hasOwnProperty.call(data.glyphs, groupName)) {
                    try {
                        const gData = data.glyphs[groupName];
                        const gid = gData.name || groupName;
                        const charCode = gData.char_code !== undefined ? gData.char_code : null;
                        this._reconstructGroup(gid, gData, null, charCode);
                    } catch (e) {
                        hasPartialErrors = true;
                    }
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
        if (gData.children) {
            for (let childIdx = 0; childIdx < gData.children.length; childIdx++) {
                try {
                    const child = gData.children[childIdx];
                    if (child.type === 'path') {
                        const uniqueCurveId = this._treeStore.ensureUniqueName(child.name);
                        this._curveStore.reconstructCurveFromSnapshotData(uniqueCurveId, child, gid);
                        this._treeStore.treeItems.set(uniqueCurveId, {
                            id: uniqueCurveId, type: 'curve', curveId: uniqueCurveId, name: uniqueCurveId, parentId: gid,
                            locked: child.locked === true,
                            visible: child.visible !== false
                        });
                        this._treeStore.treeItems.get(gid).children.push(uniqueCurveId);
                    } else if (child.type === 'component') {
                        const matrix = Array.isArray(child.transform) ? new DOMMatrix(child.transform) : new DOMMatrix();
                        const uniqueRefName = this._treeStore.ensureUniqueName(child.name);
                        this._treeStore.treeItems.set(uniqueRefName, {
                            id: uniqueRefName, type: 'group', name: uniqueRefName, parentId: gid,
                            children: [], isRef: true, refId: child.component_id, transform: matrix,
                            locked: child.locked === true,
                            visible: child.visible !== false
                        });
                        this._treeStore.treeItems.get(gid).children.push(uniqueRefName);
                    }
                } catch (e) { /* skip corrupted child */ }
            }
        }
    }
    // =========================================================================
    // Incremental replacement (undo/redo patch)
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
    // Export
    // =========================================================================
    exportJSON(editorState, extraState = {}) {
        const { prevGlyphs, dirtyGlyphs } = extraState;
        const fontSettings = editorState.font_settings || {};
        let file = {
            "version": "1.0",
            "editor_guidelines": (editorState.guidelines || []).map(g => ({
                id: g.id, x: g.x, y: g.y, angle: g.angle
            })),
            "editor_guideline_lock": editorState.guideline_lock || false,
            "editor_sequence": this._sequenceService.sequenceText,
            "editor_active_indices": Array.from(this._sequenceService.activeSequenceIndices),
            "family_name": fontSettings.family || "InkShader_Default_Font",
            "project_name": fontSettings.project_name || "",
            "basic_spacing": fontSettings.basic_spacing ?? 1000,
            "font_style": fontSettings.style || "Regular",
            "postscript_name": fontSettings.postscript_name || "",
            "preferred_family": fontSettings.preferred_family || "",
            "preferred_subfamily": fontSettings.preferred_subfamily || "",
            "copyright": fontSettings.copyright || "",
            "designer": fontSettings.designer || "",
            "designer_url": fontSettings.designer_url || "",
            "manufacturer": fontSettings.manufacturer || "",
            "manufacturer_url": fontSettings.manufacturer_url || "",
            "license": fontSettings.license || "",
            "license_url": fontSettings.license_url || "",
            "trademark": fontSettings.trademark || "",
            "description": fontSettings.description || "",
            "sample_text": fontSettings.sample_text || "",
            "upm": fontSettings.upm ?? 1000,
            "weight_class": fontSettings.weight_class ?? 400,
            "width_class": fontSettings.width_class ?? 5,
            "ascender": fontSettings.ascender ?? 800,
            "descender": fontSettings.descender ?? -200,
            "x_height": fontSettings.x_height ?? 500,
            "cap_height": fontSettings.cap_height ?? 700,
            "font_version": fontSettings.version || "1.0",
            "glyphs": {}
        };
        const serializeVertices = (curve) => {
            const vertices = [];
            let current = curve.startNode;
            while (current) {
                const v = {
                    "x": current.x, "y": current.y,
                    "control_mode": CONTROL_MODE_TO_STR[current.control_mode] ?? "corner"
                };
                if (current.control1) {
                    v.control_1 = { "x": current.control1.x, "y": current.control1.y };
                }
                if (current.control2) {
                    v.control_2 = { "x": current.control2.x, "y": current.control2.y };
                }
                vertices.push(v);
                current = current.nextOnCurve;
            }
            return vertices;
        };
        const serializeChildren = (groupItem) => {
            const children = [];
            for (let childId of groupItem.children) {
                let child = this._treeStore.treeItems.get(childId);
                if (!child) continue;
                if (child.type === 'curve') {
                    let curve = this._curveStore.curves.find(c => c.id === child.curveId);
                    if (curve) {
                        children.push({
                            "type": "path",
                            "name": child.name,
                            "closed": curve.closed,
                            "stroke_width": curve.stroke_width,
                            "smart_stroke": curve.smart_stroke,
                            "smart_stroke_clockwise": curve.smart_stroke_clockwise !== false,
                            "show_skeleton": curve.show_skeleton,
                            "visible": curve.visible !== false,
                            "locked": curve.locked === true,
                            "vertices": serializeVertices(curve)
                        });
                    }
                } else if (child.type === 'group') {
                    if (child.isRef) {
                        let targetGroup = this._treeStore.treeItems.get(child.refId);
                        children.push({
                            "type": "component",
                            "name": child.name,
                            "component_id": targetGroup ? targetGroup.name : child.refId,
                            "transform": [1, 0, 0, 1, child.transform.e, child.transform.f],
                            "visible": child.visible !== false,
                            "locked": child.locked === true
                        });
                    } else {
                        children.push({
                            "type": "component",
                            "name": child.name,
                            "component_id": child.name,
                            "transform": [1, 0, 0, 1, 0, 0],
                            "visible": child.visible !== false,
                            "locked": child.locked === true
                        });
                    }
                }
            }
            return children;
        };
        file.editor_root_order = this._treeStore.rootChildren
            .map((cid) => this._treeStore.treeItems.get(cid)?.name || cid)
            .filter(Boolean);
        const hasPrevGlyphs = prevGlyphs && typeof prevGlyphs === 'object' && !Array.isArray(prevGlyphs);
        const hasDirtyGlyphs = dirtyGlyphs && dirtyGlyphs instanceof Set && dirtyGlyphs.size > 0;
        const useIncremental = hasPrevGlyphs;

        for (let [id, item] of this._treeStore.treeItems.entries()) {
            if (item.type === 'group' && !item.isRef && item.parentId === null) {
                if (useIncremental && !hasDirtyGlyphs && prevGlyphs[item.name] !== undefined) {
                    // No dirty glyphs at all — reuse every glyph from previous snapshot
                    file.glyphs[item.name] = prevGlyphs[item.name];
                } else if (useIncremental && hasDirtyGlyphs && !dirtyGlyphs.has(item.name) && prevGlyphs[item.name] !== undefined) {
                    // This specific glyph is clean — reuse its previous snapshot data
                    file.glyphs[item.name] = prevGlyphs[item.name];
                } else {
                    file.glyphs[item.name] = {
                        "name": item.name,
                        "char_code": item.charCode,
                        "advance": item.advance !== undefined ? item.advance : 1000,
                        "locked": item.locked === true,
                        "visible": item.visible !== false,
                        "children": serializeChildren(item)
                    };
                }
            }
        }
        return JSON.stringify(file, null, 4);
    }
}
