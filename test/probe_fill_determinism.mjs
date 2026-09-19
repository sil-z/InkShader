// Is the painted fill region a function of GEOMETRY alone?
//
// A smart-stroke curve's fill is currently produced by two different formulas,
// selected by interaction state:
//   (CACHE)   cached_boolean_geometry — Paper.js boolean merge of fill ∪ band
//   (FALLBACK) cheap band (pure bezier offset) + skeleton ring, nonzero
// and when the boolean merge fails outright, neither runs and the fill is
// GONE. So the region is f(geometry, gesture state, boolean success), not
// f(geometry): the same shape can paint differently just from editing a node.
//
// This drives the REAL renderer entry point (`appendCurveFillPath`) with a
// recording 2D-context and measures the appended region with an exact
// winding-number sampler, under every interaction condition, for every smart
// closed curve in a real project plus a sequence of small node edits.
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=filldet-${Date.now()}`;
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
        if (t.includes('[InkShader')) inkErrors.push(t.slice(0, 200));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 900) };
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
    const { appendCurveFillPath } = await import('/js/canvas/rendering/curve_renderer.js');
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    const makeRecorder = () => {
        const paths = []; let curr = null;
        const ctx = {
            beginPath() { paths.length = 0; curr = null; },
            moveTo(x, y) { curr = []; paths.push(curr); curr.push({ t: 'M', x, y }); },
            lineTo(x, y) { if (curr) curr.push({ t: 'L', x, y }); },
            bezierCurveTo(a, b, c, d, e, f) { if (curr) curr.push({ t: 'C', a, b, c, d, e, f }); },
            closePath() { if (curr) { curr.push({ t: 'Z' }); curr = null; } }
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
            // open subpaths still close under nonzero fill; include them
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
    const regionArea = (polys, grid = 500) => {
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
    const measure = (c, { allowRebuild }) => {
        const rec = makeRecorder();
        appendCurveFillPath(rec.ctx, c, { scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0, matrix: null }, { allowRebuild });
        return { area: regionArea(polysFromRecording(rec.paths)), subpaths: rec.paths.length };
    };

    const rows = [];
    for (const c of cm.curveStore.curves) {
        if (!c.smart_stroke || !(c.stroke_width > 0) || !c.startNode) continue;
        const edits = [];
        // baseline: force a clean rebuild, then measure with rebuilds allowed
        c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache();
        const base = measure(c, { allowRebuild: true });

        // edit loop: nudge a node and re-measure with rebuilds allowed
        const n0 = c.startNode;
        const ox = n0.x, oy = n0.y;
        for (let k = 1; k <= 5; k++) {
            n0.x = ox + k * 1.3; n0.y = oy + k * 0.7;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            const pointk = { x: n0.x, y: n0.y };
            const m = measure(c, { allowRebuild: true, pointk });
            edits.push(m.area);
        }
        n0.x = ox; n0.y = oy;
        c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache();

        // gesture condition: stale-ish cache, rebuilds NOT allowed
        const gesture = measure(c, { allowRebuild: false });
        // hard-failure condition: cache empty AND rebuild suppressed by the empty marker
        const backup = c.cached_boolean_geometry; const p2d = c._booleanPath2D;
        c.cached_boolean_geometry = null; c._booleanPath2D = null;
        c._booleanEmptyHash = c.getGeometryHash();
        const emptyForced = measure(c, { allowRebuild: true });
        c.cached_boolean_geometry = backup; c._booleanPath2D = p2d;
        c._booleanEmptyHash = null;

        const areas = [base.area, gesture.area, emptyForced.area, ...edits];
        const nonzero = areas.filter(a => a > 0);
        const spread = nonzero.length ? Math.round((Math.max(...nonzero) - Math.min(...nonzero)) / Math.max(...nonzero) * 1000) / 10 : null;
        rows.push({
            id: c.id, closed: !!c.closed, cw: c.smart_stroke_clockwise !== false,
            cache: base.area, gesture: gesture.area, emptyForced: emptyForced.area,
            edits, anyZero: areas.some(a => a === 0), spreadPct: spread,
            gestureDiffPct: base.area > 0 ? Math.round(Math.abs(base.area - gesture.area) / base.area * 1000) / 10 : null
        });
    }
    return { rows, inkErrors: window.__inkErrorLog.map(e => (e.reason || e.message || '').slice(0, 90)) };
})()`);

if (out && out.__exc) { console.log('probe threw: ' + out.__exc); process.exit(1); }

const rows = out.rows || [];
const checks = [];
checks.push({ name: 'measured at least one smart stroke path', ok: rows.length > 0 });
for (const r of rows) {
    checks.push({
        name: `${r.id}: cache=${r.cache} gesture=${r.gesture} forcedEmpty=${r.emptyForced} edits=[${r.edits.join(',')}] — one geometry, one region`,
        ok: !r.anyZero && r.spreadPct != null && r.spreadPct <= 2
    });
}
console.log(JSON.stringify({ tag: 'fill-determinism', rows, inkErrors: out.inkErrors, checks }, null, 2));
ws.close();
process.exit(0);
