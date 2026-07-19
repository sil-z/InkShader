// js/presentation/canvas/canvas_interaction_controller.js — Tool dispatcher (delegates to specialized tools)
import { buildMarkerIdIndex } from "../../domain/selection/marker_resolution.js";
import { resolveCurvesFromSnapshot, resolveRefsFromSnapshot } from "../../domain/selection/interaction_snapshot_query.js";
import { TransformTool } from "./tools/transform_tool.js";
import { SelectTool } from "./tools/select_tool.js";
import { DrawTool } from "./tools/draw_tool.js";
import { NodeTool } from "./tools/node_tool.js";
import { MeasureTool } from "./tools/measure_tool.js";
import { EllipseTool } from "./tools/ellipse_tool.js";

/**
 * CanvasInteractionController: thin dispatcher layer, delegates mouse events to corresponding tools.
 * Each tool (Select/Draw/Node/Measure) manages its own interaction logic independently.
 * TransformTool is shared by Select and Node.
 *
 * Hover system (hit detection and visual feedback):
 * - Nodes: hitTestNode() -> highlight + hovered_node_marker
 * - Curve segments: hitTestCurve() -> highlight + hovered_curve_segment
 * - Transform handles: hitTestTransformHandles() -> cursor (nwse/nesw/ns/ew/crosshair)
 * - Curves: hit -> move cursor if selected, default otherwise
 * - User guidelines: hitTestUserGuides() -> ew-resize / ns-resize cursor
 * - Dividers: hitTestDividerLines() -> ew-resize cursor
 * - Measure ruler endpoints: _hitTestRulerEndpoint() -> draggable indicator
 * - Measure ruler lines: _hitTestRulerLine() -> actionable indicator
 */
export class CanvasInteractionController {
    constructor(canvas) {
        this.canvas = canvas;

        this.transformTool = new TransformTool(canvas, this);
        this.selectTool = new SelectTool(canvas, this);
        this.drawTool = new DrawTool(canvas, this);
        this.nodeTool = new NodeTool(canvas, this);
        this.measureTool = new MeasureTool(canvas, this);
        this.ellipseTool = new EllipseTool(canvas, this);
    }

    // =========================================================================
    // Preview key collection (shared across tools)
    // =========================================================================

    _pushPreviewKeys(keys, curveId, refId = null) {
        if (!curveId) return;
        if (refId) keys.add(`${curveId}::${refId}`);
        keys.add(curveId);
    }

    _pushCurvesFromGroup(keys, cm, groupId, refInstanceId = null) {
        if (!groupId) return;
        for (const cd of cm.getCurvesForGroup(groupId)) {
            if (!cd.curve?.id) continue;
            this._pushPreviewKeys(keys, cd.curve.id, cd.refId ?? refInstanceId);
        }
    }

    collectInteractiveStrokePreviewCurveIds() {
        const c = this.canvas;
        const cm = c.curve_manager;
        const ix = c.getInteractionSnapshot();
        const nodeRefId = c.editorStore?.getState?.()?._nodeSelectionRefId ?? null;
        const keys = new Set();

        if (c.current_curve?.id) this._pushPreviewKeys(keys, c.current_curve.id, null);

        for (const curve of resolveCurvesFromSnapshot(ix, cm)) {
            this._pushPreviewKeys(keys, curve.id, null);
        }

        for (const ref of resolveRefsFromSnapshot(ix, cm)) {
            if (ref?.type === "curve" && ref.curveId) {
                this._pushPreviewKeys(keys, ref.curveId, ref.id);
                continue;
            }
            if (ref?.isRef && ref.refId) {
                this._pushCurvesFromGroup(keys, cm, ref.refId, ref.id);
            }
        }

        const pushMarker = (marker, refIdOverride = undefined) => {
            const curve = cm.find_curve_by_dom(marker);
            if (!curve?.id) return;
            const refId = refIdOverride !== undefined ? refIdOverride : nodeRefId;
            this._pushPreviewKeys(keys, curve.id, refId);
        };

        // Build index once O(|domMap|), not resolveMarkerById per marker O(|selected| × |domMap|)
        const markerIndex = ix.selectedNodeMarkerIds?.size > 0 ? buildMarkerIdIndex(cm) : null;
        if (markerIndex) {
            for (const markerId of ix.selectedNodeMarkerIds) {
                const entry = markerIndex.get(markerId);
                if (entry?.marker) pushMarker(entry.marker);
            }
        }
        if (c.dragging_node_marker) {
            pushMarker(c.dragging_node_marker, c.dragging_node_refId || null);
        }

        return [...keys];
    }

