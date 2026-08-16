// Decisive probe: winding-based classification of resolved children.
// Ground truth = RAW self-intersecting outline fill (nonzero) — this IS the
// stroke definition the app itself produces (computeExpandedStrokeOutline).
// Rule under test:
//   child is HOLE       iff winding(interior) == 0          -> keep (reversed ring carves)
//   child is BODY       iff winding != 0 && NOT covered by any larger ring -> keep
//   child is SWALLOWTAIL iff winding != 0 && covered by another kept ring    -> delete
// Then: mask(kept compound, Paper.contains) must equal mask(raw outline, windingAt).
export async function runClassifyProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    const { Curve } = await import('/js/core/bezier/curve.js');
    const { CurveNode } = await import('/js/core/bezier/node.js');
    const { emitExpandedStrokeOutline } = await import('/js/core/bezier/path_emitter.js');

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

    function ringInteriorPoint(child) {
        const b = child.bounds;
        const steps = 20;
        for (let gy = 1; gy < steps; gy++) {
            for (let gx = 1; gx < steps; gx++) {
                const px = b.x + b.width * gx / steps;
                const py = b.y + b.height * gy / steps;
                if (child.contains(new pScope.Point(px, py))) return { x: px, y: py };
            }
        }
        return { x: b.center.x, y: b.center.y };
    }

    function analyze(label, nodes, halfWidth, closed, roundCap) {
        const curve = new Curve({ id: 'probe' });
        curve.closed = closed;
        curve.smart_stroke = true;
        curve.stroke_width = halfWidth * 2;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (i > 0) nodes[i - 1].nextOnCurve = n;
            if (i < nodes.length - 1) n.lastOnCurve = nodes[i - 1];
        }
        curve.startNode = nodes[0];
        curve.endNode = nodes[nodes.length - 1];

        const outline = curve.computeExpandedStrokeOutline(halfWidth);
        if (!outline) { log(label, 'NO OUTLINE'); return; }

        const recRaw = new Rec();
        emitExpandedStrokeOutline(recRaw, outline, (x, y) => ({ x, y }), {
            roundCap, curve: roundCap ? curve : null, halfWidth: roundCap ? halfWidth : 0
        });
        const originalPaths = buildPaperPath(recRaw, false);
        const resolvedPaths = buildPaperPath(recRaw, true);
        if (!originalPaths.length) { log(label, 'NO PATHS'); return; }
        log('  debug: raw subpaths=' + recRaw.paths.length +
            ' origPaths=' + originalPaths.length +
            ' resolvedPaths=' + resolvedPaths.length +
            ' resolvedChildren=' + (resolvedPaths.reduce((n, p) => n + (p instanceof pScope.CompoundPath ? p.children.length : 1), 0)));
        const rawWindingAll = (px, py) => {
            let w = 0;
            for (const p of originalPaths) w += windingAt(p, px, py);
            return w;
        };
        const raw = originalPaths[0];

        // collect children with metadata
        const children = [];
        for (const p of resolvedPaths) {
            if (p instanceof pScope.CompoundPath) children.push(...p.children);
            else if (p instanceof pScope.Path) children.push(p);
        }

        // diagnostic: raw path segment counts + point winding probes
        {
            const segCount = (p) => (p.segments ? p.segments.length : 'compound(' + p.children.map(c => c.segments.length).join(',') + ')');
            log('  diag: raw segs=' + segCount(raw) +
                ' children segs=[' + children.map(segCount).join(',') + ']');
            if (label === 'Hairpin open') {
                const probes = [[0,0],[60,0],[120,0],[120,45],[60,45],[0,90],[60,90],[120,90],[30,45],[95,25],[95,65]];
                for (const [px, py] of probes) {
                    log('    probe(' + px + ',' + py + ') rawWn=' + rawWindingAll(px, py) +
                        ' childWn=[' + children.map(c => windingAt(c, px, py)).join(',') + ']');
                }
                // dump segment coordinates for raw + each child
                const dumpSegs = (tag, segPaths) => {
                    for (const [ci, s] of segPaths.entries()) {
                        const coords = s.segments.map(seg =>
                            seg.point.x.toFixed(1) + ',' + seg.point.y.toFixed(1));
                        log('    ' + tag + '[' + ci + '] closed=' + s.closed + ' segs=' + JSON.stringify(coords));
                    }
                };
                dumpSegs('raw', raw instanceof pScope.CompoundPath ? raw.children : [raw]);
                dumpSegs('child', children);
            }
        }

        log('=== ' + label + ' (hw=' + halfWidth + ') ===');
        const rawAreaAll = originalPaths.reduce((s, p) => s + (p.area || 0), 0);
        log('  children: ' + children.length + ' | raw subpath areas: ' +
            originalPaths.map(p => p.area.toFixed(1)).join('+') + '=' + rawAreaAll.toFixed(1));

        // classify: winding against raw (ALL subpaths) + coverage by other rings
        const meta = children.map((child, i) => {
            const pt = ringInteriorPoint(child);
            const wn = rawWindingAll(pt.x, pt.y);
            // count how many OTHER rings contain this child's interior point
            let coveredBy = [];
            for (let j = 0; j < children.length; j++) {
                if (j === i) continue;
                try { if (children[j].contains(new pScope.Point(pt.x, pt.y))) coveredBy.push(j); } catch (_) { }
            }
            return { child, i, wn, pt, coveredBy, area: child.area, bounds: [child.bounds.width, child.bounds.height] };
        });

        for (const m of meta) {
            log('    child[' + m.i + '] area=' + m.area.toFixed(1) +
                ' bounds=' + m.bounds[0].toFixed(1) + 'x' + m.bounds[1].toFixed(1) +
                ' wn=' + m.wn + ' coveredBy=[' + m.coveredBy.join(',') + ']');
        }

        // PRODUCTION-SEMANTICS CHECK: can we use Paper's Path.contains on the
        // raw self-intersecting path instead of the custom ray-cast windingAt?
        // (Paper Path.contains with default fillRule 'nonzero' returns winding!=0)
        {
            let containsMismatch = [];
            for (const m of meta) {
                let c = null;
                try { c = originalPaths.some(p => p.contains(new pScope.Point(m.pt.x, m.pt.y))); } catch (_) { }
                const wnNonZero = m.wn !== 0;
                if (c === null || c !== wnNonZero) containsMismatch.push([m.i, +m.pt.x.toFixed(1), +m.pt.y.toFixed(1), m.wn, c]);
            }
            log('  containsSemantics: raw.contains == (winding!=0)? ' +
                (containsMismatch.length === 0 ? 'YES' : 'MISMATCH ' + JSON.stringify(containsMismatch)));
            const childAreaSum = children.reduce((s, c) => s + (c.area || 0), 0);
            const ratio = rawAreaAll !== 0 ? Math.abs(childAreaSum / rawAreaAll) : 0;
            log('  faithfulness: |sum(child.area)/raw.area|=' + ratio.toFixed(4) + ' ' +
                (Math.abs(ratio - 1) < 0.1 ? 'FAITHFUL' : 'UNFAITHFUL'));
        }

        // rule: keep = (wn==0) OR (wn!=0 && coveredBy.length==0)
        const kept = meta.filter(m => m.wn === 0 || m.coveredBy.length === 0);
        log('  kept: [' + kept.map(m => m.i).join(',') + ']  deleted: [' +
            meta.filter(m => !kept.includes(m)).map(m => m.i).join(',') + ']');

        // build kept compound with EXPLICIT direction unification:
        // all wn!=0 (fill) rings get the SAME orientation; wn==0 (hole)
        // rings get the OPPOSITE orientation. This makes CompoundPath
        // fill("nonzero") semantics equal to the raw self-intersecting
        // path's nonzero fill — without relying on resolveCrossings'
        // alternating-direction assumption (which is only valid for
        // nested rings, and breaks for separate swallowtail rings like
        // the hairpin's, turning them into holes).
        let keptPath;
        if (kept.length === 0) { log('  NOTHING KEPT'); return; }
        const fillRings = kept.filter(m => m.wn !== 0);
        const holeRings = kept.filter(m => m.wn === 0);
        if (fillRings.length) {
            const baseSign = Math.sign(fillRings[0].child.area) || -1;
            for (const m of fillRings) {
                const c = m.child;
                if ((Math.sign(c.area) || -1) !== baseSign) c.reverse();
            }
            for (const m of holeRings) {
                const c = m.child;
                if ((Math.sign(c.area) || -1) === baseSign) c.reverse();
            }
        }
        const clones = kept.map(m => m.child.clone());
        if (kept.length === 1) keptPath = clones[0];
        else {
            keptPath = new pScope.CompoundPath();
            for (const c of clones) keptPath.addChild(c);
        }

        // exact mask comparison: grid over raw bounds, excluding the
        // boundary band (windingAt ray-cast vs contains disagree exactly
        // on the outline edge — a sampling artifact, not a classification error).
        // NOTE: kept mask uses ACCUMULATED WINDING over all kept rings
        // (nonzero rule) — NOT Paper's Path.contains / CompoundPath.contains,
        // which use even-odd-style nesting semantics and would wrongly
        // report overlapping same-direction rings (hairpin swallowtail) as
        // holes. Canvas fill("nonzero") accumulates winding, so this matches
        // real rendering.
        const b = originalPaths[0].bounds;
        let bx = b.x, by = b.y, bx2 = b.x + b.width, by2 = b.y + b.height;
        for (const p of originalPaths.slice(1)) {
            bx = Math.min(bx, p.bounds.x);
            by = Math.min(by, p.bounds.y);
            bx2 = Math.max(bx2, p.bounds.x + p.bounds.width);
            by2 = Math.max(by2, p.bounds.y + p.bounds.height);
        }
        const step = 4;
        const x0 = bx - 4, y0 = by - 4, x1 = bx2 + 4, y1 = by2 + 4;
        const keptRings = keptPath instanceof pScope.CompoundPath ? keptPath.children : [keptPath];
        const keptWinding = (px, py) => {
            let w = 0;
            for (const ring of keptRings) w += windingAt(ring, px, py);
            return w;
        };
        const onBoundary = (px, py) => Math.abs(rawWindingAll(px, py)) === 0 &&
            (rawWindingAll(px - 0.01, py) !== 0 || rawWindingAll(px, py - 0.01) !== 0 ||
             rawWindingAll(px + 0.01, py) !== 0 || rawWindingAll(px, py + 0.01) !== 0);
        let diff = 0, diffCore = 0, rawFill = 0, keptFill = 0, total = 0, core = 0;
        const mismatchSamples = [];
        for (let py = y0; py <= y1; py += step) {
            for (let px = x0; px <= x1; px += step) {
                total++;
                const rw = rawWindingAll(px, py) !== 0;
                const kw = keptWinding(px, py) !== 0;
                if (rw) rawFill++;
                if (kw) keptFill++;
                if (rw !== kw) {
                    diff++;
                    if (!onBoundary(px, py)) {
                        diffCore++;
                        if (mismatchSamples.length < 5) mismatchSamples.push([px.toFixed(1), py.toFixed(1), rw, kw]);
                    }
                } else core++;
            }
        }
        log('  mask: rawFill=' + rawFill + ' keptFill=' + keptFill + ' total=' + total +
            ' DIFF=' + diff + ' CORE_DIFF=' + diffCore);
        if (mismatchSamples.length) log('  core mismatch samples (x,y,raw,kept): ' + JSON.stringify(mismatchSamples));

        // cleanup
        try { keptPath.remove(); } catch (_) { }
        for (const m of meta) try { m.child.remove(); } catch (_) { }
    }

    // Case 1: L (П) shape open
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
        analyze('L-shape open', [n1, n2, n3, n4], 20, false, false);
    }

    // Case 2: hairpin U-turn open
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
        analyze('Hairpin open', [a1, a2, a3, a4, a5, a6], 25, false, false);
    }

    // Case 3: closed ring P
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
        analyze('P-ring closed', [b1, b2, b3, b4], 15, true, false);
    }

    // Case 4: isolated resolveCrossings behavior on the hairpin raw path
    {
        log('=== resolveCrossings isolation (hairpin) ===');
        const curve = new Curve({ id: 'iso' });
        curve.closed = false;
        curve.smart_stroke = true;
        curve.stroke_width = 50;
        const nodes = [
            makeNode(0, 0), makeNode(60, 0), makeNode(120, 0),
            makeNode(120, 90), makeNode(60, 90), makeNode(0, 90)
        ];
        nodes[0].control1 = new CurveNode(null, null, 30, 0, nodes[0], null, 'h1');
        nodes[1].control2 = new CurveNode(null, null, 90, 0, nodes[1], null, 'h2');
        nodes[2].control1 = new CurveNode(null, null, 120, 30, nodes[2], null, 'h3');
        nodes[3].control2 = new CurveNode(null, null, 120, 60, nodes[3], null, 'h4');
        nodes[4].control1 = new CurveNode(null, null, 90, 90, nodes[4], null, 'h5');
        nodes[5].control2 = new CurveNode(null, null, 30, 90, nodes[5], null, 'h6');
        for (let i = 0; i < nodes.length; i++) {
            if (i > 0) nodes[i - 1].nextOnCurve = nodes[i];
            if (i < nodes.length - 1) nodes[i].lastOnCurve = nodes[i - 1];
        }
        curve.startNode = nodes[0];
        curve.endNode = nodes[nodes.length - 1];

        const outline = curve.computeExpandedStrokeOutline(25);
        const rec = new Rec();
        emitExpandedStrokeOutline(rec, outline, (x, y) => ({ x, y }), {
            roundCap: false, curve: null, halfWidth: 0
        });
        const paths = buildPaperPath(rec, false);
        const p0 = paths[0];
        log('  raw: closed=' + p0.closed + ' segs=' + p0.segments.length +
            ' bounds=' + p0.bounds.x.toFixed(1) + ',' + p0.bounds.y.toFixed(1) +
            ' ' + p0.bounds.width.toFixed(1) + 'x' + p0.bounds.height.toFixed(1));
        let resolved = p0;
        try { resolved = p0.resolveCrossings(); } catch (e) { log('  resolveCrossings threw: ' + e.message); }
        if (resolved instanceof pScope.CompoundPath) {
            log('  resolved: CompoundPath children=' + resolved.children.length);
            for (const [ci, c] of resolved.children.entries()) {
                log('    child[' + ci + '] segs=' + c.segments.length +
                    ' bounds=' + c.bounds.x.toFixed(1) + ',' + c.bounds.y.toFixed(1) +
                    ' ' + c.bounds.width.toFixed(1) + 'x' + c.bounds.height.toFixed(1) +
                    ' area=' + c.area.toFixed(1));
            }
        } else if (resolved instanceof pScope.Path) {
            log('  resolved: single Path segs=' + resolved.segments.length + ' (no split)');
        } else {
            log('  resolved: ' + String(resolved));
        }
        // cumulative segment coverage: trace all children segments, check they cover raw bounds
        const probePts = [[0, 0], [60, 0], [120, 0], [120, 45], [120, 90], [60, 90], [0, 90], [145, 45], [95, 45]];
        if (resolved instanceof pScope.CompoundPath) {
            for (const [px, py] of probePts) {
                const inAny = resolved.children.some(c => {
                    try { return c.contains(new pScope.Point(px, py)); } catch (_) { return false; }
                });
                const rawW = windingAt(p0, px, py);
                log('    contains(' + px + ',' + py + ') rawWn=' + rawW + ' inAnyChild=' + inAny);
            }
        }
        try { resolved.remove(); } catch (_) { }
        try { p0.remove(); } catch (_) { }
    }

    return out.join('\n');
}
