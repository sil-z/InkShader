/**
 * Applies snapshotPatches to CurveManager / canvas runtime (avoiding full undo/redo loadFromJSON).
 * Uses snapshotObj (with JSON patches applied) as source of truth; path-level/group-level resync covers structural changes like node insert/delete.
 */
import { CurveNode } from "../../core/bezier/node.js";
const GROUP_ROOT_KEYS = new Set(["glyphs"]);
const CONTROL_MODE_FROM_STR = { "corner": 0, "smooth": 1, "symmetric": 2 };
const FONT_SNAPSHOT_KEYS = new Set([
    "family_name",
    "project_name",
    "basic_spacing",
    "font_style",
    "postscript_name",
    "preferred_family",
    "preferred_subfamily",
    "copyright",
    "designer",
    "designer_url",
    "manufacturer",
    "manufacturer_url",
    "license",
    "license_url",
    "trademark",
    "description",
    "sample_text",
    "upm",
    "weight_class",
    "width_class",
    "ascender",
    "descender",
    "x_height",
    "cap_height",
    "font_version"
]);

function snapshotString(snapshotObj, key, fallback, defaultValue = "") {
    return Object.prototype.hasOwnProperty.call(snapshotObj, key) ? snapshotObj[key] : fallback ?? defaultValue;
}

function snapshotNumber(snapshotObj, key, fallback, defaultValue) {
    if (!Object.prototype.hasOwnProperty.call(snapshotObj, key)) return fallback ?? defaultValue;
    const value = Number(snapshotObj[key]);
    return Number.isFinite(value) ? value : fallback ?? defaultValue;
}

