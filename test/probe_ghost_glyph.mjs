// 端到端验证 glyph 面板点击语义（必须禁用 HTTP 缓存，否则页面跑旧 JS）：
//  1) 在 glyph 面板中点击一个字形 = 「浏览到该字形」：序列被替换成这一个字形，
//     绝不能在序列末尾追加（追加出来的就是用户没要的幽灵字形，且会写进项目文件）。
//  2) 用面板 Add 表单刚建的空字形，在随后切换字形后必须仍然存在（不能被剪枝删除）。
const WebSocket = (await import('ws')).default;
import { probePorts } from './probe_env.mjs';
const { port: PORT, srv: SRV } = probePorts();
const APP = `http://127.0.0.1:${SRV}/index.html?v=ghost-${Date.now()}`;
const all = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of all.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = all[all.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        logs.push((m.params.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const R = await evalp(`(async () => {
    const cv = window.__canvas;
    const out = {};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const panel = document.querySelector('glyph-popup');
    if (!panel) return { error: 'no-glyph-popup' };
    if (panel.dataset.panelHidden) panel.dataset.panelHidden = '';
    out.hasAddForm = !!panel.querySelector('.seq-menu-add-btn');

    const seq = () => cv.editorStore.getState().sequenceText;
    const hasGroup = (id) => {
        const t = cv.curve_manager.treeItems;
        return t ? (t.has ? t.has(id) : !!t[id]) : null;
    };
    const addGlyph = async (name, code) => {
        const inputs = panel.querySelectorAll('.seq-menu-input');
        inputs[0].value = name || '';
        inputs[1].value = code || '';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        panel.querySelector('.seq-menu-add-btn').click();
        await sleep(700);
    };
    const clickChar = async (ch) => {
        const item = [...panel.querySelectorAll('.seq-menu-char-item')]
            .find(el => el.querySelector('.seq-menu-char-name')?.textContent === ch
                     || el.querySelector('.seq-menu-char-name')?.textContent === ch.toUpperCase());
        if (!item) return 'no-grid-item';
        item.click();
        await sleep(700);
        return 'clicked';
    };

    // 先造一段多字形序列：A、B 两个字形
    await addGlyph('', 'A');
    await addGlyph('', 'B');
    out.seqAfterTwoAdds = seq();

    // 1) 点击不在序列中的字形 X —— 必须是「替换」，不能追加
    out.clickX = await clickChar('X');
    out.seqAfterClickX = seq();
    out.noGhostTokenAppended = !out.seqAfterClickX.includes('A') && !out.seqAfterClickX.includes('B');
    out.seqIsSingleX = out.seqAfterClickX.replace(/\\s+/g, '') === 'X';

    // 2) 面板 Add 建一个空字形，再切换到别的字形：新建的字形必须还在（不被剪枝）
    await addGlyph('probe_ghost_glyph', '');
    out.seqAfterNamedAdd = seq();
    out.namedGroupExistsAfterAdd = hasGroup('probe_ghost_glyph');
    out.clickY = await clickChar('Y');
    out.seqAfterClickY = seq();
    out.noNamedTokenLeft = !out.seqAfterClickY.includes('probe_ghost_glyph');
    out.namedGroupStillExists = hasGroup('probe_ghost_glyph');

    // 清理（不写历史）
    try {
        const ids = ['probe_ghost_glyph', 'A', 'B', 'X', 'Y'];
        for (const id of ids) {
            const it = cv.curve_manager.treeItems.get(id);
            if (it && it.children.length === 0 && !it.is_modified) {
                cv.commands.deleteTreeItems ? cv.commands.deleteTreeItems([id]) : null;
            }
        }
    } catch (e) { out.cleanupErr = String(e).slice(0, 120); }
    return out;
})()`);

console.log(JSON.stringify({ tag: 'ghost-glyph', R, errors: logs.slice(0, 12) }, null, 2));
ws.close(); process.exit(0);
