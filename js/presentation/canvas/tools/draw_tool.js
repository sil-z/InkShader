// js/presentation/canvas/tools/draw_tool.js — DRAW/pen tool: path creation, handle drawing
import { BaseTool } from "./base_tool.js";
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";
import {
    snapshotIncludesNodeMarker
} from "../../../app/editor_interaction_state.js";

/**
 * DRAW (pen) tool: Bezier path creation, handle drawing.
 *
 * Interaction:
 * - Click canvas (no current path): creates new path
 * - Click canvas (has path): adds main node
 * - Click + drag: pulls out symmetric handles, sets smooth mode on release
 * - Click path start point: closes path + commits history
 * - Right-click: completes path (closes if drawToolSettings.closed)
 * - Ctrl+Z (during draw): reverts last main node (no history write)
 * - Tool switch: auto-completes current path
 *
 * Default properties: stroke_width=0, closed=true, smart_expand=true, show_skeleton=true
 */
export class DrawTool extends BaseTool {
    // =========================================================================
    // MouseDown
    // =========================================================================

    handleMouseDown(mouseX, mouseY, worldX_raw, worldY) {
        const c = this.canvas;
        // Read from Store first (source of truth); CM projection may lag behind async event bus
        let activeGroupId = c.commandHostPort?.getStoreState?.()?.activeGroupId;
        // Verify the group still exists in the current tree.  The store's activeGroupId
        // can be stale (from a previous project) if seedFromCanvas hasn't completed yet,
        // or after createNewProject — using a non-existent group leads to a phantom
        // preview that never commits on mouse-up.
        if (activeGroupId && !c.curve_manager.treeItems.has(activeGroupId)) {
            activeGroupId = null;
        }
        activeGroupId = activeGroupId ?? c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) {
            // No group to draw in — reset stale state to prevent phantom preview
            c.previewData = null;
            c.last_on_curve_node_marker = null;
            c.is_dirty = true;
            return;
        }
        // Do not draw on a locked group
        const activeGroup = c.curve_manager.treeItems.get(activeGroupId);
        if (activeGroup && activeGroup.locked) return;
        c.commands.syncActiveGroupForDraw(activeGroupId);

        let seqOffsetX;
        if (c.current_curve === null) {
            let seqTokens = c.curve_manager.sequenceTokens;
            let activeIndices = Array.from(c.curve_manager.activeSequenceIndices).sort((a, b) => a - b);
            let targetSeqIdx = -1;
            for (let idx of activeIndices) {
                let t = seqTokens[idx];
                let gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                if (gid === activeGroupId) { targetSeqIdx = idx; break; }
            }
            if (targetSeqIdx === -1) {
                for (let i = 0; i < seqTokens.length; i++) {
                    let t = seqTokens[i];
                    let gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                    if (gid === activeGroupId) { targetSeqIdx = i; break; }
                }
            }
            seqOffsetX = targetSeqIdx !== -1 ? c.curve_manager.getSeqOffset(targetSeqIdx) : 0;

            if (!c.commands.startAddingPath(activeGroupId, seqOffsetX)) return;
        } else seqOffsetX = c.drawing_seq_offset;

        const worldX = worldX_raw - seqOffsetX;
        c.closing_path_on_mouseup = false;
        c.commands.addMainNode(worldX, worldY);

        c.current_state = 'PAINTING_HANDLE';
        c.painting_handle_start = { x: mouseX, y: mouseY };
        // Preview hidden on press (requirement: no ghost preview during handle drag).
        c.previewData = null;
        c.is_dirty = true;
    }

    // =========================================================================
    // Node hit (click start point during drawing to close path)
    // =========================================================================

    handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker) {
        const c = this.canvas;
        if (c.current_curve && hitMarker === c.current_curve.startNode.main_node) {
            c.current_curve.closed = true;
            c.commands.finishAddingPathCommand();
            c.current_state = "IDLE";
            c.previewData = null;
            return true;
        }
        return false;
    }

    // =========================================================================
    // MouseMove: handle dragging
    // =========================================================================

    handleMouseMovePaintingHandle(mouseX, mouseY) {
        const c = this.canvas;
        c._paintMoveCount = (c._paintMoveCount || 0) + 1;
        const moveSeq = c._paintMoveCount;

        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        let seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
        const worldX = (mouseX - offsetX) / c.scale - seqOffsetX;
        const worldY = (mouseY - offsetY) / c.scale;

        if (!c.last_on_curve_node_marker || !c.current_curve) return;

        // Defer adjustControlNode to rAF render tick (_renderPaintHandlePreview):
        // batching multiple mousemove events into a single geometry update per
        // frame avoids wasting half the calls (mousemove can fire at 120+ Hz while
        // rAF maxes at 60 Hz) and eliminates the ~34ms handler delay.
        if (c.new_curve_handle === null && (Math.abs(mouseX - c.painting_handle_start.x) > 1 || Math.abs(mouseY - c.painting_handle_start.y) > 1)) {
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, 2, true);
            let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!last_node_n?.control1?.main_node || !last_node_n.control2?.main_node) return;
            c.new_curve_handle = last_node_n.control1.main_node;
            c._pendingPaintPos = { worldX, worldY };
            c.is_dirty = true;
        } else if (c.new_curve_handle !== null) {
            c._pendingPaintPos = { worldX, worldY };
            c.is_dirty = true;
        }

    }

    // =========================================================================
    // MouseUp: handle release
    // =========================================================================

    handlePaintHandleMouseUp(e) {
        const c = this.canvas;
        let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
        if (last_node_n) {
            const mode = (c.new_curve_handle !== null) ? 1 : 0;
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, mode);
        }
        c.new_curve_handle = null;
        c._pendingPaintPos = null;
        c.current_state = 'IDLE';
        c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
        c.dragging_node_matrix = null; c.dragging_node_refId = null;

        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
        c.renderer.update_previewData(pointer.x, pointer.y);

        const paintCurveId = c.current_curve?.id;
        c.clearInteractiveStrokePreview?.();
        if (paintCurveId) c.flushSmartStrokeBooleanCache?.([paintCurveId]);

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    // =========================================================================
    // Right-click complete path
    // =========================================================================

    handleContextMenu() {
        const c = this.canvas;
        if (c.current_curve?.startNode) {
            if (c.drawToolSettings?.closed) c.current_curve.closed = true;
            c.commands.finishAddingPathCommand();
        } else if (c.current_curve) {
            c.commands.finishAddingPath();
        }
        c.current_state = "IDLE";
        c.closing_path_on_mouseup = false;
        c.new_curve_handle = null;
        c._pendingPaintPos = null;
        c.previewData = null;
        c.dragging_node_marker = null;
    }
}
