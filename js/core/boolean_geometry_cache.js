/**
 * Curve boolean fusion geometry cache (Paper.js); no DOM, no Canvas rendering API.
 */
import { getPaperScope } from "./paper_scope.js";
import {
    emitCubicBezierSegments,
    emitExpandedStrokeOutline,
    buildBooleanPath2D
} from "./bezier/path_emitter.js";

class LocalRecorder {
    constructor() {
        this.paths = [];
        this.curr = null;
    }
    moveTo(x, y) {
        this.curr = [];
        this.paths.push(this.curr);
        this.curr.push({ t: "M", x, y });
    }
    lineTo(x, y) {
        if (this.curr) this.curr.push({ t: "L", x, y });
    }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
        if (this.curr) this.curr.push({ t: "C", c1x, c1y, c2x, c2y, x, y });
    }
    closePath() {
        if (this.curr) this.curr.push({ t: "Z" });
    }
}

function buildPaperPaths(pScope, recorder, { resolveCrossings = true } = {}) {
    const pathList = [];
    for (const sub of recorder.paths) {
        if (sub.length === 0) continue;
        let p = new pScope.Path();
        for (const cmd of sub) {
            if (cmd.t === "M") p.moveTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "L") p.lineTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "C") {
                p.cubicCurveTo(
                    new pScope.Point(cmd.c1x, cmd.c1y),
                    new pScope.Point(cmd.c2x, cmd.c2y),
                    new pScope.Point(cmd.x, cmd.y)
                );
            } else if (cmd.t === "Z") p.closed = true;
        }
        for (const seg of p.segments) {
            if (seg.handleIn && seg.handleIn.length < 0.001) seg.handleIn.set(0, 0);
            if (seg.handleOut && seg.handleOut.length < 0.001) seg.handleOut.set(0, 0);
        }
        if (resolveCrossings && typeof p.resolveCrossings === "function") {
            try {
                const resolved = p.resolveCrossings();
                if (resolved && resolved !== p) {
                    p.remove();
                    p = resolved;
                }
            } catch (e) {
                console.warn("resolveCrossings failed for offset path", e);
            }
        }
        pathList.push(p);
    }
    return pathList;
}

/** Remove consecutive segments whose on-curve points coincide (cap/boolean artifacts). */
function mergeCoincidentPathSegments(path, eps = 0.5) {
    if (!path?.segments || path.segments.length < 2) return;
    for (let i = path.segments.length - 1; i > 0; i--) {
        const cur = path.segments[i];
        const prev = path.segments[i - 1];
        if (cur.point.getDistance(prev.point) <= eps) {
            prev.handleOut = cur.handleOut.clone();
            cur.remove();
        }
    }
    if (path.closed && path.segments.length > 1) {
        const first = path.segments[0];
        const last = path.segments[path.segments.length - 1];
        if (first.point.getDistance(last.point) <= eps) {
            first.handleIn = last.handleIn.clone();
            last.remove();
        }
    }
}

/** First on-ring point inside a closed child (grid scan; bounds.center can
 *  fall in the notch of a non-convex ring such as a "P" body). */
function ringInteriorPoint(child, pScope) {
    const b = child.bounds;
    const steps = 20;
    for (let gy = 1; gy < steps; gy++) {
        for (let gx = 1; gx < steps; gx++) {
            const px = b.x + b.width * gx / steps;
            const py = b.y + b.height * gy / steps;
            try { if (child.contains(new pScope.Point(px, py))) return { x: px, y: py }; } catch (_) { }
        }
    }
    return { x: b.center.x, y: b.center.y };
}

