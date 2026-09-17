// 复现 alt+滚轮（应“以固定位置为中心缩放”）导致的卡死：
//   - 记录每次滚轮后的 zoomTicks / offset / scale
//   - 抓 console 报错与页面未捕获异常
//   - 在滚轮之后立刻 eval 一个探针，判断主线程是否还在响应（卡死检测）
// 运行：python test/probe_server.py 8140
//       msedge --headless=new --remote-debugging-port=9240 ...
//       PROBE_PORT=9240 PROBE_SRV=8140 node test/probe_alt_wheel.mjs
const WebSocket = (await import('ws')).default;

const PORT = Number(process.env.PROBE_PORT || 9240);
const SRV = Number(process.env.PROBE_SRV || 8140);
const APP = `http://127.0.0.1:${SRV}/index.html?v=altwheel-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
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

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: APP });
await sleep(3500);

// 画布中心点
const geo = await evalp(`(() => {
    const cv = document.querySelector('main-canvas');
    const r = cv.canvasObj.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5, w: r.width, h: r.height };
})()`);

const snap = () => evalp(`(() => { const c = document.querySelector('main-canvas');
    return { ticks: c.zoomTicks, scale: +c.scale.toFixed(6), off: { x: +c.offset.x.toFixed(2), y: +c.offset.y.toFixed(2) } }; })()`);

const wheel = async (deltaY, modifiers) => {
    await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: geo.x, y: geo.y, deltaX: 0, deltaY, modifiers,
        pointerType: 'mouse', button: 'none', buttons: 0
    });
    await sleep(150);
};

const results = { geo, steps: [] };
results.before = await snap();

// --- A: ctrl+wheel（已知正常）作为基线 ---
consoleErrors.length = 0; pageExceptions.length = 0;
await wheel(-120, 2);
results.steps.push({ label: 'A ctrl+wheel up', after: await snap(), consoleErrors: [...consoleErrors], pageExceptions: [...pageExceptions] });

// --- B: alt+wheel（用户报告卡死）---
consoleErrors.length = 0; pageExceptions.length = 0;
const t0 = Date.now();
await wheel(-120, 1);
results.steps.push({ label: 'B alt+wheel up #1', after: await snap(), consoleErrors: [...consoleErrors], pageExceptions: [...pageExceptions] });

// 卡死检测：主线程还能不能执行 JS？5 秒内必须答复
const tEval = Date.now();
let responsive = null;
try {
    responsive = await Promise.race([
        evalp(`1 + 1`),
        sleep(5000).then(() => '__TIMEOUT__')
    ]);
} catch (e) { responsive = '__THROW__ ' + String(e).slice(0, 80); }
results.afterAltFirstTick = { responsive, evalMs: Date.now() - tEval, totalMs: Date.now() - t0 };

consoleErrors.length = 0; pageExceptions.length = 0;
await wheel(-120, 1);
results.steps.push({ label: 'B alt+wheel up #2', after: await snap(), consoleErrors: [...consoleErrors], pageExceptions: [...pageExceptions] });

consoleErrors.length = 0; pageExceptions.length = 0;
await wheel(120, 1);
results.steps.push({ label: 'B alt+wheel down', after: await snap(), consoleErrors: [...consoleErrors], pageExceptions: [...pageExceptions] });

// 再测一次响应性
const tEval2 = Date.now();
let responsive2 = null;
try {
    responsive2 = await Promise.race([evalp(`2 + 2`), sleep(5000).then(() => '__TIMEOUT__')]);
} catch (e) { responsive2 = '__THROW__'; }
results.finalResponsive = { responsive2, evalMs: Date.now() - tEval2 };

console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
