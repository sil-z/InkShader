import { CANVAS_ACTIONS, CANVAS_EVENTS } from "./canvas_events.js";
import { normalizeCommandCommitDetail, shouldCommitCommandAfterDispatch } from "./editor_command_log.js";
import { defaultDrawToolSettings } from "../domain/editor/interaction_reducer.js";
import {
    pickInteractionReadFields,
    pickModelRevisionFields,
    pickSequenceFields
} from "./editor_model_sync.js";
import { buildInteractionSeedFromCanvas, buildRuntimeSelectionPatchAction } from "./editor_store_bootstrap.js";
import {
    applyInteractionFromStore,
    pickDrawToolFieldsFromCanvas,
    pickHistoryStackFields,
    pickViewFieldsFromCanvas
} from "./editor_store_projection.js";
import {
    finalizeInteractionState,
    INTERACTION_PAYLOAD_ACTIONS,
    reduceInteractionState
} from "../domain/editor/interaction_reducer.js";
import { storeInteractionFromHistoryMeta } from "./editor_history_state.js";
import { snapshotStoreState, storeStatesEqual } from "./editor_store_snapshot.js";

/**
 * EditorStore: sole SSOT for UI interaction state.
 * Write path: reduce(payload) → finalize → applyInteractionFromStore (CM is projection only).
 */
export class EditorStore {
    constructor({
        emit = () => {},
        getCanvas = () => null,
        recordHistory = null,
        undoHistory = null,
        redoHistory = null
    } = {}) {
        this.emit = typeof emit === "function" ? emit : () => {};
        this._getCanvas = typeof getCanvas === "function" ? getCanvas : () => null;
        this._recordHistory = typeof recordHistory === "function" ? recordHistory : null;
        this._undoHistory = typeof undoHistory === "function" ? undoHistory : null;
        this._redoHistory = typeof redoHistory === "function" ? redoHistory : null;
        const canvas = this._getCanvas();
        const seed = buildInteractionSeedFromCanvas(canvas);
        this.state = {
            modelRevision: 0,
            treeRevision: 0,
            documentRevision: 0,
            ...reduceInteractionState(
                {
                    modelRevision: 0,
                    treeRevision: 0,
                    documentRevision: 0,
                    currentTool: "DRAW",
                    drawToolSettings: defaultDrawToolSettings(),
                    treeSnapshot: { rootChildren: [], items: {}, charToGroupId: {} },
                    sequenceTokens: [],
                    curvesById: {},
                    nodesByMarkerId: {},
                    clipboardSummary: { canPaste: false, count: 0, firstType: null },
                    selectionBoundsTransform: null
                },
                { type: "SEED_FROM_RUNTIME", payload: seed },
                canvas?.curve_manager
            )
        };
    }

    _isRestoring() {
        const canvas = this._getCanvas();
        return canvas?.is_restoring === true;
    }

    _isHistoryApplying() {
        const canvas = this._getCanvas();
        return canvas?.is_restoring === true || (canvas?.__historyApplyDepth || 0) > 0;
    }

    _bumpDocumentRevision() {
        this.state = {
            ...this.state,
            documentRevision: (this.state.documentRevision || 0) + 1
        };
    }

    commitCommand(actionOrDetail = {}) {
        if (this._isRestoring() || !this._recordHistory) return false;
        const detail = normalizeCommandCommitDetail(actionOrDetail);
        const recorded = this._recordHistory(detail);
        if (recorded !== false) {
            this._bumpDocumentRevision();
            this.syncHistoryStacks();
            this.emit('COMMAND_COMMITTED', {
                commandName: detail.commandName,
                payload: detail.payload
            });
        }
        return recorded !== false;
    }

    async undo() {
        if (!this._undoHistory) return undefined;
        const result = await this._undoHistory();
        this.syncHistoryStacks();
        return result;
    }

    async redo() {
        if (!this._redoHistory) return undefined;
        const result = await this._redoHistory();
        this.syncHistoryStacks();
        return result;
    }

