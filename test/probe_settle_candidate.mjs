// Which post-processing removes the fold node that sits inside the fill?
//
// Current cache rings can contain a fold whose node is surrounded by fill (the
// user's swallowtail). This compares candidate ring sets built from the SAME
// raw band:
//   as-is              — the current result (reference)
//   crossings          — resolveCrossings over the combined rings
//   settle             — unite the combined rings with an empty path, so Paper
//                        settles the nonzero region into clean contours
// For each we report the number of nodes fully surrounded by the region.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=settle-${Date.now()}`;
const jsonText = readFileSync(exampleProject(process.env.PROBE_FILES || 'bug_test.json'), 'utf8');

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

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1200);

    const pathFromRing = (sub) => {
        const p = new pScope.Path();
        for (const s of sub.segments) {
            const seg = p.add(new pScope.Point(s.x, s.y));
            seg.handleIn = new pScope.Point(s.inX || 0, s.inY || 0);
            seg.handleOut = new pScope.Point(s.outX || 0, s.outY || 0);
        }
        p.closed = sub.closed !== false;
        return p;
    };
    const flatten = (item, out) => {
        if (!item) return;
        if (item instanceof pScope.CompoundPath) { for (const k of [...item.children]) flatten(k, out); }
        else if (item instanceof pScope.Path && item.segments.length >= 2) out.push(item);
    };
    const ringData = (paths) => paths.map(p => ({ closed: p.closed, segments: p.segments.map(s => ({ x: s.point.x, y: s.point.y, inX: s.handleIn.x, inY: s.handleIn.y, outX: s.handleOut.x, outY: s.handleOut.y })) }));

    // count nodes whose 4-unit neighbourhood is entirely filled
    const interiorCount = (rings, hw) => {
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for (const sub of rings) for (const s of sub.segments) { minX=Math.min(minX,s.x);maxX=Math.max(maxX,s.x);minY=Math.min(minY,s.y);maxY=Math.max(maxY,s.y); }
        const pad = hw*3+4; minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
        const scale = 1200/Math.max(maxX-minX, maxY-minY);
        const w = Math.max(8,Math.ceil((maxX-minX)*scale)), h = Math.max(8,Math.ceil((maxY-minY)*scale));
        const combined = new Path2D();
        for (const sub of rings) {
            const sg = sub.segments; if (!sg || sg.length < 2) continue;
            combined.moveTo(sg[0].x, sg[0].y);
            for (let i = 0; i < sg.length; i++) { const a = sg[i], b = sg[(i+1)%sg.length];
                combined.bezierCurveTo(a.x+(a.outX||0),a.y+(a.outY||0),b.x+(b.inX||0),b.y+(b.inY||0),b.x,b.y); }
            combined.closePath();
        }
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.canvas.width = w; ctx.canvas.height = h;
        ctx.setTransform(scale,0,0,scale,-minX*scale,-minY*scale);
        ctx.fillStyle = '#000'; ctx.fill(combined, 'nonzero');
        const data = ctx.getImageData(0,0,w,h).data;
        const inside = (wx,wy) => { const px=Math.round((wx-minX)*scale), py=Math.round((wy-minY)*scale);
            if (px<0||py<0||px>=w||py>=h) return false; return data[(py*w+px)*4+3] > 127; };
        let n = 0;
        for (const sub of rings) for (const s of sub.segments) {
            const r = Math.max(2, hw*0.5); let all = true;
            for (let k = 0; k < 8; k++) { const a = k*Math.PI/4; if (!inside(s.x+Math.cos(a)*r, s.y+Math.sin(a)*r)) { all = false; break; } }
            if (all) n++;
        }
        return n;
    };

    // the raw band pieces, exactly as the cache builds them (single keyhole ring)
    const { emitCubicBezierSegments } = await import('/js/core/bezier/curve.js').catch(() => ({ emitCubicBezierSegments: null }));
    const rows2 = [];
    for (const c of cm.curveStore.curves) {
        if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
        const hw = c.stroke_width / 2;
        c.invalidateBooleanCache(); c._booleanEmptyHash = null;
        c.updateBooleanCache();
        const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];
        if (cache.length < 2) continue;

        const cur = interiorCount(cache, hw);

        // crossings: resolveCrossings over the combined cache rings
        let crossings = null;
        try {
            const cp = new pScope.CompoundPath({ children: cache.map(pathFromRing) });
            const r = cp.resolveCrossings();
            const rings = []; flatten(r, rings);
            crossings = interiorCount(ringData(rings), hw);
            try { if (r !== cp) r.remove(); } catch (_) {}
            cp.remove();
        } catch (_) { crossings = 'threw'; }

        // settle: unite the combined rings with an empty path
        let settle = null, settleRings = null;
        try {
            const cp = new pScope.CompoundPath({ children: cache.map(pathFromRing) });
            const empty = new pScope.Path({ closed: true });
            const u = cp.unite(empty);
            const rings = []; flatten(u, rings);
            settle = interiorCount(ringData(rings), hw);
            settleRings = rings.length;
            try { empty.remove(); } catch (_) {}
            try { if (u && u !== cp) u.remove(); } catch (_) {}
            cp.remove();
        } catch (e) { settle = 'threw ' + String(e.message || e).slice(0, 80); }

        rows2.push({ id: c.id, closed: !!c.closed, rings: cache.length, asIs: cur, crossings, settle, settleRings });
    }
    return rows2;
})()`);

if (out && out.__exc) { console.log('threw: ' + out.__exc); process.exit(1); }
try { writeFileSync(path.join(TMP_DIR, 'settle_candidate.json'), JSON.stringify(out, null, 2)); } catch { /* diag */ }
for (const r of out || []) {
    console.log('=== ' + r.id + ' closed=' + r.closed + ' rings=' + r.rings);
    console.log('    as-is interiorNodes=' + r.asIs + '   crossings=' + r.crossings + '   settle=' + r.settle + (r.settleRings != null ? ' (rings ' + r.settleRings + ')' : ''));
}
ws.close();
process.exit(0);
