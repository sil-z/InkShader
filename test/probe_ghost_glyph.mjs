// Glyph-panel click semantics and tree/sequence agreement, end to end (HTTP cache
// disabled, otherwise the page runs stale JS):
//
//   1) Clicking a glyph in the glyph panel means "browse to this glyph": the
//      sequence is replaced by that one glyph, never appended to. An appended
//      token is a glyph the user did not ask for, and it gets written to the file.
//   2) An empty glyph created through the panel's Add form must still exist after
//      switching to another glyph (it must not be pruned).
//
// Both are checked together with the stronger invariant from probe_tree_sequence_sync:
// after each step the object tree's visible root rows must be exactly the sequence.
// Tree visibility is derived from the sequence in SequenceService.syncTreeWithSequence,
// so a mismatch here means some path mutated the tree without re-deriving it.
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
    const cm = cv.curve_manager;
    const out = {};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const panel = document.querySelector('glyph-popup');
    if (!panel) return { error: 'no-glyph-popup' };
    if (panel.dataset.panelHidden) panel.dataset.panelHidden = '';
    out.hasAddForm = !!panel.querySelector('.seq-menu-add-btn');

    /** Group ids the sequence currently lists, in order. */
    const seqIds = () => (cm.sequenceTokens || [])
        .map(t => (t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value))
        .filter(Boolean);
    const seqText = () => cv.editorStore.getState().sequenceText;
    /** Root rows the object tree actually renders. */
    const treeRows = () => {
        const el = document.querySelector('object-tree');
        return (el && el._collectVisibleTreeRows)
            ? el._collectVisibleTreeRows().filter(r => r.depth === 0).map(r => r.id)
            : null;
    };
    /** Every way the tree and the sequence can disagree: rows, and the flag itself. */
    const disagreements = () => {
        const want = new Set(seqIds());
        const rows = treeRows() || [];
        const rowSet = new Set(rows);
        const bad = [];
        for (const id of want) if (!rowSet.has(id)) bad.push(id + ': in sequence but not a tree row');
        for (const id of rows) if (!want.has(id)) bad.push(id + ': tree row but not in sequence');
        for (const id of cm.rootChildren) {
            const it = cm.treeItems.get(id);
            if (!it || it.type !== 'group') continue;
            if (it.hidden_by_sequence && want.has(id)) bad.push(id + ': flagged hidden but in sequence');
            if (!it.hidden_by_sequence && !want.has(id)) bad.push(id + ': visible flag but out of sequence');
        }
        return bad;
    };
    const snap = () => ({ text: seqText(), ids: seqIds(), rows: treeRows(), bad: disagreements() });

    const hasGroup = (id) => cm.treeItems.has(id);
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

    // Two glyphs in the sequence to start from.
    await addGlyph('', 'A');
    await addGlyph('', 'B');
    out.afterTwoAdds = snap();

    // 1) Clicking a glyph that is not in the sequence browses to it — replace, never append.
    out.clickX = await clickChar('X');
    out.afterClickX = snap();

    // 2) An empty glyph from the Add form must survive leaving the sequence.
    await addGlyph('probe_ghost_glyph', '');
    out.afterNamedAdd = snap();
    out.namedGroupExistsAfterAdd = hasGroup('probe_ghost_glyph');
    out.clickY = await clickChar('Y');
    out.afterClickY = snap();
    out.namedGroupStillExists = hasGroup('probe_ghost_glyph');

    // Clean up without recording history.
    try {
        for (const id of ['probe_ghost_glyph', 'A', 'B', 'X', 'Y']) {
            const it = cm.treeItems.get(id);
            if (it && it.children.length === 0 && !it.is_modified) {
                cv.commands.deleteTreeItems ? cv.commands.deleteTreeItems([id]) : null;
            }
        }
    } catch (e) { out.cleanupErr = String(e).slice(0, 120); }
    return out;
})()`);

const checks = [];
const chk = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const show = (s) => JSON.stringify(s && (s.__exc || { text: s.text, rows: s.rows, bad: s.bad }));
const rowsAre = (s, ids) => !!s && !s.__exc && s.rows && s.rows.length === ids.length && ids.every(id => s.rows.includes(id));

chk('page booted with the glyph panel', !!R && !R.__exc && R.hasAddForm === true, JSON.stringify(R && (R.__exc || R.error || { hasAddForm: R.hasAddForm })));

// The probe shares its origin with the other probes, so the startup sequence is not
// empty; only the two glyphs this case adds are asserted.
chk('two glyphs added through the panel reach the sequence',
    !!R.afterTwoAdds && R.afterTwoAdds.ids.includes('A') && R.afterTwoAdds.ids.includes('B'),
    show(R.afterTwoAdds));
chk('after adding: tree rows are exactly the sequence',
    R.afterTwoAdds && R.afterTwoAdds.bad.length === 0, show(R.afterTwoAdds));

chk('clicking a glyph browses to it (sequence replaced, not appended)',
    R.clickX === 'clicked' && rowsAre(R.afterClickX, ['X']), show(R.afterClickX));
chk('after browsing: no token left behind from the previous sequence',
    R.afterClickX && !R.afterClickX.ids.includes('A') && !R.afterClickX.ids.includes('B'), show(R.afterClickX));
chk('after browsing: tree rows are exactly the sequence',
    R.afterClickX && R.afterClickX.bad.length === 0, show(R.afterClickX));

chk('a glyph created by the Add form exists right after creation',
    R.namedGroupExistsAfterAdd === true, JSON.stringify({ exists: R.namedGroupExistsAfterAdd, seq: R.afterNamedAdd && R.afterNamedAdd.text }));
chk('after creating: tree rows are exactly the sequence',
    R.afterNamedAdd && R.afterNamedAdd.bad.length === 0, show(R.afterNamedAdd));

chk('a created glyph survives leaving the sequence',
    R.namedGroupStillExists === true, JSON.stringify({ exists: R.namedGroupStillExists, seq: R.afterClickY && R.afterClickY.text }));
chk('after leaving: the created glyph is not a tree row (it is out of the sequence)',
    R.afterClickY && R.afterClickY.rows && !R.afterClickY.rows.includes('probe_ghost_glyph'), show(R.afterClickY));
chk('after leaving: tree rows are exactly the sequence',
    R.afterClickY && R.afterClickY.bad.length === 0, show(R.afterClickY));

const exceptions = logs.filter(l => l.startsWith('EXC'));
chk('no uncaught exception during the run', exceptions.length === 0, exceptions.join(' | '));

const failed = checks.filter(c => !c.ok);
console.log(JSON.stringify({ tag: 'ghost-glyph', checks: checks.length, failed: failed.length }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? '   [' + c.detail + ']' : ''}`);
console.log('\n--- raw ---');
console.log(JSON.stringify({ R, warnings: logs.slice(0, 8) }, null, 2));
ws.close(); process.exit(failed.length ? 1 : 0);
