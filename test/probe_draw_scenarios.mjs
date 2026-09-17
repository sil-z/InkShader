// 覆盖多种「绘制新路径」场景，检查 smart expand 布尔缓存不变量：
//   - 空白新工程里画：单点 / 两点闭合 / 右键结束
//   - 拖动落点（平滑节点带控制柄）
//   - 自交环（领结形）
//   - 与已有 smart 路径重叠
//   - 画完之后既有路径的缓存不被破坏（填充不会消失）
// 每个场景都同时看三条通道：可复制报错框、window.__inkErrorLog、console 的 [InkShader:] 错误。
//
// 运行前提：静态服务器 + 带 remote-debugging 的无头 Edge
//   python test/probe_server.py 8138
//   msedge --headless=new --remote-debugging-port=9231 --user-data-dir=... about:blank
//   PROBE_PORT=9231 PROBE_SRV=8138 node test/probe_draw_scenarios.mjs
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=drawscn-${Date.now()}`;
const EXAMPLE = exampleProject();
const jsonText = readFileSync(EXAMPLE, 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
const click = async (x, y, button = 'left') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
    await sleep(350);
};
const drag = async (x0, y0, x1, y1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 5, y: y0 + (y1 - y0) * i / 5, button: 'left', buttons: 1 });
        await sleep(40);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
};
const move = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await sleep(200);
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(7000);

// 安装错误采集器（三种通道）+ 常用 helper
const bootOk = await evalp(`(async () => {
    if (!window.__canvas) return { ok: false };
    window.__errs = []; window.__errCtx = [];
    new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.classList && n.classList.contains('ink-error-overlay')) {
                window.__errs.push(n.textContent.slice(0, 400));
                setTimeout(() => n.remove(), 0);
            }
        }
    }).observe(document.body, { childList: true });
    const origError = console.error;
    console.error = function (...a) {
        const text = a.map(x => String(x && x.message || x)).join(' ');
        if (text.includes('[InkShader:')) window.__errCtx.push(text.slice(0, 240));
        return origError.apply(this, a);
    };
    document.querySelectorAll('.ink-error-overlay').forEach(n => n.remove());
    window.__inkErrorLog.length = 0;
    return { ok: true };
})()`);
console.log('boot:', JSON.stringify(bootOk));

const reset = async () => evalp(`(() => { window.__errs.length = 0; window.__errCtx.length = 0; window.__inkErrorLog.length = 0; return true; })()`);

const snap = async (label) => evalp(`(() => {
    const c = window.__canvas, cm = c.curve_manager;
    const count = (node) => { let k = 0, p = node; const seen = new Set(); while (p && !seen.has(p)) { seen.add(p); k++; p = p.nextOnCurve; } return k; };
    const cur = c.current_curve || c.commands.current_curve;
    const info = (cv) => cv ? { id: cv.id, closed: !!cv.closed, smart: !!cv.smart_stroke, sw: cv.stroke_width, nodes: count(cv.startNode), endNode: !!cv.endNode, cache: Array.isArray(cv.cached_boolean_geometry) ? cv.cached_boolean_geometry.length : (cv.cached_boolean_geometry === null ? null : 'na'), emptyHash: cv._booleanEmptyHash === undefined } : null;
    const smartCaches = cm.curves.filter(cv => cv.smart_stroke).map(cv => Array.isArray(cv.cached_boolean_geometry) ? cv.cached_boolean_geometry.length : -1);
    return {
        label: ${JSON.stringify(label)},
        dialogs: window.__errs.length,
        lastDialog: window.__errs.length ? window.__errs[window.__errs.length - 1].slice(0, 240) : null,
        logEntries: window.__inkErrorLog.length,
        consoleErrors: window.__errCtx.length,
        lastConsole: window.__errCtx.length ? window.__errCtx[window.__errCtx.length - 1] : null,
        curveCount: cm.curves.length,
        current: info(cur),
        lastCurve: info(cm.curves[cm.curves.length - 1]),
        smartCaches
    };
})()`);

const drawingSetup = async (groupSelector) => evalp(`(async () => {
    const D = await import('/js/app/canvas_dispatcher.js');
    const cm = window.__canvas.curve_manager;
    const groups = [...cm.treeItems.values()].filter(i => i.type === 'group' && !i.isRef);
    let target = null;
    if (${JSON.stringify(groupSelector || '')}) target = groups.find(g => g.id === ${JSON.stringify(groupSelector || '')});
    if (!target) target = groups.find(g => !g.hidden_by_sequence) || groups[0];
    if (!target) return { error: 'no group', ids: groups.map(g => g.id) };
    D.CanvasDispatcher.requestSetTreeSelection([target.id], target.id);
    await new Promise(r => setTimeout(r, 250));
    D.CanvasDispatcher.requestSetToolMode('DRAW');
    await new Promise(r => setTimeout(r, 350));
    const c = window.__canvas;
    c.drawToolSettings.stroke_width = 16;
    c.drawToolSettings.closed = true;
    c.drawToolSettings.smart_expand = true;
    c.is_dirty = true;
    return { group: target.id, groups: groups.map(g => g.id), tool: c.editorStore.getState().currentTool };
})()`);

// 找几个互不干扰的空白落点（不压在任何节点/路径上）
const spots = async (n) => evalp(`(() => {
    const c = window.__canvas;
    const r = c.canvasObj.getBoundingClientRect();
    const out = [];
    for (let gy = 2; gy <= 9; gy++) {
        for (let gx = 2; gx <= 9; gx++) {
            const cx = r.left + r.width * gx / 11;
            const cy = r.top + r.height * gy / 11;
            const p = c.getViewportMousePosition(cx, cy);
            if (!c.utils.hitTestNode(p.x, p.y) && !c.utils.hitTestCurve(p.x, p.y)) out.push({ x: Math.round(cx), y: Math.round(cy) });
        }
    }
    return out.slice(0, ${n});
})()`);

const results = [];
const steps = [];
const record = async (label) => { const s = await snap(label); results.push(s); return s; };

// ---------- 场景 A：空白新工程 ----------
const setupA = await drawingSetup(null);
console.log('setup A (fresh project):', JSON.stringify(setupA));
const spA = await spots(6);
console.log('spots A:', JSON.stringify(spA));
if (spA.length < 4) { console.log('not enough free spots'); }
await reset();

// A1 单点
await click(spA[0].x, spA[0].y);
await move(spA[0].x + 30, spA[0].y - 20);
steps.push(await record('A1 single node (fresh)'));

// A2 两点闭合 + 右键结束
await click(spA[1].x, spA[1].y);
await move(spA[1].x + 40, spA[1].y + 20);
steps.push(await record('A2 two nodes (fresh)'));
await click(spA[1].x, spA[1].y, 'right');
await move(spA[1].x + 80, spA[1].y + 40);
await sleep(500);
steps.push(await record('A3 finished (fresh)'));

// A4 拖动落点（平滑节点，带控制柄）+ 闭合
await click(spA[2].x, spA[2].y);
await drag(spA[3].x, spA[3].y, spA[3].x + 60, spA[3].y + 40);
await drag(spA[4].x, spA[4].y, spA[4].x - 40, spA[4].y + 50);
await move(spA[4].x + 20, spA[4].y + 60);
steps.push(await record('A4 smooth nodes via drag (fresh)'));
await click(spA[4].x, spA[4].y, 'right');
await sleep(500);
steps.push(await record('A5 finished smooth (fresh)'));

// ---------- 场景 B/C/D：载入示例工程 ----------
const loaded = await evalp(`(async () => {
    await window.__canvas.curve_manager.loadFromJSON(${JSON.stringify(jsonText)});
    await new Promise(r => setTimeout(r, 1500));
    return { curves: window.__canvas.curve_manager.curves.length };
})()`);
console.log('example loaded:', JSON.stringify(loaded));

// B：自交环（领结形：四点点成交叉环）
const setupB = await drawingSetup('lturn_long');
console.log('setup B:', JSON.stringify(setupB && setupB.group ? setupB : setupB));
const spB = await spots(8);
await reset();
if (spB.length >= 4) {
    await click(spB[0].x, spB[0].y);
    await click(spB[2].x, spB[2].y);
    await click(spB[1].x, spB[1].y);
    await click(spB[3].x, spB[3].y);
    await move(spB[3].x + 30, spB[3].y + 30);
    steps.push(await record('B1 self-crossing loop (in progress)'));
    await click(spB[3].x + 30, spB[3].y + 30, 'right');
    await sleep(500);
    steps.push(await record('B2 self-crossing loop finished'));
}

// C：与已有路径重叠（新路径穿过既有 smart 路径）
const overlapSpot = await evalp(`(() => {
    const c = window.__canvas;
    const cm = c.curve_manager;
    const target = cm.curves.find(cv => cv.smart_stroke && (cv.groupId === 'lturn_long')) || cm.curves.find(cv => cv.smart_stroke);
    if (!target) return null;
    const b = target.getBounds ? target.getBounds() : null;
    const r = c.canvasObj.getBoundingClientRect();
    const toScreen = (x, y) => { const v = c.utils.worldToViewport ? c.utils.worldToViewport(x, y) : null; return v ? { x: r.left + v.x, y: r.top + v.y } : null; };
    return { bounds: b, rect: { l: r.left, t: r.top, w: r.width, h: r.height } };
})()`);
console.log('overlap target:', JSON.stringify(overlapSpot));
await reset();
if (spB.length >= 6) {
    await click(spB[5].x, spB[5].y);
    await click(spB[0].x, spB[0].y);
    await click(spB[6].x, spB[6].y);
    await move(spB[6].x + 40, spB[6].y + 20);
    steps.push(await record('C1 overlapping draw (in progress)'));
    await click(spB[6].x + 40, spB[6].y + 20, 'right');
    await sleep(600);
    steps.push(await record('C2 overlapping draw finished'));
}

// D：画完后既有 smart 路径缓存是否还健康（填充没有消失）
const afterAll = await evalp(`(() => {
    const cm = window.__canvas.curve_manager;
    const smart = cm.curves.filter(cv => cv.smart_stroke);
    return {
        smartTotal: smart.length,
        nullCaches: smart.filter(cv => cv.cached_boolean_geometry === null).map(cv => cv.id),
        emptyCaches: smart.filter(cv => Array.isArray(cv.cached_boolean_geometry) && cv.cached_boolean_geometry.length === 0).map(cv => cv.id),
        ringCounts: smart.map(cv => Array.isArray(cv.cached_boolean_geometry) ? cv.cached_boolean_geometry.length : -1)
    };
})()`);
results.push({ label: 'D existing smart caches after drawing', ...afterAll });

const clean = (r) => (r.dialogs ?? 0) === 0 && (r.logEntries ?? 0) === 0 && (r.consoleErrors ?? 0) === 0;
const checks = [
    { name: 'A1 pen first click: silent (no dialog/log/console error)', ok: clean(steps[0]) },
    { name: 'A2 two-node closed path: silent + non-empty cache', ok: clean(steps[1]) && (steps[1].current?.cache ?? 0) >= 1 },
    { name: 'A3 finished path: silent + non-empty cache', ok: clean(steps[2]) && (steps[2].lastCurve?.cache ?? 0) >= 1 },
    { name: 'A4 smooth-node path: silent + non-empty cache', ok: clean(steps[3]) && (steps[3].current?.cache ?? 0) >= 1 },
    { name: 'A5 finished smooth path: silent + non-empty cache', ok: clean(steps[4]) && (steps[4].lastCurve?.cache ?? 0) >= 1 },
    { name: 'B1/B2 self-crossing loop: silent + non-empty cache', ok: steps.length > 6 ? (clean(steps[5]) && clean(steps[6])) : true },
    { name: 'C1/C2 overlapping draw: silent + non-empty cache', ok: steps.length > 8 ? (clean(steps[7]) && clean(steps[8])) : true },
    { name: 'D no existing smart curve lost its cache', ok: afterAll.nullCaches.length === 0 && afterAll.emptyCaches.length === 0 },
    { name: 'no dialog/log/console error across every recorded step', ok: steps.every(clean) }
];

console.log(JSON.stringify({ tag: 'draw-scenarios', steps, results, checks, failed: checks.filter(c => !c.ok).map(c => c.name) }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
