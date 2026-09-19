// Object tree <-> sequence consistency.
//
// The object tree walks root groups and skips any flagged `hidden_by_sequence`,
// while the canvas draws the glyphs the sequence text lists. Those two must agree
// after every edit: a glyph the sequence shows is visible in the tree, a glyph it
// does not show is hidden (or has been pruned if it was an empty stub), and no
// glyph is left in the other state. This used to be maintained incrementally — the
// sync diffed against cached id sets and only looked for new root groups when the
// root count changed — so a create+delete in one step, or any bulk tree mutation
// that forgot to invalidate the cache, left the tree listing glyphs that were not
// in the sequence.
//
// The probe drives the real request path (CanvasDispatcher.requestSetSequenceEditorState,
// i.e. what the sequence bar sends) and compares the tree module's own visible-row
// set against the sequence after each step, including through undo.
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync, writeFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('tree_seq_probe.json');
copyFileSync(SRC, TMP);
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();
const APP = process.env.APP_URL || `http://127.0.0.1:${SRV}/index.html?v=tseq-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const dialogs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(m.params && m.params.message);
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
});
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    const ex = r.result?.exceptionDetails;
    if (ex) return { __exc: (ex.exception?.description || ex.text || '').slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null;' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

await evalp(`(() => {
    window.__ts = {
        /** Everything the invariant needs, read straight from the model + tree module. */
        snapshot() {
            const cv = window.__canvas, cm = cv.curve_manager;
            const ss = cm.seqService;
            const seqIds = [];
            for (const t of (ss.sequenceTokens || [])) {
                const gid = t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value;
                if (gid) seqIds.push(gid);
            }
            const seqSet = new Set(seqIds);
            const treeEl = document.querySelector('object-tree');
            const rows = (treeEl && treeEl._collectVisibleTreeRows)
                ? treeEl._collectVisibleTreeRows().filter(r => r.depth === 0).map(r => r.id)
                : null;
            const mismatches = [];
            for (const id of cm.rootChildren) {
                const item = cm.treeItems.get(id);
                if (!item || item.type !== 'group') continue;
                if (!!item.hidden_by_sequence && seqSet.has(id)) mismatches.push(id + ': in sequence but hidden');
                if (!item.hidden_by_sequence && !seqSet.has(id)) mismatches.push(id + ': in tree but not in sequence');
            }
            if (rows) {
                const rowSet = new Set(rows);
                for (const id of seqSet) if (!rowSet.has(id)) mismatches.push(id + ': in sequence but not a tree row');
                for (const id of rows) if (!seqSet.has(id)) mismatches.push(id + ': tree row but not in sequence');
            }
            return {
                sequenceText: ss.sequenceText,
                sequence: seqIds,
                visibleRows: rows,
                rootGroups: [...cm.rootChildren],
                emptyStubs: [...cm.rootChildren].filter((id) => {
                    const it = cm.treeItems.get(id);
                    return it && it.type === 'group' && it.children.length === 0 && !it.is_modified;
                }),
                mismatches
            };
        },
        async setSequence(text) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            const indices = text.split(/\\s+/).filter(Boolean).map((_, i) => i);
            return mod.CanvasDispatcher.requestSetSequenceEditorState(
                { text, activeIndices: indices }, { recordHistory: true }
            );
        },
        async deleteGlyph(gid) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            const cm = window.__canvas.curve_manager;
            const tokens = cm.sequenceTokens || [];
            const keep = [];
            let removed = false;
            for (const t of tokens) {
                const id = t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value;
                if (id === gid) { removed = true; continue; }
                keep.push(t.isChar ? t.value : t.name);
            }
            if (!removed) return false;
            const res = mod.CanvasDispatcher.requestSetSequenceEditorState(
                { text: keep.join(' '), activeIndices: keep.map((_, i) => i) }, { recordHistory: true }
            );
            // requestWithResult envelopes: { payload, options, result }
            return !!(res && (res === true || res.result === true));
        },
        undo() {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
        }
    };
    return true;
})()`);

const check = async (label, name) => {
    const s = await evalp('window.__ts.snapshot()');
    chk(`${label}: tree and sequence agree`, s && !s.__exc && s.mismatches.length === 0,
        s && s.__exc ? JSON.stringify(s) : JSON.stringify({ sequence: s.sequence, rows: s.visibleRows, mismatches: s.mismatches }));
    return s;
};

const checks = [];
const chk = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail });

const setup = await evalp(`(async () => {
    const cv = window.__canvas;
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await new Promise(r => setTimeout(r, 2500));
    return window.__ts.snapshot();
})()`);
chk('after load: tree and sequence agree', !!setup && !setup.__exc && setup.mismatches.length === 0,
    JSON.stringify(setup && (setup.__exc || { sequence: setup.sequence, rows: setup.visibleRows, mismatches: setup.mismatches })));

// Add glyphs the way the sequence bar does, and take some away again.
await evalp(`window.__ts.setSequence('i j k')`);
await new Promise(r => setTimeout(r, 700));
await check('after adding a glyph', 'add');

// Same count, different content: remove one glyph from the sequence while creating
// another. The removed-before count heuristic could not see the new group here.
await evalp(`window.__ts.setSequence('i m')`);
await new Promise(r => setTimeout(r, 700));
await check('after swapping a glyph in the same step', 'swap');

await evalp(`window.__ts.setSequence('i j k m')`);
await new Promise(r => setTimeout(r, 700));
await check('after re-adding', 'readd');

// Remove a glyph entirely (what the sequence bar's delete does).
const removed = await evalp(`(async () => {
    const cm = window.__canvas.curve_manager;
    const gid = cm.getDefaultGroupForChar ? cm.getDefaultGroupForChar('k') : 'k';
    return window.__ts.deleteGlyph(gid);
})()`);
await new Promise(r => setTimeout(r, 700));
chk('delete-glyph request accepted', removed === true, JSON.stringify(removed));
await check('after deleting a glyph', 'delete');

// Undo must restore a consistent pair too (the snapshot restores the whole tree).
for (let i = 0; i < 3; i++) { await evalp('(window.__ts.undo(), true)'); await new Promise(r => setTimeout(r, 800)); }
await check('after undo', 'undo');
for (let i = 0; i < 3; i++) { await evalp('(window.__ts.undo(), true)'); await new Promise(r => setTimeout(r, 800)); }
await check('after undo again', 'undo2');

// An empty glyph the user deliberately created must survive leaving the sequence,
// and both sides must then agree that it is out of the sequence.
await evalp(`window.__ts.setSequence('i j k')`);
await new Promise(r => setTimeout(r, 700));
const created = await evalp(`(async () => {
    const cm = window.__canvas.curve_manager;
    const gid = cm.getDefaultGroupForChar ? cm.getDefaultGroupForChar('k') : 'k';
    const item = cm.treeItems.get(gid);
    if (!item) return 'no-group';
    const mod = await import('/js/app/canvas_dispatcher.js');
    mod.CanvasDispatcher.requestMarkGroupExplicit(gid);
    return { gid, children: item.children.length, is_modified: !!item.is_modified };
})()`);
await new Promise(r => setTimeout(r, 400));
await evalp(`window.__ts.setSequence('i j')`);
await new Promise(r => setTimeout(r, 700));
const afterLeave = await check('after a created glyph leaves the sequence', 'leave');
chk('created glyph survived leaving the sequence', !!afterLeave && !afterLeave.__exc && afterLeave.rootGroups.includes('k'),
    JSON.stringify({ created, roots: afterLeave && afterLeave.rootGroups }));

const failed = checks.filter(c => !c.ok);
writeFileSync(tmpFile('tree_seq_probe.json.out'), JSON.stringify({ checks, dialogs }, null, 2));
console.log(JSON.stringify({ tag: 'tree-sequence-sync', checks: checks.length, failed: failed.length, dialogs }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '   [' + c.detail + ']' : ''}`);
ws.close();
process.exit(failed.length ? 1 : 0);
