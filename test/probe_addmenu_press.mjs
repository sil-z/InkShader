// 已定位到“真实点击不产生 click 事件”（trace 里只有 mousedown）。这里验证
// 机制：按下(add 按钮) → 松开 之间，按钮是否被 _render() 从 DOM 中摘掉。
// 浏览器只在 mousedown/mouseup 目标有共同祖先时才合成 click；按下时命中的节点
// 若在松开前已被移除，click 事件根本不会产生 —— 按钮的监听器自然永不执行。
//
// 手法：按下与松开之间插一次求值，读取按钮是否仍 connected、_render 调用计数与
// 触发栈。
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=menupress-${Date.now()}`;
const EXAMPLE = exampleProject();
const jsonText = readFileSync(EXAMPLE, 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(7000);
await evalp(`(async () => { await window.__canvas.curve_manager.loadFromJSON(${JSON.stringify(jsonText)}); await new Promise(r=>setTimeout(r,1500)); })()`);

await evalp(`
window.__bar = () => document.querySelector('glyph-sequence-bar');
window.__addBtns = () => Array.from(document.querySelectorAll('.seq-bar-add-btn, .seq-bar-ins-btn, .seq-bar-ins-last-btn'));
window.__pickAddBtn = () => {
    const bar = window.__bar(); if (!bar) return null;
    const br = bar.getBoundingClientRect();
    for (const b of window.__addBtns()) {
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= br.left && cx <= br.right && cy >= br.top && cy <= br.bottom) return b;
    }
    return window.__addBtns()[window.__addBtns().length - 1] || null;
};
window.__renders = [];
window.__clickSeen = [];
window.__install = () => {
    const bar = window.__bar();
    if (!bar || bar.__renderSpied) return false;
    bar.__renderSpied = true;
    const orig = bar._render.bind(bar);
    bar._render = function (...a) {
        const st = new Error().stack.split('\\n').slice(1, 5).map(s => s.trim()).join(' | ');
        window.__renders.push({ at: performance.now(), stack: st });
        return orig(...a);
    };
    document.addEventListener('click', (e) => {
        window.__clickSeen.push({ at: performance.now(), target: e.target ? e.target.tagName + '.' + String(e.target.className || '').split(' ')[0] : null });
    }, true);
    return true;
};
true;
`);
await evalp(`window.__install()`);

const pressAt = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
const releaseAt = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

const out = {};

async function pressReleaseProbe(label) {
    const p = await evalp(`(() => {
        const b = window.__pickAddBtn();
        window.__btn = b;
        const r = b.getBoundingClientRect();
        window.__p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        window.__renders = [];
        window.__clickSeen = [];
        return { x: window.__p.x, y: window.__p.y, cls: String(b.className) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
    await pressAt(p.x, p.y);
    const during = await evalp(`(() => {
        const hit = document.elementFromPoint(window.__p.x, window.__p.y);
        return {
            btnStillConnected: !!(window.__btn && window.__btn.isConnected),
            btnParent: window.__btn && window.__btn.parentNode ? String(window.__btn.parentNode.className) : null,
            hitNow: hit ? hit.tagName + '.' + String(hit.className || '').split(' ')[0] : null,
            hitIsOurBtn: !!(window.__btn && hit && window.__btn.contains(hit)),
            rendersDuringPress: window.__renders.length,
            renderStacks: window.__renders.slice(0, 3),
            clicksDuringPress: window.__clickSeen.length
        };
    })()`);
    await releaseAt(p.x, p.y);
    await sleep(300);
    const after = await evalp(`({
        clickEventsSeen: window.__clickSeen.length,
        clickTargets: window.__clickSeen.map(c => c.target),
        menus: document.querySelectorAll('.sequence-add-menu').length,
        activeMenuSet: !!window.__bar()._activeMenu,
        rendersAfterPressBeforeRelease: window.__renders.length,
        renderStacksAll: window.__renders.slice(0, 4)
    })`);
    out[label] = { picked: p, during, after };
}

await pressReleaseProbe('beforeMaximize');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await pressReleaseProbe('afterMaximize');

console.log(JSON.stringify({ tag: 'add-glyph-menu-press', ...out }, null, 2));
ws.close();
process.exit(0);
