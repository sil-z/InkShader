// 复现「序列条的 add glyph 菜单：窗口最大化后菜单消失，再点 add 再也点不出来」。
//
// 关键点：
//  - 必须用 CDP 真实鼠标事件（Input.dispatchMouseEvent），element.dispatchEvent
//    绕过命中测试，会把 bug 藏起来；
//  - 序列必须短，否则 add 按钮本身就被排到序列条外面（示例工程的长序列就是
//    这种情况），那样测的是另一回事；
//  - 每次都要同时记录画布 offset / 序列条矩形 / 所有 add 按钮矩形，才能看出
//    按钮到底是被移走了、被裁掉了，还是点击被别的东西吃掉。
const WebSocket = (await import('ws')).default;
import { readFileSync, writeFileSync } from 'fs';
import { exampleProject, tmpFile } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=menu-${Date.now()}`;
const EXAMPLE = exampleProject();
const OUT = process.env.PROBE_OUT || tmpFile('probe_addmenu.json');
const jsonText = readFileSync(EXAMPLE, 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        logs.push((m.params.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 600) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(320);
};

await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(7000);

// 载入示例工程（只读）拿到有内容的字形菜单，然后把序列缩到一个字形，
// 保证 add 按钮落在序列条内部、用户看得见也点得到。
const setup = await evalp(`(async () => {
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await new Promise(r => setTimeout(r, 1500));
    const seqBefore = cm.sequenceText;
    window.__dispatcher.requestSetSequenceEditorState({ text: 'a', activeIndices: [0] }, { recordHistory: true });
    await new Promise(r => setTimeout(r, 600));
    return { seqBefore, seqAfter: cm.sequenceText, offset: cv.offset ? { ...cv.offset } : null, scale: cv.scale };
})()`);

const HELPERS = `
window.__bar = () => document.querySelector('glyph-sequence-bar');
window.__addBtns = () => Array.from(document.querySelectorAll('.seq-bar-add-btn, .seq-bar-ins-btn, .seq-bar-ins-last-btn'));
window.__menus = () => Array.from(document.querySelectorAll('.sequence-add-menu'));
window.__activeMenuOf = () => { const b = window.__bar(); return b ? b._activeMenu : null; };
// 选一个“用户会点”的 add 按钮：中心落在序列条可见矩形内的那个
window.__pickAddBtn = () => {
    const bar = window.__bar();
    if (!bar) return null;
    const br = bar.getBoundingClientRect();
    const btns = window.__addBtns();
    for (const b of btns) {
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= br.left && cx <= br.right && cy >= br.top && cy <= br.bottom) return b;
    }
    return btns[btns.length - 1] || null;
};
window.__dump = (label) => {
    const bar = window.__bar();
    const cv = window.__canvas;
    const menus = window.__menus();
    const topMenu = menus[menus.length - 1];
    const mr = topMenu ? topMenu.getBoundingClientRect() : null;
    const btns = window.__addBtns().map(b => {
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
            cls: String(b.className),
            text: (b.textContent || '').slice(0, 14),
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            hitSelf: !!(hit && b.contains(hit)),
            hitTag: hit ? hit.tagName + '.' + String(hit.className || '').split(' ')[0] : null
        };
    });
    const br = bar ? bar.getBoundingClientRect() : null;
    const cs = bar ? getComputedStyle(bar) : null;
    return {
        label,
        innerW: window.innerWidth, innerH: window.innerHeight,
        canvasOffsetX: cv && cv.offset ? Math.round(cv.offset.x) : null,
        canvasScale: cv ? cv.scale : null,
        barRect: br ? { x: Math.round(br.left), y: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) } : null,
        barOverflowX: cs ? cs.overflowX : null,
        barScrollLeft: bar ? bar.scrollLeft : null,
        barScrollWidth: bar ? bar.scrollWidth : null,
        addButtons: btns,
        menusInDom: menus.length,
        activeMenuSet: !!(bar && bar._activeMenu),
        activeMenuConnected: !!(bar && bar._activeMenu && bar._activeMenu.isConnected),
        menuRect: mr ? { x: Math.round(mr.left), y: Math.round(mr.top), w: Math.round(mr.width), h: Math.round(mr.height) } : null,
        menuVisible: !!(mr && mr.width > 0 && mr.height > 0 && mr.bottom > 0 && mr.top < window.innerHeight && mr.right > 0 && mr.left < window.innerWidth),
        addMenuCalls: window.__addMenuCalls || 0
    };
};
window.__addMenuCalls = 0;
window.__installSpy = () => {
    const bar = window.__bar();
    if (!bar || bar.__spied) return false;
    bar.__spied = true;
    const orig = bar._addMenu.bind(bar);
    bar._addMenu = function (...args) { window.__addMenuCalls++; window.__lastArgs = args.slice(0, 3); return orig(...args); };
    return true;
};
true;
`;
await evalp(HELPERS);
await evalp(`window.__installSpy()`);

const steps = [];
const step = async (label, note = null) => {
    const d = await evalp(`window.__dump(${JSON.stringify(label)})`);
    if (note) d.note = note;
    steps.push(d);
    return d;
};
const clickAddBtn = async (note) => {
    const c = await evalp(`(() => { const b = window.__pickAddBtn(); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, cls: String(b.className) }; })()`);
    if (!c) return null;
    await clickAt(c.x, c.y);
    return { ...c, note };
};

await step('boot');

const first = await clickAddBtn('first click');
await step('after-first-click', JSON.stringify(first));

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await step('after-maximize');

const second = await clickAddBtn('second click');
await step('after-second-click', JSON.stringify(second));

const third = await clickAddBtn('third click');
await step('after-third-click', JSON.stringify(third));

await clickAt(700, 600); // 画布别处（用户说这样能恢复）
await step('after-canvas-click');
const fourth = await clickAddBtn('post-canvas click');
await step('after-click-post-canvas', JSON.stringify(fourth));

const out = { tag: 'add-glyph-menu', setup, steps, consoleMessages: logs.slice(0, 8) };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
    tag: 'add-glyph-menu', wroteTo: OUT, setup,
    summaries: steps.map(s => ({
        label: s.label, note: s.note || null,
        inner: `${s.innerW}x${s.innerH}`, offsetX: s.canvasOffsetX, scale: s.canvasScale,
        bar: s.barRect, barScroll: `${s.barScrollLeft}/${s.barScrollWidth}`,
        addButtons: s.addButtons.length,
        hittableAdd: s.addButtons.filter(b => b.hitSelf).length,
        firstAddBtn: s.addButtons[0] || null,
        menus: s.menusInDom, activeMenuSet: s.activeMenuSet, menuVisible: s.menuVisible, calls: s.addMenuCalls
    }))
}, null, 2));
ws.close();
process.exit(0);
