// End-to-end check of the non-union boolean commands on real example data.
//
// These operations are REGION-based set operations on the operands' own areas:
//   intersection = A ∩ B ∩ C   difference = A \ B \ C   exclusion = A ⊕ B ⊕ C
// where A is the bottom-most path (first in the glyph's tree order).
//
// The expected region is computed independently with canvas composite
// operations on each operand's nonzero fill, and compared to the region the
// command actually leaves behind. Intersection and difference must also collapse
// the selection into a single result curve; exclusion may legitimately leave
// several disjoint components.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, probePorts, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const { port: PORT, srv: SRV } = probePorts();
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.alert=()=>{};` });
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?v=binops-${Date.now()}` });
await new Promise(r => setTimeout(r, 7000));

const HANDLERS = `
(() => {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const ringsOf = (curves) => {
        const out = [];
        for (const c of curves) {
            const g = c.cached_boolean_geometry || (c.updateBooleanCache && c.updateBooleanCache(), c.cached_boolean_geometry) || [];
            for (const sub of g) if (sub && sub.segments && sub.segments.length >= 2) out.push(sub);
        }
        return out;
    };
    const pathOf = (rings) => {
        const pp = new Path2D();
        for (const sub of rings) {
            const s = sub.segments;
            pp.moveTo(s[0].x, s[0].y);
            for (let i = 0; i < s.length; i++) {
                const a = s[i], b = s[(i + 1) % s.length];
                pp.bezierCurveTo(a.x + a.outX, a.y + a.outY, b.x + b.inX, b.y + b.inY, b.x, b.y);
            }
            pp.closePath();
        }
        return pp;
    };
    const PAD = 6, SCALE = 3;
    const frameOf = (curves) => {
        const rings = ringsOf(curves);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const sub of rings) for (const s of sub.segments) {
            if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
            if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
        }
        if (!isFinite(minX)) return null;
        return { minX: minX - PAD, minY: minY - PAD, w: Math.ceil((maxX - minX + 2 * PAD) * SCALE) + 2, h: Math.ceil((maxY - minY + 2 * PAD) * SCALE) + 2 };
    };
    const setup = (frame) => {
        cv.width = frame.w; cv.height = frame.h;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, frame.w, frame.h);
        ctx.setTransform(SCALE, 0, 0, -SCALE, -frame.minX * SCALE, frame.h + frame.minY * SCALE);
        ctx.fillStyle = '#000';
    };
    const fillOne = (c) => { const rs = ringsOf([c]); if (rs.length) ctx.fill(pathOf(rs), 'nonzero'); };
    window.__regionCount = (curves, frame, mode) => {
        setup(frame);
        if (mode === 'solid') {
            const rs = ringsOf(curves); if (rs.length) ctx.fill(pathOf(rs), 'nonzero');
        } else if (mode === 'parity') {
            ctx.globalCompositeOperation = 'xor';
            for (const c of curves) fillOne(c);
        } else if (mode === 'intersect') {
            fillOne(curves[0]); ctx.globalCompositeOperation = 'destination-in';
            for (let i = 1; i < curves.length; i++) fillOne(curves[i]);
        } else if (mode === 'difference') {
            fillOne(curves[0]); ctx.globalCompositeOperation = 'destination-out';
            for (let i = 1; i < curves.length; i++) fillOne(curves[i]);
        }
        ctx.globalCompositeOperation = 'source-over';
        const d = ctx.getImageData(0, 0, frame.w, frame.h).data;
        let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 127) n++;
        return n;
    };
    window.__frameOf = frameOf;
    return true;
})()
`;

const install = await evalp(HANDLERS);
if (install && install.__exc) { console.log('install threw: ' + install.__exc); process.exit(1); }

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    // Group curves in TREE order (children array), which is the order the
    // boolean commands use for "bottom-most".
    const groupCurves = (name) => {
        const item = cm.treeItems.get(name);
        const ids = (item && Array.isArray(item.children)) ? item.children : [];
        const curves = [], treeIds = [];
        for (const id of ids) {
            const ti = cm.treeItems.get(id);
            if (ti && ti.type === 'curve') { const c = cm.curveById.get(ti.curveId); if (c) { curves.push(c); treeIds.push(id); } }
        }
        return { curves, treeIds };
    };
    const rows = [];
    const ops = [
        ['intersection', 'booleanIntersectionSelectedCurves', 'intersect', true],
        ['difference', 'booleanDifferenceSelectedCurves', 'difference', true],
        ['exclusion', 'booleanExclusionSelectedCurves', 'parity', false],
    ];
    for (const [tag, fn, mode, single] of ops) {
        await cm.loadFromJSON(${JSON.stringify(jsonText)});
        await sleep(1200);
        const before = groupCurves('test_union');
        const frame = window.__frameOf(before.curves);
        const expected = window.__regionCount(before.curves, frame, mode);
        cv.commands.setTreeSelection(before.treeIds);
        let ok = false, err = null;
        try { ok = cv.commands[fn](); } catch (e) { err = String(e.message || e).slice(0, 300); }
        await sleep(500);
        const after = groupCurves('test_union');
        const actual = window.__regionCount(after.curves, frame, 'solid');
        rows.push({
            tag, ok, err, single,
            beforeCount: before.curves.length, afterCount: after.curves.length,
            expected, actual,
            afterSegs: after.curves.map(c => (c.getSkeletonBezierSegments() || []).length),
        });
    }
    return { rows };
})()`);

if (out && out.__exc) { console.log('probe threw: ' + out.__exc); process.exit(1); }
try { writeFileSync(path.join(TMP_DIR, 'binary_ops_e2e.json'), JSON.stringify(out, null, 2)); } catch { }
const rows = (out && out.rows) || [];
const checks = [];
for (const r of rows) {
    if (r.err) { checks.push({ name: `${r.tag}: command threw (${r.err})`, ok: false }); continue; }
    checks.push({ name: `${r.tag}: command returned`, ok: r.ok === true });
    const tol = Math.max(40, r.expected * 0.01);
    checks.push({
        name: `${r.tag}: region matches the set operation (expected≈${r.expected} actual=${r.actual})`,
        ok: Math.abs(r.expected - r.actual) <= tol,
        detail: `Δ=${r.expected - r.actual}`,
    });
    if (r.single) checks.push({
        name: `${r.tag}: single result curve (before=${r.beforeCount} after=${r.afterCount})`,
        ok: r.afterCount === 1,
        detail: `segs=${JSON.stringify(r.afterSegs)}`,
    });
}
try { writeFileSync(path.join(TMP_DIR, 'binary_ops_e2e_checks.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { }
const failed = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail || ''}`);
console.log(JSON.stringify({ checks, passed: checks.length - failed, total: checks.length, failedCount: failed }, null, 2));
ws.close();
process.exit(failed ? 1 : 0);