function fontSettingsFromSnapshot(snapshotObj = {}, fallback = {}) {
    return {
        family: snapshotString(snapshotObj, "family_name", fallback.family, "InkShader Default Font"),
        style: snapshotString(snapshotObj, "font_style", fallback.style, "Regular"),
        postscript_name: snapshotString(snapshotObj, "postscript_name", fallback.postscript_name),
        preferred_family: snapshotString(snapshotObj, "preferred_family", fallback.preferred_family),
        preferred_subfamily: snapshotString(snapshotObj, "preferred_subfamily", fallback.preferred_subfamily),
        copyright: snapshotString(snapshotObj, "copyright", fallback.copyright),
        designer: snapshotString(snapshotObj, "designer", fallback.designer),
        designer_url: snapshotString(snapshotObj, "designer_url", fallback.designer_url),
        manufacturer: snapshotString(snapshotObj, "manufacturer", fallback.manufacturer),
        manufacturer_url: snapshotString(snapshotObj, "manufacturer_url", fallback.manufacturer_url),
        license: snapshotString(snapshotObj, "license", fallback.license),
        license_url: snapshotString(snapshotObj, "license_url", fallback.license_url),
        trademark: snapshotString(snapshotObj, "trademark", fallback.trademark),
        description: snapshotString(snapshotObj, "description", fallback.description),
        sample_text: snapshotString(snapshotObj, "sample_text", fallback.sample_text),
        upm: snapshotNumber(snapshotObj, "upm", fallback.upm, 1000),
        weight_class: snapshotNumber(snapshotObj, "weight_class", fallback.weight_class, 400),
        width_class: snapshotNumber(snapshotObj, "width_class", fallback.width_class, 5),
        ascender: snapshotNumber(snapshotObj, "ascender", fallback.ascender, 800),
        descender: snapshotNumber(snapshotObj, "descender", fallback.descender, -200),
        x_height: snapshotNumber(snapshotObj, "x_height", fallback.x_height, 500),
        cap_height: snapshotNumber(snapshotObj, "cap_height", fallback.cap_height, 700),
        version: snapshotString(snapshotObj, "font_version", fallback.version, "1.0"),
        project_name: snapshotString(snapshotObj, "project_name", fallback.project_name),
        basic_spacing: snapshotNumber(snapshotObj, "basic_spacing", fallback.basic_spacing, 1000)
    };
}
function patchValue(patch, direction) {
    const applyReverse = direction === "undo";
    return {
        shouldExist: applyReverse ? patch.oldExists : patch.newExists,
        value: applyReverse ? patch.oldValue : patch.newValue
    };
}
function getGroupDataFromSnapshot(snapshotObj, groupName) {
    return snapshotObj?.glyphs?.[groupName] ?? null;
}
function getPathDataFromSnapshot(snapshotObj, groupName, pathName) {
    const group = getGroupDataFromSnapshot(snapshotObj, groupName);
    if (!group?.children) return null;
    return group.children.find(c => c.type === 'path' && c.name === pathName) ?? null;
}
function findCurveByGroupAndPathName(cm, groupName, pathName) {
    const group = cm.getGroupByName(groupName);
    if (!group) return null;
    for (const childId of group.children || []) {
        const child = cm.treeItems.get(childId);
        if (child?.type !== "curve") continue;
        if (child.name === pathName || child.curveId === pathName || child.id === pathName) {
            return cm.curves.find((c) => c.id === child.curveId) || null;
        }
    }
    return null;
}
function findMainNodeByVertexKey(curve, vertexKey) {
    if (!curve?.startNode) return null;
    // If vertexKey is a number (array index), walk to that position
    if (typeof vertexKey === 'number') {
        let current = curve.startNode;
        let idx = 0;
        while (current) {
            if (idx === vertexKey) return current;
            idx++;
            current = current.nextOnCurve;
        }
        return null;
    }
    if (!vertexKey) return null;
    let current = curve.startNode;
    while (current) {
        const nodeId = current.node_id;
        const markerId = current.main_node?.id;
        if (
            nodeId === vertexKey ||
            markerId === vertexKey ||
            (nodeId && `m_${nodeId}` === vertexKey) ||
            (markerId && markerId.replace(/^m_/, "") === vertexKey)
        ) {
            return current;
        }
        current = current.nextOnCurve;
    }
    return null;
}
function deleteRootGroupByName(cm, groupName) {
    const group = cm.getGroupByName(groupName);
    if (!group) return true;
    return cm.deleteSingleObject(group.id);
}
function reconstructRootGroup(cm, groupName, groupData) {
    if (!groupData || typeof groupData !== "object") return false;
    const existing = cm.getGroupByName(groupName);
    if (existing) cm.deleteSingleObject(existing.id);
    const charCode = groupData.char_code ?? null;
    cm._reconstructGroup(groupName, groupData, null, charCode);
    return true;
}
/** Rebuild runtime curve from full path data in snapshot (insert/delete nodes, vertices table replacement) */
function resyncPathFromSnapshot(cm, snapshotObj, groupName, pathName) {
    const pathData = getPathDataFromSnapshot(snapshotObj, groupName, pathName);
    if (!pathData) {
        const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
        if (!curve) return true;
        const treeItem = Array.from(cm.treeItems.values()).find(
            (item) => item.type === "curve" && item.curveId === curve.id
        );
        return treeItem ? cm.deleteSingleObject(treeItem.id) : true;
    }
    return cm.replacePathFromSnapshotData(groupName, pathName, pathData);
}
/** Rebuild group from full snapshot data (delete objects, components reference changes, etc.) */
function resyncGroupFromSnapshot(cm, snapshotObj, groupName) {
    const groupData = getGroupDataFromSnapshot(snapshotObj, groupName);
    if (!groupData) return deleteRootGroupByName(cm, groupName);
    return reconstructRootGroup(cm, groupName, groupData);
}
function resyncFromSnapshotForPath(cm, snapshotObj, path) {
    if (!Array.isArray(path) || path.length < 2 || !GROUP_ROOT_KEYS.has(path[0])) return false;
    const groupName = path[1];
    if (typeof groupName !== "string") return false;
    // ["glyphs", "groupName"] — full group resync
    if (path.length === 2) {
        return resyncGroupFromSnapshot(cm, snapshotObj, groupName);
    }
    // ["glyphs", "groupName", "advance"] — just update advance
    if (path.length === 3 && path[2] === "advance") {
        const group = cm.getGroupByName(groupName);
        const groupData = getGroupDataFromSnapshot(snapshotObj, groupName);
        if (!group || !groupData) return false;
        group.advance = groupData.advance;
        group.is_modified = true;
        return true;
    }
    // ["glyphs", "groupName", "children", "pathName"] — path resync
    if (path.length >= 4 && path[2] === "children" && typeof path[3] === "string") {
        return resyncPathFromSnapshot(cm, snapshotObj, groupName, path[3]);
    }
    // ["glyphs", "groupName", "children"] — full group resync (children replaced)
    if (path.length === 3 && path[2] === "children") {
        return resyncGroupFromSnapshot(cm, snapshotObj, groupName);
    }
    return false;
}
function patchTouchesGroupStructure(path) {
    if (!Array.isArray(path) || path.length < 2 || !GROUP_ROOT_KEYS.has(path[0])) return false;
    if (path.length === 2) return true;
    const seg = path[2];
    return seg === "children" || seg === "advance";
}
function collectTouchedGroupsFromPatches(patches) {
    const keys = new Set();
    for (const patch of patches) {
        const path = patch?.path;
        if (!patchTouchesGroupStructure(path)) continue;
        if (typeof path[1] === "string") keys.add(`glyphs:${path[1]}`);
    }
    return keys;
}
/** Sync all group children order from snapshot authoritative state (patch order independent) */
export function syncTreeHierarchyFromSnapshot(cm, snapshotObj) {
    if (!cm || !snapshotObj) return;
    const groups = snapshotObj.glyphs;
    if (groups && typeof groups === "object") {
        for (const groupName of Object.keys(groups)) {
            const gData = groups[groupName];
            const group = cm.getGroupByName(groupName);
            if (!group) continue;
            // For runtime tree, child order is maintained by the children array during reconstruction.
            // The applyTreeChildOrder call uses the runtime tree's existing order from _reconstructGroup.
        }
    }
    if (Array.isArray(snapshotObj.editor_root_order)) {
        cm.applyTreeChildOrder(null, snapshotObj.editor_root_order);
    }
}
function resyncTouchedGroupsFromSnapshot(cm, snapshotObj, patches) {
    const keys = collectTouchedGroupsFromPatches(patches);
    for (const key of keys) {
        const sep = key.indexOf(":");
        const groupName = key.slice(sep + 1);
        resyncGroupFromSnapshot(cm, snapshotObj, groupName);
    }
}
function applyVertexField(node, field, value) {
    if (!node) return false;
    if (field === "x" || field === "y") {
        node[field] = value;
        return true;
    }
    if (field === "control_mode") {
        node.control_mode = typeof value === "string"
            ? (CONTROL_MODE_FROM_STR[value] ?? 0)
            : value;
        return true;
    }
    if (field === "smooth") {
        node.control_mode = value ? 1 : 0;
        return true;
    }
    return false;
}
function ensureControlHandle(node, curve, cm, controlKey, subField, value) {
    if (!node || !curve) return false;
    let control = controlKey === "control_1" ? node.control1 : controlKey === "control_2" ? node.control2 : null;
    if (!control) {
        const nId =
            node.node_id ||
            node.main_node?.id?.replace(/^m_/, "") ||
            `n_${Date.now().toString(36)}`;
        const markerId = controlKey === "control_1" ? `c1_${nId}` : `c2_${nId}`;
        const marker = { id: markerId };
        const x = subField === "x" ? value : node.x;
        const y = subField === "y" ? value : node.y;
        control = new CurveNode(marker, null, x, y, node, null, markerId);
        control.curve = curve;
        curve.domMap.set(marker, control);
        cm.domMap.set(marker, control);
        if (controlKey === "control_1") node.control1 = control;
        else node.control2 = control;
        return true;
    }
    if (subField === "x" || subField === "y") {
        control[subField] = value;
        return true;
    }
    if (subField === "active") {
        if (!value) {
            if (controlKey === "control_1") node.control1 = null;
            else node.control2 = null;
        }
        return true;
    }
    return false;
}
function applyEditorField(canvas, cm, path, value, shouldExist) {
    const key = path[0];
    if (!shouldExist) return true;
    switch (key) {
        case "editor_root_order":
            if (Array.isArray(value)) {
                cm.applyTreeChildOrder(null, value);
                return true;
            }
            return false;
        case "editor_sequence":
            cm.sequenceText = value || "";
            cm.updateSequenceParsing();
            return true;
        case "editor_active_indices":
            cm.activeSequenceIndices = new Set(Array.isArray(value) ? value : []);
            cm.calculateSequenceOffsets?.();
            return true;
        case "editor_guidelines":
            if (Array.isArray(value)) {
                canvas.guidelines = value.map(g => ({ id: g.id, x: g.x, y: g.y, angle: g.angle }));
                const maxId = canvas.guidelines.reduce((m, g) => Math.max(m, g.id || 0), 0);
                canvas._nextUserGuideId = maxId + 1;
            }
            return true;
        case "editor_guideline_lock":
        default:
            if (FONT_SNAPSHOT_KEYS.has(key)) {
                const snapshotObj = canvas.currentStateObj?.snapshotObj || {};
                canvas.fontSettings = fontSettingsFromSnapshot(snapshotObj, canvas.fontSettings);
                return true;
            }
            return false;
    }
}
function applySinglePatch(cm, canvas, patch, direction, snapshotObj) {
    const { path } = patch;
    if (!Array.isArray(path) || path.length === 0) return false;
    const { shouldExist, value } = patchValue(patch, direction);
    if (!GROUP_ROOT_KEYS.has(path[0])) {
        return applyEditorField(canvas, cm, path, value, shouldExist);
    }
    const charBucket = path[0];
    const groupName = path[1];
    if (typeof groupName !== "string") return false;
    if (path.length === 2) {
        if (!shouldExist) return deleteRootGroupByName(cm, groupName);
        return reconstructRootGroup(cm, groupName, value);
    }
    if (path[2] === "advance" && path.length === 3) {
        const group = cm.getGroupByName(groupName);
        if (!group || !shouldExist) return false;
        group.advance = value;
        group.is_modified = true;
        return true;
    }
    if (path[2] === "children" && path.length >= 4 && typeof path[3] === "string") {
        const pathName = path[3];
        if (path.length === 4) {
            if (!shouldExist) {
                // Delete a path child
                const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
                if (!curve) return true;
                const treeItem = Array.from(cm.treeItems.values()).find(
                    (item) => item.type === "curve" && item.curveId === curve.id
                );
                return treeItem ? cm.deleteSingleObject(treeItem.id) : true;
            }
            // Replace/restore a path child (value is the full path data from snapshot)
            return cm.replacePathFromSnapshotData(groupName, pathName, value);
        }
        // "children" → path-level property change
        if (path.length === 5 && path[4] !== "vertices") {
            const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
            if (!curve || !shouldExist) return false;
            const prop = path[4];
            if (prop in curve) {
                curve[prop] = value;
                if (prop === "locked" || prop === "visible") {
                    const treeItem = Array.from(cm.treeItems.values()).find(
                        (item) => item.type === "curve" && item.curveId === curve.id
                    );
                    if (treeItem) treeItem[prop] = value;
                }
                if (curve.groupId) cm.invalidateGroupCache?.(curve.groupId);
                return true;
            }
            return false;
        }
        // "children" → vertices change
        if (path[4] !== "vertices" || typeof path[5] === "undefined") {
            return resyncFromSnapshotForPath(cm, snapshotObj, path);
        }
        const vertexIdx = path[5]; // array index
        if (path.length === 6) {
            return resyncPathFromSnapshot(cm, snapshotObj, groupName, pathName);
        }
        const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
        if (!curve) return resyncPathFromSnapshot(cm, snapshotObj, groupName, pathName);
        const node = findMainNodeByVertexKey(curve, vertexIdx);
        if (!node) {
            return resyncPathFromSnapshot(cm, snapshotObj, groupName, pathName);
        }
        if (path.length === 7) {
            if (!shouldExist) return false;
            return applyVertexField(node, path[6], value);
        }
        if (path.length === 8 && (path[6] === "control_1" || path[6] === "control_2")) {
            if (!shouldExist) return false;
            return ensureControlHandle(node, curve, cm, path[6], path[7], value);
        }
        return resyncPathFromSnapshot(cm, snapshotObj, groupName, pathName);
    }
    // ["glyphs", "groupName", "children"] — full children replacement
    if (path.length === 3 && path[2] === "children") {
        if (!shouldExist) return deleteRootGroupByName(cm, groupName);
        return reconstructRootGroup(cm, groupName, getGroupDataFromSnapshot(snapshotObj, groupName));
    }
    // Nested group (sub-group) within children
    if (path[2] === "children" && path.length >= 4 && typeof path[3] === "number") {
        return resyncGroupFromSnapshot(cm, snapshotObj, groupName);
    }
}
/**
 * @returns {{ ok: boolean, incremental: boolean, failedPatch?: object }}
 */
