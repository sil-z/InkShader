// Does the boolean cache clean self-intersections out of a smart stroke?
//
// `expandSelectedStroke` materializes `curve.cached_boolean_geometry` verbatim
// into new curves, so "expand stroke did not remove the self-intersecting part"
// means the cache stored raw, still-self-intersecting rings (the `raw` merge
// candidate won) instead of the split/clean outline.
//
// For every smart curve this forces a cache rebuild and then re-splits each
// cached ring with Paper's resolveCrossings: a ring that splits into >1 piece was
// still self-intersecting. The skeleton is measured the same way, so we can tell
// "the source shape self-intersects" apart from "the cache failed to clean it".
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=csx-${Date.now()}`;

const files = [];
for (const name of (process.env.PROBE_FILES || 'bug_test.json,InkShader_Roundhand.json').split(',')) {
    try { files.push({ name, text: readFileSync(exampleProject(name.trim()), 'utf8') }); } catch { /* optional */ }
}
if (!files.length) { console.log('no example files found'); process.exit(1); }

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
        if (t.includes('[InkShader')) inkErrors.push(t.slice(0, 180));
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

const rows = [];
for (const f of files) {
    const out = await evalp(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const cv = window.__canvas;
        const cm = cv.curve_manager;
        const { getPaperScope } = await import('/js/core/paper_scope.js');
        const pScope = getPaperScope();
        await cm.loadFromJSON(${JSON.stringify(f.text)});
        await sleep(1200);

        const splitsOf = (p) => {
            // How many pieces does resolveCrossings produce? >1 ⇒ self-intersecting.
            try {
                const clone = p.clone({ insert: false });
                if (typeof clone.resolveCrossings !== 'function') { clone.remove(); return -1; }
                const r = clone.resolveCrossings();
                let n = 0;
                const collect = (it) => {
                    if (it instanceof pScope.CompoundPath) { for (const k of [...it.children]) collect(k); }
                    else if (it instanceof pScope.Path && it.segments.length >= 2) n++;
                };
                collect(r);
                const changed = !!(r && r !== clone);
                if (changed) { try { r.remove(); } catch (_) {} }
                clone.remove();
                return n;
            } catch (_) { return -1; }
        };
        // Cached segments carry handle offsets RELATIVE to the point (inX/inY,
        // outX/outY). The reconstruction must assign them as relative handles:
        // passing them as absolute points (or dropping them) yields a different
        // curve, and a self-intersection test on that curve is meaningless.
        const pathFromSegs = (segs, closed) => {
            const p = new pScope.Path();
            for (const s of segs) {
                const seg = p.add(new pScope.Point(s.x, s.y));
                seg.handleIn = new pScope.Point(s.inX || 0, s.inY || 0);
                seg.handleOut = new pScope.Point(s.outX || 0, s.outY || 0);
            }
            p.closed = closed !== false;
            return p;
        };

        const out2 = [];
        for (const c of cm.curveStore.curves) {
            if (!c.startNode) continue;
            if (!(c.smart_stroke && c.stroke_width > 0)) continue;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            c.updateBooleanCache();
            const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];

            // skeleton ring self-intersection
            let skelSelf = false;
            try {
                const segs = c.getSkeletonBezierSegments();
                if (segs && segs.length >= 2) {
                    const sk = new pScope.Path();
                    sk.moveTo(new pScope.Point(segs[0].p0.x, segs[0].p0.y));
                    for (const s of segs) sk.cubicCurveTo(new pScope.Point(s.p1.x, s.p1.y), new pScope.Point(s.p2.x, s.p2.y), new pScope.Point(s.p3.x, s.p3.y));
                    sk.closed = !!c.closed;
                    skelSelf = splitsOf(sk) > 1;
                    sk.remove();
                }
            } catch (_) {}

            let selfIntRings = 0, rings = 0;
            const ringInfo = [];
            for (const sub of cache) {
                if (!sub.segments || sub.segments.length < 2) continue;
                rings++;
                const p = pathFromSegs(sub.segments, sub.closed);
                const si = splitsOf(p) > 1;
                if (si) selfIntRings++;
                let a = 0;
                const sg = sub.segments;
                for (let i = 0; i < sg.length; i++) { const q = sg[i], r2 = sg[(i + 1) % sg.length]; a += q.x * r2.y - r2.x * q.y; }
                const b = p.bounds;
                ringInfo.push({ area: Math.round(a / 2), si, segs: sg.length, box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] });
                p.remove();
            }
            out2.push({ id: c.id, closed: !!c.closed, sw: c.stroke_width, skelSelf, rings, selfIntRings, ringInfo });
        }
        return { rows: out2, inkErrors: window.__inkErrorLog.map(e => (e.reason || e.message || '').slice(0, 80)) };
    })()`);
    if (out && out.__exc) { console.log(`[${f.name}] probe threw: ` + out.__exc); continue; }
    for (const r of out.rows || []) rows.push({ file: f.name, ...r });
}

const checks = [{ name: 'measured smart stroke curves', ok: rows.length > 0 }];
for (const r of rows) {
    if (r.skelSelf) {
        checks.push({
            name: `${r.file}:${r.id} skeleton self-intersects — cache must be cleaned (rings=${r.rings} selfIntersectingRings=${r.selfIntRings})`,
            ok: r.selfIntRings === 0
        });
    }
}
try { writeFileSync(path.join(TMP_DIR, 'cache_selfint_rows.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { /* diagnostics only */ }
console.log(JSON.stringify({ tag: 'cache-selfintersection', rows, inkErrors, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
