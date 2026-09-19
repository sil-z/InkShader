// Independent region oracle for smart-expand geometry, by rasterisation.
//
// The expand region has a definition that needs no Paper.js and no boolean
// cache: fill the skeleton ring (closed paths) and stroke the skeleton with
// lineWidth = stroke_width. That is exactly "every point within halfWidth of the
// skeleton, plus the interior". Both sides are rasterised on the SAME canvas
// grid — the oracle from canvas stroke/fill, the cache from its stored rings
// filled with nonzero — and compared pixel by pixel, so a cache that drops a
// hole, fills a self-intersection, or merges the wrong lobes shows up as a
// deviation instead of a silent visual defect.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=expandoracle-${Date.now()}`;

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

        const out2 = [];
        for (const c of cm.curveStore.curves) {
            if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
            c.invalidateBooleanCache(); c._booleanEmptyHash = null;
            c.updateBooleanCache();
            if (!Array.isArray(c.cached_boolean_geometry) || !c.cached_boolean_geometry.length) continue;

            const segs = c.getSkeletonBezierSegments() || [];
            if (!segs.length) continue;

            // common bbox over skeleton + cache, padded by stroke width
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const acc = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
            for (const s of segs) { acc(s.p0.x, s.p0.y); acc(s.p1.x, s.p1.y); acc(s.p2.x, s.p2.y); acc(s.p3.x, s.p3.y); }
            for (const sub of c.cached_boolean_geometry) for (const p of sub.segments) { acc(p.x, p.y); acc(p.x + p.inX, p.y + p.inY); acc(p.x + p.outX, p.y + p.outY); }
            const pad = c.stroke_width;
            minX -= pad; minY -= pad; maxX += pad; maxY += pad;
            const bw = maxX - minX, bh = maxY - minY;
            if (!(bw > 0 && bh > 0)) continue;
            const scale = 900 / Math.max(bw, bh);
            const W = Math.max(8, Math.ceil(bw * scale)), H = Math.max(8, Math.ceil(bh * scale));
            if (W * H > 4e6) continue;

            const newCtx = () => {
                const ctx = document.createElement("canvas").getContext("2d");
                ctx.canvas.width = W; ctx.canvas.height = H;
                ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
                ctx.fillStyle = "#000"; ctx.strokeStyle = "#000"; ctx.lineJoin = "round";
                return ctx;
            };
            const maskOf = (ctx) => {
                const d = ctx.getImageData(0, 0, W, H).data;
                const m = new Uint8Array(W * H);
                for (let i = 3, p = 0; i < d.length; i += 4, p++) m[p] = d[i] > 127 ? 1 : 0;
                return m;
            };

            const skelPath = () => {
                const p = new Path2D();
                p.moveTo(segs[0].p0.x, segs[0].p0.y);
                for (const s of segs) p.bezierCurveTo(s.p1.x, s.p1.y, s.p2.x, s.p2.y, s.p3.x, s.p3.y);
                return p;
            };
            const closedRing = !!(c.closed && c.startNode !== c.endNode);

            // ORACLE: fill the ring (closed) + canvas-stroke the skeleton.
            const oc = newCtx();
            const sp = skelPath();
            if (closedRing) oc.fill(sp, "nonzero");
            oc.lineWidth = c.stroke_width;
            oc.lineCap = (!closedRing && c._expandRoundCap === true) ? "round" : "butt";
            oc.stroke(sp);
            const oracle = maskOf(oc);

            // CACHE: fill the stored rings with nonzero.
            const cc = newCtx();
            const cp = new Path2D();
            for (const sub of c.cached_boolean_geometry) {
                const sg = sub.segments;
                if (!sg || sg.length < 2) continue;
                cp.moveTo(sg[0].x, sg[0].y);
                for (let i = 0; i < sg.length; i++) {
                    const a = sg[i], b = sg[(i + 1) % sg.length];
                    cp.bezierCurveTo(a.x + a.outX, a.y + a.outY, b.x + b.inX, b.y + b.inY, b.x, b.y);
                }
                cp.closePath();
            }
            cc.fill(cp, "nonzero");
            const cached = maskOf(cc);

            let oh = 0, ch = 0, both = 0, onlyO = 0, onlyC = 0;
            for (let p = 0; p < oracle.length; p++) {
                if (oracle[p]) oh++;
                if (cached[p]) ch++;
                if (oracle[p] && cached[p]) both++;
                else if (oracle[p]) onlyO++;
                else if (cached[p]) onlyC++;
            }
            const pxArea = 1 / (scale * scale);
            out2.push({
                id: c.id, closed: closedRing, sw: c.stroke_width,
                rings: c.cached_boolean_geometry.length,
                oracleArea: Math.round(oh * pxArea),
                cacheArea: Math.round(ch * pxArea),
                symDiffPct: oh > 0 ? Math.round((onlyO + onlyC) / oh * 1000) / 10 : 0,
                missingPct: Math.round(onlyO / Math.max(1, oh) * 1000) / 10,
                extraPct: Math.round(onlyC / Math.max(1, oh) * 1000) / 10
            });
        }
        return out2;
    })()`);
    if (out && out.__exc) { console.log(`[${f.name}] threw: ` + out.__exc); continue; }
    for (const r of out || []) rows.push({ file: f.name, ...r });
}

const checks = [{ name: 'measured smart stroke curves', ok: rows.length > 0 }];
for (const r of rows) {
    checks.push({
        name: `${r.file}:${r.id} cache region must match canvas expand (oracle=${r.oracleArea} cache=${r.cacheArea} symDiff=${r.symDiffPct}% missing=${r.missingPct}% extra=${r.extraPct}%)`,
        ok: r.symDiffPct <= 5
    });
}
try { writeFileSync(path.join(TMP_DIR, 'expand_oracle_rows.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { /* diagnostics only */ }
console.log(JSON.stringify({ tag: 'expand-region-oracle', rows, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
