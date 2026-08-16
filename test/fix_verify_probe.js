// Production-entry verification: call refreshCurveBooleanCache (the real app
// code path) on the regression cases and validate the OUTPUT structure
// (cached_boolean_geometry) plus a winding-mask comparison against the
// correct ground truth.
//
// Ground truth:
//   OPEN stroke  → the raw self-intersecting outline fill (nonzero) — this IS
//                  the stroke definition the app produces.
//   CLOSED stroke → raw outline fill  ∪  skeleton-polygon fill (the app's
//                  "hasFillArea" model: a closed smart stroke is a solid
//                  shape; the fill-area union intentionally fills the
//                  counter).  The union step may collapse a hole-bearing
//                  CompoundPath into one self-intersecting path — the
//                  counter then fills, matching the closed-stroke model.
//
// Structural expectations:
//   L-shape  → 1 closed subpath (single clean ring — no path splitting)
//              [old code: 3 subpaths — the "stroke cut" regression]
//   Hairpin  → 1 closed subpath covering the FULL U incl. the right band
//              (x up to 145) — resolveCrossings drops that band, so the
//              faithfulness guard must fall back to the raw outline.
//   P-ring / Circle → production fill must match raw∪fillArea ground truth.
export async function runFixVerifyProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    const { Curve } = await import('/js/core/bezier/curve.js');
    const { CurveNode } = await import('/js/core/bezier/node.js');
    const { refreshCurveBooleanCache } = await import('/js/core/boolean_geometry_cache.js');
    const { emitExpandedStrokeOutline, emitCubicBezierSegments } = await import('/js/core/bezier/path_emitter.js');

    function makeNode(x, y, c1x, c1y, c2x, c2y) {
        const n = new CurveNode(null, null, x, y, null, null, 'n' + Math.random().toString(36).slice(2));
        if (c1x !== undefined) n.control1 = new CurveNode(null, null, c1x, c1y, n, null, 'c1' + Math.random());
        if (c2x !== undefined) n.control2 = new CurveNode(null, null, c2x, c2y, n, null, 'c2' + Math.random());
        return n;
    }

    class Rec {
        constructor() { this.paths = []; this.curr = null; }
        moveTo(x, y) { this.curr = []; this.paths.push(this.curr); this.curr.push({ t: 'M', x, y }); }
        lineTo(x, y) { if (this.curr) this.curr.push({ t: 'L', x, y }); }
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { if (this.curr) this.curr.push({ t: 'C', c1x, c1y, c2x, c2y, x, y }); }
        closePath() { if (this.curr) this.curr.push({ t: 'Z' }); }
    }

    function buildPaperPath(rec, resolve) {
        const list = [];
        for (const sub of rec.paths) {
            if (!sub.length) continue;
            let p = new pScope.Path();
            for (const c of sub) {
                if (c.t === 'M') p.moveTo(new pScope.Point(c.x, c.y));
                else if (c.t === 'L') p.lineTo(new pScope.Point(c.x, c.y));
                else if (c.t === 'C') p.cubicCurveTo(new pScope.Point(c.c1x, c.c1y), new pScope.Point(c.c2x, c.c2y), new pScope.Point(c.x, c.y));
                else if (c.t === 'Z') p.closed = true;
            }
            for (const s of p.segments) {
                if (s.handleIn && s.handleIn.length < 0.001) s.handleIn.set(0, 0);
                if (s.handleOut && s.handleOut.length < 0.001) s.handleOut.set(0, 0);
            }
            if (resolve && typeof p.resolveCrossings === 'function') {
                try {
                    const r = p.resolveCrossings();
                    if (r && r !== p) { p.remove(); p = r; }
                } catch (e) { log('resolveCrossings failed:', e.message); }
            }
            list.push(p);
        }
        return list;
    }

    function windingAt(path, px, py, samplesPerSeg = 48) {
        const pts = [];
        for (const seg of path.segments) {
            const p0 = seg.point;
            const c1 = seg.handleOut ? p0.add(seg.handleOut) : p0;
            const nxt = seg.next;
            const p3 = nxt ? nxt.point : p0;
            const c2 = nxt && nxt.handleIn ? p3.add(nxt.handleIn) : p3;
            for (let i = 0; i <= samplesPerSeg; i++) {
                const t = i / samplesPerSeg, mt = 1 - t;
                pts.push({
                    x: mt*mt*mt*p0.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*p3.x,
                    y: mt*mt*mt*p0.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*p3.y
                });
            }
        }
        let w = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            if ((a.y > py) !== (b.y > py)) {
                const x = a.x + (b.x - a.x) * (py - a.y) / (b.y - a.y);
                if (x > px) w += b.y > a.y ? 1 : -1;
            }
        }
        return w;
    }

    // winding from cached_boolean_geometry segments (production output shape)
    function windingFromCache(subpaths, px, py, samplesPerSeg = 48) {
        let w = 0;
        for (const sub of subpaths) {
            const n = sub.segments.length;
            if (n < 2) continue;
            const pts = [];
            for (let i = 0; i < n; i++) {
                const s = sub.segments[i];
                const nxt = sub.segments[(i + 1) % n];
                const p0 = { x: s.x, y: s.y };
                const c1 = { x: s.x + s.outX, y: s.y + s.outY };
                const c2 = { x: nxt.x + nxt.inX, y: nxt.y + nxt.inY };
                const p3 = { x: nxt.x, y: nxt.y };
                for (let t = 0; t <= samplesPerSeg; t++) {
                    const tt = t / samplesPerSeg, mt = 1 - tt;
                    pts.push({
                        x: mt*mt*mt*p0.x + 3*mt*mt*tt*c1.x + 3*mt*tt*tt*c2.x + tt*tt*tt*p3.x,
                        y: mt*mt*mt*p0.y + 3*mt*mt*tt*c1.y + 3*mt*tt*tt*c2.y + tt*tt*tt*p3.y
                    });
                }
            }
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                if ((a.y > py) !== (b.y > py)) {
                    const x = a.x + (b.x - a.x) * (py - a.y) / (b.y - a.y);
                    if (x > px) w += b.y > a.y ? 1 : -1;
                }
            }
        }
        return w;
    }

    function buildCurve(nodes, closed, halfWidth) {
        const curve = new Curve({ id: 'verify' });
        curve.closed = closed;
        curve.smart_stroke = true;
        curve.stroke_width = halfWidth * 2;
        for (let i = 0; i < nodes.length; i++) {
            if (i > 0) nodes[i - 1].nextOnCurve = nodes[i];
            if (i < nodes.length - 1) nodes[i].lastOnCurve = nodes[i - 1];
        }
        curve.startNode = nodes[0];
        curve.endNode = nodes[nodes.length - 1];
        return curve;
    }

    function verify(label, curve, halfWidth, closed) {
        log('=== ' + label + ' ===');
        refreshCurveBooleanCache(curve);
        const cache = curve.cached_boolean_geometry;
        if (!cache) { log('  CACHE NULL (bad)'); return; }
        log('  cache subpaths=' + cache.length + '  segs=[' + cache.map(s => s.segments.length).join(',') +
            '] closed=[' + cache.map(s => s.closed ? 1 : 0).join(',') + ']');
        // structural assertions
        let ok = true;
        if (label.startsWith('L-shape')) {
            if (cache.length !== 1 || !cache[0].closed) { ok = false; log('  FAIL: expected 1 closed subpath'); }
        } else if (label.startsWith('Hairpin')) {
            let maxX = -Infinity;
            for (const s of cache) for (const g of s.segments) maxX = Math.max(maxX, g.x);
            if (cache.length !== 1 || !cache[0].closed) { ok = false; log('  FAIL: expected 1 closed subpath'); }
            if (maxX < 140) { ok = false; log('  FAIL: right band missing (maxX=' + maxX.toFixed(1) + ' < 140)'); }
            else log('  right band present (maxX=' + maxX.toFixed(1) + ')');
            if (cache[0].segments.length < 20) { ok = false; log('  FAIL: too few segments — resolveCrossings children leaked'); }
            log('  segs=' + cache[0].segments.length + ' (raw self-intersecting outline expected)');
        }
        // mask comparison vs ground truth (freshly rebuilt, unresolved)
        const outline = curve.computeExpandedStrokeOutline(halfWidth);
        const rec = new Rec();
        emitExpandedStrokeOutline(rec, outline, (x, y) => ({ x, y }), {
            roundCap: false, curve: null, halfWidth: 0
        });
        const rawPaths = buildPaperPath(rec, false);
        if (!rawPaths.length) { log('  NO RAW PATHS'); return; }
        const rawWindingAll = (px, py) => {
            let w = 0;
            for (const p of rawPaths) w += windingAt(p, px, py);
            return w;
        };
        // closed strokes: the app unions the skeleton polygon (fill area)
        // into the outline — ground truth = raw ∪ fillArea
        let fillPaths = [];
        if (closed) {
            const fillRec = new Rec();
            emitCubicBezierSegments(fillRec, curve.getSkeletonBezierSegments(), (x, y) => ({ x, y }), {
                close: true
            });
            fillPaths = buildPaperPath(fillRec, false);
        }
        const fillWindingAll = (px, py) => {
            let w = 0;
            for (const p of fillPaths) w += windingAt(p, px, py);
            return w;
        };
        const truthWinding = (px, py) => (rawWindingAll(px, py) !== 0 || fillWindingAll(px, py) !== 0);
        let bx = Infinity, by = Infinity, bx2 = -Infinity, by2 = -Infinity;
        for (const p of rawPaths) {
            bx = Math.min(bx, p.bounds.x); by = Math.min(by, p.bounds.y);
            bx2 = Math.max(bx2, p.bounds.x + p.bounds.width); by2 = Math.max(by2, p.bounds.y + p.bounds.height);
        }
        const step = 4;
        const x0 = bx - 4, y0 = by - 4, x1 = bx2 + 4, y1 = by2 + 4;
        // boundary band: windingAt ray-cast and the cache geometry disagree
        // exactly on outline edges (a sampling artifact, not a fill error).
        const onBoundary = (px, py) => {
            const c = truthWinding(px, py);
            return truthWinding(px - 0.01, py) !== c || truthWinding(px + 0.01, py) !== c ||
                   truthWinding(px, py - 0.01) !== c || truthWinding(px, py + 0.01) !== c;
        };
        let diff = 0, diffCore = 0, truthFill = 0, cacheFill = 0, total = 0;
        const samples = [];
        for (let py = y0; py <= y1; py += step) {
            for (let px = x0; px <= x1; px += step) {
                total++;
                const tw = truthWinding(px, py);
                const cw = windingFromCache(cache, px, py) !== 0;
                if (tw) truthFill++;
                if (cw) cacheFill++;
                if (tw !== cw) {
                    diff++;
                    if (!onBoundary(px, py)) {
                        diffCore++;
                        if (samples.length < 6) samples.push([px.toFixed(1), py.toFixed(1), tw, cw]);
                    }
                }
            }
        }
        log('  mask: truthFill=' + truthFill + ' cacheFill=' + cacheFill + ' total=' + total +
            ' DIFF=' + diff + ' CORE_DIFF=' + diffCore);
        if (samples.length) log('  core mismatch samples (x,y,truth,cache): ' + JSON.stringify(samples));
        log(ok ? '  STRUCTURE: PASS' : '  STRUCTURE: FAIL');
        for (const p of [...rawPaths, ...fillPaths]) try { p.remove(); } catch (_) { }
    }

    // Case 1: L (П) shape open — regression: stroke was split into 2+ paths
    {
        const n1 = makeNode(0, 0, 10, -30, null, null);
        const n2 = makeNode(120, 0, null, null, 10, 30);
        const n3 = makeNode(120, -100, -30, -10, null, null);
        const n4 = makeNode(0, -100, null, null, -30, 10);
        n1.control1 = new CurveNode(null, null, 40, 0, n1, null, 'c1');
        n2.control2 = new CurveNode(null, null, 80, 0, n2, null, 'c2');
        n2.control1 = new CurveNode(null, null, 120, -30, n2, null, 'c3');
        n3.control2 = new CurveNode(null, null, 120, -70, n3, null, 'c4');
        n3.control1 = new CurveNode(null, null, 80, -100, n3, null, 'c5');
        n4.control2 = new CurveNode(null, null, 40, -100, n4, null, 'c6');
        verify('L-shape open', buildCurve([n1, n2, n3, n4], false, 20), 20, false);
    }

    // Case 2: hairpin U-turn open — resolveCrossings drops the right band
    {
        const a1 = makeNode(0, 0);
        const a2 = makeNode(60, 0);
        const a3 = makeNode(120, 0);
        const a4 = makeNode(120, 90);
        const a5 = makeNode(60, 90);
        const a6 = makeNode(0, 90);
        a1.control1 = new CurveNode(null, null, 30, 0, a1, null, 'h1');
        a2.control2 = new CurveNode(null, null, 90, 0, a2, null, 'h2');
        a3.control1 = new CurveNode(null, null, 120, 30, a3, null, 'h3');
        a4.control2 = new CurveNode(null, null, 120, 60, a4, null, 'h4');
        a5.control1 = new CurveNode(null, null, 90, 90, a5, null, 'h5');
        a6.control2 = new CurveNode(null, null, 30, 90, a6, null, 'h6');
        verify('Hairpin open', buildCurve([a1, a2, a3, a4, a5, a6], false, 25), 25, false);
    }

    // Case 3: closed ring P — the stroke outline has a genuine counter hole.
    // Production unions the skeleton fill area (closed-stroke model: solid
    // interior), so the counter fills — ground truth = raw ∪ fillArea must
    // match the cache exactly (behavior preserved vs old code).
    {
        const b1 = makeNode(0, 0);
        const b2 = makeNode(150, 0);
        const b3 = makeNode(150, 90);
        const b4 = makeNode(0, 90);
        b1.control1 = new CurveNode(null, null, 50, 0, b1, null, 'p1');
        b2.control2 = new CurveNode(null, null, 100, 0, b2, null, 'p2');
        b2.control1 = new CurveNode(null, null, 150, 30, b2, null, 'p3');
        b3.control2 = new CurveNode(null, null, 150, 60, b3, null, 'p4');
        b3.control1 = new CurveNode(null, null, 100, 90, b3, null, 'p5');
        b4.control2 = new CurveNode(null, null, 50, 90, b4, null, 'p6');
        verify('P-ring closed', buildCurve([b1, b2, b3, b4], true, 15), 15, true);
    }

    // Case 4: closed circle — convex closed stroke; fillArea must still be
    // unioned (solid disc, NOT an annulus)
    {
        const R = 50, k = 0.5523;
        const c1 = makeNode(R, 0, R, -k * R, R, k * R);
        const c2 = makeNode(0, R, k * R, R, -k * R, R);
        const c3 = makeNode(-R, 0, -R, k * R, -R, -k * R);
        const c4 = makeNode(0, -R, -k * R, -R, k * R, -R);
        verify('Circle closed', buildCurve([c1, c2, c3, c4], true, 15), 15, true);
    }

    return out.join('\n');
}
