// js/presentation/canvas/tools/draw_tool.js — DRAW/钢笔工具：路径创建、控制柄绘制
import { BaseTool } from "./base_tool.js";
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";
import {
    snapshotIncludesNodeMarker
} from "../../../app/editor_interaction_state.js";

export class DrawTool extends BaseTool {
    // =========================================================================
    // MouseDown
    // =========================================================================

    handleMouseDown(mouseX, mouseY, worldX_raw, worldY) {
        const c = this.canvas;
        if (c.curve_manager.activeSequenceIndices.size === 0) return;
        let activeGroupId = c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) return;
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
        if (c.current_curve?.id) {
            c.setInteractiveStrokePreviewCurveIds?.([c.current_curve.id]);
        }
        c.renderer.update_previewData(mouseX, mouseY);
        c.is_dirty = true;
    }

    // =========================================================================
    // Node hit（绘制中点击起点闭合路径）
    // =========================================================================

    handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker) {
        const c = this.canvas;
        if (c.current_curve && hitMarker === c.current_curve.startNode.main_node) {
            c.current_state = 'PAINTING_HANDLE';
            c.painting_handle_start = { x: mouseX, y: mouseY };
            c.closing_path_on_mouseup = true;
            c.renderer.update_previewData(mouseX, mouseY);
            c.is_dirty = true;
            return true; // handled
        }
        return false; // not handled, let NodeTool take over
    }

    // =========================================================================
    // MouseMove: 控制柄拖拽
    // =========================================================================

    handleMouseMovePaintingHandle(mouseX, mouseY) {
        const c = this.canvas;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        let seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
        const worldX = (mouseX - offsetX) / c.scale - seqOffsetX;
        const worldY = (mouseY - offsetY) / c.scale;

        if (!c.last_on_curve_node_marker || !c.current_curve) return;

        if (c.new_curve_handle === null && (Math.abs(mouseX - c.painting_handle_start.x) > 1 || Math.abs(mouseY - c.painting_handle_start.y) > 1)) {
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, 2, true);
            let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!last_node_n?.control1?.main_node || !last_node_n.control2?.main_node) return;
            c.new_curve_handle = last_node_n.control1.main_node;

            let other_x = 2 * last_node_n.x - worldX, other_y = 2 * last_node_n.y - worldY;
            c.curve_manager.adjustControlNode(last_node_n.control1.main_node, worldX, worldY);
            c.curve_manager.adjustControlNode(last_node_n.control2.main_node, other_x, other_y);
            c.is_dirty = true;
        } else if (c.new_curve_handle !== null) {
            let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!last_node_n?.control1?.main_node || !last_node_n.control2?.main_node) return;
            let other_x = 2 * last_node_n.x - worldX, other_y = 2 * last_node_n.y - worldY;

            c.curve_manager.adjustControlNode(last_node_n.control1.main_node, worldX, worldY);
            c.curve_manager.adjustControlNode(last_node_n.control2.main_node, other_x, other_y);
            c.is_dirty = true;
        }
    }

    // =========================================================================
    // MouseUp: 控制柄释放
    // =========================================================================

    handlePaintHandleMouseUp(e) {
        const c = this.canvas;
        let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
        if (last_node_n) {
            const mode = (c.new_curve_handle !== null) ? 1 : 0;
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, mode);
        }
        c.new_curve_handle = null;
        c.current_state = 'IDLE';
        c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
        c.dragging_node_matrix = null; c.dragging_node_refId = null;

        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
        c.renderer.update_previewData(pointer.x, pointer.y);

        const paintCurveId = c.current_curve?.id;
        c.clearInteractiveStrokePreview?.();
        if (paintCurveId) c.flushSmartStrokeBooleanCache?.([paintCurveId]);

        if (c.closing_path_on_mouseup && c.current_curve) {
            c.current_curve.closed = true;
            c.commands.finishAddingPathCommand();
        } else {
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
        }
    }

    // =========================================================================
    // 右键完成路径
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
        c.previewData = null;
        c.dragging_node_marker = null;
    }
}
