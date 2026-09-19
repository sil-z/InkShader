// Tree mutations must leave the object tree and the sequence in agreement.
//
// `hidden_by_sequence` is the only thing that decides whether the object tree lists
// a root glyph, and it is derived in SequenceService.syncTreeWithSequence. This suite
// drives the mutations that create or destroy root groups — duplicate, copy/paste,
// delete, unlink a reference, undo — and asserts after each one that the tree's
// visible root rows are exactly the sequence, and that no root group carries a flag
// contradicting the sequence. A "ghost" row (listed in the tree, not in the sequence)
// is exactly the disagreement the user sees when this drifts.
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync, writeFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('tree_mut_probe.json');
copyFileSync(SRC, TMP);
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();
const APP = process.env.APP_URL || `http://127.0.0.1:${SRV}/index.html?v=tmut-${Date.now()}`;

// Start from a clean tab: a leftover page can hold a pending dialog or a stale app.
for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const dialogs = []; const exceptions = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(m.params && m.params.message);
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') {
        exceptions.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null; window.alert=()=>{};' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 8000));

await evalp(`(() => {
    window.__tm = {
        /** Root rows the tree renders vs the groups the sequence lists. */
        snapshot() {
            const cv = window.__canvas, cm = cv.curve_manager;
            const seq = [];
            for (const t of (cm.sequenceTokens || [])) {
                const gid = t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value;
                if (gid) seq.push(gid);
            }
            const want = new Set(seq);
            const el = document.querySelector('object-tree');
            const rows = (el && el._collectVisibleTreeRows) ? el._collectVisibleTreeRows() : [];
            const rootRows = rows.filter(r => r.depth === 0).map(r => r.id);
            const rowSet = new Set(rootRows);
            const bad = [];
            for (const id of want) if (!rowSet.has(id)) bad.push(id + ': sequence but not a root row');
            for (const id of rootRows) if (!want.has(id)) bad.push(id + ': root row but not in sequence');
            for (const id of cm.rootChildren) {
                const it = cm.treeItems.get(id);
                if (!it || it.type !== 'group') continue;
                if (it.hidden_by_sequence && want.has(id)) bad.push(id + ': hidden flag but in sequence');
                if (!it.hidden_by_sequence && !want.has(id)) bad.push(id + ': visible flag but out of sequence');
            }
            return { text: cv.editorStore.getState().sequenceText, ids: seq, rows: rootRows, allRows: rows.map(r => r.id), bad };
        },
        roots() { return [...window.__canvas.curve_manager.rootChildren]; },
        /** Root groups that are references (what Unlink operates on). */
        rootRefs() {
            const cm = window.__canvas.curve_manager;
            return [...cm.rootChildren].filter(id => { const it = cm.treeItems.get(id); return it && it.isRef; });
        },
        async setSequence(text) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            const indices = text.split(' ').filter(Boolean).map((_, i) => i);
            await mod.CanvasDispatcher.requestSetSequenceEditorState({ text, activeIndices: indices }, { recordHistory: true });
            await new Promise(r => setTimeout(r, 600));
        },
        async duplicate(gid) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            await mod.CanvasDispatcher.requestDuplicateSelectedObjects([gid]);
            await new Promise(r => setTimeout(r, 700));
        },
        async copyPaste(gid) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            await mod.CanvasDispatcher.requestCopySelectedObjects([gid]);
            await new Promise(r => setTimeout(r, 300));
            await mod.CanvasDispatcher.requestPasteCopiedObjects(null);
            await new Promise(r => setTimeout(r, 700));
        },
        async deleteItems(ids) {
            const cv = window.__canvas;
            cv.commands.deleteTreeItems(ids);
            cv.curve_manager.notifyTreeUpdate();
            await new Promise(r => setTimeout(r, 700));
        },
        async unlink(gid) {
            const mod = await import('/js/app/canvas_dispatcher.js');
            await mod.CanvasDispatcher.requestUnlink([gid]);
            await new Promise(r => setTimeout(r, 700));
        },
        async undo(times = 1) {
            for (let i = 0; i < times; i++) {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
                await new Promise(r => setTimeout(r, 800));
            }
        }
    };
    return true;
})()`);

const checks = [];
const chk = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const show = (s) => JSON.stringify(s && (s.__exc || { text: s.text, rows: s.rows, bad: s.bad }));
const agree = (label, s) => chk(`${label}: tree rows and sequence agree`, !!s && !s.__exc && s.bad.length === 0, show(s));

