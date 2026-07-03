/**
 * Applies snapshotPatches to CurveManager / canvas runtime (avoiding full undo/redo loadFromJSON).
 * Uses snapshotObj (with JSON patches applied) as source of truth; path-level/group-level resync covers structural changes like node insert/delete.
 */
import { CurveNode } from "../../core/bezier/node.js";
const GROUP_ROOT_KEYS = new Set(["ch", "components"]);
function patchValue(patch, direction) {
    const applyReverse = direction === "undo";
    return {
        shouldExist: applyReverse ? patch.oldExists : patch.newExists,
        value: applyReverse ? patch.oldValue : patch.newValue
    };
}
function getPathDataFromSnapshot(snapshotObj, charBucket, groupName, pathName) {
    return snapshotObj?.[charBucket]?.[groupName]?.paths?.[pathName] ?? null;
}
function getGroupDataFromSnapshot(snapshotObj, charBucket, groupName) {
    return snapshotObj?.[charBucket]?.[groupName] ?? null;
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
    if (!curve?.startNode || !vertexKey) return null;
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
function reconstructRootGroup(cm, groupName, groupData, charBucket) {
    if (!groupData || typeof groupData !== "object") return false;
    const existing = cm.getGroupByName(groupName);
    if (existing) cm.deleteSingleObject(existing.id);
    const charCode = charBucket === "ch" ? groupData.char_code ?? groupName : null;
    cm._reconstructGroup(groupName, groupData, null, charCode);
    return true;
}
/** Rebuild runtime curve from full path data in snapshot (insert/delete nodes, vertices table replacement) */
function resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName) {
    const pathData = getPathDataFromSnapshot(snapshotObj, charBucket, groupName, pathName);
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
function resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName) {
    const groupData = getGroupDataFromSnapshot(snapshotObj, charBucket, groupName);
    if (!groupData) return deleteRootGroupByName(cm, groupName);
    return reconstructRootGroup(cm, groupName, groupData, charBucket);
}
function resyncFromSnapshotForPath(cm, snapshotObj, path) {
    if (!Array.isArray(path) || path.length < 2 || !GROUP_ROOT_KEYS.has(path[0])) return false;
    const charBucket = path[0];
    const groupName = path[1];
    if (typeof groupName !== "string") return false;
    if (path.length >= 3 && path[2] === "tree_child_order") {
        return resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName);
    }
    if (path.length >= 4 && path[2] === "paths" && typeof path[3] === "string") {
        return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, path[3]);
    }
    if (path.length >= 3 && (path[2] === "components" || path[2] === "paths")) {
        return resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName);
    }
    if (path.length === 2) {
        return resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName);
    }
    return false;
}
function patchTouchesGroupStructure(path) {
    if (!Array.isArray(path) || path.length < 2 || !GROUP_ROOT_KEYS.has(path[0])) return false;
    if (path.length === 2) return true;
    const seg = path[2];
    return seg === "paths" || seg === "components" || seg === "tree_child_order";
}
function collectTouchedGroupsFromPatches(patches) {
    const keys = new Set();
    for (const patch of patches) {
        const path = patch?.path;
        if (!patchTouchesGroupStructure(path)) continue;
        if (typeof path[1] === "string") keys.add(`${path[0]}:${path[1]}`);
    }
    return keys;
}
/** Sync all group children order from snapshot authoritative state (patch order independent) */
export function syncTreeHierarchyFromSnapshot(cm, snapshotObj) {
    if (!cm || !snapshotObj) return;
    for (const bucket of GROUP_ROOT_KEYS) {
        const groups = snapshotObj[bucket];
        if (!groups || typeof groups !== "object") continue;
        for (const groupName of Object.keys(groups)) {
            const gData = groups[groupName];
            const group = cm.getGroupByName(groupName);
            if (!group || !Array.isArray(gData?.tree_child_order)) continue;
            cm.applyTreeChildOrder(group.id, gData.tree_child_order);
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
        const charBucket = key.slice(0, sep);
        const groupName = key.slice(sep + 1);
        resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName);
    }
}
function applyVertexField(node, field, value) {
    if (!node) return false;
    if (field === "x" || field === "y") {
        node[field] = value;
        return true;
    }
    if (field === "control_mode") {
        node.control_mode = value;
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
        case "editor_guideline_h":
            canvas.active_guidelines = [
                ...(canvas.active_guidelines || []).filter((g) => g.type !== "h"),
                ...(Array.isArray(value) ? value.map((v) => ({ type: "h", value: v })) : [])
            ];
            return true;
        case "editor_guideline_v":
            canvas.active_guidelines = [
                ...(canvas.active_guidelines || []).filter((g) => g.type !== "v"),
                ...(Array.isArray(value) ? value.map((v) => ({ type: "v", value: v })) : [])
            ];
            return true;
        case "editor_guideline_lock":
            canvas.guideline_lock = !!value;
            return true;
        case "editor_user_guidelines":
            if (Array.isArray(value)) {
                canvas.user_guidelines = value.map(g => ({ id: g.id, type: g.type, x: g.x, y: g.y, angle: g.angle || 0 }));
                const maxId = canvas.user_guidelines.reduce((m, g) => Math.max(m, g.id || 0), 0);
                canvas._nextUserGuideId = maxId + 1;
            }
            return true;
        case "canvas_size_width":
            canvas.canvas_size_width = value;
            return true;
        case "canvas_size_height":
            canvas.canvas_size_height = value;
            return true;
        default:
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
        return reconstructRootGroup(cm, groupName, value, charBucket);
    }
    if (path[2] === "advance" && path.length === 3) {
        const group = cm.getGroupByName(groupName);
        if (!group || !shouldExist) return false;
        group.advance = value;
        group.is_modified = true;
        return true;
    }
    if (path[2] === "tree_child_order" && path.length >= 3) {
        const group = cm.getGroupByName(groupName);
        if (!group) return false;
        const order =
            path.length === 3 && shouldExist && Array.isArray(value)
                ? value
                : getGroupDataFromSnapshot(snapshotObj, charBucket, groupName)?.tree_child_order;
        if (!Array.isArray(order)) return false;
        cm.applyTreeChildOrder(group.id, order);
        return true;
    }
    if (path[2] === "components") {
        return resyncGroupFromSnapshot(cm, snapshotObj, charBucket, groupName);
    }
    if (path[2] !== "paths" || typeof path[3] !== "string") {
        return resyncFromSnapshotForPath(cm, snapshotObj, path);
    }
    const pathName = path[3];
    if (path.length === 4) {
        if (!shouldExist) {
            const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
            if (!curve) return true;
            const treeItem = Array.from(cm.treeItems.values()).find(
                (item) => item.type === "curve" && item.curveId === curve.id
            );
            return treeItem ? cm.deleteSingleObject(treeItem.id) : true;
        }
        return cm.replacePathFromSnapshotData(groupName, pathName, value);
    }
    if (path.length === 5 && path[4] === "vertices") {
        return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName);
    }
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
    if (path[4] !== "vertices" || typeof path[5] !== "string") return false;
    const nodeId = path[5];
    if (path.length === 6) {
        return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName);
    }
    const curve = findCurveByGroupAndPathName(cm, groupName, pathName);
    if (!curve) return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName);
    const node = findMainNodeByVertexKey(curve, nodeId);
    if (!node) {
        return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName);
    }
    if (path.length === 7) {
        if (!shouldExist) return false;
        return applyVertexField(node, path[6], value);
    }
    if (path.length === 8 && (path[6] === "control_1" || path[6] === "control_2")) {
        if (!shouldExist) return false;
        return ensureControlHandle(node, curve, cm, path[6], path[7], value);
    }
    return resyncPathFromSnapshot(cm, snapshotObj, charBucket, groupName, pathName);
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
    if (Array.isArray(snapshotObj.editor_guideline_h) || Array.isArray(snapshotObj.editor_guideline_v)) {
        const h = (snapshotObj.editor_guideline_h || []).map((v) => ({ type: "h", value: v }));
        const v = (snapshotObj.editor_guideline_v || []).map((val) => ({ type: "v", value: val }));
        canvas.active_guidelines = [...h, ...v];
    }
    if (snapshotObj.editor_guideline_lock !== undefined) {
        canvas.guideline_lock = !!snapshotObj.editor_guideline_lock;
    }
    if (snapshotObj.canvas_size_width) canvas.canvas_size_width = snapshotObj.canvas_size_width;
    if (snapshotObj.canvas_size_height) canvas.canvas_size_height = snapshotObj.canvas_size_height;
    return true;
}
