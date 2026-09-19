// Diagnostic: what region does the app actually produce for the four paths in
// example/bug_test.json, before and after union?
//
// Regions are measured with an exact winding-number sampler (flatten each cached
// ring, sum winding numbers of all rings of a curve at each grid point, count the
// non-zero samples). That is precisely what the canvas `fill('nonzero')` paints and
// it does not depend on raster resolution, unlike a 256px canvas mask.
import { readFileSync, writeFileSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=windiag-${Date.now()}`;
const EXAMPLE = exampleProject('bug_test.json');
const jsonText = readFileSync(EXAMPLE, 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null; window.alert=()=>{};` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    try { localStorage.removeItem('__ink_error_log'); } catch (e) { }
    window.__inkErrorLog.length = 0;

    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    // ── exact winding geometry helpers ────────────────────────────────────────
    const flattenRing = (ring) => {
        const segs = ring.segments, N = segs.length, pts = [];
        for (let i = 0; i < N; i++) {
            const a = segs[i], b = segs[(i + 1) % N];
            const x0 = a.x, y0 = a.y, x1 = a.x + a.outX, y1 = a.y + a.outY;
            const x2 = b.x + b.inX, y2 = b.y + b.inY, x3 = b.x, y3 = b.y;
            for (let k = 0; k < 16; k++) {
                const t = k / 16, u = 1 - t;
                pts.push([
                    u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
                    u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3
                ]);
            }
        }
        return pts;
    };
    const windingOf = (poly, px, py) => {
        let w = 0;
        for (let i = 0; i < poly.length; i++) {
            const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
            if (y0 <= py) { if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++; }
            else { if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) w--; }
        }
        return w;
    };
    const signedArea = (poly) => {
        let A = 0;
        for (let i = 0; i < poly.length; i++) {
            const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
            A += x0 * y1 - x1 * y0;
        }
        return A / 2;
    };
    const ringsOf = (curves) => {
        const out = [];
        for (const c of curves) for (const r of (c.cached_boolean_geometry || [])) {
            if (r.segments && r.segments.length >= 2) out.push(flattenRing(r));
        }
        return out;
    };
    // Nonzero region area of a set of curves, on a grid sized to the union bbox.
    const regionArea = (curves, grid = 700) => {
        const polys = ringsOf(curves);
        if (!polys.length) return { area: 0, rings: 0, ringAreas: [] };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of polys) for (const [x, y] of p) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const bw = maxX - minX, bh = maxY - minY;
        if (!(bw > 0) || !(bh > 0)) return { area: 0, rings: polys.length, ringAreas: polys.map(signedArea) };
        const aspect = bw / bh;
        const nx = Math.max(16, Math.round(aspect >= 1 ? grid : grid * aspect));
        const ny = Math.max(16, Math.round(aspect >= 1 ? grid / aspect : grid));
        let hits = 0;
        for (let gy = 0; gy < ny; gy++) {
            const py = minY + bh * (gy + 0.5) / ny;
            for (let gx = 0; gx < nx; gx++) {
                const px = minX + bw * (gx + 0.5) / nx;
                let w = 0;
                for (const p of polys) w += windingOf(p, px, py);
                if (w !== 0) hits++;
            }
        }
        return {
            area: Math.round(hits / (nx * ny) * bw * bh),
            rings: polys.length,
            ringAreas: polys.map(a => Math.round(a)),
            ringSigns: polys.map(a => (a > 0 ? '+' : '-')).join(''),
            bbox: [Math.round(minX), Math.round(minY), Math.round(bw), Math.round(bh)]
        };
    };
    const describeCurves = (curves, grid) => curves.map(c => {
        try { c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache(); } catch (e) { }
        let verts = 0, p = c.startNode; const seen = new Set();
        while (p && !seen.has(p)) { seen.add(p); verts++; p = p.nextOnCurve; }
        const r = regionArea([c], grid);
        return {
            id: c.id, verts, closed: c.closed, smart: c.smart_stroke,
            cw: c.smart_stroke_clockwise !== false, strokeWidth: c.stroke_width,
            rings: r.rings, ringAreas: r.ringAreas, ringSigns: r.ringSigns,
            region: r.area, regionBox: r.bbox
        };
    });

    const before = describeCurves(cm.curveStore.curves);

    const treeIdOf = (curve) => { for (const [id, item] of cm.treeItems) if (item.type === 'curve' && item.curveId === curve.id) return id; return null; };
    const byId = {}; for (const c of cm.curveStore.curves) byId[c.id] = c;
    const D = await import('/js/app/canvas_dispatcher.js');
    const sel = ['Path_4', 'Path_5'].map(n => byId[n]).filter(Boolean).map(treeIdOf).filter(Boolean);
    D.CanvasDispatcher.requestSetTreeSelection(sel, 'zero');
    await sleep(300);
    const unionOk = cv.commands.booleanUnionSelectedCurves();
    await sleep(800);

    const after = describeCurves(cm.curveStore.curves);
    // Which side of the canvas does the union result paint?
    const result = cm.curveStore.curves.filter(c => c.id && c.id.startsWith('Bool_'));
    const resultRegion = result.length ? regionArea(result, 700) : null;

    // Determinism: rebuild Path_4 / Path_5 caches repeatedly; a signature change is
    // exactly the inconsistent rendering reported.
    const rebuildSeq = {};
    for (const name of ['Path_4', 'Path_5']) {
        const c = byId[name];
        if (!c) continue;
        const seq = [];
        for (let k = 0; k < 8; k++) {
            c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache();
            const r = regionArea([c], 240);
            seq.push(r.ringSigns + ':' + r.ringAreas.join(','));
        }
        rebuildSeq[name] = seq;
    }

    // Stability of the UNION RESULT under small node edits. This is the object the
    // user edits after a union; if its cached ring structure flips between rebuilds,
    // the hole appears and disappears exactly as reported.
    const resultSweep = [];
    if (result.length) {
        const c = result[0];
        const base = [];
        let n0 = c.startNode, seen0 = new Set();
        while (n0 && !seen0.has(n0)) { seen0.add(n0); base.push([n0, n0.x, n0.y]); n0 = n0.nextOnCurve; }
        for (let k = 0; k <= 10; k++) {
            for (const [node, x, y] of base) node.y = y + k * 4;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            let err = null;
            try { c.updateBooleanCache(); } catch (e) { err = String(e && e.message || e).slice(0, 80); }
            const g = c.cached_boolean_geometry || [];
            const ps = g.map(r => flattenRing(r));
            const sa = ps.map(signedArea);
            const reg = regionArea([c], 260);
            resultSweep.push({ dy: k * 4, rings: ps.length, signs: sa.map(a => (a > 0 ? '+' : '-')).join(''), absSum: Math.round(sa.reduce((s, a) => s + Math.abs(a), 0)), region: reg.area, err });
        }
        for (const [node, x, y] of base) node.y = y;
    }

    // Second experiment: flip Path_5's stroke direction and union again. If the
    // overlap then carves, the whole result is decided by the stroke-direction flags.
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(800);
    const byId2 = {}; for (const c of cm.curveStore.curves) byId2[c.id] = c;
    byId2['Path_5'].smart_stroke_clockwise = true;
    const flip = describeCurves([byId2['Path_4'], byId2['Path_5']]);
    const sel2 = ['Path_4', 'Path_5'].map(n => byId2[n]).map(treeIdOf).filter(Boolean);
    D.CanvasDispatcher.requestSetTreeSelection(sel2, 'zero');
    await sleep(300);
    const unionOk2 = cv.commands.booleanUnionSelectedCurves();
    await sleep(800);
    const flipResult = describeCurves(cm.curveStore.curves.filter(c => c.id && c.id.startsWith('Bool_')));

    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(800);
    return { before, unionOk: !!unionOk, after, resultRegion, rebuildSeq, resultSweep, flip, unionOk2: !!unionOk2, flipResult, inkErrorCount: window.__inkErrorLog.length, messages: window.__inkErrorLog.map(e => (e.message || '').slice(0, 120)) };
})()`);

const payload = JSON.stringify({ tag: 'winding-diag', out, inkErrors }, null, 2);
console.log(payload);
writeFileSync(path.join(os.tmpdir(), 'inkshader-winding-diag.json'), payload);
ws.close();
process.exit(0);
