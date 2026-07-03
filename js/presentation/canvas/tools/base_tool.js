// js/presentation/canvas/tools/base_tool.js — Tool base class + shared helpers
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";
import {
    createNodeMarkerIdSet,
    resolveCurvesFromSnapshot,
    resolveMarkerById,
    resolveMarkersFromStore,
    resolveRefsFromSnapshot,
    snapshotIncludesCurve,
    snapshotIncludesNodeMarker,
    snapshotIncludesRef
} from "../../../app/editor_interaction_state.js";

/**
 * BaseTool: base class for all tools, provides shared helper methods.
 *
 * Lifecycle:
 * constructor -> (handleMouseDown -> handleMouseMove -> handleMouseUp)* -> destructor
 *
 * Tool rules (all tools MUST follow):
 * 1. Tools are only responsible for INPUT HANDLING and PREVIEW UPDATES.
 *    Final data changes MUST go through CanvasCommands.*
 * 2. Tools MUST NOT directly modify CurveManager data.
 * 3. Tool switching is handled by CanvasController which cleans up previous tool state.
 *
 * Subclasses only need to implement handleMouseDown / handleMouseMove / handleMouseUp.
 */
export class BaseTool {
    constructor(canvas, interactionController) {
        /** @type {import('../main_canvas.js').MainCanvasBase} */
        this.canvas = canvas;
        /** @type {import('../canvas_interaction_controller.js').CanvasInteractionController} */
        this.ic = interactionController;
    }

    // =========================================================================
    // Selection request helper
    // =========================================================================

    requestObjectSelection(strategy, { curves = [], refs = [], curve = null, refId = null } = {}) {
        const curveIds =
            curves.length > 0
                ? curves.map((entry) => entry?.id).filter(Boolean)
                : curve?.id
                    ? [curve.id]
                    : [];
        const refIds =
            refs.length > 0
                ? refs.map((entry) => entry?.id).filter(Boolean)
                : refId
                    ? [refId]
                    : [];
        CanvasDispatcher.requestChangeObjectSelection(strategy, { curveIds, refIds });
    }

    requestNodeSelection(strategy, markers = [], refId = null) {
        const markerIds = markers
            .map((m) => (m && typeof m === "object" ? m.id : m))
            .filter(Boolean);
        CanvasDispatcher.requestChangeNodeSelection(strategy, { markerIds, refId });
    }

    setFocusedSequenceIndex(index) {
        const store = this.canvas.editorStore;
        if (!store?.commitInteraction) return;
        const idx = typeof index === "number" ? index : -1;
        store.commitInteraction({
            type: "SET_FOCUSED_SEQUENCE_INDEX",
            payload: { index: idx }
        });
    }

    // =========================================================================
    // Preview key collection (stroke preview)
    // =========================================================================

    pushPreviewKeys(keys, curveId, refId = null) {
        if (!curveId) return;
        if (refId) keys.add(`${curveId}::${refId}`);
        keys.add(curveId);
    }

    pushCurvesFromGroup(keys, cm, groupId, refInstanceId = null) {
        if (!groupId) return;
        for (const cd of cm.getCurvesForGroup(groupId)) {
            if (!cd.curve?.id) continue;
            this.pushPreviewKeys(keys, cd.curve.id, cd.refId ?? refInstanceId);
        }
    }

    collectInteractiveStrokePreviewCurveIds() {
        return this.ic.collectInteractiveStrokePreviewCurveIds();
    }

    previewKeysFromTransformContexts(curveContexts = []) {
        const keys = new Set();
        for (const info of curveContexts) {
            this.pushPreviewKeys(keys, info.curve?.id, info.previewRefId ?? null);
        }
        return keys;
    }

    // =========================================================================
    // Box-select helper
    // =========================================================================

    getBoxSelectRectWorld() {
        const c = this.canvas;
        if (!c.box_select_start || !c.box_select_end) return { x: 0, y: 0, w: 0, h: 0 };
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const startWorldX = (c.box_select_start.x - offsetX) / c.scale;
        const startWorldY = (c.box_select_start.y - offsetY) / c.scale;
        const endWorldX = (c.box_select_end.x - offsetX) / c.scale;
        const endWorldY = (c.box_select_end.y - offsetY) / c.scale;
        return {
            x: Math.min(startWorldX, endWorldX), y: Math.min(startWorldY, endWorldY),
            w: Math.abs(endWorldX - startWorldX), h: Math.abs(endWorldY - startWorldY)
        };
    }

    // =========================================================================
    // Default implementation (subclasses may override)
    // =========================================================================

    handleMouseDown() {}
    handleMouseMove() {}
    handleMouseUp() {}
}