const setup = await evalp(`(async () => {
    const cv = window.__canvas;
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await new Promise(r => setTimeout(r, 2500));
    await window.__tm.setSequence('i j');
    return window.__tm.snapshot();
})()`);
chk('example project loads with the tree and sequence in agreement', !!setup && !setup.__exc && setup.bad.length === 0, show(setup));

const jid = await evalp(`window.__canvas.curve_manager.getDefaultGroupForChar('j')`);
chk('the sequence group for "j" exists', typeof jid === 'string' && jid.length > 0, JSON.stringify(jid));

// 1. Duplicate a root glyph: the copy must land in the sequence and in the tree.
await evalp(`window.__tm.duplicate(${JSON.stringify(await evalp(`window.__canvas.curve_manager.getDefaultGroupForChar('i')`))})`);
const afterDup = await evalp('window.__tm.snapshot()');
agree('after duplicate', afterDup);
chk('after duplicate: the copy is a root row and part of the sequence',
    !!afterDup && !afterDup.__exc && afterDup.rows.length > (setup.rows ? setup.rows.length : 0), show(afterDup));
await evalp('window.__tm.undo()');
agree('after undoing the duplicate', await evalp('window.__tm.snapshot()'));

// 2. Copy + paste a root glyph.
await evalp(`window.__tm.copyPaste(${JSON.stringify(jid)})`);
const afterPaste = await evalp('window.__tm.snapshot()');
agree('after paste', afterPaste);
await evalp('window.__tm.undo()');
agree('after undoing the paste', await evalp('window.__tm.snapshot()'));

// 3. Delete a glyph from the tree.
await evalp(`window.__tm.deleteItems([${JSON.stringify(jid)}])`);
const afterDelete = await evalp('window.__tm.snapshot()');
agree('after deleting a glyph', afterDelete);
chk('after deleting a glyph: it is not a tree row any more',
    !!afterDelete && !afterDelete.__exc && !afterDelete.allRows.includes(jid), show(afterDelete));
await evalp('window.__tm.undo()');
agree('after undoing the delete', await evalp('window.__tm.snapshot()'));

// 4. Unlink a reference: the ref row is replaced by real clones, no ghost row left.
const refs = await evalp('window.__tm.rootRefs()');
if (Array.isArray(refs) && refs.length > 0) {
    const before = await evalp('window.__tm.snapshot()');
    const target = refs[0];
    await evalp(`window.__tm.unlink(${JSON.stringify(target)})`);
    const afterUnlink = await evalp('window.__tm.snapshot()');
    agree('after unlinking a reference', afterUnlink);
    chk('after unlinking: the reference row is gone',
        !!afterUnlink && !afterUnlink.__exc && !afterUnlink.allRows.includes(target) &&
        !(await evalp(`window.__canvas.curve_manager.treeItems.has(${JSON.stringify(target)})`)), show(afterUnlink));
    await evalp('window.__tm.undo()');
    agree('after undoing the unlink', await evalp('window.__tm.snapshot()'));
    chk('undoing the unlink restores the reference row',
        JSON.stringify((await evalp('window.__tm.snapshot()')).allRows) === JSON.stringify(before.allRows),
        `before=${JSON.stringify(before.allRows)} after=${JSON.stringify((await evalp('window.__tm.snapshot()')).allRows)}`);
} else {
    // The fixture has no references; the case is skipped rather than silently passed.
    chk('fixture has a reference to unlink (otherwise this case is not covered)', false, JSON.stringify(refs));
}

// 5. Bulk: remove one glyph while adding another in the same step, then undo twice.
await evalp(`window.__tm.setSequence('i k')`);
agree('after a swap in the same step (add k, drop j)', await evalp('window.__tm.snapshot()'));
await evalp(`window.__tm.setSequence('i j k')`);
agree('after re-adding', await evalp('window.__tm.snapshot()'));
await evalp('window.__tm.undo(3)');
agree('after undoing back through the sequence edits', await evalp('window.__tm.snapshot()'));

chk('no uncaught exception during the run', exceptions.length === 0, exceptions.join(' | '));

const failed = checks.filter(c => !c.ok);
writeFileSync(tmpFile('tree_mut_probe.out.json'), JSON.stringify({ checks, dialogs, exceptions }, null, 2));
console.log(JSON.stringify({ tag: 'tree-mutations', checks: checks.length, failed: failed.length, dialogs }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? '   [' + c.detail + ']' : ''}`);
ws.close(); process.exit(failed.length ? 1 : 0);
