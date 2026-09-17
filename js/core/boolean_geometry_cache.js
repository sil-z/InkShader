/**
 * Curve boolean fusion geometry cache (Paper.js); no DOM, no Canvas rendering API.
 */
import { getPaperScope } from "./paper_scope.js";
import {
    emitCubicBezierSegments,
    emitExpandedStrokeOutline,
    buildBooleanPath2D
} from "./bezier/path_emitter.js";
import { reportFatalError } from "../services/error_log.js";

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

/** Rasterize paper items into an offscreen canvas and return the painted
 *  area in world units. Winding-independent ground truth for cache merges.
 *  Returns -1 when rasterization is unavailable (non-DOM) or fails. */
function rasterizeItems(pScope, items) {
    try {
        if (typeof document === "undefined") return -1;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const it of items) {
            const b = it.bounds;
            if (!b || !isFinite(b.x) || !isFinite(b.width) || !isFinite(b.height)) return -1;
            minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
        }
        if (!isFinite(minX) || maxX - minX < 1e-6 || maxY - minY < 1e-6) return -1;
        const scale = 256 / Math.max(maxX - minX, maxY - minY);
        const w = Math.max(2, Math.ceil((maxX - minX) * scale));
        const h = Math.max(2, Math.ceil((maxY - minY) * scale));
        const ctx = document.createElement("canvas").getContext("2d");
        if (!ctx) return -1;
        ctx.canvas.width = w; ctx.canvas.height = h;
        ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
        ctx.fillStyle = "#000";
        const p2d = new Path2D();
        for (const it of items) {
            try { p2d.addPath(new Path2D(it.getPathData(null, 2))); } catch (_) { return -1; }
        }
        ctx.fill(p2d, "nonzero");
        const data = ctx.getImageData(0, 0, w, h).data;
        let n = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 127) n++;
        return n / (scale * scale);
    } catch (_) {
        return -1;
    }
}

/** OR-composited per-piece raster: the true semantic region each piece
 *  contributes, immune to winding cancellation between pieces.
 *
 *  Each piece is rasterized on its own and then THRESHOLDED to a hard mask
 *  (alpha>127 → on) before being unioned into the accumulator. Compositing the
 *  antialiased rasters directly (drawImage) instead ADDS the semi-transparent
 *  boundary pixels of pieces that share an edge: for the two identical offset
 *  rings a degenerate closed path produces, every boundary pixel got counted
 *  twice and crossed the threshold, inflating the "truth" ~4% above what any
 *  real composite can reach — so every merge candidate (all correct, ~8003)
 *  was rejected as "not matching the truth" (8328) and the path reported a
 *  bogus "boolean merge produced no usable rings" with no fill at all.
 *  Thresholding per piece makes the union idempotent. */
