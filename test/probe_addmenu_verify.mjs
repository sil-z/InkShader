// 验证「序列条 add glyph 菜单」修复后的完整状态机（全部用真实鼠标事件）：
//   A) 正常：点 add 打开、再点同一按钮关闭（toggle 语义未被破坏）
//   B) 最大化后：点 add 依然能打开（修复前 click 事件被吃到，永远打不开）
//   C) 挂起的重建会补做，补做后菜单仍在、触发按钮重新绑回等价按钮，
//      于是 C 之后的 toggle 语义仍然成立
//   D) 重建不会变成风暴：一次交互只补建一次
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=menuverify-${Date.now()}`;
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
const realClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
};

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
window.__state = (label) => {
    const bar = window.__bar();
    const trig = window.__pickAddBtn();
    const menus = Array.from(document.querySelectorAll('.sequence-add-menu'));
    const bound = bar ? bar._lastTriggerBtn : null;
    return {
        label,
        menus: menus.length,
        activeMenuSet: !!bar._activeMenu,
        lastTriggerBound: !!bound,
        lastTriggerConnected: !!(bound && bound.isConnected),
        lastTriggerSameAsCurrent: !!(bound && trig && bound === trig),
        lastTriggerKey: bound && bound.dataset ? bound.dataset.seqTriggerKey || null : null,
        triggerKey: trig && trig.dataset ? trig.dataset.seqTriggerKey || null : null,
        // renderCount = 真正重建轨道的次数；renderCalls = _render 被调用的次数
        // （含按下期间被挂起的空转调用，那些不做任何 DOM 工作）。
        renderCount: window.__renders.filter(r => !r.deferred).length,
        renderCalls: window.__renders.length,
        clicks: window.__clicks
    };
};
window.__renders = []; window.__clicks = 0;
(() => {
    const bar = window.__bar();
    const origR = bar._render.bind(bar);
    bar._render = function (...a) {
        window.__renders.push({ deferred: this._pointerDownOnBar === true });
        return origR(...a);
    };
    document.addEventListener('click', () => { window.__clicks++; }, true);
})();
true;
`);

const results = [];
const step = async (label) => { const s = await evalp(`window.__state(${JSON.stringify(label)})`); results.push(s); return s; };
const clickTrigger = async (label) => {
    const p = await evalp(`(() => { const b = window.__pickAddBtn(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await realClick(p.x, p.y);
    return step(label);
};

await step('boot');
await clickTrigger('A1-open');
await clickTrigger('A2-toggle-closed');
await clickTrigger('B0-open-before-max');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await step('B1-after-maximize');
await clickTrigger('B2-open-after-max');
await sleep(700);
await step('C1-after-deferred-flush');
await clickTrigger('C2-toggle-closed-after-flush');
await sleep(300);
await step('D1-settled');

// E) 人为在按下期间制造一次“真正改变签名”的状态事件（选中另一棵树项），
//    验证安全网：按下期间只挂起、不重建；松开后 click 仍能打开菜单；
//    挂起的重建随后补做（渲染计数 +1）且菜单保留。
const eBefore = await evalp(`window.__state('E0-before-press')`);
const ep = await evalp(`(() => { const b = window.__pickAddBtn(); const r = b.getBoundingClientRect(); window.__btn = b; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ep.x, y: ep.y, button: 'none', buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ep.x, y: ep.y, button: 'left', buttons: 1, clickCount: 1 });
const changed = await evalp(`(async () => {
    const D = await import('/js/app/canvas_dispatcher.js');
    const cm = window.__canvas.curve_manager;
    const ids = Array.from(cm.treeItems.values()).filter(i => i.type === 'group' && !i.isRef).map(i => i.id);
    const target = ids[ids.length - 1];
    D.CanvasDispatcher.requestSetTreeSelection([target], target);
    await new Promise(r => setTimeout(r, 250));
    const st = window.__state('E1-during-press-after-state-event');
    st.btnStillConnected = !!(window.__btn && window.__btn.isConnected);
    return st;
})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ep.x, y: ep.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(450);
const eAfter = await evalp(`window.__state('E2-after-release-and-flush')`);
results.push(changed);
results.push(eAfter);

globalThis.__e = { eBefore, changed, eAfter };

const summary = results.map(r => ({
    label: r.label, menus: r.menus, activeMenuSet: r.activeMenuSet,
    bound: r.lastTriggerBound, boundSame: r.lastTriggerSameAsCurrent,
    boundKey: r.lastTriggerKey, trigKey: r.triggerKey,
    renders: r.renderCount, renderCalls: r.renderCalls, clicks: r.clicks
}));
const checks = [
    { name: 'A1 open', ok: results[1].menus === 2 && results[1].activeMenuSet === true && results[1].clicks === 1 },
    { name: 'A2 toggle closes', ok: results[2].menus === 1 && results[2].activeMenuSet === false },
    { name: 'B1 maximize closes menu (by design)', ok: results[4].menus === 1 && results[4].activeMenuSet === false },
    { name: 'B2 click after maximize opens menu', ok: results[5].menus === 2 && results[5].activeMenuSet === true && results[5].clicks === 4 },
    { name: 'C1 menu survives deferred flush', ok: results[6].menus === 2 && results[6].activeMenuSet === true },
    { name: 'C1 trigger rebound to equivalent button', ok: results[6].lastTriggerBound === true && results[6].lastTriggerConnected === true && results[6].lastTriggerSameAsCurrent === true },
    { name: 'C2 toggle still closes after flush', ok: results[7].menus === 1 && results[7].activeMenuSet === false },
    { name: 'D1 no render storm (<=6 renders total)', ok: results[8].renderCount <= 6 },
    { name: 'E1 press-time state event does not rebuild while pressed', ok: changed.btnStillConnected === true && changed.renderCount === eBefore.renderCount },
    { name: 'E1 the skipped render was actually requested (deferred call)', ok: changed.renderCalls === eBefore.renderCalls + 1 },
    { name: 'E2 release: click opens menu (safety net keeps button alive)', ok: eAfter.activeMenuSet === true },
    { name: 'E2 deferred rebuild flushed after the click (real rebuild +1)', ok: eAfter.renderCount === eBefore.renderCount + 1 },
    { name: 'E2 menu kept after flush', ok: eAfter.menus === 2 && eAfter.lastTriggerBound === true }
];
console.log(JSON.stringify({ tag: 'add-glyph-menu-verify', summary, checks, failed: checks.filter(c => !c.ok).length }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
