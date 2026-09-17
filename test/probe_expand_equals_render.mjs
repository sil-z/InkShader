// 断言用户要求的核心不变量：smart expand 曲线在画布上画出来的区域（布尔缓存）
// 必须等于对它执行 expand stroke 之后物化出来的曲线区域。
//
// 做法（真实工程 + 真实命令层，逐字形比较）：
//   1. 对每个含 smart 曲线的组：把该组所有 smart 曲线的缓存区域按“逐件取掩码再并集”
//      光栅化成 A（与画布同一个 nonzero 填充规则、同一个路径构造器）。
//   2. 选中这些曲线，调用 expandSelectedStroke()（真实命令，会删掉原曲线、
//      按缓存子环建立新曲线）。
//   3. 对展开后的曲线做同样的光栅化得到 B，比较面积差（容差 max(60, 2%)）。
//   4. 最后重新加载工程，保证不留痕。
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=expandrender-${Date.now()}`;
const EXAMPLE = exampleProject();
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
        if (t.includes('[InkShader:')) inkErrors.push(t.slice(0, 160));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
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
    const { buildBooleanPath2D } = await import('/js/core/bezier/path_emitter.js');
    // 清掉上一次会话持久化的错误日志（
    // _loadFromStorage 会在首次上报时把 localStorage 里的旧条目读进来）
    try { localStorage.removeItem('__ink_error_log'); } catch (e) { }
    window.__inkErrorLog.length = 0;

    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1800);

    // 与缓存模块同款：逐件画到独立画布 → 阈值化成掩码 → 并集
    const rasterMask = (path2d, box) => {
        const scale = 256 / Math.max(box.w, box.h);
        const w = Math.max(2, Math.ceil(box.w * scale));
        const h = Math.max(2, Math.ceil(box.h * scale));
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
        ctx.fillStyle = '#000';
        ctx.fill(path2d, 'nonzero');
        const data = ctx.getImageData(0, 0, w, h).data;
        const mask = new Uint8Array(w * h);
        for (let i = 3, p = 0; i < data.length; i += 4, p++) if (data[i] > 127) mask[p] = 1;
        return { mask, scale, w, h };
    };
    const maskArea = (m) => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; };
    const unionInto = (acc, m) => { for (let i = 0; i < acc.length; i++) if (m[i]) acc[i] = 1; };

    const curveTreeId = (curve) => {
        for (const [id, item] of cm.treeItems) if (item.type === 'curve' && item.curveId === curve.id) return id;
        return null;
    };
    const cacheBox = (curves) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of curves) for (const r of (c.cached_boolean_geometry || [])) for (const s of r.segments) {
            minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
            minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
        }
        for (const c of curves) for (const r of (c.cached_boolean_geometry || [])) for (const s of r.segments) {
            minX = Math.min(minX, s.x + s.outX, s.x + s.inX); maxX = Math.max(maxX, s.x + s.outX, s.x + s.inX);
            minY = Math.min(minY, s.y + s.outY, s.y + s.inY); maxY = Math.max(maxY, s.y + s.outY, s.y + s.inY);
        }
        const pad = 4;
        return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    };
    const regionOf = (curves, box) => {
        const r = rasterMask(new Path2D(), box);      // 空掩码
        let any = false;
        for (const c of curves) {
            const p2d = buildBooleanPath2D(c.cached_boolean_geometry);
            if (!p2d) continue;
            const m = rasterMask(p2d, box).mask;
            unionInto(r.mask, m); any = true;
        }
        return { area: maskArea(r.mask) / (r.scale * r.scale), any };
    };

    // 每个组挑出“含且仅含 smart 曲线”的情形，逐组比较（避免跨字形坐标重叠）
    const groups = [...cm.treeItems.values()].filter(i => i.type === 'group' && !i.isRef);
    const rows = [];
    for (const g of groups) {
        const smart = cm.curveStore.curves.filter(c => c.groupId === g.id && c.smart_stroke && c.stroke_width > 0);
        if (!smart.length) continue;
        for (const c of smart) { c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache(); }
        const withRings = smart.filter(c => Array.isArray(c.cached_boolean_geometry) && c.cached_boolean_geometry.length);
        if (!withRings.length) { rows.push({ group: g.id, skipped: 'no cached rings' }); continue; }
        const box = cacheBox(withRings);
        const A = regionOf(withRings, box);
        const treeIds = withRings.map(curveTreeId).filter(Boolean);
        const D = await import('/js/app/canvas_dispatcher.js');
        D.CanvasDispatcher.requestSetTreeSelection(treeIds, g.id);
        await sleep(250);
        const ok = cv.commands.expandSelectedStroke();
        cv.is_dirty = true;
        await sleep(500);
        const newCurves = cm.curveStore.curves.filter(c => c.groupId === g.id);
        for (const c of newCurves) { c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache(); }
        const B = regionOf(newCurves, box);
        rows.push({
            group: g.id, curves: withRings.length, expandOk: !!ok, newCurves: newCurves.length,
            a: Math.round(A.area), b: Math.round(B.area),
            diff: Math.round(Math.abs(A.area - B.area)),
            tol: Math.round(Math.max(60, A.area * 0.02)),
            ok: Math.abs(A.area - B.area) <= Math.max(60, A.area * 0.02) && B.area > 0
        });
    }

    // 收尾：重新加载工程（不留痕）
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1200);
    return { rows, inkErrorCount: window.__inkErrorLog.length, messages: window.__inkErrorLog.map(e => e.message) };
})()`);

await new Promise(r => setTimeout(r, 400));
const rows = out.rows || [];
const compared = rows.filter(r => !r.skipped);
const failed = compared.filter(r => !r.ok);
const checks = [
    { name: 'every smart-stroke group has cached rings', ok: rows.every(r => !r.skipped) },
    { name: 'expand stroke materializes the same region as the cache (per group)', ok: failed.length === 0 },
    { name: 'compared at least 5 groups', ok: compared.length >= 5 },
    { name: 'no boolean cache error reports', ok: (out.inkErrorCount || 0) === 0 && inkErrors.filter(t => t.includes('boolean_geometry_cache')).length === 0 }
];
console.log(JSON.stringify({ tag: 'expand-equals-render', compared: compared.length, rows, inkErrors, checks, failedCount: checks.filter(c => !c.ok).length }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
