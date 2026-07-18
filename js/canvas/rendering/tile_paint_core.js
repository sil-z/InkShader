/**
 * Shared path-tile paint (Worker or main thread). No Paper.js, no DOM.
 * Mirrors the path fill/stroke pass of _renderScene for serialized items.
 */

function mapPointFactory({ scale, offsetX, offsetY, seqOffsetX, matrix }) {
    return (x, y) => {
        let mx = x;
        let my = y;
        if (matrix) {
            mx = x * matrix.a + y * matrix.c + matrix.e;
            my = x * matrix.b + y * matrix.d + matrix.f;
        }
        return {
            x: (mx + seqOffsetX) * scale + offsetX,
            y: my * scale + offsetY
        };
    };
}

function emitSkeleton(ctx, skeleton, mapPoint, close) {
    if (!skeleton?.length) return;
    const p0 = mapPoint(skeleton[0].p0.x, skeleton[0].p0.y);
    ctx.moveTo(p0.x, p0.y);
    for (const seg of skeleton) {
        const cp1 = mapPoint(seg.p1.x, seg.p1.y);
        const cp2 = mapPoint(seg.p2.x, seg.p2.y);
        const p3 = mapPoint(seg.p3.x, seg.p3.y);
        ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p3.x, p3.y);
    }
    if (close) ctx.closePath();
}

function emitBoolean(ctx, subpaths, mapPoint) {
    if (!Array.isArray(subpaths)) return;
    for (const sub of subpaths) {
        if (!sub?.segments?.length) continue;
        const s0 = sub.segments[0];
        const pt0 = mapPoint(s0.x, s0.y);
        ctx.moveTo(pt0.x, pt0.y);
        for (let i = 1; i < sub.segments.length; i++) {
            const prev = sub.segments[i - 1];
            const curr = sub.segments[i];
            const cp1 = mapPoint(prev.x + prev.outX, prev.y + prev.outY);
            const cp2 = mapPoint(curr.x + curr.inX, curr.y + curr.inY);
            const end = mapPoint(curr.x, curr.y);
            ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
        }
        if (sub.closed) {
            const prev = sub.segments[sub.segments.length - 1];
            const curr = sub.segments[0];
            const cp1 = mapPoint(prev.x + prev.outX, prev.y + prev.outY);
            const cp2 = mapPoint(curr.x + curr.inX, curr.y + curr.inY);
            const end = mapPoint(curr.x, curr.y);
            ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
            ctx.closePath();
        }
    }
}

function itemGeneratesFill(item) {
    if (item.smart_stroke) {
        return (item.closed && item.skeleton?.length > 0) || item.stroke_width > 0;
    }
    return !!(item.closed && item.skeleton?.length > 0);
}

/**
 * Paint serialized path items into ctx (already setTransform'd to user space).
 * @param {OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D} ctx
 * @param {{ scale:number, offsetX:number, offsetY:number, items:object[], theme:{path_fill_color:string, path_stroke_color:string}, cssSize:number }} job
 */
export function paintTilePaths(ctx, job) {
    const { scale, offsetX, offsetY, items, theme, cssSize } = job;
    const fillColor = theme?.path_fill_color || "#000";
    const strokeColor = theme?.path_stroke_color || "#000";

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cssSize, cssSize);
    ctx.clip();
    ctx.clearRect(0, 0, cssSize, cssSize);

    // Batch fills
    ctx.beginPath();
    let anyFill = false;
    for (const item of items || []) {
        if (item.stroke_preview) continue;
        if (!itemGeneratesFill(item)) continue;
        const mapPoint = mapPointFactory({
            scale,
            offsetX,
            offsetY,
            seqOffsetX: item.seqOffsetX || 0,
            matrix: item.matrix
        });
        if (item.smart_stroke && item.stroke_width > 0 && item.boolean?.length) {
            emitBoolean(ctx, item.boolean, mapPoint);
            anyFill = true;
        } else if (item.skeleton?.length) {
            emitSkeleton(ctx, item.skeleton, mapPoint, !!item.closed);
            anyFill = true;
        }
    }
    if (anyFill) {
        ctx.fillStyle = fillColor;
        ctx.fill("nonzero");
    }

    // Strokes / skeleton
    for (const item of items || []) {
        const mapPoint = mapPointFactory({
            scale,
            offsetX,
            offsetY,
            seqOffsetX: item.seqOffsetX || 0,
            matrix: item.matrix
        });
        const preview = !!item.stroke_preview;
        const smart = !!item.smart_stroke && item.stroke_width > 0 && !preview;

        if (!smart && item.stroke_width > 0 && item.skeleton?.length) {
            ctx.beginPath();
            emitSkeleton(ctx, item.skeleton, mapPoint, !!item.closed);
            ctx.strokeStyle = fillColor;
            ctx.lineWidth = item.stroke_width * scale;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke();
        } else if (preview && item.skeleton?.length) {
            ctx.beginPath();
            emitSkeleton(ctx, item.skeleton, mapPoint, false);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        if (item.show_skeleton && item.skeleton?.length) {
            ctx.beginPath();
            emitSkeleton(ctx, item.skeleton, mapPoint, false);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }
    ctx.restore();
}
