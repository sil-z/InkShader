// Are the cached rings all REGION BOUNDARIES, or do some of them survive as
// spurious interior folds ("swallowtails")?
//
// A swallowtail is the inner offset crossing itself at a sharp bend. After the
// crossing is split, the fold becomes a small extra ring whose interior is
// still inside the band, wound the SAME way as the band — so it changes neither
// the filled region nor the hole count, which is exactly why a region-diff
// oracle cannot see it. What it does change is the CURVE STRUCTURE: `expand
// stroke` materializes every cached ring, so the fold survives as a curve.
//
// The correct classification: a ring is a boundary of the nonzero region iff the
// total winding just inside it differs from the winding just outside. Equal
// winding on both sides ⇒ the ring is not a boundary and must be dropped.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=rbnd-${Date.now()}`;
const files = [];
for (const name of (process.env.PROBE_FILES || 'bug_test.json,InkShader_Roundhand.json').split(',')) {
    try { files.push({ name: name.trim(), text: readFileSync(exampleProject(name.trim()), 'utf8') }); } catch { /* optional */ }
}
if (!files.length) { console.log('no example files found'); process.exit(1); }

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
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
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.alert=()=>{};` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const rows = [];
for (const f of files) {
const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(f.text)});
    await sleep(1200);

    // cubic sampling: returns [x,y] list
    const sampleSeg = (s, n, arr) => {
        for (let i = 0; i <= n; i++) {
            const t = i / n, u = 1 - t;
            const a = u*u*u, b = 3*u*u*t, c2 = 3*u*t*t, d = t*t*t;
            arr.push([a*s.p0.x + b*s.p1.x + c2*s.p2.x + d*s.p3.x, a*s.p0.y + b*s.p1.y + c2*s.p2.y + d*s.p3.y]);
        }
    };
    const ringPoly = (sub) => {
        const sg = sub.segments; if (!sg || sg.length < 2) return null;
        const pts = [];
        for (let i = 0; i < sg.length; i++) {
            const a = sg[i], b = sg[(i+1) % sg.length];
            sampleSeg({ p0: {x:a.x,y:a.y}, p1: {x:a.x+(a.outX||0), y:a.y+(a.outY||0)}, p2: {x:b.x+(b.inX||0), y:b.y+(b.inY||0)}, p3: {x:b.x,y:b.y} }, 8, pts);
        }
        return pts;
    };
    const windingAt = (polys, px, py) => {
        let wn = 0;
        for (const poly of polys) {
            for (let i = 0; i + 1 < poly.length; i++) {
                const ax = poly[i][0], ay = poly[i][1], bx = poly[i+1][0], by = poly[i+1][1];
                if (ay <= py && by > py) { if ((bx-ax)*(py-ay) - (px-ax)*(by-ay) > 0) wn++; }
                else if (ay > py && by <= py) { if ((bx-ax)*(py-ay) - (px-ax)*(by-ay) < 0) wn--; }
            }
        }
        return wn;
    };
    const ringArea = (poly) => { let a = 0; for (let i = 0; i + 1 < poly.length; i++) a += poly[i][0]*poly[i+1][1] - poly[i+1][0]*poly[i][1]; return a / 2; };

    // A swallowtail that survived as a slit shows up as two non-adjacent points
    // of the ring that nearly coincide: the boundary runs into the fold, loops
    // around a sliver of ~zero width, and comes back. resolveCrossings splits
    // transversal crossings; a tangential self-touch is not split. The loop
    // between such a pair is the leftover fold.
    const detectPinches = (poly, eps, minArc) => {
        const n = poly.length;
        const hits = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + minArc; j < n; j++) {
                if (j - i > n - minArc) break;              // wrap-around is adjacency
                const dx = poly[i][0] - poly[j][0], dy = poly[i][1] - poly[j][1];
                if (dx*dx + dy*dy > eps*eps) continue;
                let a = 0;
                for (let k = i; k < j; k++) a += poly[k][0]*poly[k+1][1] - poly[k+1][0]*poly[k][1];
                hits.push({ i, j, loopArea: Math.round(Math.abs(a / 2)) });
            }
        }
        return hits;
    };

    const rows = [];
    for (const c of cm.curveStore.curves) {
        if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
        c.invalidateBooleanCache(); c._booleanEmptyHash = null;
        c.updateBooleanCache();
        const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];
        if (!cache.length) continue;
        const polys = cache.map(ringPoly).filter(Boolean);
        const eps = 1.2;                       // world units either side of the ring
        const rings = [];
        for (let i = 0; i < polys.length; i++) {
            const poly = polys[i];
            const area = ringArea(poly);
            let same = 0, diff = 0;
            for (let k = 0; k + 1 < poly.length; k++) {
                const ax = poly[k][0], ay = poly[k][1], bx = poly[k+1][0], by = poly[k+1][1];
                const mx = (ax + bx) / 2, my = (ay + by) / 2;
                const dx = bx - ax, dy = by - ay;
                const len = Math.hypot(dx, dy) || 1e-9;
                const nx = -dy / len, ny = dx / len;
                const w1 = windingAt(polys, mx + nx * eps, my + ny * eps);
                const w2 = windingAt(polys, mx - nx * eps, my - ny * eps);
                if (w1 === w2) same++; else diff++;
            }
            const pinches = detectPinches(poly, 0.8, 12);
            rings.push({ idx: i, segs: cache[i].segments.length, approxArea: Math.round(area),
                windingSameSamples: same, windingDiffSamples: diff,
                spurious: diff === 0,
                pinchCount: pinches.length, pinchLoopAreas: pinches.slice(0, 6).map(h => h.loopArea) });
        }
        rows.push({ id: c.id, closed: !!c.closed, rings, spuriousRings: rings.filter(r => r.spurious).length,
            ringsWithPinches: rings.filter(r => r.pinchCount > 0).length });
    }
    return rows;
})()`);
    if (out && out.__exc) { console.log(`[${f.name}] threw: ` + out.__exc); continue; }
    for (const r of out || []) rows.push({ file: f.name, ...r });
}

