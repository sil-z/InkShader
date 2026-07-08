// js/presentation/canvas/tools/select_tool.js — SELECT tool: object selection, box select, transform initiation
import { BaseTool } from "./base_tool.js";
import {
    snapshotIncludesCurve,
    snapshotIncludesRef
} from "../../../app/editor_interaction_state.js";

/**
 * SELECT tool: object selection, box-select, transform initiation.
 *
 * Interaction:
 * - Click hit detection priority: transform handle -> curve segment -> ref instance -> blank
 * - Selection strategy: no modifier = replace, Shift = add/toggle, blank click = clear
 * - Drag selected object: starts move transform
 * - Blank area drag: starts box-select (rect bounds detection)
 * - Transform handle click: delegates to TransformTool.startTransform
 */
export class SelectTool extends BaseTool {
    handleMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, isShiftKey, clientX, clientY) {
        const c = this.canvas;
        const ix = c.getInteractionSnapshot();

        if (handleHit) {
            // If pivot is clicked (no drag detected yet), start pivot drag
            if (handleHit === 'pivot') {
                this.ic.transformTool.startTransform('pivot', mouseX, mouseY, clientX, clientY);
                return;
            }
            this.ic.transformTool.startTransform(handleHit, mouseX, mouseY, clientX, clientY);
            return;
        }

        if (hitCurveSegment) {
            if (hitCurveSegment.seqIndex !== undefined) this.setFocusedSequenceIndex(hitCurveSegment.seqIndex);

            if (hitCurveSegment.refId) {
                let refItem = c.curve_manager.treeItems.get(hitCurveSegment.refId);
                if (refItem && snapshotIncludesRef(ix, refItem)) {
                    // Clicking already-selected ref — toggle mode on mouseup (if no drag)
                    c.pending_mode_toggle = true;
                    this.ic.transformTool.startTransform('drag', mouseX, mouseY, clientX, clientY);
                    return;
                } else if (refItem) {
                    this.requestObjectSelection(isShiftKey ? "add" : "replace", { refs: [refItem] });
                    this.ic.transformTool.startTransform('drag', mouseX, mouseY, clientX, clientY);
                    return;
                }
            } else if (snapshotIncludesCurve(ix, hitCurveSegment.curve)) {
                // Clicking already-selected curve — toggle mode on mouseup (if no drag)
                c.pending_mode_toggle = true;
                this.ic.transformTool.startTransform('drag', mouseX, mouseY, clientX, clientY);
                return;
            } else {
                this.requestObjectSelection(isShiftKey ? "add" : "replace", { curves: [hitCurveSegment.curve] });
                this.ic.transformTool.startTransform('drag', mouseX, mouseY, clientX, clientY);
                return;
            }
        }

        if (!isShiftKey) {
            this.requestObjectSelection("clear");
            this.setFocusedSequenceIndex(-1);
        }
        c.is_box_selecting = true;
        c.box_select_start = { x: mouseX, y: mouseY };
        c.box_select_end = { x: mouseX, y: mouseY };
        c.is_dirty = true;
    }

    handleBoxMouseUp(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = false;
        let dx = mouseX - c.box_select_start.x, dy = mouseY - c.box_select_start.y;

        if (Math.hypot(dx, dy) < 4) {
            let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
            if (hitCurveSegment) {
                if (hitCurveSegment.refId) {
                    let refItem = c.curve_manager.treeItems.get(hitCurveSegment.refId);
                    if (refItem) this.requestObjectSelection(isShiftKey ? "toggle" : "replace", { refs: [refItem] });
                } else {
                    this.requestObjectSelection(isShiftKey ? "toggle" : "replace", { curves: [hitCurveSegment.curve] });
                }
            } else if (!isShiftKey) {
                this.requestObjectSelection("clear");
            }
            c.notifyPropertiesUpdate(); c.is_dirty = true;
            return;
        }

        const rect = this.getBoxSelectRectWorld();
        let seqTokens = c.curve_manager.sequenceTokens || [];
        let newlyFocusedSeqIdx = -1;
        let curvesToSelect = [];
        let refsToSelect = [];

        for (let i = 0; i < seqTokens.length; i++) {
            if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

            for (let cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let bounds = cd.curve.getBounds(cd.matrix);
                if (bounds) {
                    if (bounds.minX + seqOffsetX >= rect.x && bounds.maxX + seqOffsetX <= rect.x + rect.w &&
                        bounds.minY >= rect.y && bounds.maxY <= rect.y + rect.h) {
                        if (cd.refId) {
                            let refItem = c.curve_manager.treeItems.get(cd.refId);
                            if (refItem) refsToSelect.push(refItem);
                        } else curvesToSelect.push(cd.curve);
                        newlyFocusedSeqIdx = i;
                    }
                }
            }
        }
        if (newlyFocusedSeqIdx !== -1) this.setFocusedSequenceIndex(newlyFocusedSeqIdx);

        if (curvesToSelect.length > 0 || refsToSelect.length > 0) {
            this.requestObjectSelection(isShiftKey ? "add" : "replace", { curves: curvesToSelect, refs: refsToSelect });
        } else if (!isShiftKey) {
            this.requestObjectSelection("clear");
        }
        c.notifyPropertiesUpdate(); c.is_dirty = true;
    }
}
