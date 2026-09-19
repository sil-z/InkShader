// Does the region the renderer paints depend on WHICH code path draws it?
//
// A smart-stroke curve is painted either from the boolean cache, or — while a
// geometry gesture is running — from a cheap fallback inside
// `appendCurveFillPath`. Both are filled with the same nonzero rule, so both must
// paint the SAME region for the same geometry; otherwise what the user sees
// depends on the interaction state at frame time rather than on the geometry.
//
// This drives the REAL renderer entry point (`appendCurveFillPath`) with a
// recording 2D-context stub, both with the cache available and forced onto the
// fallback, and measures both regions with an exact winding-number sampler.
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=renderpaths-${Date.now()}`;
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const inkErrors = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        const t = (m.params.args || []).map(a => a.value ?? a.description).join(' ');
        if (t.includes('[InkShader:')) inkErrors.push(t.slice(0, 200));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 700) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.alert=()=>{};` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const { appendCurveFillPath } = await import('/js/canvas/rendering/curve_renderer.js');
    const pScope = getPaperScope();
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    // Recording 2D-context stub: captures exactly the path the renderer appends.
    const makeRecorder = () => {
        const paths = [];
        let curr = null, cur = null;
        const ctx = {
            beginPath() { paths.length = 0; curr = null; },
            moveTo(x, y) { curr = []; paths.push(curr); cur = [x, y]; curr.push({ t: 'M', x, y }); },
            lineTo(x, y) { if (curr) { cur = [x, y]; curr.push({ t: 'L', x, y }); } },
            bezierCurveTo(a, b, c, d, e, f) { if (curr) { cur = [e, f]; curr.push({ t: 'C', a, b, c, d, e, f }); } },
            closePath() { if (curr) { curr.push({ t: 'Z' }); paths.push(curr); curr = null; } }
        };
        return { ctx, paths };
    };
    const polysFromRecording = (paths) => {
        const polys = [];
        for (const sub of paths) {
            const pts = [];
            for (const c of sub) {
                if (c.t === 'M' || c.t === 'L') pts.push([c.x, c.y]);
                else if (c.t === 'C') {
                    const prev = pts.length ? pts[pts.length - 1] : [c.a, c.b];
                    for (let k = 1; k <= 12; k++) {
                        const t = k / 12, u = 1 - t;
                        pts.push([
                            u*u*u*prev[0] + 3*u*u*t*c.a + 3*u*t*t*c.c + t*t*t*c.e,
                            u*u*u*prev[1] + 3*u*u*t*c.b + 3*u*t*t*c.d + t*t*t*c.f
                        ]);
                    }
                }
            }
            if (pts.length >= 3) polys.push(pts);
        }
        return polys;
    };
    const winding = (poly, px, py) => {
        let w = 0;
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i], q = poly[(i + 1) % poly.length];
            if (p[1] <= py) { if (q[1] > py && (q[0] - p[0]) * (py - p[1]) - (px - p[0]) * (q[1] - p[1]) > 0) w++; }
            else { if (q[1] <= py && (q[0] - p[0]) * (py - p[1]) - (px - p[0]) * (q[1] - p[1]) < 0) w--; }
        }
        return w;
    };
    const regionArea = (polys, grid = 600) => {
        if (!polys.length) return 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of polys) for (const [x, y] of p) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const bw = maxX - minX, bh = maxY - minY;
        if (!(bw > 0 && bh > 0)) return 0;
        const aspect = bw / bh;
        const nx = Math.max(16, Math.round(aspect >= 1 ? grid : grid * aspect));
        const ny = Math.max(16, Math.round(aspect >= 1 ? grid / aspect : grid));
        let hits = 0;
        for (let gy = 0; gy < ny; gy++) {
            const py = minY + bh * (gy + 0.5) / ny;
            for (let gx = 0; gx < nx; gx++) {
                const px = minX + bw * (gx + 0.5) / nx;
                let w = 0;
                for (const p of polys) w += winding(p, px, py);
                if (w !== 0) hits++;
            }
        }
        return Math.round(hits / (nx * ny) * bw * bh);
    };
    const cachePolysOf = (curve) => {
        const polys = [];
        for (const r of (curve.cached_boolean_geometry || [])) {
            const items = [];
            const p = new pScope.Path({ closed: true });
            for (const s of r.segments) p.add(new pScope.Segment(new pScope.Point(s.x, s.y), new pScope.Point(s.inX, s.inY), new pScope.Point(s.outX, s.outY)));
            const segs = p.segments, N = segs.length, pts = [];
            for (let i = 0; i < N; i++) {
                const a = segs[i], b = segs[(i + 1) % N];
                const x0 = a.point.x, y0 = a.point.y, x1 = x0 + a.handleOut.x, y1 = y0 + a.handleOut.y;
                const x2 = b.point.x + b.handleIn.x, y2 = b.point.y + b.handleIn.y, x3 = b.point.x, y3 = b.point.y;
                for (let k = 0; k < 16; k++) {
                    const t = k / 16, u = 1 - t;
                    pts.push([u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3, u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3]);
                }
            }
            polys.push(pts);
            p.remove();
        }
        return polys;
    };

    // Identity viewport: model space == recorded space, so both regions are comparable.
    const viewport = { scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0, matrix: null };

    const rows = [];
    for (const c of cm.curveStore.curves) {
        if (!c.smart_stroke || !(c.stroke_width > 0) || !c.closed || !c.startNode) continue;

        // (A) cache path
        c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache();
        const cacheArea = regionArea(cachePolysOf(c));

        // (B) forced fallback: no cache available, rebuilds not allowed (gesture)
        const cacheBackup = c.cached_boolean_geometry;
        const path2dBackup = c._booleanPath2D;
        c.cached_boolean_geometry = null;
        c._booleanPath2D = null;
        const rec = makeRecorder();
        appendCurveFillPath(rec.ctx, c, viewport, { refId: null, strokePreview: false, allowRebuild: false });
        const fallbackArea = regionArea(polysFromRecording(rec.paths));
        c.cached_boolean_geometry = cacheBackup;
        c._booleanPath2D = path2dBackup;

        rows.push({
            id: c.id, cw: c.smart_stroke_clockwise !== false,
            cacheArea, fallbackArea,
            diffPct: cacheArea > 0 ? Math.round(Math.abs(cacheArea - fallbackArea) / cacheArea * 1000) / 10 : 0,
            agree: cacheArea > 0 && fallbackArea > 0
                && Math.abs(cacheArea - fallbackArea) <= Math.max(200, cacheArea * 0.02)
        });
    }
    return { rows, inkErrorCount: window.__inkErrorLog.length, messages: window.__inkErrorLog.map(e => (e.message || '').slice(0, 120)) };
})()`);

if (out && out.__exc) { console.log('probe threw: ' + out.__exc); process.exit(1); }
const checks = [];
checks.push({ name: 'measured at least one smart closed path', ok: (out.rows || []).length > 0 });
for (const r of out.rows || []) {
    checks.push({
        name: `${r.id}: cache=${r.cacheArea} fallback=${r.fallbackArea} (${r.diffPct}%) — must agree`,
        ok: r.agree
    });
}
checks.push({ name: 'no boolean cache error reports', ok: (out.inkErrorCount || 0) === 0 && inkErrors.filter(t => t.includes('boolean_geometry_cache')).length === 0 });
console.log(JSON.stringify({ tag: 'render-paths-agree', rows: out.rows, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
