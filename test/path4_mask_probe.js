// Path_4 real-curve mask verification after the kept>1 child-removal fix:
// compare the cached geometry fill vs the RAW (unresolved) outline fill.
// Also replicate the PRE-FIX pipeline (classify + direction-unify but keep
// ALL children) to see whether CORE_DIFF=8 is introduced by the removal
// or pre-exists in the resolved CompoundPath fill itself.
// If CORE_DIFF=0 for both, the removal was pure redundancy.
export async function runPath4MaskProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const c = document.querySelector('main-canvas');
    const cm = c ? c.curve_manager : null;
    const curves = cm ? cm.curves : [];
    const path4 = curves.find(cur => cur.id === 'Path_4');
    if (!path4) { log('Path_4 NOT FOUND'); return out.join('\n'); }

    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    const { refreshCurveBooleanCache } = await import('/js/core/boolean_geometry_cache.js');
    const { emitExpandedStrokeOutline } = await import('/js/core/bezier/path_emitter.js');

    class Rec {
        constructor() { this.paths = []; this.curr = null; }
        moveTo(x, y) { this.curr = []; this.paths.push(this.curr); this.curr.push({ t: 'M', x, y }); }
        lineTo(x, y) { if (this.curr) this.curr.push({ t: 'L', x, y }); }
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { if (this.curr) this.curr.push({ t: 'C', c1x, c1y, c2x, c2y, x, y }); }
        closePath() { if (this.curr) this.curr.push({ t: 'Z' }); }
    }

    const SAMPLES = 32;

    // polyline sampling of a cache subpath (production segment format)
    function polylineOfCacheSub(sub, samples) {
        const pts = [];
        const n = sub.segments.length;
        if (n < 2) return pts;
        for (let i = 0; i < n; i++) {
            const s = sub.segments[i];
            const nxt = sub.segments[(i + 1) % n];
            const p0 = { x: s.x, y: s.y };
            const c1 = { x: s.x + s.outX, y: s.y + s.outY };
            const c2 = { x: nxt.x + nxt.inX, y: nxt.y + nxt.inY };
            const p3 = { x: nxt.x, y: nxt.y };
            for (let t = 0; t < samples; t++) {
                const tt = t / samples, mt = 1 - tt;
                pts.push({
                    x: mt * mt * mt * p0.x + 3 * mt * mt * tt * c1.x + 3 * mt * tt * tt * c2.x + tt * tt * tt * p3.x,
                    y: mt * mt * mt * p0.y + 3 * mt * mt * tt * c1.y + 3 * mt * tt * tt * c2.y + tt * tt * tt * p3.y
                });
            }
        }
        return pts;
    }

    // winding of a polyline against (px, py)
    function windingOfPolyline(pts, px, py) {
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

    // polyline of one raw (unresolved) paper path
    function polylineOfPath(p, samples) {
        const pts = [];
        for (const seg of p.segments) {
            const p0 = seg.point;
            const c1 = seg.handleOut ? p0.add(seg.handleOut) : p0;
            const nxt = seg.next;
            const p3 = nxt ? nxt.point : p0;
            const c2 = nxt && nxt.handleIn ? p3.add(nxt.handleIn) : p3;
            for (let t = 0; t < samples; t++) {
                const tt = t / samples, mt = 1 - tt;
                pts.push({
                    x: mt * mt * mt * p0.x + 3 * mt * mt * tt * c1.x + 3 * mt * tt * tt * c2.x + tt * tt * tt * p3.x,
                    y: mt * mt * mt * p0.y + 3 * mt * mt * tt * c1.y + 3 * mt * tt * tt * c2.y + tt * tt * tt * p3.y
                });
            }
        }
        return pts;
    }

    // --- replicate the production pipeline for the PRE-FIX geometry ---
    function buildPaperPathsLike(recPaths) {
        const list = [];
        for (const sub of recPaths) {
            if (!sub.length) continue;
            let p = new pScope.Path();
            for (const cmd of sub) {
                if (cmd.t === 'M') p.moveTo(new pScope.Point(cmd.x, cmd.y));
                else if (cmd.t === 'L') p.lineTo(new pScope.Point(cmd.x, cmd.y));
                else if (cmd.t === 'C') p.cubicCurveTo(new pScope.Point(cmd.c1x, cmd.c1y), new pScope.Point(cmd.c2x, cmd.c2y), new pScope.Point(cmd.x, cmd.y));
                else if (cmd.t === 'Z') p.closed = true;
            }
            for (const s of p.segments) {
                if (s.handleIn && s.handleIn.length < 0.001) s.handleIn.set(0, 0);
                if (s.handleOut && s.handleOut.length < 0.001) s.handleOut.set(0, 0);
            }
            list.push(p);
        }
        return list;
    }

    // build raw unresolved outlines (same recorder replay as production)
    const outline = path4.computeExpandedStrokeOutline(4);
    const recRaw = new Rec();
    emitExpandedStrokeOutline(recRaw, outline, (x, y) => ({ x, y }), {
        roundCap: false, curve: null, halfWidth: 0
    });
    const rawPaths = buildPaperPathsLike(recRaw.paths);
    const rawPolylines = rawPaths.map(p => polylineOfPath(p, SAMPLES));
    const rawWinding = (px, py) => {
        let w = 0;
        for (const pl of rawPolylines) w += windingOfPolyline(pl, px, py);
        return w;
    };

    // --- resolveCrossings + classify + direction-unify, keep ALL children (pre-fix behavior) ---
    const recRes = new Rec();
    emitExpandedStrokeOutline(recRes, outline, (x, y) => ({ x, y }), {
        roundCap: false, curve: null, halfWidth: 0
    });
    const resPaths = [];
    for (const sub of recRes.paths) {
        if (!sub.length) continue;
        let p = buildPaperPathsLike([sub])[0];
        try {
            const resolved = p.resolveCrossings();
            if (resolved && resolved !== p) { p.remove(); p = resolved; }
        } catch (_) { }
        resPaths.push(p);
    }

    // classify children (mirror of production L169-217), then serialize ALL children
    function ringInterior(child) {
        const b = child.bounds;
        for (let gy = 1; gy < 20; gy++) {
            for (let gx = 1; gx < 20; gx++) {
                const px = b.x + b.width * gx / 20;
                const py = b.y + b.height * gy / 20;
                try { if (child.contains(new pScope.Point(px, py))) return { x: px, y: py }; } catch (_) { }
            }
        }
        return { x: b.center.x, y: b.center.y };
    }

    const prefixed = [];
    const postfixed = [];
    for (let i = 0; i < resPaths.length; i++) {
        const p = resPaths[i];
        const rawPath = rawPaths[i];
        const serialize = (child) => {
            const segs = [];
            for (const seg of child.segments) {
                segs.push({ x: seg.point.x, y: seg.point.y, inX: seg.handleIn.x, inY: seg.handleIn.y, outX: seg.handleOut.x, outY: seg.handleOut.y });
            }
            return { closed: child.closed, segments: segs };
        };
        if (p instanceof pScope.CompoundPath && p.children.length > 1) {
            const rawArea = rawPath ? rawPath.area : 0;
            const childAreaSum = p.children.reduce((s, cc) => s + (cc.area || 0), 0);
            const faithful = rawArea !== 0 && Math.abs(childAreaSum - rawArea) / Math.abs(rawArea) < 0.1;
            if (!faithful) {
                // fallback keeps raw path (same in pre/post fix)
                prefixed.push(serialize(rawPath));
                postfixed.push(serialize(rawPath));
                continue;
            }
            const kept = [];
            for (const child of p.children) {
                if (!(child instanceof pScope.Path)) { kept.push({ child, wnNonZero: true }); continue; }
                const pt = ringInterior(child);
                let wnNonZero = true;
                try { wnNonZero = rawPath.contains(new pScope.Point(pt.x, pt.y)); } catch (_) { }
                let covered = false;
                for (const other of p.children) {
                    if (other === child) continue;
                    try { if (other.contains(new pScope.Point(pt.x, pt.y))) { covered = true; break; } } catch (_) { }
                }
                if (!wnNonZero || !covered) kept.push({ child, wnNonZero });
            }
            const fillRings = kept.filter(m => m.wnNonZero).map(m => m.child);
            const holeRings = kept.filter(m => !m.wnNonZero).map(m => m.child);
            if (fillRings.length) {
                const baseSign = Math.sign(fillRings[0].area) || -1;
                for (const cc of fillRings) if ((Math.sign(cc.area) || -1) !== baseSign) cc.reverse();
                for (const cc of holeRings) if ((Math.sign(cc.area) || -1) === baseSign) cc.reverse();
            }
            // PRE-FIX: keep ALL children
            for (const child of p.children) prefixed.push(serialize(child));
            // POST-FIX: keep only kept children
            const keptSet = new Set(kept.map(m => m.child));
            for (const child of p.children) if (keptSet.has(child)) postfixed.push(serialize(child));
        } else {
            const ser = serialize(p);
            prefixed.push(ser);
            postfixed.push(ser);
        }
    }
    for (const p of resPaths) { try { p.remove(); } catch (_) { } }

    // production cache (post-fix)
    refreshCurveBooleanCache(path4);
    const cache = path4.cached_boolean_geometry;
    if (!cache) { log('CACHE NULL'); return out.join('\n'); }
    log('cache subpaths=' + cache.length + ' segs=[' + cache.map(s => s.segments.length).join(',') + ']');
    log('replicated PREFIX subpaths=' + prefixed.length + ' POSTFIX subpaths=' + postfixed.length);

    const cachePolylines = cache.map(s => polylineOfCacheSub(s, SAMPLES));
    const prefixPolylines = prefixed.map(s => polylineOfCacheSub(s, SAMPLES));
    const postfixPolylines = postfixed.map(s => polylineOfCacheSub(s, SAMPLES));
    const geomWinding = (pls, px, py) => {
        let w = 0;
        for (const pl of pls) w += windingOfPolyline(pl, px, py);
        return w;
    };

    let bx = Infinity, by = Infinity, bx2 = -Infinity, by2 = -Infinity;
    for (const p of rawPaths) {
        bx = Math.min(bx, p.bounds.x); by = Math.min(by, p.bounds.y);
        bx2 = Math.max(bx2, p.bounds.x + p.bounds.width); by2 = Math.max(by2, p.bounds.y + p.bounds.height);
    }
    const step = 6;

    const compareMasks = (label, geomW, isCore) => {
        let diff = 0, diffCore = 0, truthFill = 0, geomFill = 0, total = 0;
        const coreSamples = [];
        for (let py = by - 4; py <= by2 + 4; py += step) {
            for (let px = bx - 4; px <= bx2 + 4; px += step) {
                total++;
                const tw = rawWinding(px, py) !== 0;
                const gw = geomW(px, py) !== 0;
                if (tw) truthFill++;
                if (gw) geomFill++;
                if (tw !== gw) {
                    diff++;
                    // boundary artifact check: winding changes within 0.01px on EITHER side
                    const t0 = rawWinding(px - 0.01, py) !== 0, t1 = rawWinding(px + 0.01, py) !== 0;
                    const t2 = rawWinding(px, py - 0.01) !== 0, t3 = rawWinding(px, py + 0.01) !== 0;
                    const g0 = geomW(px - 0.01, py) !== 0, g1 = geomW(px + 0.01, py) !== 0;
                    const g2 = geomW(px, py - 0.01) !== 0, g3 = geomW(px, py + 0.01) !== 0;
                    const rawStable = !(t0 !== tw || t1 !== tw || t2 !== tw || t3 !== tw);
                    const geomStable = !(g0 !== gw || g1 !== gw || g2 !== gw || g3 !== gw);
                    if (rawStable && geomStable) {
                        diffCore++;
                        if (coreSamples.length < 8) coreSamples.push({ x: px.toFixed(1), y: py.toFixed(1), tw, gw, rw: rawWinding(px, py), gwv: geomW(px, py) });
                    }
                }
            }
        }
        log(label + ': truthFill=' + truthFill + ' geomFill=' + geomFill + ' total=' + total +
            ' DIFF=' + diff + ' CORE_DIFF=' + diffCore);
        if (coreSamples.length) {
            log('  core samples (x,y,truthFilled,geomFilled,rawWinding,geomWinding): ' + JSON.stringify(coreSamples));
        }
        if (isCore) log(coreSamples.length === 0 ? 'RESULT: PASS (removed rings were pure redundancy)' : 'RESULT: FAIL (fill changed!)');
    };
    compareMasks('POSTFIX-replica (kept only)', postfixPolylines && ((px, py) => geomWinding(postfixPolylines, px, py)), false);
    compareMasks('PREFIX-replica  (all children)', (px, py) => geomWinding(prefixPolylines, px, py), false);
    compareMasks('PRODUCTION cache (post-fix)', (px, py) => geomWinding(cachePolylines, px, py), true);

    for (const p of rawPaths) { try { p.remove(); } catch (_) { } }
    return out.join('\n');
}
