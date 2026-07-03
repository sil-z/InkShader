/**
 * Editor interaction state: UI read-only snapshot (SSOT = EditorStore.state, field names adapted via mergeInteractionFromStoreState).
 * CurveManager.selection is runtime projection only, not a read path.
 */
import {
    createEmptyRuntimeInteractionSnapshot,
    readInteractionSnapshotFromCurveManager
} from "../domain/selection/runtime_interaction_snapshot.js";
import {
    hasObjectSelection,
    resolveCurvesFromSnapshot,
    resolveRefsFromSnapshot
} from "../domain/selection/interaction_snapshot_query.js";
import {
    resolveMarkerById,
    resolveMarkersFromCanvas
} from "../domain/selection/marker_resolution.js";

export { hasObjectSelection, resolveCurvesFromSnapshot, resolveRefsFromSnapshot };

export { resolveMarkerById, resolveMarkersFromCanvas };

/**
 * When NODE tool is deselected: derive object selection from Store node selection (do not scan CM selection set).
 */
export function deriveObjectSelectionFromStoreState(storeState, curveManager) {
    const curveIds = new Set();
    const refIds = new Set();
    if (!storeState) {
        return { curveIds: [], refIds: [] };
    }
    const nodeRefId = storeState._nodeSelectionRefId ?? null;
    if (nodeRefId) {
        refIds.add(nodeRefId);
        return { curveIds: [], refIds: [...refIds] };
    }
    for (const markerId of storeState.selectedNodeIds || []) {
        const marker = resolveMarkerById(curveManager, markerId);
        if (!marker) continue;
        const curve = curveManager?.find_curve_by_dom?.(marker);
        if (curve?.id) curveIds.add(curve.id);
    }
    return { curveIds: [...curveIds], refIds: [...refIds] };
}

export const INTERACTION_STATE_FIELDS = Object.freeze([
    "selectedTreeIds",
    "selectedNodeMarkerIds",
    "selectedCurveIds",
    "selectedRefIds",
    "activeGroupId",
    "focusedSeqIdx"
]);

export function createEmptyInteractionSnapshot() {
    return createEmptyRuntimeInteractionSnapshot();
}

/** UI initial interaction state (not bound to CM) */
export function createEmptyEditorInteractionState() {
    return EditorInteractionState.fromStoreState({});
}

/** Current tool: read-only from EditorStore */
export function resolveActiveCanvasTool(canvas) {
    return canvas?.editorStore?.getState?.()?.currentTool || "DRAW";
}

/**
 * @internal Only for main-canvas not mounted / host port bootstrap; UI should read EditorStore + STATE_CHANGED.
 */
export function readInteractionSnapshotFromRuntime(curveManager) {
    return readInteractionSnapshotFromCurveManager(curveManager);
}

/** @deprecated alias */
export function readInteractionSnapshot(curveManager) {
    return readInteractionSnapshotFromCurveManager(curveManager);
}

/** Build UI interaction snapshot from EditorStore state */
export function mergeInteractionFromStoreState(storeState = {}) {
    if (!storeState || typeof storeState !== "object") {
        return createEmptyInteractionSnapshot();
    }
    return {
        selectedTreeIds: [...(storeState.selectedTreeIds || [])],
        selectedNodeMarkerIds: [...(storeState.selectedNodeIds || [])],
        selectedCurveIds: [...(storeState.selectedCurveIds || [])],
        selectedRefIds: [...(storeState.selectedRefIds || [])],
        activeGroupId: storeState.activeGroupId ?? null,
        focusedSeqIdx: typeof storeState.focusedSeqIdx === "number" ? storeState.focusedSeqIdx : -1
    };
}

export function resolveInteractionSnapshot(eventDetail, curveManager = null) {
    const storeState = eventDetail?.afterState || eventDetail?.state;
    if (storeState && typeof storeState === "object") {
        return mergeInteractionFromStoreState(storeState);
    }
    return readInteractionSnapshotFromRuntime(curveManager);
}

export class EditorInteractionState {
    constructor(curveManager) {
        this._cm = curveManager;
        this._cached = readInteractionSnapshotFromRuntime(curveManager);
    }

    static fromStoreState(storeState) {
        const adapter = new EditorInteractionState(null);
        adapter._cached = mergeInteractionFromStoreState(storeState);
        return adapter;
    }

    static fromManager(curveManager) {
        return new EditorInteractionState(curveManager);
    }

    static fromEvent(eventDetail, curveManager) {
        const adapter = new EditorInteractionState(curveManager);
        adapter._cached = resolveInteractionSnapshot(eventDetail, curveManager);
        return adapter;
    }

    refresh(curveManager = this._cm) {
        this._cm = curveManager;
        this._cached = readInteractionSnapshotFromRuntime(curveManager);
        return this;
    }

    applyEventDetail(eventDetail) {
        this._cached = resolveInteractionSnapshot(eventDetail, this._cm);
        return this;
    }

    snapshot() {
        return { ...this._cached };
    }

    get selectedTreeIds() { return this._cached.selectedTreeIds; }
    get selectedNodeMarkerIds() { return this._cached.selectedNodeMarkerIds; }
    get selectedCurveIds() { return this._cached.selectedCurveIds; }
    get selectedRefIds() { return this._cached.selectedRefIds; }
    get activeGroupId() { return this._cached.activeGroupId; }
    get focusedSeqIdx() { return this._cached.focusedSeqIdx; }

    hasTreeSelection(id) {
        return this._cached.selectedTreeIds.includes(id);
    }

    get nodeSelectionCount() {
        return this._cached.selectedNodeMarkerIds.length;
    }
}

export function snapshotIncludesCurve(snapshot, curve) {
    return !!(curve?.id && snapshot.selectedCurveIds.includes(curve.id));
}

export function snapshotIncludesRef(snapshot, refItem) {
    return !!(refItem?.id && snapshot.selectedRefIds.includes(refItem.id));
}

export function snapshotIncludesRefById(snapshot, refId) {
    return !!(refId && snapshot.selectedRefIds.includes(refId));
}

export function snapshotIncludesNodeMarker(snapshot, marker) {
    const id = marker && typeof marker === "object" ? marker.id : marker;
    return !!(id && snapshot.selectedNodeMarkerIds.includes(id));
}

export function snapshotActiveGroupIs(snapshot, groupId) {
    return snapshot.activeGroupId === groupId;
}

/**
 * Whether to render current_curve under this sequence group while drawing (falls back to curve.groupId when Store not synced).
 */
export function shouldIncludeCurrentDrawingCurve(canvas, snapshot, groupId) {
    if (!canvas?.current_curve || resolveActiveCanvasTool(canvas) !== "DRAW") return false;
    if (canvas.current_curve.groupId === groupId) return true;
    return snapshotActiveGroupIs(snapshot, groupId);
}

/** @deprecated use resolveMarkersFromCanvas */
export function resolveMarkersFromStore(canvas) {
    return resolveMarkersFromCanvas(canvas);
}

export function createNodeMarkerIdSet(snapshot) {
    return new Set(snapshot?.selectedNodeMarkerIds || []);
}
