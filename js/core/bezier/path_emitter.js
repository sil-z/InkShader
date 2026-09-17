/**
 * Writes domain path data to an abstract path target (Canvas ctx, Paper.js recorder, etc.).
 * No browser theme, no fill/stroke styles.
 */

export function emitCubicBezierSegments(recorder, segments, mapPoint, { close = false } = {}) {
    if (!recorder || !segments?.length) return;
    // Optional smooth-mode propagation: recorders that persist node control_mode
    // (e.g. GLIF export) implement setSmoothMode(mode); canvas ctx etc. ignore it.
    const setSmooth = (mode) => { if (typeof recorder.setSmoothMode === "function") recorder.setSmoothMode(mode); };
    setSmooth(segments[0].node?.control_mode);
    const p0 = mapPoint(segments[0].p0.x, segments[0].p0.y);
    recorder.moveTo(p0.x, p0.y);
    for (const seg of segments) {
        setSmooth(seg.endNode?.control_mode);
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

/**
 * Build a model-space Path2D from cached boolean geometry (identical contours to emitBooleanSubpaths).
 * Render via ctx.transform(viewportMatrix) + ctx.fill(path2d) to avoid re-tessellating every frame.
 */
export function buildBooleanPath2D(subpaths) {
    if (typeof Path2D === "undefined" || !Array.isArray(subpaths)) return null;
    const path = new Path2D();
    let any = false;
    for (const sub of subpaths) {
        if (!sub?.segments?.length) continue;
        const s0 = sub.segments[0];
        path.moveTo(s0.x, s0.y);
        for (let i = 1; i < sub.segments.length; i++) {
            const prev = sub.segments[i - 1];
            const curr = sub.segments[i];
            path.bezierCurveTo(
                prev.x + prev.outX,
                prev.y + prev.outY,
                curr.x + curr.inX,
                curr.y + curr.inY,
                curr.x,
                curr.y
            );
        }
        if (sub.closed) {
            const prev = sub.segments[sub.segments.length - 1];
            const curr = sub.segments[0];
            path.bezierCurveTo(
                prev.x + prev.outX,
                prev.y + prev.outY,
                curr.x + curr.inX,
                curr.y + curr.inY,
                curr.x,
                curr.y
            );
            path.closePath();
        }
        any = true;
    }
    return any ? path : null;
}

/** Affine map: model → logical canvas pixels (same as createViewportTransform). */
export function booleanViewportDOMMatrix({
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    seqOffsetX = 0,
    matrix = null
} = {}) {
    const m = new DOMMatrix();
    m.translateSelf(offsetX + seqOffsetX * scale, offsetY);
    m.scaleSelf(scale, scale);
    if (matrix) {
        m.multiplySelf(
            matrix instanceof DOMMatrix
                ? matrix
                : new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])
        );
    }
    return m;
}

/**
 * Emit a rounded cap: two cubic Bézier segments (A→M→B) forming a semicircular arc
 * with AB as the diameter.  A and B are the actual offset-path endpoints and are
 * NOT moved.  A midpoint M bulges outward by radius (|AB|/2) in the direction of
 * tDirRef, and each half is a 90° circular arc approximated with the standard
 * cubic k = 4/3·tan(π/8) ≈ 0.55228.
 *
 * Pen MUST be at A before calling; ends at B.
 *
 * @param {Object} recorder - path recorder
 * @param {Function} mapPoint - coordinate mapper (model → target space)
 * @param {{x:number,y:number}} a - forward offset endpoint (pen starts here)
 * @param {{x:number,y:number}} b - backward offset endpoint (cap ends here)
 * @param {{x:number,y:number}} tDirRef - outward tangent direction (determines bulge side)
 */