try { writeFileSync(path.join(TMP_DIR, 'ring_boundary.json'), JSON.stringify(rows, null, 2)); } catch { /* diag */ }
let anyPinch = 0, anySpurious = 0;
for (const r of rows) {
    if (r.spuriousRings) anySpurious += r.spuriousRings;
    anyPinch += r.ringsWithPinches;
    console.log('=== [' + r.file + '] ' + r.id + ' closed=' + r.closed + ' rings=' + r.rings.length + ' spurious=' + r.spuriousRings + ' ringsWithPinches=' + r.ringsWithPinches + ' segs=' + r.rings.map(g => g.segs).join(','));
    for (const g of r.rings.filter(g => g.spurious || g.pinchCount > 0))
        console.log('    ring' + g.idx + ' segs=' + g.segs + ' area=' + g.approxArea + ' same=' + g.windingSameSamples + ' diff=' + g.windingDiffSamples + ' pinches=' + g.pinchCount + ' loopAreas=' + JSON.stringify(g.pinchLoopAreas) + (g.spurious ? '   <-- NOT A BOUNDARY' : ''));
}
console.log(`\nTOTAL rings that are not boundaries: ${anySpurious}; rings containing a fold/pinch: ${anyPinch}`);
const checks = [
    { name: `measured smart stroke curves across ${files.length} file(s)`, ok: rows.length > 0 },
    { name: 'every cached ring is a region boundary (winding differs across it)', ok: anySpurious === 0 },
    { name: 'no cached ring contains an unresolved fold (near-coincident pinch)', ok: anyPinch === 0 },
];
console.log(JSON.stringify({ tag: 'ring-boundary', checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
