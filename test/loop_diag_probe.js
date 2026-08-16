// Deep diagnostic: why does the classifier keep ALL 10 children in the
// line+loop+line case (Case A) but correctly drop 2 of 3 in the X case?
// For each CompoundPath child, print:
//   - ringInteriorPoint result (grid scan vs bounds.center fallback)
//   - rawPath.contains(interior)  -> wnNonZero
//   - for each OTHER child: other.contains(interior) -> covered
// Replicates the production classifier loop step by step.
export async function runLoopDiagProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    const { Curve } = await import('/js/core/bezier/curve.js');
    const { CurveNode } = await import('/js/core/bezier/node.js');
    const { emitExpandedStrokeOutline } = await import('/js/core/bezier/path_emitter.js');
    const { emitCubicBezierSegments } = await import('/js/core/bezier/path_emitter.js');

    function makeNode(x, y) {
        return new CurveNode(null, null, x, y, null, null, 'n' + Math.random().toString(36).slice(2));
    }

    class Rec {
        constructor() { this.paths = []; this.curr = null; }
        moveTo(x, y) { this.curr = []; this.paths.push(this.curr); this.curr.push({ t: 'M', x, y }); }
        lineTo(x, y) { if (this.curr) this.curr.push({ t: 'L', x, y }); }
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { if (this.curr) this.curr.push({ t: 'C', c1x, c1y, c2x, c2y, x, y }); }
        closePath() { if (this.curr) this.curr.push({ t: 'Z' }); }
    }

    function buildPaperPaths(rec, resolve) {
        const list = [];
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

    function ringInteriorPoint(child, steps = 20) {
        const b = child.bounds;
        for (let gy = 1; gy < steps; gy++) {
            for (let gx = 1; gx < steps; gx++) {
                const px = b.x + b.width * gx / steps;
                const py = b.y + b.height * gy / steps;
                try { if (child.contains(new pScope.Point(px, py))) return { x: px, y: py, via: 'grid' }; } catch (_) { }
            }
        }
        return { x: b.center.x, y: b.center.y, via: 'fallback' };
    }

    function buildCurve(nodes, hw) {
        const curve = new Curve({ id: 'loop' });
        curve.closed = false;
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

    function diag(label, curve) {
        log('=== ' + label + ' ===');
        const hw = curve.stroke_width / 2;
        const outline = curve.computeExpandedStrokeOutline(hw);
        const rec = new Rec();
        emitExpandedStrokeOutline(rec, outline, (x, y) => ({ x, y }), {
            roundCap: false, curve: null, halfWidth: 0
        });
        const rawPaths = buildPaperPaths(rec, false);
        const resolvedPaths = buildPaperPaths(rec, true);
        log('raw paths=' + rawPaths.length + ' resolved=' + resolvedPaths.length);
        for (let i = 0; i < resolvedPaths.length; i++) {
            const p = resolvedPaths[i];
            const rawPath = rawPaths[i];
            if (!(p instanceof pScope.CompoundPath) || p.children.length <= 1) {
                log('  path#' + i + ': not a multi-child CompoundPath (' + (p.constructor.name) + ')');
                continue;
            }
            const rawArea = rawPath ? rawPath.area : 0;
            const childSum = p.children.reduce((s, c) => s + (c.area || 0), 0);
            log('  path#' + i + ': CompoundPath children=' + p.children.length + ' rawArea=' + rawArea.toFixed(1) +
                ' childSum=' + childSum.toFixed(1) + ' faithful=' + (Math.abs(childSum - rawArea) / Math.abs(rawArea) < 0.1).toString());
            p.children.forEach((child, ci) => {
                const pt = ringInteriorPoint(child);
                let wnNonZero = true, wnErr = null;
                try { wnNonZero = rawPath.contains(new pScope.Point(pt.x, pt.y)); } catch (e) { wnErr = e.message; }
                log('    child#' + ci + ' segs=' + child.segments.length + ' area=' + (child.area || 0).toFixed(1) +
                    ' dir=' + ((child.area || 0) > 0 ? 'CW' : 'CCW') +
                    ' interior=(' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1) + ') via=' + pt.via +
                    ' rawContains=' + wnNonZero + (wnErr ? ' ERR:' + wnErr : ''));
                // coverage by other children
                let coveredBy = [];
                for (const other of p.children) {
                    if (other === child) continue;
                    try {
                        if (other.contains(new pScope.Point(pt.x, pt.y))) coveredBy.push(other === child ? 'self' : '#' + p.children.indexOf(other));
                    } catch (e) { coveredBy.push('#' + p.children.indexOf(other) + 'ERR'); }
                }
                log('      coveredBy=[' + coveredBy.join(',') + '] -> keep=' + (!wnNonZero || coveredBy.length === 0));
            });
        }
        for (const p of [...rawPaths, ...resolvedPaths]) { try { p.remove(); } catch (_) { } }
    }

    {
        const n1 = makeNode(0, 0), n2 = makeNode(60, 0), n3 = makeNode(100, -40), n4 = makeNode(140, 0);
        const n5 = makeNode(100, 40), n6 = makeNode(60, 0), n7 = makeNode(200, 0);
        diag('Case A loop (hw=10)', buildCurve([n1, n2, n3, n4, n5, n6, n7], 10));
    }
    {
        const m1 = makeNode(0, 0), m2 = makeNode(120, 0), m3 = makeNode(0, 80), m4 = makeNode(120, 80);
        diag('Case B X-cross (hw=10)', buildCurve([m1, m2, m3, m4], 10));
    }
    return out.join('\n');
}
