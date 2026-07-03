import { appendCurveFillPath, curveGeneratesFillArea } from "../../canvas/rendering/curve_renderer.js";

/**
 * Sequence menu thumbnail (presentation layer: may use Canvas API; UI components call only this module).
 */
export function drawSequenceGroupPreview(ctx, curveManager, groupId) {
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
    const size = Math.max(w, h, 1);
    const scale = 100 / size;
    const offsetX = 60 - (minX + w / 2) * scale;
    const offsetY = 60 - (minY + h / 2) * scale;

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
