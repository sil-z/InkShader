import { generateMarker } from "../../../core/bezier/utils.js";
import { CurveNode } from "../../../core/bezier/node.js";

/**
 * ELLIPSE tool: create ellipse/circle paths.
 *
 * Interaction:
 * - Drag: draws ellipse from start to end point (rectangle diagonal defines bounding box)
 * - Ctrl + drag: constrains to perfect circle (rx = ry)
 * - Release (distance >= 0.5): creates 4-node closed cubic Bezier ellipse (0.5522847498 constant)
 * - Release (distance < 0.5): cancels
 *
 * Creation flow: resolve active group -> compute sequence offset -> startAddingPath()
 * -> 4 symmetric nodes (control_mode=2) -> set handles -> finishAddingPathCommand()
 */
export class EllipseTool {
    constructor(canvas, controller) {
        this.canvas = canvas;
        this.controller = controller;
    }

    handleMouseDown(mouseX, mouseY, worldX, worldY, isCtrl) {
        const c = this.canvas;
        // Read from Store first (source of truth); CM projection may lag behind async event bus
        let activeGroupId = c.commandHostPort?.getStoreState?.()?.activeGroupId;
        if (activeGroupId) {
            const gi = c.curve_manager.treeItems.get(activeGroupId);
            if (!gi || gi.hidden_by_sequence) activeGroupId = null;
        }
        activeGroupId = activeGroupId ?? c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) return;
        const activeGroup = c.curve_manager.treeItems.get(activeGroupId);
        if (activeGroup && activeGroup.locked) return;

        c._ellipseWorldStartX = worldX;
        c._ellipseWorldStartY = worldY;
        c._ellipseIsCtrl = isCtrl;
        c._ellipseWorldEndX = worldX;
        c._ellipseWorldEndY = worldY;
        c.current_state = 'DRAGGING_ELLIPSE';
        c.is_dirty = true;
    }

    handleMouseMove(mouseX, mouseY, worldX, worldY, isCtrl) {
        const c = this.canvas;
        if (c.current_state !== 'DRAGGING_ELLIPSE') return;
        if (isCtrl !== undefined) c._ellipseIsCtrl = isCtrl;
        if (isCtrl) {
            const sx = c._ellipseWorldStartX, sy = c._ellipseWorldStartY;
            const dx = worldX - sx, dy = worldY - sy;
            const r = Math.max(Math.abs(dx), Math.abs(dy));
            c._ellipseWorldEndX = sx + r * Math.sign(dx);
            c._ellipseWorldEndY = sy + r * Math.sign(dy);
        } else {
            c._ellipseWorldEndX = worldX;
            c._ellipseWorldEndY = worldY;
        }
        c.is_dirty = true;
    }

    handleMouseUp() {
        const c = this.canvas;
        if (c.current_state !== 'DRAGGING_ELLIPSE') return;
        c.current_state = 'IDLE';

        const sx = c._ellipseWorldStartX;
        const sy = c._ellipseWorldStartY;
        const ex = c._ellipseWorldEndX;
        const ey = c._ellipseWorldEndY;

        c._ellipseWorldStartX = undefined;
        c._ellipseWorldStartY = undefined;
        c._ellipseWorldEndX = undefined;
        c._ellipseWorldEndY = undefined;
        c._ellipseIsCtrl = false;

        if (sx === undefined || ex === undefined) return;
        const dx = Math.abs(ex - sx), dy = Math.abs(ey - sy);
        if (dx < 0.5 && dy < 0.5) return;

        this._createEllipse(c, sx, sy, ex, ey);
    }

    _createEllipse(c, sx, sy, ex, ey) {
        const cm = c.curve_manager;
        let storeId = c.commandHostPort?.getStoreState?.()?.activeGroupId;
        if (storeId) {
            const gi = cm.treeItems.get(storeId);
            if (!gi || gi.hidden_by_sequence) storeId = null;
        }
        const activeGroupId = storeId ?? cm.ensureActiveGroup();
        if (!activeGroupId) return;
        c.commands.syncActiveGroupForDraw(activeGroupId);

        // Compute sequence offset for this group
        let seqOffsetX = 0;
        const seqTokens = cm.sequenceTokens;
        const activeIndices = Array.from(cm.activeSequenceIndices).sort((a, b) => a - b);
        for (let idx of activeIndices) {
            const t = seqTokens[idx];
            const gid = t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value;
            if (gid === activeGroupId) { seqOffsetX = cm.getSeqOffset(idx); break; }
        }

        const lx = sx - seqOffsetX, ly = sy;
        const rx2 = ex - seqOffsetX, ry2 = ey;
        let cx = (lx + rx2) / 2, cy = (ly + ry2) / 2;
        let rx = Math.abs(rx2 - lx) / 2, ry = Math.abs(ry2 - ly) / 2;

        if (c._ellipseIsCtrl) {
            const r = Math.max(rx, ry);
            rx = ry = r;
        }

        if (rx < 0.25 || ry < 0.25) return;

        const eSettings = c.ellipseToolSettings || c.drawToolSettings;
        if (!c.commands.startAddingPath(activeGroupId, seqOffsetX)) return;

        const k = 0.5522847498;
        const kx = k * rx, ky = k * ry;

        const nodeData = [
            { x: cx + rx, y: cy,     c1x: cx + rx, c1y: cy + ky, c2x: cx + rx, c2y: cy - ky },
            { x: cx,      y: cy + ry, c1x: cx - kx, c1y: cy + ry, c2x: cx + kx, c2y: cy + ry },
            { x: cx - rx, y: cy,     c1x: cx - rx, c1y: cy - ky, c2x: cx - rx, c2y: cy + ky },
            { x: cx,      y: cy - ry, c1x: cx + kx, c1y: cy - ry, c2x: cx - kx, c2y: cy - ry }
        ];

        const markers = [];
        for (const nd of nodeData) {
            const m = c.commands.addMainNode(nd.x, nd.y);
            if (m) markers.push(m);
        }

        c.current_curve.closed = true;

        // Apply ellipseToolSettings stroke_width to the curve
        if (eSettings.stroke_width > 0) {
            c.current_curve.stroke_width = eSettings.stroke_width;
        }
        if (eSettings.smart_expand !== undefined) {
            c.current_curve.smart_stroke = eSettings.smart_expand;
        }
        if (eSettings.show_skeleton !== undefined) {
            c.current_curve.show_skeleton = eSettings.show_skeleton;
        }

        for (let i = 0; i < markers.length; i++) {
            const n = cm.find_node_by_curve(markers[i]);
            if (!n) continue;
            cm.changeSmoothModeOnSingleNode(markers[i], 2, true);
            const nd = nodeData[i];
            if (n.control1) { n.control1.x = nd.c1x; n.control1.y = nd.c1y; }
            if (n.control2) { n.control2.x = nd.c2x; n.control2.y = nd.c2y; }
        }

        c.commands.finishAddingPathCommand();
    }
}