function emitRoundCap(recorder, mapPoint, a, b, tDirRef) {
    const k = 0.5522847498; // (4/3) * tan(pi/8) — standard for 90° circular arc

    // Vector from A to B (diameter of the semicircle)
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-8) return;

    const r = len / 2; // radius of the semicircle

    // Unit direction from A to B
    const ux = vx / len;
    const uy = vy / len;

    // Outward perpendicular: choose the side of AB that aligns with tDirRef.
    // Left normal of v: (-vy/len, vx/len)
    const lnx = -vy / len;
    const lny = vx / len;
    const dot = lnx * tDirRef.x + lny * tDirRef.y;
    const sgn = dot >= 0 ? 1 : -1;
    const nx = sgn * lnx; // outward unit normal
    const ny = sgn * lny;

    // M = midpoint of the semicircle arc, bulging outward by r
    const mx = (a.x + b.x) / 2 + r * nx;
    const my = (a.y + b.y) / 2 + r * ny;

    // First cubic: A → M  (90° arc from A toward the outward side)
    const m_mapped = mapPoint(mx, my);
    const cp1 = mapPoint(a.x + k * r * nx, a.y + k * r * ny);
    const cp2 = mapPoint(mx - k * r * ux, my - k * r * uy);
    recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, m_mapped.x, m_mapped.y);

    // Second cubic: M → B  (90° arc from the outward side to B)
    const cp3 = mapPoint(mx + k * r * ux, my + k * r * uy);
    const cp4 = mapPoint(b.x + k * r * nx, b.y + k * r * ny);
    const b_mapped = mapPoint(b.x, b.y);
    recorder.bezierCurveTo(cp3.x, cp3.y, cp4.x, cp4.y, b_mapped.x, b_mapped.y);
}

function isGap(pA, pB) {
    return Math.hypot(pA.x - pB.x, pA.y - pB.y) > 1e-3;
}

/** Degenerate cubic used as a straight segment (e.g. flat stroke cap). */
function isLineLikeSegment(sub) {
    const eps = 1e-4;
    const inDeg = Math.hypot(sub.p1.x - sub.p0.x, sub.p1.y - sub.p0.y) < eps;
    const outDeg = Math.hypot(sub.p2.x - sub.p3.x, sub.p2.y - sub.p3.y) < eps;
    return sub.isLineCap === true || (inDeg && outDeg);
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

function emitOffsetSegmentList(recorder, offsetSegs, mapPoint, reverse = false, isClosedRing = false, options = {}) {
    if (!offsetSegs?.length) return;
    const skipInitialLineTo = options.skipInitialLineTo === true;

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
                const p3 = mapPoint(sub.p3.x, sub.p3.y);
                if (isLineLikeSegment(sub)) {
                    recorder.lineTo(p3.x, p3.y);
                } else {
                    const cp1 = mapPoint(sub.p1.x, sub.p1.y);
                    const cp2 = mapPoint(sub.p2.x, sub.p2.y);
                    recorder.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p3.x, p3.y);
                }
                currentPen = sub.p3;
            }
        }
        return;
    }

    const lastSub = offsetSegs[offsetSegs.length - 1];
    const lastPiece = lastSub[lastSub.length - 1];
    const lp3 = mapPoint(lastPiece.p3.x, lastPiece.p3.y);
    if (isClosedRing) recorder.moveTo(lp3.x, lp3.y);
    else if (!skipInitialLineTo) recorder.lineTo(lp3.x, lp3.y);
    let currentPen = lastPiece.p3;

    for (let i = offsetSegs.length - 1; i >= 0; i--) {
        const subSegs = offsetSegs[i];
        for (let j = subSegs.length - 1; j >= 0; j--) {
            const sub = subSegs[j];
            const sp3 = mapPoint(sub.p3.x, sub.p3.y);
            if (isGap(currentPen, sub.p3)) recorder.lineTo(sp3.x, sp3.y);
            const p0 = mapPoint(sub.p0.x, sub.p0.y);
            if (isLineLikeSegment(sub)) {
                recorder.lineTo(p0.x, p0.y);
            } else {
                const cp2 = mapPoint(sub.p2.x, sub.p2.y);
                const cp1 = mapPoint(sub.p1.x, sub.p1.y);
                recorder.bezierCurveTo(cp2.x, cp2.y, cp1.x, cp1.y, p0.x, p0.y);
            }
            currentPen = sub.p0;
        }
    }
}

export function emitExpandedStrokeOutline(recorder, outline, mapPoint, { outerContourOnly = false, curve = null, roundCap = false, halfWidth = 0 } = {}) {
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
        // Two separate closed offset rings (outer offset traversed forward,
        // inner offset traversed backward). Under the nonzero rule their
        // combination with the fill ring yields exactly the fill ∪ band
        // region, and — critically — a boolean merge (cache melt / union)
        // sees only simple closed rings, never the near-coincident parallel
        // edges of a keyhole ring, which Paper.js resolves by eating the
        // outer stroke half-band (verified: consistent ~4.2k px loss on the
        // example Path regardless of jitter/order/pre-split).
        emitOffsetSegmentList(recorder, forwardPaths, mapPoint, false, true);
        recorder.closePath();
        emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, true);
        recorder.closePath();
    } else {
        emitOffsetSegmentList(recorder, forwardPaths, mapPoint, false, false);

        if (roundCap && curve?.endNode?.lastOnCurve) {
            _emitRoundCaps(recorder, mapPoint, outline, curve, halfWidth);
        } else {
            if (outline.openCuspCaps?.endMinus) {
                const endCap = mapPoint(outline.openCuspCaps.endMinus.x, outline.openCuspCaps.endMinus.y);
                recorder.lineTo(endCap.x, endCap.y);
                emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false, { skipInitialLineTo: true });
            } else {
                emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false);
            }
            const firstSub = forwardPaths[0][0];
            const p0 = mapPoint(firstSub.p0.x, firstSub.p0.y);
            recorder.lineTo(p0.x, p0.y);
        }
        recorder.closePath();
    }
}