    getState() {
        const snap = this._snapshotState(this.state);
        return snap;
    }

    _snapshotState(state = this.state) {
        return snapshotStoreState(state);
    }

    _stateEquals(a, b) {
        return storeStatesEqual(a, b);
    }

    /**
     * Interaction state writes without dispatch (draw point insertion, tool-internal selection, etc.): Store is the single source of truth.
     */
    commitInteraction(action, { emit = true } = {}) {
        if (!action?.type || this._isHistoryApplying()) return false;
        const canvas = this._getCanvas();
        const cm = canvas?.curve_manager;
        const beforeState = this._snapshotState(this.state);
        let next = reduceInteractionState(this.state, action, cm);
        next = finalizeInteractionState(next, cm, action.type);
        if (cm) {
            next = { ...next, ...pickInteractionReadFields(cm, next) };
        }
        if (this._stateEquals(this.state, next)) return false;
        this.state = next;
        this._applyInteractionToRuntime(action.type);
        if (emit) {
            this._emitPayload(action, beforeState, true);
        }
        return true;
    }

    _applyInteractionToRuntime(actionType) {
        const canvas = this._getCanvas();
        if (!canvas) return;
        canvas.__interactionApplyFromStore = true;
        try {
            applyInteractionFromStore(canvas, this.state, { actionType });
        } finally {
            canvas.__interactionApplyFromStore = false;
        }
    }

    /**
     * After CM.validateSelection etc. trim the selection: write via commitInteraction (no reconcile/absorb allowed).
     */
    commitRuntimeSelectionPatch() {
        if (this._isHistoryApplying()) return false;
        const canvas = this._getCanvas();
        if (!canvas || canvas.__interactionApplyFromStore) return false;
        const action = buildRuntimeSelectionPatchAction(canvas);
        if (!action) return false;
        return this.commitInteraction(action, { emit: true });
    }

    restoreFromHistoryMeta(meta = {}, { type = "UNDO", commandName = null } = {}) {
        const canvas = this._getCanvas();
        const beforeState = this._snapshotState(this.state);
        const next = {
            ...this.state,
            ...storeInteractionFromHistoryMeta(meta),
            ...pickHistoryStackFields(canvas)
        };
        if (this._stateEquals(beforeState, next)) return false;
        this.state = next;
        this._emitPayload({ type, meta: { source: "history", commandName } }, beforeState, true);
        return true;
    }

    applyInteractionToRuntime() {
        this._applyInteractionToRuntime("HISTORY_APPLY");
    }

    bumpRevisionsAfterHistory() {
        const canvas = this._getCanvas();
        const cm = canvas?.curve_manager;
        const modelPatch = cm ? pickModelRevisionFields(cm, this.state) : {};
        const beforeState = this._snapshotState(this.state);
        const next = {
            ...this.state,
            modelRevision: (this.state.modelRevision || 0) + 1,
            treeRevision: (this.state.treeRevision || 0) + 1,
            documentRevision: (this.state.documentRevision || 0) + 1,
            ...modelPatch,
            ...pickViewFieldsFromCanvas(canvas, this.state),
            drawToolSettings: pickDrawToolFieldsFromCanvas(canvas)
        };
        if (this._stateEquals(beforeState, next)) return;
        this.state = next;
        this._emitPayload(
            { type: "HISTORY_REVISION", meta: { source: "history" } },
            beforeState,
            true
        );
    }

    /** @deprecated */
    applyFromHistoryMeta(meta = {}, options = {}) {
        this.restoreFromHistoryMeta(meta, options);
        this.applyInteractionToRuntime();
        this.bumpRevisionsAfterHistory();
    }

    mergeViewFromCanvas() {
        this._mergeViewAfterDispatch();
    }

    /** Write viewport into Store after pan/zoom (does not trigger full UI refresh) */
    syncViewFromCanvas() {
        const canvas = this._getCanvas();
        if (!canvas) return;
        const next = {
            ...this.state,
            ...pickViewFieldsFromCanvas(canvas, this.state)
        };
        if (this._stateEquals(this.state, next)) return;
        this.state = next;
    }

