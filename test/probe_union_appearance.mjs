// Drives the REAL union command on real example data and checks the only
// acceptance criterion that matters for a font editor: the glyph's rendered
// appearance (nonzero region of ALL rings together) must be unchanged by a
// union, and it must be deterministic across repeats.
//
//   region(r) = nonzero fill of every ring of every curve in r
//
// A union that "fills the hole" or "loses a lobe" changes region(); a union
// whose result depends on call order / prior edits is non-deterministic.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=unapp-${Date.now()}`;
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

// Page-side helpers, installed once.
const HANDLERS = `
(() => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  window.__region = (curves) => {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    const rings=[];
    for (const c of curves) {
      const g = c.cached_boolean_geometry || (c.updateBooleanCache?.(), c.cached_boolean_geometry) || [];
      for (const sub of g) {
        if (!sub?.segments || sub.segments.length<2) continue;
        rings.push(sub);
        for (const s of sub.segments){ if(s.x<minX)minX=s.x; if(s.x>maxX)maxX=s.x; if(s.y<minY)minY=s.y; if(s.y>maxY)maxY=s.y; }
      }
    }
    if (!rings.length || !isFinite(minX)) return null;
    const pad=4, scale=4;
    const ox=minX-pad, oy=minY-pad;
    const w=Math.ceil((maxX-minX+2*pad)*scale), h=Math.ceil((maxY-minY+2*pad)*scale);
    canvas.width=w; canvas.height=h;
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,w,h);
    ctx.setTransform(scale,0,0,scale,-ox*scale,-oy*scale);
    const pp=new Path2D();
    for (const sub of rings) {
      pp.moveTo(sub.segments[0].x, sub.segments[0].y);
      const segs=sub.segments;
      for (let i=0;i<segs.length;i++){
        const a=segs[i], b=segs[(i+1)%segs.length];
        pp.bezierCurveTo(a.x+a.outX,a.y+a.outY,b.x+b.inX,b.y+b.inY,b.x,b.y);
      }
      pp.closePath();
    }
    ctx.fillStyle='#000'; ctx.fill(pp,'nonzero');
    return { w, h, canvas: ctx.getImageData(0,0,w,h).data, box:[ox,oy,maxX,minY] };
  };
  window.__regionStat = (curves) => {
    const r = window.__region(curves);
    if (!r) return { filled: 0, w:0, h:0 };
    let filled=0; for (let i=0;i<r.canvas.length;i+=4) if (r.canvas[i+3]>127) filled++;
    return { filled, w:r.w, h:r.h };
  };
  window.__regionDiff = (a, b) => {
    const A=window.__region(a), B=window.__region(b);
    if (!A && !B) return { same:true, onlyA:0, onlyB:0 };
    if (!A || !B) return { same:false, onlyA:A?1:0, onlyB:B?1:0 };
    // Re-raster both into a common frame (union bbox).
    const pad=4, scale=4;
    let minX=Math.min(A.box[0],B.box[0]), minY=Math.min(A.box[1],B.box[1]);
    let maxX=Math.max(A.box[2],B.box[2]), maxY=Math.max(A.box[3],B.box[3]);
    const w=Math.ceil((maxX-minX+2*pad)*scale), h=Math.ceil((maxY-minY+2*pad)*scale);
    const draw=(rr)=>{ if(!rr) return null; canvas.width=w; canvas.height=h; ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,w,h); ctx.setTransform(scale,0,0,scale,-minX*scale+pad*scale,-minY*scale+pad*scale); ctx.fillStyle='#000'; ctx.fill(rr.path,'nonzero'); return ctx.getImageData(0,0,w,h).data; };
    const da=draw(A), db=draw(B);
    let onlyA=0, onlyB=0, both=0;
    for (let i=0;i<da.length;i+=4){ const fa=da[i+3]>127, fb=db[i+3]>127; if(fa&&!fb)onlyA++; else if(fb&&!fa)onlyB++; else if(fa&&fb)both++; }
    return { same: onlyA===0 && onlyB===0, onlyA, onlyB, both };
  };
  return true;
})()
`;