/**
 * Emit semicircle caps at both open-curve endpoints using actual offset-path
 * endpoint positions, then emit the reversed backward paths.
 */
function _emitRoundCaps(recorder, mapPoint, outline, curve, halfWidth) {
    const { forwardPaths, backwardPaths } = outline;
    if (!forwardPaths?.length || !backwardPaths?.length) return;

    const hw = halfWidth;
    if (hw <= 0) {
        emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false);
        const firstSub = forwardPaths[0][0];
        const p0 = mapPoint(firstSub.p0.x, firstSub.p0.y);
        recorder.lineTo(p0.x, p0.y);
        return;
    }

    // — End cap —
    // Get actual offset-path endpoint positions
    const fwdEndSeg = forwardPaths[forwardPaths.length - 1];
    const bwdEndSeg = backwardPaths[backwardPaths.length - 1];
    const endA = fwdEndSeg[fwdEndSeg.length - 1].p3;  // forward offset end (pen is here)
    const endB = bwdEndSeg[bwdEndSeg.length - 1].p3;  // backward offset end

    // Outward tangent at curve end: use derivative-based direction (matching the offset
    // generator's normals) for correct bulge side determination. Fall back to chord
    // direction when the derivative is degenerate (zero-length handle).
    const en = curve.endNode;
    let eTx, eTy, eLen;
    if (en.control2) {
        const cdx = 3 * (en.x - en.control2.x);
        const cdy = 3 * (en.y - en.control2.y);
        eLen = Math.hypot(cdx, cdy);
        if (eLen > 1e-8) { eTx = cdx / eLen; eTy = cdy / eLen; }
    }
    if (!eLen || eLen < 1e-8) {
        const edx = en.x - en.lastOnCurve.x;
        const edy = en.y - en.lastOnCurve.y;
        eLen = Math.hypot(edx, edy);
        if (eLen > 1e-8) { eTx = edx / eLen; eTy = edy / eLen; }
    }
    if (eLen > 1e-8) {
        emitRoundCap(recorder, mapPoint, endA, endB, { x: eTx, y: eTy });
    } else {
        emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false);
        const firstSub = forwardPaths[0][0];
        const p0 = mapPoint(firstSub.p0.x, firstSub.p0.y);
        recorder.lineTo(p0.x, p0.y);
        return;
    }

    // Reversed backward path (the end cap arc already landed at the backward offset)
    emitOffsetSegmentList(recorder, backwardPaths, mapPoint, true, false, { skipInitialLineTo: true });

    // — Start cap —
    // Actual offset-path start positions
    const startC = backwardPaths[0][0].p0;  // backward offset start (pen is here)
    const startD = forwardPaths[0][0].p0;   // forward offset start

    // Outward tangent at start: derivative-based, then negated (bulge away from curve interior)
    const sn = curve.startNode;
    let sTx, sTy, sLen;
    if (sn.control1) {
        const cdx = 3 * (sn.control1.x - sn.x);
        const cdy = 3 * (sn.control1.y - sn.y);
        sLen = Math.hypot(cdx, cdy);
        if (sLen > 1e-8) { sTx = cdx / sLen; sTy = cdy / sLen; }
    }
    if (!sLen || sLen < 1e-8) {
        const sdx = sn.nextOnCurve.x - sn.x;
        const sdy = sn.nextOnCurve.y - sn.y;
        sLen = Math.hypot(sdx, sdy);
        if (sLen > 1e-8) { sTx = sdx / sLen; sTy = sdy / sLen; }
    }
    if (sLen > 1e-8) {
        emitRoundCap(recorder, mapPoint, startC, startD, { x: -sTx, y: -sTy });
    } else {
        const p0 = mapPoint(startD.x, startD.y);
        recorder.lineTo(p0.x, p0.y);
    }
}