    seedFromCanvas({ emit = true, applyToRuntime = false } = {}) {
        const canvas = this._getCanvas();
        const seed = buildInteractionSeedFromCanvas(canvas);
        const beforeState = this._snapshotState(this.state);
        this.state = reduceInteractionState(
            this.state,
            { type: "SEED_FROM_RUNTIME", payload: seed },
            canvas?.curve_manager
        );
        if (applyToRuntime) {
            this._applyInteractionToRuntime("SEED_FROM_RUNTIME");
        }
        if (emit) {
            this._emitPayload({ type: "SEED_FROM_RUNTIME", meta: { source: "canvas" } }, beforeState, true);
        }
    }

    syncHistoryStacks() {
        const patch = pickHistoryStackFields(this._getCanvas());
        const next = { ...this.state, ...patch };
        if (
            next.commandStackSize === this.state.commandStackSize &&
            next.redoStackSize === this.state.redoStackSize
        ) {
            return;
        }
        const beforeState = this._snapshotState(this.state);
        this.state = next;
        this._emitPayload({ type: "SYNC_HISTORY_STACKS", meta: { source: "history" } }, beforeState, true);
    }

    _mergeViewAfterDispatch() {
        const canvas = this._getCanvas();
        if (!canvas) return;
        const next = {
            ...this.state,
            ...pickViewFieldsFromCanvas(canvas, this.state),
            ...pickHistoryStackFields(canvas)
        };
        if (this._stateEquals(this.state, next)) return;
        this.state = next;
    }

    _preDispatchInteraction(action) {
        if (!INTERACTION_PAYLOAD_ACTIONS.has(action?.type)) return;
        if (action?.type === CANVAS_ACTIONS.SET_TOOL_MODE) {
            action.meta = { ...(action.meta || {}), previousTool: this.state.currentTool };
        }
        const canvas = this._getCanvas();
        const cm = canvas?.curve_manager;

        // Pre-set refIds/curveIds before reducer runs (belt-and-suspenders for 
        // CHANGE_OBJECT_SELECTION where the reducer may not propagate payload correctly).
        if (action?.type === CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION && action.payload) {
            const p = action.payload;
            if (p.strategy === "replace") {
                if (p.refIds?.length) this.state.selectedRefIds = [...p.refIds];
                if (p.curveIds?.length || p.curveIds?.size) this.state.selectedCurveIds = [...p.curveIds];
            }
        }

        let next = reduceInteractionState(this.state, action, cm);
        next = finalizeInteractionState(next, cm, action.type);
        this.state = next;
        if (canvas) {
            canvas.__storeDispatchDepth = (canvas.__storeDispatchDepth || 0) + 1;
            this._applyInteractionToRuntime(action.type);
        }
    }

    _postDispatchInteraction(action) {
        const canvas = this._getCanvas();
        if (!canvas) return;
        if (INTERACTION_PAYLOAD_ACTIONS.has(action?.type)) {
            canvas.__storeDispatchDepth = Math.max(0, (canvas.__storeDispatchDepth || 1) - 1);
        }
        this._mergeViewAfterDispatch();
    }

    _emitPayload(actionLike, beforeSnapshot, result) {
        const afterSnapshot = this._snapshotState(this.state);
        this.emit(CANVAS_EVENTS.STATE_CHANGED, {
            action: {
                type: actionLike.type,
                payload: actionLike.payload ? { ...actionLike.payload } : {},
                meta: actionLike.meta ? { ...actionLike.meta } : {},
                timestamp: Date.now()
            },
            beforeState: beforeSnapshot,
            afterState: afterSnapshot,
            state: afterSnapshot,
            result,
            timestamp: Date.now()
        });
    }

