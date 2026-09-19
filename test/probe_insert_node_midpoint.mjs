// Insert node — where does it actually land?
//
// The command is documented as "insert at midpoint of each selected segment".
// This suite measures, in the real app, where the node lands relative to three
// candidate definitions of "midpoint":
//
//   param  — the cubic evaluated at t=0.5 (exact de Casteljau split point)
//   arc    — the point that splits the segment into two equal arc lengths
//   chord  — the straight midpoint between the two endpoints
//
// For a straight segment all three coincide. For a curved segment they differ.
//
// The suite locks the parametric definition, which is what Inkscape does: its
// toolbar "Insert new node" action (PathManipulator::insertNodes) calls
// subdivideSegment(j, 0.5) for every segment whose two nodes are selected, and
// subdivideSegment builds a Geom::CubicBezier and calls subdivide(t) — de
// Casteljau, parameter space, not arc length. Inkscape also degrades a
// symmetric node to smooth on both endpoints of the split, matching this app's
// control_mode 2 → 1 degradation, and its on-canvas insertion
// (CurveDragPoint::_insertNode) uses the clicked t rather than the midpoint —
// the same split of duties as insertMainNode(segment, localX, localY) here.
//
// The arc and chord distances are reported, not asserted: they explain why the
// inserted node can look off-centre on a segment with asymmetric handles.
// Asserting param keeps that a deliberate, documented choice rather than drift.
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('insert_node_midpoint_probe.json');
copyFileSync(SRC, TMP);
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();

for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 180000);
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 800) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null; window.alert=()=>{};' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?v=insertmid-${Date.now()}` });
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await evalp('!!window.__canvas')) break;
}
await new Promise(r => setTimeout(r, 2000));

const out = await evalp(`(async () => {
    const cv = window.__canvas, cm = cv.curve_manager;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const res = { steps: [], cases: [] };
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await sleep(2500);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    await sleep(400);
    const mod = await import('/js/app/canvas_dispatcher.js');

    const chain = (c) => { const a = []; let n = c.startNode; const seen = new Set(); while (n && !seen.has(n)) { seen.add(n); a.push(n); n = n.nextOnCurve; } return a; };
    const P = (n) => ({ x: n.x, y: n.y });
    const handles = (from, to) => {
        const p0 = P(from);
        const p1 = from.control1 ? { x: from.control1.x, y: from.control1.y } : { ...p0 };
        const p2 = to.control2 ? { x: to.control2.x, y: to.control2.y } : P(to);
        const p3 = P(to);
        return { p0, p1, p2, p3 };
    };
    const cubic = (s, t) => {
        const mt = 1 - t;
        return {
            x: mt*mt*mt*s.p0.x + 3*mt*mt*t*s.p1.x + 3*mt*t*t*s.p2.x + t*t*t*s.p3.x,
            y: mt*mt*mt*s.p0.y + 3*mt*mt*t*s.p1.y + 3*mt*t*t*s.p2.y + t*t*t*s.p3.y,
        };
    };
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    // Arc-length midpoint: walk the cubic and find the t where half the length is covered.
    const arcMid = (s) => {
        const N = 400; let total = 0; const pts = [];
        for (let i = 0; i <= N; i++) { const p = cubic(s, i / N); pts.push(p); if (i) total += d(pts[i], pts[i - 1]); }
        let acc = 0;
        for (let i = 1; i <= N; i++) { acc += d(pts[i], pts[i - 1]); if (acc >= total / 2) return { point: pts[i], length: total, t: i / N }; }
        return { point: pts[N], length: total, t: 1 };
    };

    // Reference: does curve.evaluateSegmentAt agree with our own cubic eval?
    // (that tells us the segment model we use above is the app's own)

    const cases = [];
    for (const tok of (cm.sequenceTokens || [])) {
        const gid = tok.isChar ? cm.getDefaultGroupForChar(tok.value) : tok.value;
        if (!gid) continue;
        cv.commands.setActiveGroup(gid);
        await sleep(150);
        let curves = [];
        try { curves = cm.getCurvesForGroup(gid) || []; } catch { curves = []; }
        for (const cd of curves) {
            const c = cd.curve;
            const nodes = chain(c);
            if (nodes.length < 2) continue;
            // Prefer a segment with real curvature (handles not degenerate).
            for (let i = 0; i + 1 < nodes.length; i++) {
                const from = nodes[i], to = nodes[i + 1];
                const s = handles(from, to);
                const straight = d(s.p1, s.p0) < 1e-6 && d(s.p2, s.p3) < 1e-6;
                const hasHandles = !!from.control1 || !!to.control2;
                const arc = arcMid(s);
                const param = cubic(s, 0.5);
                const chord = { x: (s.p0.x + s.p3.x) / 2, y: (s.p0.y + s.p3.y) / 2 };
                const curved = d(param, chord) > 1;
                if (!hasHandles) continue;
                if (!curved) continue;
                cases.push({ gid, curveId: c.id, fromId: from.main_node?.id, toId: to.main_node?.id,
                             from, to, seg: s, before: nodes.map(n => n.id), param, arc: arc.point, chord,
                             paramVsArc: d(param, arc.point), paramVsChord: d(param, chord), segLen: arc.length });
                if (cases.length >= 3) break;
            }
            if (cases.length >= 3) break;
        }
        if (cases.length >= 3) break;
    }
    if (!cases.length) return { error: 'no-curved-segment-found', steps: res.steps };

    for (const cs of cases) {
        cv.commands.setActiveGroup(cs.gid);
        await sleep(200);
        mod.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: [cs.fromId, cs.toId] });
        await sleep(400);
        const ret = cv.commands.insertNodeSelectedSegments();
        await sleep(400);

        // Find whichever node sits between from and to now.
        const inserted = cs.from.nextOnCurve;
        const got = inserted && inserted !== cs.to ? P(inserted) : null;
        res.cases.push({
            curveId: cs.curveId, ret: ret === undefined ? 'undefined' : ret,
            selected: [cs.fromId, cs.toId],
            got,
            param: cs.param, arc: cs.arc, chord: cs.chord,
            distParam: got ? d(got, cs.param) : null,
            distArc: got ? d(got, cs.arc) : null,
            distChord: got ? d(got, cs.chord) : null,
            paramVsArc: cs.paramVsArc, paramVsChord: cs.paramVsChord, segLen: cs.segLen,
            insertedIsBetween: !!(inserted && inserted !== cs.to),
        });

        // Does the split preserve the shape? Compare the two halves against the original cubic.
        if (got && inserted) {
            const first = handles(cs.from, inserted);
            const second = handles(inserted, cs.to);
            let maxErr = 0;
            for (let i = 0; i <= 40; i++) {
                const t = i / 40;
                const a = cubic(cs.seg, t / 2);
                const b = cubic(first, t);
                maxErr = Math.max(maxErr, d(a, b));
                const a2 = cubic(cs.seg, 0.5 + t / 2);
                const b2 = cubic(second, t);
                maxErr = Math.max(maxErr, d(a2, b2));
            }
            res.cases[res.cases.length - 1].shapeMaxErr = maxErr;
        }
        // Undo so the next case starts clean.
        cv.commands.undo && cv.commands.undo();
        await sleep(300);
    }
    return res;
})()`);