/** Refresh cached_boolean_geometry based on current curve geometry */
export function refreshCurveBooleanCache(curve) {
    const pScope = getPaperScope();
    if (!pScope || !curve?.startNode) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        return;
    }

    const identity = (x, y) => ({ x, y });
    const allSolidPieces = [];
    const hasFillArea = curve.closed && curve.startNode !== curve.endNode;

    if (hasFillArea) {
        const fillRec = new LocalRecorder();
        emitCubicBezierSegments(fillRec, curve.getSkeletonBezierSegments(), identity, {
            close: curve.closed && curve.startNode !== curve.endNode
        });
        allSolidPieces.push(...buildPaperPaths(pScope, fillRec, { resolveCrossings: false }));
    }

    if (curve.smart_stroke && curve.stroke_width > 0) {
        const hw = curve.stroke_width / 2;
        const outline = curve.computeExpandedStrokeOutline(hw);
        if (outline) {
            const strokeRec = new LocalRecorder();
            const roundCap = !curve.closed && curve._expandRoundCap === true;
            emitExpandedStrokeOutline(strokeRec, outline, identity, {
                roundCap,
                curve: roundCap ? curve : null,
                halfWidth: roundCap ? hw : 0
            });
            // Build the raw (unresolved) outlines FIRST: resolveCrossings
            // removes the original path when it replaces it, so the raw
            // self-intersecting ring must be captured before resolving.
            const strokePathsRaw = buildPaperPaths(pScope, strokeRec, { resolveCrossings: false });
            const strokePaths = buildPaperPaths(pScope, strokeRec, { resolveCrossings: true });

            // Winding-based swallowtail classification (replaces the old
            // two-stage skeleton-corridor filter, which mis-kept the inner
            // offset self-intersection ring of a sharp turn as a reversed
            // fill core, cancelling it into a hole under fill("nonzero")).
            //
            // resolveCrossings splits the self-intersecting stroke outline
            // ring into CompoundPath children. Classify each child by the
            // winding of its interior point against the RAW outline
            // (nonzero — the same semantics the canvas uses):
            //
            //   • wn == 0  → genuine HOLE (region enclosed by forward &
            //                backward offsets but outside the stroke body,
            //                e.g. the counter of a "P"). KEEP with winding
            //                opposite the fill rings so the CompoundPath
            //                carves it under fill("nonzero").
            //   • wn != 0, covered by another child → SWALLOWTAIL (same-side
            //                offset self-intersection loop protruding from
            //                the fill boundary at a sharp corner). REMOVE.
            //   • wn != 0, not covered → stroke BODY. KEEP.
            //
            // Faithfulness guard: the classification is only meaningful when
            // resolveCrossings PARTITIONS the raw outline. For pathological
            // self-intersections (e.g. a 180° hairpin U-turn) resolveCrossings
            // silently DROPS whole lobes; the summed child area then deviates
            // from the raw area. In that case keep the raw self-intersecting
            // outline instead — canvas fill("nonzero") renders it correctly
            // without splitting.
            for (let i = 0; i < strokePaths.length; i++) {
                const p = strokePaths[i];
                const rawPath = strokePathsRaw[i];
                if (p instanceof pScope.CompoundPath && p.children.length > 1) {
                    const rawArea = rawPath?.area || 0;
                    const childAreaSum = p.children.reduce((s, c) => s + (c.area || 0), 0);
                    const faithful = rawArea !== 0 &&
                        Math.abs(childAreaSum - rawArea) / Math.abs(rawArea) < 0.1;
                    if (!faithful) {
                        p.remove();
                        strokePaths[i] = rawPath;
                        continue;
                    }
                    // Classify each child: winding at its interior + coverage.
                    const kept = [];
                    for (const child of p.children) {
                        if (!(child instanceof pScope.Path)) {
                            kept.push({ child, wnNonZero: true });
                            continue;
                        }
                        const pt = ringInteriorPoint(child, pScope);
                        let wnNonZero = true;
                        try { wnNonZero = rawPath.contains(new pScope.Point(pt.x, pt.y)); } catch (_) { }
                        let covered = false;
                        for (const other of p.children) {
                            if (other === child) continue;
                            try {
                                if (other.contains(new pScope.Point(pt.x, pt.y))) { covered = true; break; }
                            } catch (_) { }
                        }
                        if (!wnNonZero || !covered) kept.push({ child, wnNonZero });
                    }
                    // Direction unification: all fill rings (wn != 0) share
                    // one orientation, all hole rings (wn == 0) the opposite,
                    // so the CompoundPath's nonzero fill matches the raw ring
                    // (resolveCrossings only guarantees alternating winding
                    //  for nested rings — separate swallowtail rings would
                    //  otherwise turn into holes).
                    const fillRings = kept.filter(m => m.wnNonZero).map(m => m.child);
                    const holeRings = kept.filter(m => !m.wnNonZero).map(m => m.child);
                    if (fillRings.length) {
                        const baseSign = Math.sign(fillRings[0].area) || -1;
                        for (const c of fillRings) {
                            if ((Math.sign(c.area) || -1) !== baseSign) c.reverse();
                        }
                        for (const c of holeRings) {
                            if ((Math.sign(c.area) || -1) === baseSign) c.reverse();
                        }
                    }
                    if (kept.length === 1) {
                        const clone = kept[0].child.clone();
                        p.remove();
                        strokePaths[i] = clone;
                    } else {
                        // Keep the CompoundPath, but REMOVE the rejected
                        // children (same-direction overlap rings that are
                        // covered by another ring, e.g. when the skeleton
                        // itself loops over its own stroke). Keeping them
                        // would leak redundant overlapping paths into the
                        // cached geometry.
                        const keptSet = new Set(kept.map(m => m.child));
                        for (const child of [...p.children]) {
                            if (!keptSet.has(child)) child.remove();
                        }
                    }
                }
            }
            allSolidPieces.push(...strokePaths);
        }
    }

    if (allSolidPieces.length === 0) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        return;
    }

    let resultPath = allSolidPieces[0];
    for (let i = 1; i < allSolidPieces.length; i++) {
        const nextPiece = allSolidPieces[i];
        try {
            nextPiece.rotate(0.0001, nextPiece.position);
            nextPiece.translate(new pScope.Point(0.0001, 0.0001));
            const temp = resultPath.unite(nextPiece);
            resultPath.remove();
            nextPiece.remove();
            resultPath = temp;
        } catch (e) {
            console.warn("Boolean melting step failed for a sub-path", e);
            nextPiece.remove();
        }
    }

    // Resolve any remaining self-intersections in the united result.
    // Skipped for smart-stroke paths because resolveCrossings splits
    // self-intersecting figure‑8 outlines into sub‑paths with conflicting
    // winding directions, creating an unfilled "hole" in Canvas fill("nonzero").
    // Canvas itself handles self‑intersecting paths correctly without splitting.
    // Non-smart paths keep resolveCrossings because curve_renderer.js bypasses
    // the boolean cache entirely for those (it emits the skeleton directly).
    if (!curve?.smart_stroke) {
        if (resultPath && typeof resultPath.resolveCrossings === "function") {
            try {
                const resolved = resultPath.resolveCrossings();
                if (resolved && resolved !== resultPath) {
                    resultPath.remove();
                    resultPath = resolved;
                }
            } catch (e) {
                console.warn("resolveCrossings on united result failed", e);
            }
        }
    }

    // Apply the user's Smart Expand Direction setting: reorient the outline
    // so root rings follow smart_stroke_clockwise and hole rings the opposite
    // orientation.  The bundled paper.js reorient(nonZero, clockwise) is
    // containment-aware (reorientPaths): it preserves the alternating winding
    // of nested rings and only sets the orientation of root rings to
    // `clockwise` — safe for both closed paths (fill-area ∪ stroke-outline
    // may merge into a single self-intersecting Path) and open paths
    // (CompoundPath children from resolveCrossings), so the old curve.closed
    // guard is removed.  Without it, the direction setting was a silent
    // no-op for open smart strokes (the common pen-stroke case), leaving
    // expand direction always automatic.
    if (curve.smart_stroke && curve.stroke_width > 0 && resultPath && typeof resultPath.reorient === "function") {
        try {
            resultPath.reorient(true, curve.smart_stroke_clockwise);
        } catch (e) {
            console.warn("Smart-stroke winding reorient failed", e);
        }
    }

    curve.cached_boolean_geometry = [];
    const paths = resultPath instanceof pScope.CompoundPath ? resultPath.children : [resultPath];
    for (const p of paths) {
        if (!(p instanceof pScope.Path) || p.segments.length < 2) continue;
        mergeCoincidentPathSegments(p);
        if (p.segments.length < 2) continue;
        const subGeom = [];
        for (const seg of p.segments) {
            subGeom.push({
                x: seg.point.x,
                y: seg.point.y,
                inX: seg.handleIn.x,
                inY: seg.handleIn.y,
                outX: seg.handleOut.x,
                outY: seg.handleOut.y
            });
        }
        curve.cached_boolean_geometry.push({ closed: p.closed, segments: subGeom });
    }

    if (curve.cached_boolean_geometry.length === 0) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
    } else {
        curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
    }

    if (resultPath) resultPath.remove();
}