function rasterizeOR(pScope, items) {
    try {
        if (typeof document === "undefined" || !items.length) return -1;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const it of items) {
            const b = it.bounds;
            if (!b || !isFinite(b.x) || !isFinite(b.width) || !isFinite(b.height)) return -1;
            minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
        }
        if (!isFinite(minX) || maxX - minX < 1e-6 || maxY - minY < 1e-6) return -1;
        const scale = 256 / Math.max(maxX - minX, maxY - minY);
        const w = Math.max(2, Math.ceil((maxX - minX) * scale));
        const h = Math.max(2, Math.ceil((maxY - minY) * scale));
        const acc = new Uint8Array(w * h);
        for (const it of items) {
            const ctx = document.createElement("canvas").getContext("2d");
            if (!ctx) return -1;
            ctx.canvas.width = w; ctx.canvas.height = h;
            ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
            ctx.fillStyle = "#000";
            const p2d = new Path2D();
            try { p2d.addPath(new Path2D(it.getPathData(null, 2))); } catch (_) { return -1; }
            ctx.fill(p2d, "nonzero");
            const data = ctx.getImageData(0, 0, w, h).data;
            for (let i = 3, p = 0; i < data.length; i += 4, p++) if (data[i] > 127) acc[p] = 1;
        }
        let n = 0;
        for (let p = 0; p < acc.length; p++) if (acc[p]) n++;
        return n / (scale * scale);
    } catch (_) {
        return -1;
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

/** Diagnostics for a failed merge: everything needed to explain WHY this
 *  geometry produced no rings, so the error log is actionable. */
function describePiece(p) {
    return {
        closed: !!p.closed,
        segments: p.segments.length,
        area: Math.round(p.area || 0),
        bounds: p.bounds
            ? [Math.round(p.bounds.x), Math.round(p.bounds.y),
               Math.round(p.bounds.width), Math.round(p.bounds.height)]
            : null
    };
}

/** Report a broken invariant exactly once per geometry state. */
function reportCacheFailure(curve, reason, detail) {
    const hash = curve.getGeometryHash();
    // 同一几何只报一次：渲染循环每帧都会重新校验缓存，不去重会刷屏（
    // 弹窗也会被同一个故障连续打断）。几何一变（hash 变）就重新报。
    if (curve._booleanErrorHash === hash && curve._booleanErrorReason === reason) return;
    curve._booleanErrorHash = hash;
    curve._booleanErrorReason = reason;
    reportFatalError("boolean_geometry_cache", reason, {
        curveId: curve.id ?? null,
        groupId: curve.groupId ?? null,
        geometryHash: hash,
        ...detail
    });
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
    // A real fill area needs a closed ring with an end node on the chain.
    // `endNode === null` (the pen tool right after the first click created the
    // start node) is NOT a ring — see the empty-skeleton guard below.
    const hasFillArea = curve.closed && !!curve.endNode && curve.startNode !== curve.endNode;

    // No drawable segment at all → nothing renderable exists yet: no fill ring
    // and no stroke outline can be generated (computeExpandedStrokeOutline
    // builds from this very segment list and returns null for it). That is the
    // legitimate state of a path under construction (pen tool: one node, then
    // the rubber band is previewed separately), of a curve with no nodes, or of
    // a "path" whose nodes all sit on the same point — NOT a geometry-generation
    // failure. Reporting it as one made every single pen click pop a fatal error
    // dialog. Keep the cache empty and stay silent; the geometry hash changes as
    // soon as a drawable segment exists, which rebuilds the cache (via
    // ensureBooleanCache) with a real ring.
    //
    // A segment counts as drawable when it leaves its start point in ANY of its
    // four control points: a loop whose endpoints coincide but whose handles
    // pull out is a real shape, while p0=p1=p2=p3 is a single point.
    const skeletonSegments = curve.getSkeletonBezierSegments();
    const drawableSegments = skeletonSegments.filter((s) => (
        Math.abs(s.p1.x - s.p0.x) > 1e-6 || Math.abs(s.p1.y - s.p0.y) > 1e-6
        || Math.abs(s.p2.x - s.p0.x) > 1e-6 || Math.abs(s.p2.y - s.p0.y) > 1e-6
        || Math.abs(s.p3.x - s.p0.x) > 1e-6 || Math.abs(s.p3.y - s.p0.y) > 1e-6
    ));
    if (drawableSegments.length === 0) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        curve._lastHash = null;
        curve._booleanContentHash = null;
        curve._booleanEmptyHash = curve.getGeometryHash();
        return;
    }

    if (hasFillArea) {
        const fillRec = new LocalRecorder();
        emitCubicBezierSegments(fillRec, skeletonSegments, identity, {
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
            // Build the raw (unresolved) outline ring. It is the
            // mathematically correct stroke region under the nonzero rule:
            // overlapping offset bands count windings instead of being
            // partitioned, and the canvas paints exactly this region.
            // resolveCrossings + heuristic child classification was tried
            // here and removed: its split-and-classify stage mis-removed
            // stroke bodies (band loss on stars/hairpins) and mis-kept
            // compensation rings (fill gouges); correctness is instead
            // guaranteed by the verified melt / raw fallback merge below.
            const strokePaths = buildPaperPaths(pScope, strokeRec, { resolveCrossings: false });
            allSolidPieces.push(...strokePaths);
        }
    }

    if (allSolidPieces.length === 0) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        // The cache is only worth something for a fill ring or a smart-stroke
        // band. A plain (non-smart) OPEN path has neither: an open path has no
        // fill area in this app, and its stroke is drawn from the skeleton, not
        // from this cache. Handing such a curve to the cache (e.g. union
        // operand collection) is simply "not applicable" — nothing to store,
        // nothing broken. Stay silent instead of reporting a false failure.
        const expectsCacheGeometry = hasFillArea || (curve.smart_stroke && curve.stroke_width > 0);
        if (!expectsCacheGeometry) return;
        // Otherwise the curve DOES have a fill region / stroke band to cache,
        // yet nothing was generated: that is a broken geometry invariant and it
        // is reported loudly rather than treated as "nothing to draw".
        reportCacheFailure(curve, "smart expand: no geometry generated", {
            closed: !!curve.closed,
            startEqualsEnd: curve.startNode === curve.endNode,
            smart_stroke: !!curve.smart_stroke,
            stroke_width: curve.stroke_width ?? null,
            hasFillArea,
            expandedOutline: null
        });
        return;
    }

    // Merge the pieces into one item for the cache consumers.
    //
    // Paper.js booleans reorient every operand independently, which destroys
    // the drawn ring directions of self-intersecting outlines (dropping
    // lobes) and can flip stroke/fill windings into cancellation. Booleans
    // are therefore only used when the merge is actually needed AND safe:
    // all pieces are simple rings and a genuine direction conflict exists
    // (mixed signed areas). Otherwise a plain CompoundPath keeps every
    // piece's own winding — the canvas paints it with the same nonzero rule
    // it would use for the raw pieces, so the region is correct by
    // construction.
    // Flatten every piece to leaf Paths. resolveCrossings wraps its split
    // output in CompoundPaths; nesting a CompoundPath inside the result
    // CompoundPath would make the serializer below (which only accepts
    // `instanceof Path` children) silently DROP that whole branch.
    const leafPieces = [];
    for (const piece of allSolidPieces) {
        if (piece instanceof pScope.CompoundPath) {
            for (const child of [...piece.children]) {
                if (child instanceof pScope.Path && child.segments.length >= 2) leafPieces.push(child);
            }
        } else if (piece instanceof pScope.Path && piece.segments.length >= 2) {
            leafPieces.push(piece);
        }
    }
    if (leafPieces.length === 0) {
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        reportCacheFailure(curve, "smart expand: generated pieces are unusable", {
            closed: !!curve.closed,
            startEqualsEnd: curve.startNode === curve.endNode,
            smart_stroke: !!curve.smart_stroke,
            stroke_width: curve.stroke_width ?? null,
            hasFillArea,
            solidPieces: allSolidPieces.length,
            solidPieceSegments: allSolidPieces.map(p => (p?.segments?.length ?? -1))
        });
        return;
    }
    const allSimplePaths = leafPieces.every(p => p instanceof pScope.Path);
    // 合并候选的完整记录，失败时写进 error.log
    const diag = {
        leafPieces: leafPieces.map(describePiece),
        allSimplePaths,
        truthArea: null,
        melt: null,
        split: null,
        raw: null
    };
    // Winding-independent ground truth for every merge candidate: each piece
    // rasterized separately, then OR-composited. -1 when rasterization is
    // unavailable (candidates are then trusted as-is).
    const truth = rasterizeOR(pScope, leafPieces);
    diag.truthArea = Math.round(truth);
    // Per-candidate verification notes: without the measured numbers a rejected
    // candidate is indistinguishable from a failed raster in error.log, which
    // makes the report unactionable.
    const verifyNotes = [];
    diag.verifyNotes = verifyNotes;
    const matches = (candidate, label = "candidate") => {
        if (!candidate) { verifyNotes.push(`${label}: no candidate`); return false; }
        if (truth < 0) { verifyNotes.push(`${label}: truth unavailable → trusted`); return true; }
        const got = rasterizeItems(pScope, [candidate]);
        const tol = Math.max(60, truth * 0.02);
        verifyNotes.push(`${label}: got=${Math.round(got)} truth=${Math.round(truth)} tol=${Math.round(tol)}`);
        return got >= 0 && Math.abs(got - truth) <= tol;
    };
    // Candidates are built in ISOLATION so a failed attempt never damages
    // the source pieces; the winner is serialized below and everything is
    // discarded. Priority: boolean melt (cleanest ring structure — no
    // fragment seams or coincident nodes, best for expand materialization
    // and union input) → raw drawn windings (preserves hole directions for
    // the union engine) → crossing split with all-positive reorientation
    // (last resort; fragment sub-rings may share coincident nodes).
    let resultPath = null;
    // True when the raw-windings candidate won: it ADOPTED the leaf pieces
    // as its own children, so the discard loop below must skip them.
    let rawAdoptedPieces = false;
    if (allSimplePaths && leafPieces.length > 1) {
        // Candidate 1: melt. Opposing windings cancel under the nonzero rule
        // (e.g. a closed curve's fill ring against the inner stroke ring),
        // so the pieces must melt into clean semantic rings. Paper's
        // booleans silently drop lobes on near-tangential / self-intersecting
        // geometry, hence the verification.
        let acc = leafPieces[0].clone();
        let melted = true;
        for (let i = 1; i < leafPieces.length && melted; i++) {
            const nextClone = leafPieces[i].clone();
            try {
                nextClone.rotate(0.0001, nextClone.position);
                nextClone.translate(new pScope.Point(0.0001, 0.0001));
                const temp = acc.unite(nextClone);
                try { acc.remove(); } catch (_) { }
                try { nextClone.remove(); } catch (_) { }
                if (!temp) { melted = false; break; }
                acc = temp;
            } catch (e) {
                console.warn("Boolean melting step failed for a sub-path", e);
                try { nextClone.remove(); } catch (_) { }
                melted = false;
            }
        }
        if (melted && acc && matches(acc, "melt")) {
            resultPath = acc;
            diag.melt = { attempted: true, melted, accepted: true };
        } else {
            diag.melt = {
                attempted: true,
                melted,
                accepted: false,
                area: acc ? Math.round(acc.area || 0) : null
            };
            try { if (acc) acc.remove(); } catch (_) { }
        }
    } else {
        diag.melt = { attempted: false, why: allSimplePaths ? "single piece" : "non-simple paths" };
    }
    if (!resultPath) {
        // Candidate 2: crossing split + all-positive reorientation. When the
        // melt's booleans fail on near-tangential geometry this still yields
        // the clean minimal ring structure expand materialization and union
        // want (verified: raster must equal the OR truth; a genuine hole
        // region would fail here and fall through to raw).
        try {
            const cp = new pScope.CompoundPath({ children: leafPieces.map(p => p.clone({ insert: false })) });
            if (typeof cp.resolveCrossings === "function") {
                const split = cp.resolveCrossings();
                if (split) {
                    const kids = (split instanceof pScope.CompoundPath ? [...split.children] : [split])
                        .filter(k => k instanceof pScope.Path && k.segments.length >= 2);
                    for (const k of kids) { if ((k.area || 0) < 0) { try { k.reverse(); } catch (_) { } } }
                    const candA = kids.length === 1 ? kids[0] : new pScope.CompoundPath({ children: kids });
                    diag.split = { attempted: true, rings: kids.length, accepted: matches(candA, "split") };
                    if (diag.split.accepted) {
                        resultPath = candA;
                    } else {
                        try { candA.remove(); } catch (_) { }
                    }
                    if (split !== resultPath) { try { split.remove(); } catch (_) { } }
                } else {
                    diag.split = { attempted: true, accepted: false, why: "resolveCrossings returned nothing" };
                }
            } else {
                diag.split = { attempted: true, accepted: false, why: "no resolveCrossings" };
            }
            cp.remove();
        } catch (e) {
            diag.split = { attempted: true, accepted: false, threw: String(e?.message || e).slice(0, 200) };
        }
    }
    if (!resultPath) {
        // Candidate 3: raw pieces with their drawn windings (region-correct
        // under nonzero by construction; structure keeps overlapping rings).
        const rawCP = leafPieces.length === 1
            ? leafPieces[0]
            : new pScope.CompoundPath({ children: leafPieces });
        const rawOk = matches(rawCP, "raw");
        diag.raw = { attempted: true, accepted: rawOk };
        if (rawOk) {
            resultPath = rawCP;
            rawAdoptedPieces = true;
        } else {
            try { rawCP.remove(); } catch (_) { }
        }
    }
    if (!resultPath) {
        // Booleans were attempted and failed (or mangled the region):
        // re-emit from the curve and normalize every ring to one
        // winding so the nonzero fill equals the OR region exactly.
                const reRec = new LocalRecorder();
                if (hasFillArea) {
                    emitCubicBezierSegments(reRec, curve.getSkeletonBezierSegments(), identity, { close: hasFillArea });
                }
                if (curve.smart_stroke && curve.stroke_width > 0) {
                    const hw = curve.stroke_width / 2;
                    const outline = curve.computeExpandedStrokeOutline(hw);
                    if (outline) {
                        const roundCap = !curve.closed && curve._expandRoundCap === true;
                        emitExpandedStrokeOutline(reRec, outline, identity, { roundCap, curve: roundCap ? curve : null, halfWidth: roundCap ? hw : 0 });
                    }
                }
                let fresh = buildPaperPaths(pScope, reRec, { resolveCrossings: false });
                fresh = fresh.flatMap(p => p instanceof pScope.CompoundPath ? [...p.children] : [p])
                    .filter(p => p instanceof pScope.Path && p.segments.length >= 2);
                const buildAll = (list) => list.length === 1 ? list[0] : new pScope.CompoundPath({ children: list });
                const truth2 = fresh.length ? rasterizeOR(pScope, fresh) : -1;
                diag.lastResort = { reEmitted: fresh.length, truth2Area: Math.round(truth2), accepted: false };
                if (truth2 < 0 || fresh.length <= 1) {
                    for (const p of fresh) { if ((p.area || 0) < 0) { try { p.reverse(); } catch (_) { } } }
                    resultPath = buildAll(fresh);
                    // A single self-intersecting ring (e.g. a thin band around
                    // an open figure-8 skeleton) cancels its own lobes under
                    // the nonzero rule. Split it at the crossings and reorient
                    // every leaf positive; keep the split only when it
                    // verifiably reproduces the raster truth.
                    if (truth2 >= 0 && resultPath instanceof pScope.Path && typeof resultPath.resolveCrossings === "function") {
                        try {
                            const split = resultPath.resolveCrossings();
                            if (split && split !== resultPath) {
                                const leaves = [];
                                const collect = (it) => {
                                    if (it instanceof pScope.CompoundPath) { for (const k of it.children) collect(k); }
                                    else if (it instanceof pScope.Path && it.segments.length >= 2) leaves.push(it);
                                };
                                collect(split);
                                for (const k of leaves) { if ((k.area || 0) < 0) { try { k.reverse(); } catch (_) { } } }
                                const cand = leaves.length === 1 ? leaves[0] : new pScope.CompoundPath({ children: leaves });
                                const gotC = rasterizeItems(pScope, [cand]);
                                if (gotC >= 0 && Math.abs(gotC - truth2) <= Math.max(60, truth2 * 0.02)) {
                                    resultPath.remove();
                                    resultPath = cand;
                                } else {
                                    try { cand.remove(); } catch (_) { }
                                }
                            }
                        } catch (_) { }
                    }
                } else {
                    // Candidate A: split all self/inter-piece crossings, then
                    // reorient every sub-ring positive — simple positive rings
                    // compose under nonzero into exactly the OR region.
                    let candA = null;
                    try {
                        const cp = new pScope.CompoundPath({ children: fresh.map(p => p.clone({ insert: false })) });
                        if (typeof cp.resolveCrossings === "function") {
                            const split = cp.resolveCrossings();
                            if (split) {
                                const kids = (split instanceof pScope.CompoundPath ? [...split.children] : [split])
                                    .filter(k => k instanceof pScope.Path && k.segments.length >= 2);
                                for (const k of kids) { if ((k.area || 0) < 0) { try { k.reverse(); } catch (_) { } } }
                                candA = buildAll(kids);
                                if (split !== candA) { try { split.remove(); } catch (_) { } }
                            }
                        }
                        cp.remove();
                    } catch (_) { candA = null; }
                    const gotA = candA ? rasterizeItems(pScope, [candA]) : -1;
                    if (candA && gotA >= 0 && Math.abs(gotA - truth2) <= Math.max(60, truth2 * 0.02)) {
                        for (const p of fresh) { try { p.remove(); } catch (_) { } }
                        resultPath = candA;
                    } else {
                        try { if (candA) candA.remove(); } catch (_) { }
                        // There USED to be a "Candidate B" here: reorient every fresh
                        // piece positive and accept it without any verification. That
                        // silently changed the region on self-intersecting input — the
                        // rendered result then disagreed with what Expand Stroke
                        // materializes, and the defect was invisible. Removed: an
                        // unverified candidate is not a result, it is a failure, and
                        // it is reported as one below.
                        for (const p of fresh) { try { p.remove(); } catch (_) { } }
                    }
                }
    }

    // Discard the source pieces — EXCEPT when the raw candidate adopted them
    // as its own children: paper's Item.remove() detaches a child from its
    // parent, so removing them here would empty the winning CompoundPath and
    // null the whole cache (fill vanishes, every frame rebuilds the cache =
    // stall, expand stroke no-ops).
    if (!rawAdoptedPieces) {
        for (const p of leafPieces) { try { p.remove(); } catch (_) { } }
    } else if (resultPath && Array.isArray(resultPath.children)) {
        // CompoundPath result: re-check the adopted children. Its children are
        // the source pieces themselves, so a detach anywhere above would leave
        // an empty shell that serializes to zero rings.
        //
        // NOTE: this check must be guarded with Array.isArray(children). When the
        // raw candidate is a SINGLE piece, `resultPath` is a bare Path, which has
        // no `children` at all — treating that as "empty" dropped a perfectly good
        // result and fell through to a reoriented clone of the ring (the old
        // rebuild fallback). That reorientation silently flipped the winding of a
        // self-intersecting stroke ring, i.e. it changed the painted region: it is
        // the exact class of silent fallback that must not exist. A bare Path is
        // the geometry itself; if it was accepted by the raster check it is valid
        // as-is.
        const live = resultPath.children.filter(k => k instanceof pScope.Path && k.segments.length >= 2);
        if (live.length === 0) {
            try { resultPath.remove(); } catch (_) { }
            resultPath = null;
            diag.rawChildrenDetached = true;
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

    // Smart Expand Direction (rule: winding decided by signed-area integral,
    // same semantics as plain path direction): the cache IS the expand-
    // materialized region, so its outer contour must follow
    // smart_stroke_clockwise — root rings set to the requested direction,
    // nested hole rings kept alternating (paper's reorient is containment-
    // aware). Direction flips of simple rings preserve the region; verified
    // against the raster anyway, and the pre-reorient shape is restored when
    // a self-intersecting candidate would change area under reorientation.
    if (curve.smart_stroke && curve.stroke_width > 0 && resultPath && typeof resultPath.reorient === "function") {
        let restored = null;
        try {
            const before = truth >= 0 ? rasterizeItems(pScope, [resultPath]) : -1;
            if (before >= 0) restored = resultPath.clone({ insert: false });
            resultPath.reorient(true, curve.smart_stroke_clockwise !== false);
            if (restored) {
                const after = rasterizeItems(pScope, [resultPath]);
                if (after < 0 || Math.abs(after - before) > Math.max(60, before * 0.02)) {
                    // reorientation changed the region (pathological self-
                    // intersecting candidate) — region correctness wins.
                    try { resultPath.remove(); } catch (_) { }
                    resultPath = restored;
                    restored = null;
                }
            }
        } catch (e) {
            console.warn("Smart-stroke winding reorient failed", e);
        }
        if (restored) { try { restored.remove(); } catch (_) { } }
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
        // No merge candidate produced a ring structure that could be verified
        // against the winding-independent ground truth. This is a broken
        // invariant: this curve's fill cannot be produced, so the render would
        // show only the 1px skeleton line. Report it explicitly (dialog +
        // error.log) and commit NO cache — deliberately not substituted with
        // un-merged raw geometry, because that would render a region that
        // disagrees with what Expand Stroke materializes, hiding the defect.
        curve.cached_boolean_geometry = null;
        curve._booleanPath2D = null;
        reportCacheFailure(curve, "smart expand: boolean merge produced no usable rings", {
            ...diag,
            resultPathKind: resultPath ? (resultPath instanceof pScope.CompoundPath ? "CompoundPath" : "Path") : null,
            resultRings: resultPath && resultPath.children ? resultPath.children.length : (resultPath ? 1 : 0),
            startEqualsEnd: curve.startNode === curve.endNode,
            smart_stroke: !!curve.smart_stroke,
            smart_stroke_clockwise: curve.smart_stroke_clockwise !== false,
            stroke_width: curve.stroke_width ?? null,
            closed: !!curve.closed,
            hasFillArea
        });
    } else {
        curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
    }

    if (resultPath) resultPath.remove();
}
