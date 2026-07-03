/**
 * Writes domain path data to an abstract path target (Canvas ctx, Paper.js recorder, etc.).
 * No browser theme, no fill/stroke styles.
 */

export function emitCubicBezierSegments(recorder, segments, mapPoint, { close = false } = {}) {
    if (!recorder || !segments?.length) return;
    const p0 = mapPoint(segments[0].p0.x, segments[0].p0.y);
    recorder.moveTo(p0.x, p0.y);
    for (const seg of segments) {
        const cp1 = mapPoint(seg.p1.x, seg.p1.y);
        const cp2 = mapPoint(seg.p2.x, seg.p2.y);
        const p3 = mapPoint(seg.p3.x, seg.p3.y);
        recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p3.x, p3.y);
    }
    if (close) recorder.closePath();
}

export function emitBooleanSubpaths(recorder, subpaths, mapPoint) {
    if (!recorder || !Array.isArray(subpaths)) return;
    for (const sub of subpaths) {
        if (!sub?.segments?.length) continue;
        const s0 = sub.segments[0];
        const pt0 = mapPoint(s0.x, s0.y);
        recorder.moveTo(pt0.x, pt0.y);
        for (let i = 1; i < sub.segments.length; i++) {
            const prev = sub.segments[i - 1];
            const curr = sub.segments[i];
            const cp1 = mapPoint(prev.x + prev.outX, prev.y + prev.outY);
            const cp2 = mapPoint(curr.x + curr.inX, curr.y + curr.inY);
            const end = mapPoint(curr.x, curr.y);
            recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
        }
        if (sub.closed) {
            const prev = sub.segments[sub.segments.length - 1];
            const curr = sub.segments[0];
            const cp1 = mapPoint(prev.x + prev.outX, prev.y + prev.outY);
            const cp2 = mapPoint(curr.x + curr.inX, curr.y + curr.inY);
            const end = mapPoint(curr.x, curr.y);
            recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
            recorder.closePath();
        }
    }
}

function isGap(pA, pB) {
    return Math.hypot(pA.x - pB.x, pA.y - pB.y) > 1e-3;
}

/** Estimate signed area of closed loop from offset segment vertices (sign preserved) */
function estimateOffsetPathsSignedArea(paths) {
    if (!paths?.length) return 0;
    const pts = [];
    for (const subSegs of paths) {
        for (const sub of subSegs) {
            pts.push(sub.p0, sub.p3);
        }
    }
    if (pts.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return sum / 2;
}

function sampleSkeletonPoints(curve) {
    const pts = [];
    if (!curve?.startNode) return pts;
    let current = curve.startNode;
    const visited = new Set();
    while (current && !visited.has(current)) {
        visited.add(current);
        pts.push({ x: current.x, y: current.y });
        if (!curve.closed && current === curve.endNode) break;
        current = current.nextOnCurve;
        if (curve.closed && current === curve.startNode) break;
    }
    return pts;
}

function evalCubicPoint(sub, t) {
    const mt = 1 - t;
    const { p0, p1, p2, p3 } = sub;
    return {
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
    };
}

function minDistanceToSkeleton(skeleton, x, y) {
    let best = Infinity;
    for (const s of skeleton) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d < best) best = d;
    }
    return best;
}

/** Average minimum distance from offset ring sample points to skeleton */
function averageMinDistanceToSkeleton(curve, offsetPaths) {
    const skeleton = sampleSkeletonPoints(curve);
    if (!skeleton.length || !offsetPaths?.length) return 0;
    let sum = 0;
    let count = 0;
    for (const subSegs of offsetPaths) {
        for (const sub of subSegs) {
            for (const t of [0, 0.5, 1]) {
                const p = evalCubicPoint(sub, t);
                const d = minDistanceToSkeleton(skeleton, p.x, p.y);
                if (Number.isFinite(d)) {
                    sum += d;
                    count++;
                }
            }
        }
    }
    return count ? sum / count : 0;
}

/**
 * Closed loop outer ring selection: prefers the side farther from the skeleton; ties broken by winding + signed area.
 * Using |area| alone would misjudge during self-intersection/node tweaking, causing double guide lines.
 */
