/**
 * 节点手柄 Canvas 呈现（领域 CurveNode 仅提供坐标与 control_mode）。
 */
import { getCanvasTheme } from "./canvas_theme.js";
import { createViewportTransform } from "./viewport_transform.js";

export function drawCurveNode(
    ctx,
    node,
    viewport,
    theme = getCanvasTheme(),
    {
        isSelected = false,
        hoverStates = {},
        showHandles = true
    } = {}
) {
    if (!ctx || !node) return;

    const mapPoint = createViewportTransform(viewport);
    const mainPt = mapPoint(node.x, node.y);
    const screenX = mainPt.x;
    const screenY = mainPt.y;
    const strokeW = theme.path_stroke_width;

    ctx.lineWidth = strokeW * 0.75;

    if (showHandles) {
        if (node.control1 !== null) {
            const cp1 = mapPoint(node.control1.x, node.control1.y);
            ctx.strokeStyle = theme.control_ahead_color;
            ctx.beginPath();
            ctx.moveTo(screenX, screenY);
            ctx.lineTo(cp1.x, cp1.y);
            ctx.stroke();
        }
        if (node.control2 !== null) {
            const cp2 = mapPoint(node.control2.x, node.control2.y);
            ctx.strokeStyle = theme.control_back_color;
            ctx.beginPath();
            ctx.moveTo(screenX, screenY);
            ctx.lineTo(cp2.x, cp2.y);
            ctx.stroke();
        }
    }

    const baseR = hoverStates.main ? 5 : 4.2;
    ctx.lineWidth = strokeW;
    ctx.fillStyle = isSelected ? theme.selected_fill_color : theme.oncurve_fill_color;
    ctx.strokeStyle = isSelected ? theme.selected_stroke_color : theme.oncurve_stroke_color;
    ctx.beginPath();

    if (node.control_mode === 2) {
        ctx.arc(screenX, screenY, baseR, 0, Math.PI * 2);
    } else if (node.control_mode === 0) {
        const d = baseR * 1.25;
        ctx.moveTo(screenX, screenY - d);
        ctx.lineTo(screenX + d, screenY);
        ctx.lineTo(screenX, screenY + d);
        ctx.lineTo(screenX - d, screenY);
        ctx.closePath();
    } else {
        const s = baseR * 0.9;
        ctx.rect(screenX - s, screenY - s, s * 2, s * 2);
    }
    ctx.fill();
    ctx.stroke();

    const drawHandle = (handle, isHovered) => {
        if (!handle) return;
        const hp = mapPoint(handle.x, handle.y);
        const hr = isHovered ? 4 : 3;
        ctx.fillStyle = isSelected ? theme.selected_fill_color : theme.control_fill_color;
        ctx.strokeStyle = isSelected ? theme.selected_stroke_color : theme.control_stroke_color;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, hr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    };

    if (showHandles) {
        drawHandle(node.control1, hoverStates.c1);
        drawHandle(node.control2, hoverStates.c2);
    }
}
