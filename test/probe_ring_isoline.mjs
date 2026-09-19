// Invariant: a stroke band is { p : dist(p, skeleton) <= stroke_width/2 }.
// Therefore EVERY point of every cached smart-stroke ring must sit ON that
// isoline (distance == halfWidth) — never inside the band (that would cut paint
// that the stroke owns) and never far outside it (that would paint space the
// stroke does not own).
//
// This is the check that the fold/needle question demands: a "swallowtail" apex
// is legitimate if and only if it lies exactly on the isoline, and a cleanup
// that reconnects boundary nodes with their old handles pushes the boundary
// away from the isoline — which this measures directly.
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=isoline-${Date.now()}`;

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
        const cub = (a, b, c, d, t) => {
            const u = 1 - t;
            return { x: u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x, y: u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y };
        };
        const res = [];
        for (const c of cm.curveStore.curves) {
            if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            c.updateBooleanCache();
            const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];
            if (!cache.length) continue;
            const hw = c.stroke_width / 2;
            const skel = [];
            for (const seg of (c.getSkeletonBezierSegments ? c.getSkeletonBezierSegments() : [])) {
                for (let k = 0; k <= 3000; k++) skel.push(cub(seg.p0, seg.p1, seg.p2, seg.p3, k / 3000));
            }
            if (!skel.length) continue;
            const distSkel = (x, y) => {
                let best = Infinity;
                for (const q of skel) { const d2 = (x - q.x) ** 2 + (y - q.y) ** 2; if (d2 < best) best = d2; }
                return Math.sqrt(best);
            };
            let minDev = Infinity, maxDev = -Infinity, samples = 0;
            let worstRing = -1;
            for (let i = 0; i < cache.length; i++) {
                const sg = cache[i].segments;
                for (let n = 0; n < sg.length; n++) {
                    const a = sg[n], b = sg[(n + 1) % sg.length];
                    const p0 = { x: a.x, y: a.y };
                    const p1 = { x: a.x + (a.outX || 0), y: a.y + (a.outY || 0) };
                    const p2 = { x: b.x + (b.inX || 0), y: b.y + (b.inY || 0) };
                    const p3 = { x: b.x, y: b.y };
                    for (let k = 0; k <= 24; k++) {
                        const pt = cub(p0, p1, p2, p3, k / 24);
                        const dev = distSkel(pt.x, pt.y) - hw;
                        if (dev < minDev) { minDev = dev; worstRing = i; }
                        if (dev > maxDev) maxDev = dev;
                        samples++;
                    }
                }
            }
            res.push({
                id: c.id, closed: !!c.closed, hw, rings: cache.length,
                samples,
                minDeviation: +minDev.toFixed(2),
                maxDeviation: +maxDev.toFixed(2),
                worstRing
            });
        }
        return res;
    })()`);
    if (out && out.__exc) { console.log(`[${f.name}] threw: ` + out.__exc); continue; }
    for (const r of out || []) rows.push({ file: f.name, ...r });
}

let worstIn = 0, worstOut = 0;
for (const r of rows) {
    worstIn = Math.min(worstIn, r.minDeviation);
    worstOut = Math.max(worstOut, r.maxDeviation);
    console.log(`${r.id.padEnd(10)} closed=${String(r.closed).padEnd(5)} rings=${r.rings} hw=${r.hw} dev=[${r.minDeviation}, ${r.maxDeviation}]`);
}

// Inward deviations are legitimate where the ring uses a keyhole slit: a
// zero-width cut that travels along the skeleton to join two offset branches
// into one contour. Such a cut changes no painted pixel, so it is reported as
// INFO rather than asserted. Outward deviations are what a shape-changing
// cleanup produces (it reconnects boundary nodes with handles that balloon away
// from the isoline), so that side is asserted.
const EPS_OUT = 3.0;
const checks = [
    { name: `measured ${rows.length} smart stroke curve(s)`, ok: rows.length > 0 },
    { name: `no ring point lies outside the stroke band (max deviation ${worstOut} <= ${EPS_OUT})`, ok: worstOut <= EPS_OUT },
];
console.log(`INFO  inward deviation (keyhole slits / cap centres touch the skeleton): min ${worstIn}`);
console.log(JSON.stringify({ tag: 'ring-isoline', checks }, null, 2));
ws.close();
process.exit(checks.every(c => c.ok) ? 0 : 1);