function pickOuterOffsetPaths(outline, curve) {
    const { forwardPaths, backwardPaths } = outline;
    if (!forwardPaths?.length) return backwardPaths;
    if (!backwardPaths?.length) return forwardPaths;

    if (curve) {
        const df = averageMinDistanceToSkeleton(curve, forwardPaths);
        const db = averageMinDistanceToSkeleton(curve, backwardPaths);
        const half = (curve.stroke_width || 0) / 2;
        const distEps = Math.max(1e-4, half * 0.02);
        if (Math.abs(df - db) > distEps) {
            return df >= db ? forwardPaths : backwardPaths;
        }
    }

    const af = estimateOffsetPathsSignedArea(forwardPaths);
    const ab = estimateOffsetPathsSignedArea(backwardPaths);
    const winding = curve?.getSkeletonWinding?.();
    const areaEps = 1e-4;

    if (!winding || winding === "open") {
        return Math.abs(af) >= Math.abs(ab) ? forwardPaths : backwardPaths;
    }

    const skeletonSign = winding === "cw" ? 1 : -1;
    const forwardAligned = Math.abs(af) < areaEps || Math.sign(af) === skeletonSign;
    const backwardAligned = Math.abs(ab) < areaEps || Math.sign(ab) === skeletonSign;

    if (forwardAligned && !backwardAligned) return forwardPaths;
    if (backwardAligned && !forwardAligned) return backwardPaths;

    return Math.abs(af) >= Math.abs(ab) ? forwardPaths : backwardPaths;
}

function emitOffsetSegmentList(recorder, offsetSegs, mapPoint, reverse = false, isClosedRing = false) {
    if (!offsetSegs?.length) return;

    if (!reverse) {
        const firstSub = offsetSegs[0][0];
        const p0 = mapPoint(firstSub.p0.x, firstSub.p0.y);
        recorder.moveTo(p0.x, p0.y);
        let currentPen = firstSub.p0;

        for (let i = 0; i < offsetSegs.length; i++) {
            const subSegs = offsetSegs[i];
            for (let j = 0; j < subSegs.length; j++) {
                const sub = subSegs[j];
                const sp0 = mapPoint(sub.p0.x, sub.p0.y);
                if (isGap(currentPen, sub.p0)) recorder.lineTo(sp0.x, sp0.y);
                const cp1 = mapPoint(sub.p1.x, sub.p1.y);
                const cp2 = mapPoint(sub.p2.x, sub.p2.y);
                const p3 = mapPoint(sub.p3.x, sub.p3.y);
                recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p3.x, p3.y);
                currentPen = sub.p3;
            }
        }
        return;
    }

    const lastSub = offsetSegs[offsetSegs.length - 1];
    const lastPiece = lastSub[lastSub.length - 1];
    const lp3 = mapPoint(lastPiece.p3.x, lastPiece.p3.y);
    if (isClosedRing) recorder.moveTo(lp3.x, lp3.y);
    else recorder.lineTo(lp3.x, lp3.y);
    let currentPen = lastPiece.p3;

    for (let i = offsetSegs.length - 1; i >= 0; i--) {
        const subSegs = offsetSegs[i];
        for (let j = subSegs.length - 1; j >= 0; j--) {
            const sub = subSegs[j];
            const sp3 = mapPoint(sub.p3.x, sub.p3.y);
            if (isGap(currentPen, sub.p3)) recorder.lineTo(sp3.x, sp3.y);
            const cp2 = mapPoint(sub.p2.x, sub.p2.y);
            const cp1 = mapPoint(sub.p1.x, sub.p1.y);
            const p0 = mapPoint(sub.p0.x, sub.p0.y);
            recorder.bezierCurveTo(cp2.x, cp2.y, cp1.x, cp1.y, p0.x, p0.y);
            currentPen = sub.p0;
        }
    }
}

export function emitExpandedStrokeOutline(recorder, outline, mapPoint, { outerContourOnly = false, curve = null } = {}) {
    if (!outline || !recorder) return;
    const { closed, forwardPaths, backwardPaths } = outline;
    if (!forwardPaths?.length) return;

    if (closed) {
        if (outerContourOnly) {
            const outer = pickOuterOffsetPaths(outline, curve);
            emitOffsetSegmentList(recorder, outer, mapPoint, false, true);
            recorder.closePath();
            return;
        }
        emitOffsetSegmentList(recorder, forwardPaths, mapPoint, false, true);
        recorder.closePath();
        emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, true);
        recorder.closePath();
    } else {
        emitOffsetSegmentList(recorder, forwardPaths, mapPoint, false, false);
        emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false);
        const firstSub = forwardPaths[0][0];
        const p0 = mapPoint(firstSub.p0.x, firstSub.p0.y);
        recorder.lineTo(p0.x, p0.y);
        recorder.closePath();
    }
}
