// 视图旋转的持久化验证：alt+方向键旋转后重载页面，旋转角应从保存的视图状态恢复。
const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9240);
const SRV = Number(process.env.PROBE_SRV || 8140);
const APP = `http://127.0.0.1:${SRV}/index.html`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ed = r.result?.exceptionDetails;
    if (ed) return { __exc: (ed.exception?.description || ed.text || '').slice(0, 300) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const key = async (code, keyStr, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyStr, windowsVirtualKeyCode: 0, modifiers, nativeVirtualKeyCode: 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr, windowsVirtualKeyCode: 0, modifiers, nativeVirtualKeyCode: 0 });
    await sleep(200);
};

await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${APP}?v=rotpersist-${Date.now()}` });
await sleep(6000);

// 先归零，保证起始状态确定
await evalp(`(() => { window.__canvas.setViewRotation(0); return 1; })()`);
await sleep(300);
const startRotation = await evalp(`window.__canvas.viewRotation`);

// Alt+Right ×2 → 10°
await key('ArrowRight', 'ArrowRight', 1);
await key('ArrowRight', 'ArrowRight', 1);
const rotated = await evalp(`window.__canvas.viewRotation`);
const stored = await evalp(`(async () => { const mod = await import('/js/services/storage.js').catch(() => null); return null; })()`);

await sleep(500);
await send('Page.navigate', { url: `${APP}?v=rotpersist-${Date.now()}` });
await sleep(6000);
const restored = await evalp(`(() => {
    const c = window.__canvas;
    const el = c.main_canvas_large;
    const b = c.viewportService.getPanelBox();
    return {
        rotation: c.viewRotation,
        sheetTransform: getComputedStyle(el).transform,
        stageTransform: getComputedStyle(document.querySelector('#canvas_stage')).transform,
        userSpace: c.viewportConfig.userSpaceWidth,
        panel: { w: Math.round(b.width), h: Math.round(b.height) },
        sheetBox: { w: el.clientWidth, h: el.clientHeight }
    };
})()`);

console.log(JSON.stringify({ startRotation, rotated, restored, ok: restored.rotation === rotated }, null, 2));
ws.close();
process.exit(restored.rotation === rotated ? 0 : 1);
