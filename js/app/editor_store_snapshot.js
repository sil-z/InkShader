/** EditorStore state shallow snapshot (avoiding structuredClone / JSON full deep copy) */

const ARRAY_KEYS = Object.freeze([
    "selectedTreeIds",
    "selectedNodeIds",
    "selectedCurveIds",
    "selectedRefIds",
    "activeSequenceIndices"
]);

const SCALAR_KEYS = Object.freeze([
    "modelRevision",
    "treeRevision",
    "documentRevision",
    "currentTool",
    "currentState",
    "scale",
    "activeGroupId",
    "focusedSeqIdx",
    "sequenceText",
    "commandStackSize",
    "redoStackSize",
    "isRestoring",
    "_nodeSelectionRefId",
    "draggingNodeId"
]);

const DRAW_TOOL_KEYS = Object.freeze([
    "stroke_width",
    "closed",
    "smart_expand",
    "show_skeleton"
]);

function arraysShallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function snapshotStoreState(state) {
    if (!state || typeof state !== "object") return state;
    const out = {};
    for (const key of SCALAR_KEYS) {
        if (key in state) out[key] = state[key];
    }
    if (state.offset && typeof state.offset === "object") {
        out.offset = { x: state.offset.x, y: state.offset.y };
    } else {
        out.offset = { x: 0, y: 0 };
    }
    for (const key of ARRAY_KEYS) {
        out[key] = [...(state[key] || [])];
    }
    if (state.drawToolSettings && typeof state.drawToolSettings === "object") {
        out.drawToolSettings = { ...state.drawToolSettings };
    }
    if (state.treeSnapshot && typeof state.treeSnapshot === "object") {
        out.treeSnapshot = {
            rootChildren: [...(state.treeSnapshot.rootChildren || [])],
            items: { ...state.treeSnapshot.items },
            charToGroupId: { ...state.treeSnapshot.charToGroupId }
        };
    }
    if (Array.isArray(state.sequenceTokens)) {
        out.sequenceTokens = state.sequenceTokens.map((t) => ({ ...t }));
    }
    if (state.curvesById && typeof state.curvesById === "object") {
        out.curvesById = { ...state.curvesById };
    }
    if (state.nodesByMarkerId && typeof state.nodesByMarkerId === "object") {
        out.nodesByMarkerId = { ...state.nodesByMarkerId };
    }
    if (state.clipboardSummary && typeof state.clipboardSummary === "object") {
        out.clipboardSummary = { ...state.clipboardSummary };
    }
    if (state.selectionBoundsTransform && typeof state.selectionBoundsTransform === "object") {
        out.selectionBoundsTransform = { ...state.selectionBoundsTransform };
    }
    return out;
}

export function storeStatesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    for (const key of SCALAR_KEYS) {
        if (a[key] !== b[key]) return false;
    }
    const ao = a.offset;
    const bo = b.offset;
    if ((ao?.x ?? 0) !== (bo?.x ?? 0) || (ao?.y ?? 0) !== (bo?.y ?? 0)) return false;
    for (const key of ARRAY_KEYS) {
        if (!arraysShallowEqual(a[key], b[key])) return false;
    }
    const ad = a.drawToolSettings;
    const bd = b.drawToolSettings;
    if (!ad && !bd) return true;
    if (!ad || !bd) return false;
    for (const key of DRAW_TOOL_KEYS) {
        if (ad[key] !== bd[key]) return false;
    }
    return true;
}
