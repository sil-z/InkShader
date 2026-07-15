/**
 * UI layer data boundary (SSOT read model + read-only domain queries).
 *
 * - UI must NOT import `canvas_access`, `CurveManager`, `core/bezier/*`, `presentation/*`
 * - Write: `CanvasDispatcher.request*`
 * - Read: `EditorStore` snapshot (STATE_CHANGED / getEditorStoreState)
 * - This module may fall back to CM (bootstrap, thumbnail, write-path marker resolution)
 */
import { mapActiveIndicesAfterTokenChange } from "../domain/sequence/sequence_active_indices.js";
import { appendRawToSequence, removeGroupTokensFromSequence } from "../domain/sequence/sequence_text_ops.js";
import { createSequenceLayoutFromState } from "../domain/sequence/sequence_layout.js";
import { parseSequenceTokens } from "../domain/sequence/sequence_tokenizer.js";
import { listRootGroupsForSequenceMenu } from "../domain/sequence/sequence_menu_groups.js";
import {
    buildTreeSnapshot,
    getTreeItemFromSnapshot,
    isDescendantInTreeSnapshot,
    treeItemsMapFromSnapshot
} from "../domain/tree/tree_snapshot.js";
import { pickCurvesReadSnapshot } from "../domain/curves/curve_read_snapshot.js";
import { resolveMarkerById } from "../domain/selection/marker_resolution.js";
import {
    computeSelectionBounds,
    createSequenceLayoutFromCurveManager,
    getSeqIdxForGroupId
} from "../domain/selection/selection_bounds.js";
import { mergeInteractionFromStoreState } from "./editor_interaction_state.js";
import { getMainCanvasFromDocument, whenCanvasReady } from "./canvas_access.js";
import { drawSequenceGroupPreviewOnContext } from "./sequence_preview_facade.js";

function curveManager() {
    return getMainCanvasFromDocument()?.curve_manager ?? null;
}

function storeState() {
    return getMainCanvasFromDocument()?.editorStore?.getState?.() ?? null;
}

function treeSnapshot() {
    return storeState()?.treeSnapshot ?? null;
}

/** Callback after Store is ready (does not expose canvas instance to UI) */
export function whenEditorStoreReady(callback) {
    whenCanvasReady(() => {
        const st = storeState();
        if (st) callback(st);
    });
}

/** @deprecated Use whenEditorStoreReady */
export function whenEditorModelReady(callback) {
    whenEditorStoreReady(callback);
}

export function getEditorStoreState() {
    return storeState();
}

export function parseSequenceText(text) {
    const st = storeState();
    const snap = st?.treeSnapshot;
    const tokens = st?.sequenceTokens;
    if (tokens?.length && text === (st.sequenceText ?? "")) {
        return tokens;
    }
    const cm = curveManager();
    return parseSequenceTokens(text, {
        resolveGroupByName: (name) => {
            if (snap?.items) {
                for (const item of Object.values(snap.items)) {
                    if (item.type === "group" && item.name === name && item.parentId === null && !item.isRef) {
                        return { id: item.id };
                    }
                }
            }
            return cm?.getGroupByName(name) ?? null;
        }
    });
}

export function getDefaultGroupForChar(char) {
    const snap = treeSnapshot();
    if (snap?.charToGroupId && snap.charToGroupId[char]) {
        return snap.charToGroupId[char];
    }
    return curveManager()?.getDefaultGroupForChar(char) ?? null;
}

export function getTreeItem(id) {
    const snap = treeSnapshot();
    const fromSnap = getTreeItemFromSnapshot(snap, id);
    if (fromSnap) return fromSnap;
    return curveManager()?.treeItems.get(id) ?? null;
}

/** Tree row visibility/lock (snapshot fields only, no Curve instance reads) */
export function getTreeItemVisibilityState(item) {
    if (!item) return { isVis: true, isLocked: false };
    let isVis = item.visible !== false;
    let isLocked = item.locked === true;
    if (item.type === "curve") {
        if (item.curveVisible !== undefined) isVis = item.curveVisible !== false;
        if (item.curveLocked !== undefined) isLocked = item.curveLocked === true;
    }
    return { isVis, isLocked };
}

/** Ref group transform (snapshot as plain object; falls back to CM) */
export function getRefTransform(itemOrId) {
    const id = typeof itemOrId === "string" ? itemOrId : itemOrId?.id;
    const item = typeof itemOrId === "object" && itemOrId ? itemOrId : getTreeItem(id);
    if (item?.transform) return item.transform;
    const live = id ? curveManager()?.treeItems.get(id) : null;
    if (live?.transform) {
        return {
            a: live.transform.a,
            b: live.transform.b,
            c: live.transform.c,
            d: live.transform.d,
            e: live.transform.e,
            f: live.transform.f
        };
    }
    return null;
}

export function getTreeItemsMap() {
    const snap = treeSnapshot();
    const map = treeItemsMapFromSnapshot(snap);
    if (map?.size) return map;
    return curveManager()?.treeItems ?? null;
}

export function getRootChildren() {
    const snap = treeSnapshot();
    if (snap?.rootChildren?.length) return snap.rootChildren;
    return curveManager()?.rootChildren ?? [];
}