const install = await evalp(HANDLERS);
if (install && install.__exc) { console.log('install threw: ' + install.__exc); process.exit(1); }

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const rows = [];

    const glyphCurves = (name) => {
        const res = [];
        for (const [, item] of cm.treeItems) {
            if (item.type === 'curve' && item.parentId === name) res.push(cm.curveById.get(item.curveId));
        }
        return res.filter(Boolean);
    };
    const treeIdsOf = (name) => {
        const res = [];
        for (const [id, item] of cm.treeItems) if (item.type==='curve' && item.parentId===name) res.push(id);
        return res;
    };
    const dirOf = (c) => {
        const g = c.cached_boolean_geometry || [];
        return g.map(sub => {
            let a=0; const s=sub.segments;
            for (let i=0;i<s.length;i++){ const p=s[i], q=s[(i+1)%s.length]; a += p.x*q.y - q.x*p.y; }
            return Math.round(a/2);
        });
    };

    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    const dbg = { items: [], curves: [] };
    for (const [id, it] of cm.treeItems) dbg.items.push({ id, keys: Object.keys(it), type: it.type, name: it.name, parentId: it.parentId, groupId: it.groupId, curveId: it.curveId });
    for (const c of cm.curveStore.curves) dbg.curves.push({ id: c.id, keys: Object.keys(c).slice(0,40) });

    // ---- test_union glyph: union all 4 curves, compare appearance
    const ids = treeIdsOf('test_union');
    const names = [];
    for (let i=0;i<ids.length;i++) names.push((cm.curveById.get(cm.treeItems.get(ids[i]).curveId)||{}).id || ('#'+ids[i]));
    const before = glyphCurves('test_union');
    const beforeStat = window.__regionStat(before);
    const beforeDirs = before.map(c => ({ id:c.id, dirs:dirOf(c), closed:!!c.closed }));

    cv.commands.setTreeSelection(ids);
    let ok=false, err=null;
    try { ok = cv.commands.booleanUnionSelectedCurves(); } catch(e){ err = String(e.message||e).slice(0,300); }
    await sleep(600);
    const after1 = glyphCurves('test_union');
    const afterStat1 = window.__regionStat(after1);

    rows.push({
        tag: 'test_union',
        names, ok, err,
        beforeCount: before.length, afterCount: after1.length,
        beforeStat, afterStat1,
        beforeDirs,
        afterDirs: after1.map(c => ({ id:c.id, dirs:dirOf(c), segs:(c.getSkeletonBezierSegments()||[]).length, filled: window.__regionStat([c]).filled })),
        regionDelta: beforeStat.filled - afterStat1.filled,
    });

    // ---- repeat on a fresh reload: same operation, compare appearance
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1200);
    const before2 = glyphCurves('test_union');
    const beforeStat2 = window.__regionStat(before2);
    cv.commands.setTreeSelection(treeIdsOf('test_union'));
    try { cv.commands.booleanUnionSelectedCurves(); } catch(e){ /* recorded above */ }
    await sleep(600);
    const after2 = glyphCurves('test_union');
    const afterStat2 = window.__regionStat(after2);
    rows.push({
        tag: 'test_union_repeat',
        beforeStat: beforeStat2, afterStat: afterStat2,
        repeatSame: beforeStat.filled === beforeStat2.filled && afterStat1.filled === afterStat2.filled,
        regionDelta: beforeStat2.filled - afterStat2.filled,
    });

    return { rows, dbg };
})()`);

if (out && out.__exc) { console.log('probe threw: ' + out.__exc); process.exit(1); }
const rows = (out && out.rows) || [];
const dbg = (out && out.dbg) || null;
try { writeFileSync(path.join(TMP_DIR, 'union_appearance_dbg.json'), JSON.stringify(dbg, null, 2)); } catch { }
const checks = [];
for (const r of rows) {
    if (r.err) { checks.push({ name: `${r.tag}: command threw (${r.err})`, ok: false }); continue; }
    const before = r.beforeStat || {};
    const after = r.afterStat || r.afterStat1 || {};
    if (r.ok != null) checks.push({ name: `${r.tag}: command returned`, ok: r.ok === true });
    checks.push({
        name: `${r.tag}: appearance preserved (before=${before.filled} after=${after.filled})`,
        ok: Math.abs(r.regionDelta) <= Math.max(20, (before.filled || 0) * 0.005),
    });
    if (r.repeatSame != null) checks.push({ name: `${r.tag}: deterministic across reloads`, ok: r.repeatSame === true });
    if (r.afterCount != null) checks.push({ name: `${r.tag}: result has rings`, ok: r.afterCount >= 1 });
}
const fails = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok?'PASS':'FAIL'} ${c.name}`);
try { writeFileSync(path.join(TMP_DIR, 'union_appearance.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { }
console.log(JSON.stringify({ tag: 'union-appearance', rows, checks, passed: checks.length-fails, total: checks.length }, null, 2));
ws.close();
process.exit(fails ? 1 : 0);
