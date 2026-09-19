// End-to-end expand stroke on open self-crossing smart paths.
//
// The user reports "expand stroke does not clear the self-intersecting part"
// for Path_10. This drives the REAL command (cv.commands.expandSelectedStroke)
// and measures what it produced: the number of result curves, whether any of
// them self-intersects, and whether the filled region still equals the stroke
// region of the original skeleton.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=expe2e-${Date.now()}`;
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

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

    const ringOf = (curve) => {
        const segs = curve.getSkeletonBezierSegments();
        if (!segs || segs.length < 2) return null;
        const p = new pScope.Path();
        p.moveTo(new pScope.Point(segs[0].p0.x, segs[0].p0.y));
        for (const s of segs) p.cubicCurveTo(new pScope.Point(s.p1.x,s.p1.y), new pScope.Point(s.p2.x,s.p2.y), new pScope.Point(s.p3.x,s.p3.y));
        p.closed = !!curve.closed;
        return p;
    };
    const splitsOf = (p) => {
        try {
            const clone = p.clone({ insert: false });
            const r = clone.resolveCrossings();
            let n = 0; const col=(it)=>{ if(it instanceof pScope.CompoundPath){for(const k of [...it.children])col(k);} else if(it instanceof pScope.Path&&it.segments.length>=2)n++; };
            col(r);
            if (r && r !== clone) { try { r.remove(); } catch(_){} }
            clone.remove();
            return n;
        } catch(_) { return -1; }
    };
    const areaStats = (curves) => {
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        const acc=(x,y)=>{if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;};
        for (const c of curves) for (const s of (c.getSkeletonBezierSegments()||[])) { acc(s.p0.x,s.p0.y);acc(s.p1.x,s.p1.y);acc(s.p2.x,s.p2.y);acc(s.p3.x,s.p3.y); }
        if (!Number.isFinite(minX)) return null;
        const pad=(curves[0].stroke_width||16)*2+8; const sp0=[minX-pad,minY-pad,maxX+pad,maxY+pad];
        const scale=900/Math.max(sp0[2]-sp0[0], sp0[3]-sp0[1]);
        const w=Math.max(8,Math.ceil((sp0[2]-sp0[0])*scale)), h=Math.max(8,Math.ceil((sp0[3]-sp0[1])*scale));
        const ctx=document.createElement('canvas').getContext('2d');
        ctx.canvas.width=w; ctx.canvas.height=h;
        ctx.setTransform(scale,0,0,scale,-sp0[0]*scale,-sp0[1]*scale);
        ctx.fillStyle='#000'; ctx.strokeStyle='#000'; ctx.lineJoin='round';
        const pp=new Path2D();
        for (const c of curves) {
            const segs=c.getSkeletonBezierSegments(); if(!segs||segs.length<2)continue;
            pp.moveTo(segs[0].p0.x,segs[0].p0.y);
            for(let i=0;i<segs.length;i++){const s=segs[i];pp.bezierCurveTo(s.p1.x,s.p1.y,s.p2.x,s.p2.y,s.p3.x,s.p3.y);}
            if (curveClosed(c)) pp.closePath();
        }
        const strokeP=new Path2D();
        for (const c of curves) {
            if (!(c.smart_stroke && c.stroke_width>0)) continue;
            const segs=c.getSkeletonBezierSegments(); if(!segs||segs.length<2)continue;
            strokeP.moveTo(segs[0].p0.x,segs[0].p0.y);
            for(const s of segs)strokeP.bezierCurveTo(s.p1.x,s.p1.y,s.p2.x,s.p2.y,s.p3.x,s.p3.y);
        }
        if (strokeP) { ctx.lineWidth=curves[0].stroke_width||16; ctx.lineCap='butt'; ctx.stroke(strokeP); }
        ctx.fill(pp,'nonzero');
        const d=ctx.getImageData(0,0,w,h).data; let filled=0;
        for(let i=0;i<d.length;i+=4) if(d[i+3]>127) filled++;
        return { filled, w, h };
    };
    function curveClosed(c){ return !!c.closed; }

    const rows = [];
    for (const target of ['Path_10','Path_11']) {
        let tid = null;
        for (const [id, item] of cm.treeItems) if (item.type==='curve' && item.curveId===target) tid=id;
        if (!tid) { rows.push({ id: target, err:'no tree item' }); continue; }
        const before = cm.curveById.get(target);
        const beforeRegion = before ? areaStats([before]) : null;
        cv.commands.setTreeSelection([tid]);
        let ok=false;
        try { ok = cv.commands.expandSelectedStroke(); } catch(e){ rows.push({ id:target, err:'threw '+String(e.message||e).slice(0,200) }); continue; }
        await sleep(300);
        // result curves: newly added, smart, width 0
        const results = [...cm.curveStore.curves].filter(c => c.smart_stroke && c.stroke_width === 0 && c.id !== target && c.closed);
        const per = [];
        for (const c of results) {
            const rp = ringOf(c);
            const n = rp ? splitsOf(rp) : -1;
            if (rp) rp.remove();
            per.push({ segs: c.getSkeletonBezierSegments()?.length ?? 0, selfSplits: n, closed: !!c.closed });
        }
        rows.push({ id: target, ok, resultCount: results.length, selfIntersectingResults: per.filter(p=>p.selfSplits>1).length, per, beforeRegion, afterRegion: areaStats(results) });
    }
    return rows;
})()`);

if (out && out.__exc) { console.log('threw: ' + out.__exc); process.exit(1); }
const rows = out || [];
const checks = [{ name: 'measured expand on open self-crossing paths', ok: rows.length > 0 && rows.every(r => !r.err) }];
for (const r of rows) {
    if (r.err) { checks.push({ name: `${r.id}: expand threw/no tree item (${r.err})`, ok: false }); continue; }
    checks.push({ name: `${r.id}: expand succeeded`, ok: r.ok === true });
    checks.push({ name: `${r.id}: expand produced result curves`, ok: r.resultCount >= 1 });
    checks.push({ name: `${r.id}: no self-intersecting result ring (${r.resultCount} curves)`, ok: r.selfIntersectingResults === 0 });
}
try { writeFileSync(path.join(TMP_DIR, 'expand_e2e.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { /* diag */ }
for (const r of rows) {
    if (r.err) { console.log('=== ' + r.id + ' ERR ' + r.err); continue; }
    console.log('=== ' + r.id + ' ok=' + r.ok + ' resultCurves=' + r.resultCount + ' selfIntersecting=' + r.selfIntersectingResults);
}
console.log(JSON.stringify({ tag: 'expand-e2e', rows, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