export function applySnapshotPatchesToRuntime(canvas, patches, direction) {
    const cm = canvas?.curve_manager;
    if (!cm || !Array.isArray(patches) || patches.length === 0) {
        return { ok: true, incremental: true };
    }
    if (canvas.history_use_patch_runtime === false) {
        return { ok: false, incremental: false };
    }
    const snapshotObj = canvas.currentStateObj?.snapshotObj;
    if (!snapshotObj) {
        return { ok: false, incremental: false };
    }
    const ordered = direction === "undo" ? [...patches].reverse() : patches;
    for (const patch of ordered) {
        if (applySinglePatch(cm, canvas, patch, direction, snapshotObj)) {
            continue;
        }
        if (resyncFromSnapshotForPath(cm, snapshotObj, patch.path)) {
            continue;
        }
        return { ok: false, incremental: false, failedPatch: patch };
    }
    resyncTouchedGroupsFromSnapshot(cm, snapshotObj, ordered);
    syncTreeHierarchyFromSnapshot(cm, snapshotObj);
    cm.groupFlatCache?.clear?.();
    cm.calculateSequenceOffsets?.();
    cm.notifyModelUpdate?.();
    cm.notifyTreeUpdate?.();
    canvas.flushSmartStrokeBooleanCache?.();
    return { ok: true, incremental: true };
}
/** Full sync fallback (open file / restore / documentChanged with no granular patches) */
export async function syncRuntimeFromSnapshotObject(canvas, snapshotObj) {
    const cm = canvas?.curve_manager;
    if (!cm || !snapshotObj) return false;
    await cm.loadFromSnapshotObject(snapshotObj);
    syncTreeHierarchyFromSnapshot(cm, snapshotObj);
    if (Array.isArray(snapshotObj.editor_guidelines)) {
        canvas.guidelines = snapshotObj.editor_guidelines.map(g => ({
            id: g.id, x: g.x, y: g.y, angle: g.angle
        }));
    }
    if (snapshotObj.editor_guideline_lock !== undefined) {
        canvas.guideline_lock = !!snapshotObj.editor_guideline_lock;
    }
    canvas.fontSettings = fontSettingsFromSnapshot(snapshotObj, canvas.fontSettings);
    return true;
}