    _emitStateChanged(action, beforeSnapshot, afterSnapshot, result) {
        const after = afterSnapshot ?? this._snapshotState(this.state);
        const before = beforeSnapshot ?? after;
        this.emit(CANVAS_EVENTS.STATE_CHANGED, {
            action: {
                type: action.type,
                payload: action.payload ? { ...action.payload } : {},
                meta: action.meta ? { ...action.meta } : {},
                timestamp: action.timestamp ?? Date.now()
            },
            beforeState: before,
            afterState: after,
            state: after,
            result,
            timestamp: Date.now()
        });
    }

    _finalizeDispatch(action, beforeSnapshot, result) {
        this._postDispatchInteraction(action);
        if (shouldCommitCommandAfterDispatch(action, result)) {
            this.commitCommand(action);
        }
        const afterSnapshot = this._snapshotState(this.state);
        if (!this._stateEquals(beforeSnapshot, afterSnapshot)) {
            this._emitStateChanged(action, beforeSnapshot, afterSnapshot, result);
        }
    }

    dispatchAction(action, executor = null) {
        const isHistoryNav =
            action?.type === CANVAS_ACTIONS.UNDO || action?.type === CANVAS_ACTIONS.REDO;
        const beforeSnapshot = this._snapshotState(this.state);
        const run = typeof executor === "function" ? executor : () => undefined;

        if (!isHistoryNav) {
            this._preDispatchInteraction(action);
        }

        let result;
        try {
            result = run(action);
        } catch (error) {
            const canvas = this._getCanvas();
            if (INTERACTION_PAYLOAD_ACTIONS.has(action?.type) && canvas) {
                canvas.__storeDispatchDepth = Math.max(0, (canvas.__storeDispatchDepth || 1) - 1);
            }
            throw error;
        }

        if (result && typeof result.then === "function") {
            return result.then((resolved) => {
                if (isHistoryNav) return resolved;
                this._finalizeDispatch(action, beforeSnapshot, resolved);
                return resolved;
            });
        }

        if (isHistoryNav) return result;
        this._finalizeDispatch(action, beforeSnapshot, result);
        return result;
    }

    bumpModelRevision() {
        const canvas = this._getCanvas();
        const cm = canvas?.curve_manager;
        const modelPatch = cm ? pickModelRevisionFields(cm, this.state) : {};

        let draggingNodeId = null;
        if (canvas?.dragging_node_marker && cm) {
            draggingNodeId = canvas.dragging_node_marker.id || null;
            if (draggingNodeId && !modelPatch.nodesByMarkerId?.[draggingNodeId]) {
                const node = cm.find_node_by_curve?.(canvas.dragging_node_marker);
                if (node) {
                    modelPatch.nodesByMarkerId = {
                        ...(modelPatch.nodesByMarkerId || {}),
                        [draggingNodeId]: {
                            x: node.x,
                            y: node.y,
                            control1: node.control1 ? { x: node.control1.x, y: node.control1.y } : null,
                            control2: node.control2 ? { x: node.control2.x, y: node.control2.y } : null
                        }
                    };
                }
            }
        }

        const beforeState = this._snapshotState(this.state);
        const next = {
            ...this.state,
            modelRevision: (this.state.modelRevision || 0) + 1,
            treeRevision: (this.state.treeRevision || 0) + 1,
            draggingNodeId,
            ...modelPatch
        };
        if (this._stateEquals(beforeState, next)) return;
        this.state = next;
        this._emitPayload(
            { type: "MODEL_REVISION", meta: { source: "model" } },
            beforeState,
            true
        );
    }

    bumpTreeRevision() {
        const cm = this._getCanvas()?.curve_manager;
        const treeSnapshot = cm ? pickModelRevisionFields(cm).treeSnapshot : this.state.treeSnapshot;
        const seqPatch = cm ? pickSequenceFields(cm) : {};
        const beforeState = this._snapshotState(this.state);
        const next = {
            ...this.state,
            treeRevision: (this.state.treeRevision || 0) + 1,
            treeSnapshot,
            ...seqPatch
        };
        if (this._stateEquals(beforeState, next)) return;
        this.state = next;
        this._emitPayload(
            { type: "TREE_REVISION", meta: { source: "tree" } },
            beforeState,
            true
        );
    }
}
