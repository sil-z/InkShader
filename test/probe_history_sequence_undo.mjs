// 端到端回归（用户报的场景）：从序列移除一个字形 -> 添加另一个字形 -> 再做几步
// 操作 -> 连按撤回。撤回不得报 "Runtime patch failed at editor_root_order"，
// 也不得触发 history recovery（入口被丢弃）。
//
// 判据：整个过程不出现错误对话框、__inkErrorLog 里没有 history_recovery 记录、
// 序列文本按撤回次数回到预期的中间状态、树根顺序与快照一致。
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=histseq-${Date.now()}`;
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
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(7000);

const R = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const D = await import('/js/app/canvas_dispatcher.js');
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    const out = { steps: [] };
    const dialogs = () => document.querySelectorAll('.ink-error-overlay').length;
    const seqNow = () => cv.curve_manager.sequenceText;
    const rootOrder = () => JSON.stringify(cv.curve_manager.rootChildren);
    const snapshotOrder = () => JSON.stringify(cv.currentStateObj?.snapshotObj?.editor_root_order || null);
    const push = (label) => out.steps.push({
        label,
        seq: seqNow(),
        dialogs: dialogs(),
        historyErrors: (window.__inkErrorLog || []).filter(e => String(e.scope).startsWith('history')).length,
        commandStack: (cv.commandStack || []).length,
        rootOrderMatchesSnapshot: rootOrder() === snapshotOrder()
    });

    out.initialSeq = seqNow();
    push('initial');
    out.dialogsBefore = dialogs();

    const parse = (t) => {
        // 复用应用自己的解析
        const M = window.__canvas.editorStore ? null : null;
        return t;
    };
    const setSeq = async (text, label) => {
        // 用与序列条相同的命令路径改序列
        const gid = cv.curve_manager.getGroupByName ? null : null;
        D.CanvasDispatcher.requestSetSequenceEditorState({ text, activeIndices: [0] }, { recordHistory: true });
        await sleep(500);
        push(label);
    };

    const seq0 = seqNow();
    const tokens = [];
    {
        // 粗略按字形名/字符切分，够本回归用
        const re = /\\\\[^\\\\]+\\\\|./g;
        let m;
        while ((m = re.exec(seq0)) !== null) tokens.push(m[0]);
    }
    out.tokens = tokens;

    // 1) 移除一个字形（第 2 个 token）
    const removed = tokens.splice(1, 1)[0];
    out.removedToken = removed;
    await setSeq(tokens.join(''), 'after-remove');

    // 2) 添加另一个字形（追加一个已有字符字形）
    const groups = (await import('/js/app/editor_read_facade.js')).listSequenceMenuGroups()
        .filter(g => typeof g.charCode === 'string' && g.charCode.length === 1);
    const added = groups.length ? groups[0].charCode : 'a';
    out.addedToken = added;
    tokens.push(added);
    await setSeq(tokens.join(''), 'after-add');

    // 3) 再做一步（把最后一个 token 移走）
    const last = tokens.pop();
    await setSeq(tokens.join(''), 'after-second-remove');

    // 4) 连按撤回
    for (let i = 0; i < 4; i++) {
        D.CanvasDispatcher.requestUndo();
        await sleep(600);
        push('undo-' + (i + 1));
    }

    out.finalSeq = seqNow();
    out.dialogsAfter = dialogs();
    out.historyErrorsAfter = (window.__inkErrorLog || []).filter(e => String(e.scope).startsWith('history')).length;
    out.historyErrorScopes = (window.__inkErrorLog || []).filter(e => String(e.scope).startsWith('history')).map(e => e.scope + ': ' + e.message);
    out.returnedToInitial = seqNow() === seq0;
    return out;
})()`);

console.log(JSON.stringify({ tag: 'history-sequence-undo', R }, null, 2));
ws.close();
process.exit(0);