    // =========================================================================
    // Box-select rectangle (shared across tools)
    // =========================================================================

    getBoxSelectRectWorld() {
        return this.selectTool.getBoxSelectRectWorld();
    }

    // =========================================================================
    // Drawing reset
    // =========================================================================

    resetCurveDrawing() {
        const c = this.canvas;
        if (!c.current_curve) return;
        c.commands.finishAddingPathCommand();
    }

    // =========================================================================
    // MouseDown delegation
    // =========================================================================

    handleMeasureMouseDown(worldX, worldY) {
        this.measureTool.handleMouseDown(worldX, worldY);
    }

    handleMeasureMouseMove(mouseX, mouseY) {
        this.measureTool.handleMouseMove(mouseX, mouseY);
    }

    handleMeasureMouseUp() {
        this.measureTool.handleMouseUp();
    }

    handleSelectMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, isShiftKey, clientX, clientY) {
        this.selectTool.handleMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, isShiftKey, clientX, clientY);
    }

    handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, isShiftKey, isCtrlKey) {
        const c = this.canvas;
        const tool = c.getActiveTool();

        // DRAW tool click on start point → close path
        if (tool === "DRAW" && c.current_curve && hitMarker === c.current_curve.startNode.main_node) {
            this.drawTool.handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker);
            return;
        }

        // NODE tool or DRAW tool node dragging
        this.nodeTool.handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, isShiftKey, isCtrlKey);
    }

    handleNodeMissMouseDown(mouseX, mouseY, isShiftKey) {
        this.nodeTool.handleNodeMissMouseDown(mouseX, mouseY, isShiftKey);
    }

    handleDrawMouseDown(mouseX, mouseY, worldX_raw, worldY) {
        this.drawTool.handleMouseDown(mouseX, mouseY, worldX_raw, worldY);
    }

    handleEllipseMouseDown(mouseX, mouseY, worldX, worldY, isCtrl) {
        this.ellipseTool.handleMouseDown(mouseX, mouseY, worldX, worldY, isCtrl);
    }

    handleEllipseMouseMove(mouseX, mouseY, worldX, worldY, isCtrl) {
        this.ellipseTool.handleMouseMove(mouseX, mouseY, worldX, worldY, isCtrl);
    }

    handleEllipseMouseUp() {
        this.ellipseTool.handleMouseUp();
    }

    // =========================================================================
    // MouseMove delegation
    // =========================================================================

    handleMouseMovePaintingHandle(mouseX, mouseY) {
        this.drawTool.handleMouseMovePaintingHandle(mouseX, mouseY);
    }

    handleMouseMoveTransforming(mouseX, mouseY, clientX, clientY, isCtrlPressed, isShiftPressed) {
        this.transformTool.handleMouseMove(mouseX, mouseY, clientX, clientY, isCtrlPressed, isShiftPressed);
    }

    handleMouseMoveDraggingNode(mouseX, mouseY, isCtrlPressed) {
        this.nodeTool.handleMouseMoveDraggingNode(mouseX, mouseY, isCtrlPressed);
    }

    // =========================================================================
    // MouseUp delegation
    // =========================================================================

    handleTransformMouseUp() {
        this.transformTool.handleMouseUp();
    }

    handleSelectBoxMouseUp(mouseX, mouseY, isShiftKey) {
        this.selectTool.handleBoxMouseUp(mouseX, mouseY, isShiftKey);
    }

    handleNodeBoxMouseUp(mouseX, mouseY, isShiftKey) {
        this.nodeTool.handleNodeBoxMouseUp(mouseX, mouseY, isShiftKey);
    }

    handleNodeDragMouseUp(e) {
        this.nodeTool.handleNodeDragMouseUp(e);
    }

    handlePaintHandleMouseUp(e) {
        this.drawTool.handlePaintHandleMouseUp(e);
    }

    // =========================================================================
    // Wheel delegation
    // =========================================================================

    actionSpiralMove(anchorNode, isExpanding) {
        this.nodeTool.actionSpiralMove(anchorNode, isExpanding);
    }
}
