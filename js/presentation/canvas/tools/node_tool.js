// js/presentation/canvas/tools/node_tool.js — NODE tool: node selection, drag, box-select, snap
import { TransformEngine } from "../../../core/transform_engine.js";
import { BaseTool } from "./base_tool.js";
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";
import {
    createNodeMarkerIdSet,
    resolveMarkersFromStore,
    snapshotIncludesNodeMarker
} from "../../../app/editor_interaction_state.js";

/**
 * NODE tool: node selection, box-select, drag nodes (with snapping), handle editing, scroll-wheel spiral selection.
 *
 * Click interaction:
 * - Click main node: no modifier = replace, Ctrl = toggle, Shift = add
 * - Click blank area: clear
 * - Drag node: moves selected nodes with POINT SNAPPING (threshold 5/scale);
 *   Ctrl = AXIS LOCK (keep the larger absolute axis component)
 * - Drag handle: angle snapping; Ctrl locks to initial angle +/- n*5deg unioned with opposite handle angle
 * - Box select: blank area drag starts rectangle box-select
 * - Scroll wheel: when hovering a node, scroll up expands selection range, down contracts
 * - Release: commits changeSelectedNodesPosition / changeControlNodePosition
 *
 * Scroll wheel selection:
 * When mouse pointer is above a node, scroll UP selects the node, DOWN deselects.
 * Skips when at sequence end or node already at target state.
 * Does not affect other nodes' selection state.
 *
 * Node snapping (three modes):
 * - Point snap (default): drag main node, auto-snaps to other visible main nodes'
 *   horizontal/vertical/coincident alignment. Threshold 5/scale.
 * - Axis lock: Ctrl + drag main node, displacement keeps only the larger
 *   absolute horizontal or vertical component.
 * - Handle angle constraint: Ctrl + drag handle, angle locked to closest among:
 *   initial angle +/- n*5deg and opposite handle angle.
 * Releasing Ctrl during drag unlocks constraint, resumes free drag.
 */
export class NodeTool extends BaseTool {
    // =========================================================================
    // MouseDown: node hit
    // =========================================================================

    handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, isShiftKey, isCtrlKey) {
        const c = this.canvas;
        if (hitResult.seqIndex !== undefined) this.setFocusedSequenceIndex(hitResult.seqIndex);

        c.dragging_node_start = { x: mouseX, y: mouseY };
        c.current_state = 'DRAGGING_NODE_READY';
        c.dragging_node_marker = hitMarker;
        c.dragging_node_seq_idx = hitResult.seqIndex;
        c.dragging_node_matrix = hitResult.matrix;
        c.dragging_node_refId = hitResult.refId;

        if (!c.current_curve) {
            let token = c.curve_manager.sequenceTokens[hitResult.seqIndex];
            if (token) {
                const groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                CanvasDispatcher.requestSetActiveGroup(groupId);
            }
        }

        let dragged_n = c.curve_manager.find_node_by_curve(hitMarker);
        let isMainNode = dragged_n.type !== null;
        let parentMainNode = isMainNode ? dragged_n : (dragged_n.nextOnCurve || dragged_n.lastOnCurve);
        let parentMarker = parentMainNode.main_node;
        parentMainNode.last_touched = Date.now();

        let isAlreadySelected = snapshotIncludesNodeMarker(c.getInteractionSnapshot(), parentMarker);
        const refId = hitResult.refId || null;
        c.ctrl_click_added_selection = false;
        if (isMainNode) {
            if (isCtrlKey) {
                if (!isAlreadySelected) {
                    this.requestNodeSelection("toggle", [parentMarker], refId);
                    c.ctrl_click_added_selection = true;
                }
            } else if (isShiftKey) {
                this.requestNodeSelection("add", [parentMarker], refId);
            } else if (!isAlreadySelected) {
                this.requestNodeSelection("replace", [parentMarker], refId);
            }
            c.new_selected_temp = parentMarker;
        }

        c.drag_initial_mouse = { x: mouseX, y: mouseY };
        c.drag_initial_nodes.clear();
        for (const marker of resolveMarkersFromStore(c)) {
            const n = c.curve_manager.find_node_by_curve(marker);
            if (n) {
                c.drag_initial_nodes.set(marker, {
                    x: n.x, y: n.y,
                    c1x: n.control1?.x, c1y: n.control1?.y,
                    c2x: n.control2?.x, c2y: n.control2?.y
                });
            }
        }

        c.drag_initial_target = { x: dragged_n.x, y: dragged_n.y };
        if (dragged_n.type === null) {
            let p = dragged_n.nextOnCurve || dragged_n.lastOnCurve;
            c.drag_initial_target.px = p.x; c.drag_initial_target.py = p.y;
            c.drag_initial_target.angle = Math.atan2(dragged_n.y - p.y, dragged_n.x - p.x);
        }
        c.previewData = null;

        // Snapshot original node positions of all affected curves for drag ghost preview
        c.drag_preview = null;
        {
            const affectedCurveIds = new Set();
            for (const marker of c.drag_initial_nodes.keys()) {
                const n = c.curve_manager.find_node_by_curve(marker);
                if (n && n.curve) affectedCurveIds.add(n.curve.id);
            }
            if (affectedCurveIds.size > 0) {
                const nodePositions = new Map();
                for (const curveId of affectedCurveIds) {
                    const curve = c.curve_manager.curves.find(crv => crv.id === curveId);
                    if (!curve?.startNode) continue;
                    let current = curve.startNode;
                    while (current) {
                        nodePositions.set(current.main_node, {
                            x: current.x, y: current.y,
                            c1x: current.control1?.x ?? null,
                            c1y: current.control1?.y ?? null,
                            c2x: current.control2?.x ?? null,
                            c2y: current.control2?.y ?? null
                        });
                        current = current.nextOnCurve;
                    }
                }
                c.drag_preview = { curveIds: affectedCurveIds, nodePositions };
            }
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    // =========================================================================
    // MouseDown: no node hit (box-select start)
    // =========================================================================

    handleNodeMissMouseDown(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = true;
        c.box_select_start = { x: mouseX, y: mouseY };
        c.box_select_end = { x: mouseX, y: mouseY };
        if (!isShiftKey) {
            this.requestObjectSelection("clear");
            this.setFocusedSequenceIndex(-1);
        } else {
            this.requestNodeSelection("clear", []);
        }
        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    // =========================================================================
    // MouseMove: node dragging
    // =========================================================================

    handleMouseMoveDraggingNode(mouseX, mouseY, isCtrlPressed) {
        const c = this.canvas;
        const dragging_node_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
        if (!dragging_node_n) return;

        const { local_dx, local_dy } = TransformEngine.calculateLocalDelta(
            mouseX - c.drag_initial_mouse.x, mouseY - c.drag_initial_mouse.y,
            c.scale, c.dragging_node_matrix
        );

        let raw_x = c.drag_initial_target.x + local_dx;
        let raw_y = c.drag_initial_target.y + local_dy;

        let snapped_x = raw_x;
        let snapped_y = raw_y;
        c.active_guidelines = [];

        let isMainNode = dragging_node_n.type !== null;
        let dragged_seq_offset = c.dragging_node_seq_idx !== -1 ? c.curve_manager.getSeqOffset(c.dragging_node_seq_idx) : 0;

        if (isCtrlPressed) {
            const snapResult = this.calculateAngleSnapping(dragging_node_n, isMainNode, local_dx, local_dy, raw_x, raw_y, dragged_seq_offset);
            snapped_x = snapResult.x; snapped_y = snapResult.y;
        } else {
            const snapResult = this.calculatePointSnapping(dragging_node_n, isMainNode, raw_x, raw_y, dragged_seq_offset);
            snapped_x = snapResult.x; snapped_y = snapResult.y;
        }

        if (isMainNode) {
            let actual_dx = snapped_x - c.drag_initial_target.x;
            let actual_dy = snapped_y - c.drag_initial_target.y;
            const updates = TransformEngine.calculateNodesTranslation(c.drag_initial_nodes, actual_dx, actual_dy);
            c.curve_manager.moveSelectedNodes(updates);
        } else {
            c.curve_manager.adjustControlNode(c.dragging_node_marker, snapped_x, snapped_y);
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    // =========================================================================
    // MouseUp: node drag release
    // =========================================================================

    handleNodeDragMouseUp(e) {
        const c = this.canvas;
        if (c.current_state === 'DRAGGING_NODE') c.active_guidelines = [];

        let isMainNode = false;
        let isStateChangingAction = (c.current_state === 'DRAGGING_NODE');

        if (c.dragging_node_marker) {
            let dragged_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
            if (dragged_n) {
                isMainNode = dragged_n.type !== null;
                let parentMainNode = isMainNode ? dragged_n : (dragged_n.nextOnCurve || dragged_n.lastOnCurve);
                let parentMarker = parentMainNode.main_node;

                if (c.current_state !== "DRAGGING_NODE" && !e.ctrlKey) {
                    this.requestNodeSelection("replace", [parentMarker], c.dragging_node_refId || null);
                } else if (e.ctrlKey && c.current_state !== "DRAGGING_NODE") {
                    if (!c.ctrl_click_added_selection && snapshotIncludesNodeMarker(c.getInteractionSnapshot(), parentMarker)) {
                        this.requestNodeSelection("toggle", [parentMarker], c.dragging_node_refId || null);
                    }
                }
            }
            c.new_selected_temp = null;
            c.ctrl_click_added_selection = false;
        }

        if (isStateChangingAction && isMainNode) {
            c.commands.changeSelectedNodesPosition();
            isStateChangingAction = false;
        } else if (isStateChangingAction && !isMainNode && c.dragging_node_marker) {
            let dragged_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
            if (dragged_n) {
                c.commands.changeControlNodePosition(c.dragging_node_marker, dragged_n.x, dragged_n.y);
                isStateChangingAction = false;
            }
        }

        c.current_state = 'IDLE';
        c.drag_preview = null;
        c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
        c.dragging_node_matrix = null; c.dragging_node_refId = null;

        const affectedCurveIds = this.collectInteractiveStrokePreviewCurveIds();
        c.clearInteractiveStrokePreview?.();
        c.flushSmartStrokeBooleanCache?.(affectedCurveIds);

        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
        c.renderer.update_previewData(pointer.x, pointer.y);
        c.notifyPropertiesUpdate(); c.is_dirty = true;

        if (isStateChangingAction) {
            CanvasDispatcher.requestHistoryCommit("node-drag-fallback", {});
        }
    }

    // =========================================================================
    // Box select: node selection
    // =========================================================================

    handleNodeBoxMouseUp(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = false;
        let dx = mouseX - c.box_select_start.x, dy = mouseY - c.box_select_start.y;
        let markersToSelect = [];
        let activeGroupFromBox = null;

        if (Math.hypot(dx, dy) > 4) {
            const rect = this.getBoxSelectRectWorld();
            let seqTokens = c.curve_manager.sequenceTokens || [];

            for (let i = 0; i < seqTokens.length; i++) {
                if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
                let seqOffsetX = c.curve_manager.getSeqOffset(i);
                let token = seqTokens[i];
                let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

                for (let cd of curveDataList) {
                    if (!cd.effectiveVis || cd.effectiveLock) continue;
                    let current = cd.curve.startNode;
                    while (current) {
                        let mx = current.x, my = current.y;
                        if (cd.matrix) {
                            const x = mx; const y = my;
                            mx = x * cd.matrix.a + y * cd.matrix.c + cd.matrix.e;
                            my = x * cd.matrix.b + y * cd.matrix.d + cd.matrix.f;
                        }
                        let wx = mx + seqOffsetX;
                        if (wx >= rect.x && wx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) {
                            markersToSelect.push({ marker: current.main_node, refId: cd.refId || null });
                            activeGroupFromBox = groupId;
                        }
                        current = current.nextOnCurve;
                    }
                }
            }
            if (activeGroupFromBox) CanvasDispatcher.requestSetActiveGroup(activeGroupFromBox);
            c.notifyPropertiesUpdate(); c.is_dirty = true;
        }

        if (markersToSelect.length > 0) {
            const markers = markersToSelect.map(e => e.marker);
            const refIds = markersToSelect.map(e => e.refId);
            if (!isShiftKey) this.requestNodeSelection("replace", markers, refIds[0] ?? null);
            else this.requestNodeSelection("add", markers, refIds[0] ?? null);
        } else if (!isShiftKey) {
            this.requestObjectSelection("clear");
        }
        if (Math.hypot(dx, dy) > 4) {
            CanvasDispatcher.requestHistoryCommit("node-box-selection", {});
        }
    }

    // =========================================================================
    // Snap calculation
    // =========================================================================

    calculateAngleSnapping(dragging_node_n, isMainNode, local_dx, local_dy, raw_x, raw_y, dragged_seq_offset) {
        const c = this.canvas;
        let snapped_x = raw_x, snapped_y = raw_y;
        if (isMainNode) {
            if (Math.abs(local_dx) > Math.abs(local_dy)) snapped_y = c.drag_initial_target.y;
            else snapped_x = c.drag_initial_target.x;
        } else {
            let parentNode = dragging_node_n.nextOnCurve || dragging_node_n.lastOnCurve;
            let px = parentNode.x, py = parentNode.y;
            let currentAngle = Math.atan2(raw_y - py, raw_x - px);
            let dist = Math.hypot(raw_x - px, raw_y - py);
            let candidateAngles = [];
            candidateAngles.push(Math.round(currentAngle * 180 / Math.PI / 5) * 5 * Math.PI / 180);
            candidateAngles.push(c.drag_initial_target.angle);

            let oppositeControl = parentNode.control1?.main_node === c.dragging_node_marker ? parentNode.control2 : parentNode.control1;
            if (oppositeControl) {
                let oppAng = Math.atan2(oppositeControl.y - py, oppositeControl.x - px);
                candidateAngles.push(oppAng); candidateAngles.push(oppAng + Math.PI);
            }

            let bestAngle = candidateAngles[0]; let minDiff = Infinity;
            for (let ang of candidateAngles) {
                let diff = Math.abs(currentAngle - ang);
                while (diff > Math.PI) diff = Math.abs(diff - 2 * Math.PI);
                if (diff < minDiff) { minDiff = diff; bestAngle = ang; }
            }
            snapped_x = px + dist * Math.cos(bestAngle); snapped_y = py + dist * Math.sin(bestAngle);
        }
        return { x: snapped_x, y: snapped_y };
    }

    calculatePointSnapping(dragging_node_n, isMainNode, raw_x, raw_y, dragged_seq_offset) {
        const c = this.canvas;
        let snapped_x = raw_x, snapped_y = raw_y;

        // Respect snap toggle flags; when both disabled, return raw position immediately
        const alignEnabled = c.snap_alignment_enabled !== false;
        const coincidentEnabled = c.snap_coincident_enabled !== false;
        if (!alignEnabled && !coincidentEnabled) {
            return { x: raw_x, y: raw_y };
        }

        let snapThresholdLogical = 5 / c.scale;
        let targets = [];
        let seqTokens = c.curve_manager.sequenceTokens || [];

        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

            for (let cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let current = cd.curve.startNode;
                while (current) {
                    const ixDrag = c.getInteractionSnapshot();
                    let isThisNodeMoving = isMainNode && snapshotIncludesNodeMarker(ixDrag, current.main_node);
                    const pt = (x, y) => {
                        let mx = x, my = y;
                        if (cd.matrix) {
                            let new_x = mx * cd.matrix.a + my * cd.matrix.c + cd.matrix.e;
                            let new_y = mx * cd.matrix.b + my * cd.matrix.d + cd.matrix.f;
                            mx = new_x; my = new_y;
                        }
                        return { x: mx + seqOffsetX, y: my };
                    };
                    if ((current.main_node !== c.dragging_node_marker) && !isThisNodeMoving) targets.push(pt(current.x, current.y));
                    current = current.nextOnCurve;
                }
            }
        }

        let bestDist = Infinity, pointMatch = null, xMatch = null, bestXDist = Infinity, yMatch = null, bestYDist = Infinity;
        let world_raw_x = raw_x, world_raw_y = raw_y;

        if (c.dragging_node_matrix) {
            let p = c.dragging_node_matrix.transformPoint({ x: raw_x, y: raw_y });
            world_raw_x = p.x; world_raw_y = p.y;
        }
        world_raw_x += dragged_seq_offset;

        for (let t of targets) {
            let dx = Math.abs(world_raw_x - t.x); let dy = Math.abs(world_raw_y - t.y); let d = Math.hypot(dx, dy);
            if (coincidentEnabled && d < snapThresholdLogical && d < bestDist) { bestDist = d; pointMatch = t; }
            if (alignEnabled && dx < snapThresholdLogical && dx < bestXDist) { bestXDist = dx; xMatch = t; }
            if (alignEnabled && dy < snapThresholdLogical && dy < bestYDist) { bestYDist = dy; yMatch = t; }
        }

        if (pointMatch) {
            let local = pointMatch;
            if (c.dragging_node_matrix) local = c.dragging_node_matrix.inverse().transformPoint({ x: pointMatch.x - dragged_seq_offset, y: pointMatch.y });
            else local = { x: pointMatch.x - dragged_seq_offset, y: pointMatch.y };
            snapped_x = local.x; snapped_y = local.y;
        } else {
            if (xMatch) {
                let p = { x: xMatch.x - dragged_seq_offset, y: world_raw_y };
                if (c.dragging_node_matrix) p = c.dragging_node_matrix.inverse().transformPoint(p);
                snapped_x = p.x; snapped_y = p.y; c.active_guidelines.push({ type: 'v', value: xMatch.x });
            }
            if (yMatch) {
                let p = { x: world_raw_x - dragged_seq_offset, y: yMatch.y };
                if (c.dragging_node_matrix) p = c.dragging_node_matrix.inverse().transformPoint(p);
                snapped_x = p.x; snapped_y = p.y; c.active_guidelines.push({ type: 'h', value: yMatch.y });
            }
        }
        return { x: snapped_x, y: snapped_y };
    }

    // =========================================================================
    // Spiral move (wheel)
    // =========================================================================

    actionSpiralMove(anchorNode, isExpanding) {
        const c = this.canvas;
        if (!anchorNode || !anchorNode.curve) return;
        const nodesArray = []; let curr = anchorNode.curve.startNode;
        while (curr) { nodesArray.push(curr); curr = curr.nextOnCurve; }
        const centerIdx = nodesArray.indexOf(anchorNode); const total = nodesArray.length;
        const selecting = createNodeMarkerIdSet(c.getInteractionSnapshot());

        const getIndexByStep = (s) => {
            if (s === 0) return centerIdx;
            const offset = Math.ceil(s / 2); return (s % 2 !== 0) ? (centerIdx + offset) : (centerIdx - offset);
        };

        for (let s = 0; s < total * 2; s++) {
            const idx = getIndexByStep(s);
            if (idx >= 0 && idx < total) {
                const marker = nodesArray[idx].main_node;
                if (isExpanding) {
                    if (!selecting.has(marker.id)) {
                        this.requestNodeSelection("add", [marker]);
                        CanvasDispatcher.requestHistoryCommit("spiral-move-expand", {}); return;
                    }
                } else {
                    if (selecting.has(marker.id)) {
                        this.requestNodeSelection("toggle", [marker]);
                        CanvasDispatcher.requestHistoryCommit("spiral-move-shrink", {}); return;
                    }
                }
            }
        }
    }
}