console.log(JSON.stringify(out, null, 2));
const checks = [];
if (out && out.cases && out.cases.length) {
    for (const c of out.cases) {
        checks.push({ name: `case ${c.curveId}: inserted`, ok: !!c.insertedIsBetween });
        checks.push({ name: `case ${c.curveId}: shape preserved (maxErr<0.01)`, ok: c.shapeMaxErr != null && c.shapeMaxErr < 0.01, detail: c.shapeMaxErr });
        checks.push({
            name: `case ${c.curveId}: at parametric midpoint t=0.5`,
            ok: c.distParam != null && c.distParam < 1e-6,
            detail: { distParam: c.distParam, distArc: c.distArc, distChord: c.distChord },
        });
    }
    // Report (not assert) which definition "midpoint" currently satisfies.
    for (const c of out.cases) {
        const defs = [];
        if (c.distParam != null && c.distParam < 0.5) defs.push('param');
        if (c.distArc != null && c.distArc < 0.5) defs.push('arc');
        if (c.distChord != null && c.distChord < 0.5) defs.push('chord');
        console.log(`INFO ${c.curveId}: inserted at (${c.got?.x.toFixed(1)}, ${c.got?.y.toFixed(1)}) ` +
            `distParam=${c.distParam?.toFixed(3)} distArc=${c.distArc?.toFixed(3)} distChord=${c.distChord?.toFixed(3)} ` +
            `[paramVsArc=${c.paramVsArc?.toFixed(2)} paramVsChord=${c.paramVsChord?.toFixed(2)}] matches=${defs.join(',') || 'none'}`);
    }
} else {
    checks.push({ name: 'probe produced cases', ok: false, detail: out });
}
console.log('CHECKS ' + JSON.stringify({ checks }));
console.log(`${checks.filter(c => c.ok).length}/${checks.length} passed`);
ws.close();
process.exit(checks.every(c => c.ok) ? 0 : 1);
