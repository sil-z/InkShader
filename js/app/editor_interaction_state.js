/**
 * 编辑器交互态：UI 只读快照（SSOT = EditorStore.state，经 mergeInteractionFromStoreState 适配字段名）。
 * CurveManager.selection 仅为运行时投影，不作为读路径。
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
 * NODE 工具切走时：由 Store 节点选区推导对象选区（不扫 CM 选区集合）。
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

/** UI 初始交互态（不绑定 CM） */
export function createEmptyEditorInteractionState() {
    return EditorInteractionState.fromStoreState({});
}

/** 当前工具：仅读 EditorStore */
export function resolveActiveCanvasTool(canvas) {
    return canvas?.editorStore?.getState?.()?.currentTool || "DRAW";
}

/**
 * @internal 仅 main-canvas 未挂载 / 宿主端口 bootstrap；UI 应读 EditorStore + STATE_CHANGED。
 */
export function readInteractionSnapshotFromRuntime(curveManager) {
    return readInteractionSnapshotFromCurveManager(curveManager);
}

/** @deprecated 别名 */
export function readInteractionSnapshot(curveManager) {
    return readInteractionSnapshotFromCurveManager(curveManager);
}

/** 从 EditorStore 状态构建 UI 交互快照 */
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
 * 绘制中是否应在该 sequence 组下渲染 current_curve（Store 未同步时回退 curve.groupId）。
 */
export function shouldIncludeCurrentDrawingCurve(canvas, snapshot, groupId) {
    if (!canvas?.current_curve || resolveActiveCanvasTool(canvas) !== "DRAW") return false;
    if (canvas.current_curve.groupId === groupId) return true;
    return snapshotActiveGroupIs(snapshot, groupId);
}

/** @deprecated 使用 resolveMarkersFromCanvas */
export function resolveMarkersFromStore(canvas) {
    return resolveMarkersFromCanvas(canvas);
}

export function createNodeMarkerIdSet(snapshot) {
    return new Set(snapshot?.selectedNodeMarkerIds || []);
}
