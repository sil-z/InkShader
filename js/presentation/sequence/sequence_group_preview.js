import { appendCurveFillPath, curveGeneratesFillArea } from "../../canvas/rendering/curve_renderer.js";

/**
 * Sequence menu thumbnail (presentation layer: may use Canvas API; UI components call only this module).
 *
 * @param {CanvasRenderingContext2D} ctx 120x120 preview context (content square: 100x100 at (10,10)-(110,110))
 * @param {object} curveManager
 * @param {string} groupId
 * @param {{ascender?: number, descender?: number, canvasSizeHeight?: number}|null} [fontMetrics]
 *        Font metrics for the metric-frame layout. When valid (asc > desc, canvasH > 0) the preview
 *        pins the ascender to the top and the descender to the bottom of the content square and centers
 *        horizontally on the side-bearing frame [lsb, advance - rsb]; anything outside the square is
 *        clipped by the canvas bounds. Falls back to bbox centering when metrics are unavailable.
 */
export function drawSequenceGroupPreview(ctx, curveManager, groupId, fontMetrics = null) {
    if (!ctx || !curveManager) return;
    const curveDataList = curveManager.getCurvesForGroup(groupId);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const cd of curveDataList) {
        const bounds = cd.curve.getBounds(cd.matrix);
        if (bounds) {
            minX = Math.min(minX, bounds.minX);
            minY = Math.min(minY, bounds.minY);
            maxX = Math.max(maxX, bounds.maxX);
            maxY = Math.max(maxY, bounds.maxY);
        }
    }
    if (minX === Infinity) return;

    const w = maxX - minX;
    const h = maxY - minY;

    let scale;
    let offsetX;
    let offsetY;

    const asc = fontMetrics?.ascender;
    const desc = fontMetrics?.descender;
    const canvasH = fontMetrics?.canvasSizeHeight;
    if (Number.isFinite(asc) && Number.isFinite(desc) && asc > desc && Number.isFinite(canvasH) && canvasH > 0) {
        // Metric-frame layout: ascender pinned to top, descender to bottom of the
        // 100-unit content square (y=10..110); horizontally centered on the
        // side-bearing frame [lsb, advance - rsb] == [minX, maxX] of curve extents.
        // Model space is y-flipped (fontY = 0.8*canvasH - modelY), so the model y
        // of the ascender line is 0.8*canvasH - asc and of the descender 0.8*canvasH - desc.
        scale = 100 / (asc - desc);
        offsetX = 60 - (minX + w / 2) * scale;
        offsetY = 10 - (0.8 * canvasH - asc) * scale;
    } else {
        // Fallback: center the curve bounding box (legacy behavior).
        const size = Math.max(w, h, 1);
        scale = 100 / size;
        offsetX = 60 - (minX + w / 2) * scale;
        offsetY = 60 - (minY + h / 2) * scale;
    }

    // Use CSS custom property to support theme switching
    const rootStyle = getComputedStyle(document.documentElement);
    ctx.fillStyle = rootStyle.getPropertyValue('--cvs-path-fill').trim() || '#111';
    ctx.beginPath();

    let hasFill = false;
    for (const cd of curveDataList) {
        const curve = cd.curve;
        if (!curve?.startNode || !curveGeneratesFillArea(curve)) continue;
        appendCurveFillPath(ctx, curve, { scale, offsetX, offsetY, seqOffsetX: 0, matrix: cd.matrix });
        hasFill = true;
    }

    if (hasFill) {
        ctx.fill("nonzero");
    }
}
