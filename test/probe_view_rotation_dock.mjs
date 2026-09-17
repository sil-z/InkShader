// 旋转（极简方案）在坞区变化下的稳定性：停靠 / 浮动 / 拖浮动窗尺寸 / 取消浮动 /
// 隐藏再显示 / 改角度，每一步都要求：
//   - 纸张层尺寸 = 面板的旋转外接框（解析值与实测布局值一致）
//   - 画布位图尺寸 = 该外接框（渲染区域完整）
//   - 面板四角逆旋转后落在纸张层矩形内（没有空白角）
//   - 标尺 / 序列条 / 工具栏在旋转下始终没有 transform
//   - 旋转角在坞区churn中保持不变
//
// 运行前提：python test/probe_server.py 8140
//           msedge --headless=new --remote-debugging-port=9240 about:blank
//           PROBE_PORT=9240 PROBE_SRV=8140 node test/probe_view_rotation_dock.mjs
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';
const EXAMPLE = exampleProject();
const jsonText = readFileSync(EXAMPLE, 'utf8');

const PORT = Number(process.env.PROBE_PORT || 9240);
const SRV = Number(process.env.PROBE_SRV || 8140);
const APP = `http://127.0.0.1:${SRV}/index.html?v=rotdock-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
const consoleErrors = []; const pageExceptions = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.description || a.value).join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
        pageExceptions.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
    }
    if (m.method === 'Page.javascriptDialogOpening') {
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ed = r.result?.exceptionDetails;
    if (ed) return { __exc: (ed.exception?.description || ed.text || '').slice(0, 400) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(6500);

// 载入示例工程，保证画布里有真实内容（尺寸/渲染都走真实路径）
const loaded = await evalp(`(async () => {
    const c = window.__canvas;
    await c.commands.loadSnapshotCommand(${JSON.stringify(jsonText)});
    c.commandStack = []; c.redoCommandStack = [];
    c.currentStateObj = c.history.getHistoryState();
    if (typeof c.history._flushRuntimeStateSave === 'function') c.history._flushRuntimeStateSave();
    c.history.saveCurrentViewState(true);
    c.notifyPropertiesUpdate();
    c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
    await new Promise(r => setTimeout(r, 1500));
    return { curves: c.curve_manager.curves.length };
})()`);

const MEASURE = `(() => {
    const c = window.__canvas;
    const el = c.main_canvas_large;
    const b = c.viewportService.getPanelBox();
    const deg = c.viewRotation || 0;
    const rad = Math.abs(deg) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const analytic = { w: b.width * cos + b.height * sin, h: b.width * sin + b.height * cos };
    const u = c.viewportService.getCanvasUserSpaceSize();
    const t = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).transform : 'missing'; };
    // 面板四角逆旋转后是否落在纸张层矩形内。旋转轴取纸张层自身外接框的中心
    // （CSS transform-origin: 50% 50%），与面板中心只差布局取整的亚像素量。
    const th = -deg * Math.PI / 180;
    const cth = Math.cos(th), sth = Math.sin(th);
    const lr = el.getBoundingClientRect();
    const px = lr.left + lr.width / 2, py = lr.top + lr.height / 2;
    const corners = [[b.left, b.top], [b.left + b.width, b.top], [b.left, b.top + b.height], [b.left + b.width, b.top + b.height]]
        .map(([x, y]) => { const vx = x - px, vy = y - py;
            return { x: el.clientWidth / 2 + (vx * cth - vy * sth), y: el.clientHeight / 2 + (vx * sth + vy * cth) }; });
    const worst = Math.max(...corners.map(p => Math.max(-p.x, -p.y, p.x - el.clientWidth, p.y - el.clientHeight)));
    return {
        deg, rotation: +deg.toFixed(4),
        panel: { w: +b.width.toFixed(2), h: +b.height.toFixed(2) },
        analytic: { w: +analytic.w.toFixed(2), h: +analytic.h.toFixed(2) },
        sheetBox: { w: el.clientWidth, h: el.clientHeight },
        canvasEl: { w: c.canvasObj.clientWidth, h: c.canvasObj.clientHeight },
        user: { w: +u.width.toFixed(2), h: +u.height.toFixed(2) },
        worstOvershoot: +worst.toFixed(3),
        stageTransform: t('#canvas_stage'), rulerTransform: t('#ruler_horizontal'),
        seqTransform: t('glyph-sequence-bar'), toolbarTransform: t('.toolbar'),
        sheetTransform: t('#main_canvas_large'),
        floated: window.__dock ? window.__dock._floatedPanels.has('canvas') : null,
        hidden: window.__dock ? window.__dock._hiddenPanels.has('canvas') : null
    };
})()`;

const measure = (label) => evalp(MEASURE).then(m => ({ label, ...m }));
const setRot = async (deg) => { await evalp(`(() => { window.__canvas.setViewRotation(${deg}); return 1; })()`); await sleep(400); };

const states = [];
await setRot(20);
states.push(await measure('docked @20°'));

await evalp(`(() => { window.__dock._floatPanel('canvas', { left: 420, top: 90, width: 820, height: 640 }); return 1; })()`);
await sleep(1400);
states.push(await measure('floated @20°'));

const resized = await evalp(`(() => {
    const f = document.querySelector('.dock-float-window');
    if (!f) return { error: 'no float window' };
    const before = { w: f.offsetWidth, h: f.offsetHeight };
    f.style.width = '560px'; f.style.height = '460px';
    window.dispatchEvent(new Event('resize'));
    return { before, after: { w: f.offsetWidth, h: f.offsetHeight } };
})()`);
await sleep(1400);
states.push(await measure('floated + resized @20°'));

await evalp(`(() => { window.__dock._unfloatPanel('canvas'); return 1; })()`);
await sleep(1400);
states.push(await measure('unfloated @20°'));

await evalp(`(() => { window.__dock.hidePanel('canvas'); return 1; })()`);
await sleep(900);
await evalp(`(() => { window.__dock.showPanel('canvas'); return 1; })()`);
await sleep(1600);
states.push(await measure('hidden → shown @20°'));

await setRot(45);
states.push(await measure('shown @45°'));

const notNone = (t) => t === 'none';
const checks = [
    { name: 'example project loaded', ok: (loaded?.curves || 0) > 0 },
    ...states.flatMap(s => [
        { name: `${s.label}: sheet box = analytic rotated bbox of the panel (<=1px)`, ok: Math.abs(s.sheetBox.w - s.analytic.w) <= 1 && Math.abs(s.sheetBox.h - s.analytic.h) <= 1 },
        { name: `${s.label}: canvas bitmap covers the whole box (<=1.5px)`, ok: Math.abs(s.user.w - s.sheetBox.w) <= 1.5 && Math.abs(s.user.h - s.sheetBox.h) <= 1.5 && s.canvasEl.w > 0 },
        { name: `${s.label}: panel corners stay inside the sheet rect (no gaps)`, ok: s.worstOvershoot <= 0.05 },
        { name: `${s.label}: sheet carries a pure rotation, chrome stays upright`, ok: s.sheetTransform !== 'none' && notNone(s.stageTransform) && notNone(s.rulerTransform) && notNone(s.seqTransform) && notNone(s.toolbarTransform) }
    ]),
    { name: 'float window actually took the panel', ok: states[1].floated === true },
    { name: 'resizing the float window really changed its size', ok: !!resized?.after && resized.after.w !== resized.before.w && resized.after.h !== resized.before.h },
    { name: 'the sheet box follows the float window size (re-derived)', ok: Math.abs(states[2].sheetBox.w - states[1].sheetBox.w) > 1 },
    { name: 'unfloat returned it to the dock', ok: states[3].floated === false },
    { name: 'float and dock states use different boxes', ok: Math.abs(states[1].sheetBox.w - states[0].sheetBox.w) > 1 },
    { name: 'hide/show kept the rotation', ok: states[4].rotation === 20 },
    { name: 'rotation change while shown re-derives the box', ok: states[5].rotation === 45 && states[5].sheetBox.w > states[4].sheetBox.w },
    { name: 'no console errors / exceptions across dock churn', ok: consoleErrors.length === 0 && pageExceptions.length === 0 }
];

const failed = checks.filter(c => !c.ok);
console.log(JSON.stringify({ tag: 'view-rotation-dock', loaded, resized, states, failed: failed.map(f => f.name) }, null, 2));
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) console.log('failed:', failed.map(f => f.name).join(' | '));
ws.close();
process.exit(failed.length ? 1 : 0);
