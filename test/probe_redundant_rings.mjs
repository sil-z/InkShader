// Is any cached ring NOT a boundary of the region?
//
// The user's criterion, verbatim: after expand there is one extra curve whose
// nodes sit INSIDE the fill rather than on its edge — a leftover swallowtail.
// The operational form of that: remove the ring from the geometry and see
// whether the painted region changes.
//   - a genuine boundary (outer edge or hole edge) ⇒ removing it changes the region;
//   - a leftover fold wound with the band ⇒ removing it changes NOTHING.
// This is the one test a region-equality oracle cannot fake: it compares the
// region against itself with each ring deleted.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=redr-${Date.now()}`;

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

        const ring2d = (sub) => {
            const sg = sub.segments; if (!sg || sg.length < 2) return null;
            const p = new Path2D();
            p.moveTo(sg[0].x, sg[0].y);
            for (let i = 0; i < sg.length; i++) {
                const a = sg[i], b = sg[(i+1)%sg.length];
                p.bezierCurveTo(a.x+(a.outX||0), a.y+(a.outY||0), b.x+(b.inX||0), b.y+(b.inY||0), b.x, b.y);
            }
            p.closePath();
            return p;
        };

        const rows2 = [];
        for (const c of cm.curveStore.curves) {
            if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
            const segs = c.getSkeletonBezierSegments() || [];
            if (!segs.length) continue;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            c.updateBooleanCache();
            const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];
            if (cache.length < 2) continue;                     // nothing to compare

            let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
            const acc=(x,y)=>{if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;};
            for (const sub of cache) for (const s of sub.segments) { acc(s.x,s.y); acc(s.x+(s.outX||0),s.y+(s.outY||0)); acc(s.x+(s.inX||0),s.y+(s.inY||0)); }
            const pad = (c.stroke_width||16)*2+8; minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
            const scale = 700/Math.max(maxX-minX, maxY-minY);
            const w = Math.max(8,Math.ceil((maxX-minX)*scale)), h = Math.max(8,Math.ceil((maxY-minY)*scale));

            const paths = cache.map(ring2d).filter(Boolean);
            // ONE combined path, ONE nonzero fill — the same semantics the cache
            // and the canvas use. Filling each ring separately would take the UNION
            // of the rings and could never cancel, so an opposite-wound hole ring
            // would look "redundant" instead of carving its hole.
            const raster = (subset) => {
                const ctx = document.createElement('canvas').getContext('2d');
                ctx.canvas.width = w; ctx.canvas.height = h;
                ctx.setTransform(scale,0,0,scale,-minX*scale,-minY*scale);
                ctx.fillStyle = '#000';
                const combined = new Path2D();
                for (const idx of subset) combined.addPath(paths[idx]);
                ctx.fill(combined, 'nonzero');
                const d = ctx.getImageData(0,0,w,h).data;
                const m = new Uint8Array(w*h); let n = 0;
                for (let i=0,p=0;i<d.length;i+=4,p++) { m[p] = d[i+3] > 127 ? 1 : 0; if (m[p]) n++; }
                return { m, n };
            };
            const all = raster(paths.map((_, i) => i));
            const perRing = [];
            for (let r = 0; r < paths.length; r++) {
                const without = raster(paths.map((_, i) => i).filter(i => i !== r));
                // pixels present only with r, and only without r
                let onlyWith = 0, onlyWithout = 0;
                for (let p = 0; p < w*h; p++) {
                    if (all.m[p] && !without.m[p]) onlyWith++;
                    else if (!all.m[p] && without.m[p]) onlyWithout++;
                }
                perRing.push({ ring: r, segs: cache[r].segments.length, carvedPx: onlyWith, addedPx: onlyWithout,
                    boundsAnything: (onlyWith + onlyWithout) > Math.max(120, all.n * 0.004) });
            }
            rows2.push({ id: c.id, closed: !!c.closed, rings: paths.length, regionPx: all.n,
                redundant: perRing.filter(x => !x.boundsAnything).length, perRing });
        }
        return rows2;
    })()`);
    if (out && out.__exc) { console.log(`[${f.name}] threw: ` + out.__exc); continue; }
    for (const r of out || []) rows.push({ file: f.name, ...r });
}

try { writeFileSync(path.join(TMP_DIR, 'redundant_rings.json'), JSON.stringify(rows, null, 2)); } catch { /* diag */ }
let totalRedundant = 0;
for (const r of rows) {
    totalRedundant += r.redundant;
    const flag = r.redundant ? '  <-- ' + r.redundant + ' RING(S) BOUND NOTHING' : '';
    console.log('=== [' + r.file + '] ' + r.id + ' closed=' + r.closed + ' rings=' + r.rings + ' region=' + r.regionPx + 'px' + flag);
    for (const x of r.perRing) console.log('    ring' + x.ring + ' segs=' + x.segs + ' carves=' + x.carvedPx + 'px adds=' + x.addedPx + 'px  ' + (x.boundsAnything ? 'bounds the region' : 'REDUNDANT FOLD'));
}
console.log(`\nTOTAL redundant rings across ${rows.length} curve(s): ${totalRedundant}`);
const checks = [
    { name: `measured ${rows.length} smart stroke curve(s) with >=2 cached rings`, ok: rows.length > 0 },
    { name: 'every cached ring bounds the region (removing it changes the paint)', ok: totalRedundant === 0 },
];
console.log(JSON.stringify({ tag: 'redundant-rings', checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