export function getCurveById(curveId) {
    if (!curveId) return null;
    const st = storeState();
    const fromStore = st?.curvesById?.[curveId];
    if (fromStore) return fromStore;
    const cm = curveManager();
    const live = cm?.curveById?.get(curveId);
    if (!live) return null;
    // Build a minimal snapshot for this single curve
    const c = live;
    let skeletonWinding = "open";
    let skeletonVertexCount = 0;
    if (typeof c.getSkeletonWinding === "function") skeletonWinding = c.getSkeletonWinding();
    if (typeof c.getSkeletonVertices === "function") skeletonVertexCount = c.getSkeletonVertices().length;
    return {
        id: c.id, groupId: c.groupId ?? null,
        visible: c.visible !== false, locked: c.locked === true,
        stroke_width: c.stroke_width, closed: !!c.closed,
        smart_stroke: !!c.smart_stroke, show_skeleton: !!c.show_skeleton,
        smart_stroke_clockwise: c.smart_stroke_clockwise !== false,
        skeletonWinding, skeletonVertexCount
    };
}

/** @deprecated use getCurveById */
export function findCurveById(curveId) {
    return getCurveById(curveId);
}

export function getCurvesForTreeSelection(treeIds) {
    const curves = [];
    const seen = new Set();
    for (const tid of treeIds || []) {
        const item = getTreeItem(tid);
        if (!item || item.type !== "curve" || !item.curveId || seen.has(item.curveId)) continue;
        const curve = getCurveById(item.curveId);
        if (curve) {
            seen.add(item.curveId);
            curves.push(curve);
        }
    }
    return curves;
}

export function getCurvesByIds(curveIds) {
    const curves = [];
    for (const id of curveIds || []) {
        const curve = getCurveById(id);
        if (curve) curves.push(curve);
    }
    return curves;
}

export function getNodeReadByMarkerId(markerId) {
    if (!markerId) return null;
    const st = storeState();
    const fromStore = st?.nodesByMarkerId?.[markerId];
    if (fromStore) return fromStore;
    const marker = resolveNodeMarker(markerId);
    if (!marker) return null;
    const node = curveManager()?.find_node_by_curve?.(marker);
    if (!node) return null;
    return {
        x: node.x,
        y: node.y,
        groupId: node.curve?.groupId || null,
        control1: node.control1 ? { x: node.control1.x, y: node.control1.y } : null,
        control2: node.control2 ? { x: node.control2.x, y: node.control2.y } : null
    };
}

/** Write path: resolve marker DOM (UI only for dispatch params) */
export function resolveNodeMarker(markerId) {
    return resolveMarkerById(curveManager(), markerId);
}

export function getClipboardSummary() {
    const st = storeState();
    if (st?.clipboardSummary) return st.clipboardSummary;
    const cm = curveManager();
    const clip = cm?.clipboard;
    if (!clip?.length) return { canPaste: false, count: 0, firstType: null };
    return { canPaste: true, count: clip.length, firstType: clip[0]?.type ?? null };
}

export function getSelectionBounds(mode = "transform") {
    const st = storeState();
    if (mode === "transform" && st?.selectionBoundsTransform) {
        return st.selectionBoundsTransform;
    }
    const cm = curveManager();
    if (!cm || !st) return null;
    return computeSelectionBounds(cm, mergeInteractionFromStoreState(st), mode);
}

/** @deprecated use getSelectionBounds */
export function computeSelectionBoundsForSnapshot(interactionSnapshot, mode = "transform") {
    const cm = curveManager();
    if (!cm) return null;
    return computeSelectionBounds(cm, interactionSnapshot, mode);
}

export function drawSequenceGroupPreview(ctx, groupId) {
    drawSequenceGroupPreviewOnContext(ctx, groupId);
}

export function isTreeDescendant(ancestorId, descendantId) {
    const snap = treeSnapshot();
    if (snap) return isDescendantInTreeSnapshot(snap, ancestorId, descendantId);
    return curveManager()?.isDescendant(ancestorId, descendantId) ?? false;
}

export function listSequenceMenuGroups() {
    const map = getTreeItemsMap();
    return map ? listRootGroupsForSequenceMenu(map) : [];
}

export function isDefaultCharGroup(groupId, charCode) {
    if (charCode == null) return false;
    return getDefaultGroupForChar(charCode) === groupId;
}

function resolveSequenceLayout() {
    const st = storeState();
    if (st?.sequenceTokens) {
        const layout = createSequenceLayoutFromState({
            sequenceTokens: st.sequenceTokens,
            activeSequenceIndices: st.activeSequenceIndices,
            charToGroupId: st.treeSnapshot?.charToGroupId ?? {}
        });
        const cm = curveManager();
        if (cm) {
            layout.getSeqOffset = (seqIdx) => cm.getSeqOffset(seqIdx);
        }
        return layout;
    }
    return createSequenceLayoutFromCurveManager(curveManager());
}

export function getSeqIdxForGroup(groupId, focusedSeqIdx = -1) {
    const layout = resolveSequenceLayout();
    return layout ? getSeqIdxForGroupId(layout, groupId, focusedSeqIdx) : -1;
}

export function getSeqOffsetForGroup(groupId) {
    const layout = resolveSequenceLayout();
    if (!layout) return 0;
    const seqIdx = getSeqIdxForGroupId(layout, groupId);
    if (seqIdx === -1 || typeof layout.getSeqOffset !== 'function') return 0;
    return layout.getSeqOffset(seqIdx);
}

export function getGroupByName(name) {
    const snap = treeSnapshot();
    if (snap?.items) {
        for (const item of Object.values(snap.items)) {
            if (item.type === "group" && item.name === name && item.parentId === null && !item.isRef) {
                return item;
            }
        }
    }
    return curveManager()?.getGroupByName(name) ?? null;
}

/** Host not ready yet, built by Store seed (bootstrap) */
export function snapshotTreeFromCurveManager(cm) {
    return buildTreeSnapshot(cm);
}

export {
    mapActiveIndicesAfterTokenChange,
    appendRawToSequence,
    removeGroupTokensFromSequence,
    parseSequenceTokens
};
