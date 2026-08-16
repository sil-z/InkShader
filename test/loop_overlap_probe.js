// Loop-overlap probe: skeleton self-overlap (the stroke itself loops back and
// crosses/overlaps itself) — NOT offset self-intersection (swallowtail).
//
// User report: when the STROKE itself loops (draws a circle and returns over
// itself), the expanded outline has MULTIPLE SAME-DIRECTION subpaths in the
// overlap region. Same-direction subpaths are redundant overlap (not holes —
// holes need opposite winding to cancel under nonzero fill), so they should
// be removed, but the current classifier keeps them.
//
// This probe builds a handwriting-style loop (line + full loop back to itself
// + continue), runs the production entry (refreshCurveBooleanCache), and
// reports subpath count, winding direction, and pairwise overlap relations.
export async function runLoopOverlapProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const { Curve } = await import('/js/core/bezier/curve.js');
    const { CurveNode } = await import('/js/core/bezier/node.js');
    const { refreshCurveBooleanCache } = await import('/js/core/boolean_geometry_cache.js');

    function makeNode(x, y) {
        return new CurveNode(null, null, x, y, null, null, 'n' + Math.random().toString(36).slice(2));
    }

    function buildCurve(nodes, closed, hw) {
        const curve = new Curve({ id: 'loop' });
        curve.closed = closed;
        curve.smart_stroke = true;
        curve.stroke_width = hw * 2;
        for (let i = 0; i < nodes.length; i++) {
            if (i > 0) nodes[i - 1].nextOnCurve = nodes[i];
            if (i < nodes.length - 1) nodes[i].lastOnCurve = nodes[i - 1];
        }
        curve.startNode = nodes[0];
        curve.endNode = nodes[nodes.length - 1];
        return curve;
    }

    async function analyze(curve) {
        // --- diagnostic: what does the production pipeline see? ---
        const { getPaperScope } = await import('/js/core/paper_scope.js');
        const pScope = getPaperScope();
        const { emitExpandedStrokeOutline } = await import('/js/core/bezier/path_emitter.js');
        const { CurveNode } = await import('/js/core/bezier/node.js');
        class Rec {
            constructor() { this.paths = []; this.curr = null; }
            moveTo(x, y) { this.curr = []; this.paths.push(this.curr); this.curr.push({ t: 'M', x, y }); }
            lineTo(x, y) { if (this.curr) this.curr.push({ t: 'L', x, y }); }
            bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { if (this.curr) this.curr.push({ t: 'C', c1x, c1y, c2x, c2y, x, y }); }
            closePath() { if (this.curr) this.curr.push({ t: 'Z' }); }
        }
        const outline = curve.computeExpandedStrokeOutline(curve.stroke_width / 2);
        const rec = new Rec();
        emitExpandedStrokeOutline(rec, outline, (x, y) => ({ x, y }), {
            roundCap: false, curve: null, halfWidth: 0
        });
        log('  DIAG: emitter sub-paths=' + rec.paths.length + ' cmds=[' + rec.paths.map(s => s.length).join(',') + ']');
        const built = [];
        for (const sub of rec.paths) {
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
            built.push(p);
        }
        for (const p of built) {
            try {
                const r = p.resolveCrossings();
                const res = (r && r !== p) ? r : p;
                log('  DIAG: sub ' + (res instanceof pScope.CompoundPath ? 'CompoundPath children=' + res.children.length : res instanceof pScope.Path ? 'Path segs=' + res.segments.length : '?') + (r && r !== p ? ' (REPLACED)' : ''));
                if (r && r !== p) p.remove();
            } catch (e) { log('  DIAG: resolveCrossings ERR: ' + e.message); }
        }
        for (const p of built) { try { p.remove(); } catch (_) { } }

        refreshCurveBooleanCache(curve);
        const cache = curve.cached_boolean_geometry;
        if (!cache) { log('  CACHE NULL'); return; }
        log('  subpaths=' + cache.length);
        const metas = [];
        for (let i = 0; i < cache.length; i++) {
            const s = cache[i];
            let area = 0;
            const n = s.segments.length;
            for (let j = 0; j < n; j++) {
                const a = s.segments[j], b = s.segments[(j + 1) % n];
                area += a.x * b.y - b.x * a.y;
            }
            area /= 2;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const g of s.segments) {
                if (g.x < minX) minX = g.x;
                if (g.x > maxX) maxX = g.x;
                if (g.y < minY) minY = g.y;
                if (g.y > maxY) maxY = g.y;
            }
            metas.push({ i, n, area, dir: area > 0 ? 'CW' : 'CCW', minX, minY, maxX, maxY });
            log('    #' + i + ' segs=' + n + ' area=' + area.toFixed(1) + ' dir=' + (area > 0 ? 'CW' : 'CCW') +
                ' bounds=(' + minX.toFixed(0) + ',' + minY.toFixed(0) + ')-(' + maxX.toFixed(0) + ',' + maxY.toFixed(0) + ')');
        }
        // pairwise overlap: same-direction subpaths whose bounding boxes intersect
        // and whose interiors overlap (center of one inside the other)
        function interiorPoint(meta) {
            const b = { x: meta.minX, y: meta.minY, width: meta.maxX - meta.minX, height: meta.maxY - meta.minY };
            // sample grid for a point inside the subpath ring
            for (let gy = 1; gy < 10; gy++) {
                for (let gx = 1; gx < 10; gx++) {
                    const px = b.x + b.width * gx / 10;
                    const py = b.y + b.height * gy / 10;
                    if (windingFromSegs(cache[meta.i], px, py) !== 0) return { x: px, y: py };
                }
            }
            return null;
        }
        function windingFromSegs(sub, px, py) {
            let w = 0;
            const n = sub.segments.length;
            for (let j = 0; j < n; j++) {
                const a = sub.segments[j], b = sub.segments[(j + 1) % n];
                if ((a.y > py) !== (b.y > py)) {
                    const x = a.x + (b.x - a.x) * (py - a.y) / (b.y - a.y);
                    if (x > px) w += b.y > a.y ? 1 : -1;
                }
            }
            return w;
        }
        for (let a = 0; a < metas.length; a++) {
            for (let b = a + 1; b < metas.length; b++) {
                const ma = metas[a], mb = metas[b];
                if (ma.dir !== mb.dir) continue;
                if (ma.maxX < mb.minX || mb.maxX < ma.minX || ma.maxY < mb.minY || mb.maxY < ma.minY) continue;
                // boxes overlap + same direction -> check interior overlap
                const pt = interiorPoint(mb);
                if (pt && windingFromSegs(cache[ma.i], pt.x, pt.y) !== 0) {
                    log('  OVERLAP: #' + ma.i + ' and #' + mb.i + ' same direction ' + ma.dir + ' overlap (interior point of #' + mb.i + ' inside #' + ma.i + ')');
                } else {
                    const pt2 = interiorPoint(ma);
                    if (pt2 && windingFromSegs(cache[mb.i], pt2.x, pt2.y) !== 0) {
                        log('  OVERLAP: #' + ma.i + ' and #' + mb.i + ' same direction ' + ma.dir + ' overlap (interior point of #' + ma.i + ' inside #' + mb.i + ')');
                    }
                }
            }
        }
    }

    // Case A: line + full loop back to itself + continue (handwriting loop)
    {
        const n1 = makeNode(0, 0);
        const n2 = makeNode(60, 0);
        const n3 = makeNode(100, -40);
        const n4 = makeNode(140, 0);
        const n5 = makeNode(100, 40);
        const n6 = makeNode(60, 0);
        const n7 = makeNode(200, 0);
        log('=== Case A: line+loop+line (open, hw=10) ===');
        await analyze(buildCurve([n1, n2, n3, n4, n5, n6, n7], false, 10));
    }

    // Case A2: same loop, tighter (hw=8)
    {
        const o1 = makeNode(0, 0);
        const o2 = makeNode(60, 0);
        const o3 = makeNode(100, -40);
        const o4 = makeNode(140, 0);
        const o5 = makeNode(100, 40);
        const o6 = makeNode(60, 0);
        const o7 = makeNode(200, 0);
        log('=== Case A2: line+loop+line (open, hw=8) ===');
        await analyze(buildCurve([o1, o2, o3, o4, o5, o6, o7], false, 8));
    }

    // Case B: figure-8 crossing (skeleton crosses itself once)
    {
        const m1 = makeNode(0, 0);
        const m2 = makeNode(120, 0);
        const m3 = makeNode(0, 80);
        const m4 = makeNode(120, 80);
        log('=== Case B: X crossing (open, hw=10) ===');
        await analyze(buildCurve([m1, m2, m3, m4], false, 10));
    }

    return out.join('\n');
}
