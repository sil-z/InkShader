// UPM freeze probe v8: compact SET_FONT_SETTINGS entry — timing breakdown of
// the undo path + corrected sequencing (sleep after undo/redo so the async
// is_restoring reset lands, avoiding the v7 artifacts).
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=freeze-8';

const PROBE = `
(async () => {
    const out = { errors: [], alerts: 0, t: {} };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const origAlert = window.alert;
    window.alert = (...a) => { out.alerts++; return origAlert(...a); };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t0 = performance.now();
    const mark = (k) => { out.t[k] = Math.round(performance.now() - t0); };

    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;
    const resp = await fetch('/test/huge_project.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(800);
    mark('loaded');

    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');

    const spot = () => {
        const cur = cm.curveById.values().next().value;
        if (!cur?.startNode) return null;
        const item = [...cm.treeItems.values()].find(i => i.type === 'curve' && i.curveId === cur.id);
        const glyph = cv.currentStateObj?.snapshotObj?.glyphs?.[cur.groupId];
        let snapNode = null;
        if (glyph?.children) {
            const path = glyph.children.find(c => c.type === 'path' && (c.name === item?.name || c.id === item?.id || c.curveId === item?.name));
            const v = path?.vertices?.[0];
            if (v) snapNode = { x: v.x, y: v.y };
        }
        return { rx: cur.startNode.x, ry: cur.startNode.y, sx: snapNode?.x ?? null, sy: snapNode?.y ?? null };
    };
    const lastEntry = () => cv.commandStack[cv.commandStack.length - 1];

    const base = spot();
    const baseJsonLen = cv.currentStateObj?.json?.length;
    out.base = base;
    out.baseJsonLen = baseJsonLen;
    out.canvasHAtLoad = cv.canvas_size_height;

    // ── A) RECORD: full dispatch + serialize + compact entry ──
    let s = performance.now();
    CanvasDispatcher.requestSetFontSettings({ upm: 2000 }, { recordHistory: true });
    out.recordMs = Math.round(performance.now() - s);
    mark('saved');
    const e1 = lastEntry();
    out.entry1 = {
        commandName: e1?.commandName,
        fontSettingsEntry: e1?.fontSettingsEntry === true,
        patchCount: e1?.snapshotPatches?.length ?? null,
        entryJsonLen: JSON.stringify(e1).length,
        beforeUpm: e1?.beforeFontSettings?.upm,
        afterUpm: e1?.afterFontSettings?.upm
    };

    // ── B) UNDO piece timing (exact replication of the compact branch) ──
    cv.commandStack.pop();
    cv.redoCommandStack.push(e1);
    s = performance.now();
    cv.commands.setFontSettings(e1.beforeFontSettings || {}, {});
    out.p1_setFontSettingsMs = Math.round(performance.now() - s);
    s = performance.now();
    cv.currentStateObj = cv.history.getHistoryState();
    out.p2_getHistoryStateMs = Math.round(performance.now() - s);
    s = performance.now();
    cv.history._assignCurrentStateMeta(e1.beforeMeta || {});
    out.p3_assignMetaMs = Math.round(performance.now() - s);
    s = performance.now();
    await cv.history._applyState(cv.currentStateObj, e1, 'undo');
    out.p4_applyStateMs = Math.round(performance.now() - s);
    await sleep(200);
    out.afterManualUndo = {
        upm: cv.fontSettings?.upm,
        spot: spot(),
        canvasH: cv.canvas_size_height,
        jsonLen: cv.currentStateObj?.json?.length,
        stackLen: cv.commandStack?.length,
        redoStackLen: cv.redoCommandStack?.length
    };

    // ── C) REDO (real, with sleep) ──
    s = performance.now();
    await cv.editorStore.redo();
    out.redoMs = Math.round(performance.now() - s);
    await sleep(200);
    out.afterRedo = { upm: cv.fontSettings?.upm, spot: spot(), canvasH: cv.canvas_size_height, stackLen: cv.commandStack?.length };

    // ── D) chain: 2000 → 3000 → undo → undo ──
    CanvasDispatcher.requestSetFontSettings({ upm: 3000 }, { recordHistory: true });
    const e2 = lastEntry();
    out.entry2 = { fontSettingsEntry: e2?.fontSettingsEntry === true, beforeUpm: e2?.beforeFontSettings?.upm, afterUpm: e2?.afterFontSettings?.upm, entryJsonLen: JSON.stringify(e2).length };
    s = performance.now();
    await cv.editorStore.undo(); // 3000 → 2000
    out.undo3Ms = Math.round(performance.now() - s);
    await sleep(200);
    out.afterUndo3000 = { upm: cv.fontSettings?.upm, spot: spot(), stackLen: cv.commandStack?.length, redoStackLen: cv.redoCommandStack?.length };
    s = performance.now();
    await cv.editorStore.undo(); // 2000 → 1000
    out.undo1Ms = Math.round(performance.now() - s);
    await sleep(200);
    out.afterUndo2000 = { upm: cv.fontSettings?.upm, spot: spot(), jsonLen: cv.currentStateObj?.json?.length, stackLen: cv.commandStack?.length };

    // ── E) redo chain: 1000 → 2000 → 3000 ──
    await cv.editorStore.redo();
    await sleep(200);
    out.redoChain1 = { upm: cv.fontSettings?.upm, spot: spot() };
    await cv.editorStore.redo();
    await sleep(200);
    out.redoChain2 = { upm: cv.fontSettings?.upm, spot: spot() };

    // ── F) non-UPM font setting (family) + undo + sanitize ──
    const familyBefore = cv.fontSettings?.family;
    CanvasDispatcher.requestSetFontSettings({ family: 'Probe Family' }, { recordHistory: true });
    const ef = lastEntry();
    out.entryFamily = { fontSettingsEntry: ef?.fontSettingsEntry === true, patchCount: ef?.snapshotPatches?.length ?? null, beforeFamily: ef?.beforeFontSettings?.family, afterFamily: ef?.afterFontSettings?.family };
    s = performance.now();
    await cv.editorStore.undo();
    out.familyUndoMs = Math.round(performance.now() - s);
    await sleep(200);
    out.familyAfterUndo = cv.fontSettings?.family;
    out.familyBefore = familyBefore;
    const efs = cv.history._sanitizeCommandEntry(ef);
    out.sanitizeFamily = { kept: efs?.fontSettingsEntry === true, beforeFamily: efs?.beforeFontSettings?.family, afterFamily: efs?.afterFontSettings?.family, patchCount: efs?.snapshotPatches?.length ?? null };
    const e2s = cv.history._sanitizeCommandEntry(e2);
    out.sanitizeUpm = { kept: e2s?.fontSettingsEntry === true, beforeUpm: e2s?.beforeFontSettings?.upm, afterUpm: e2s?.afterFontSettings?.upm, patchCount: e2s?.snapshotPatches?.length ?? null };

    // ── G) baseline integrity: normal geometry command after compact undos ──
    // setGroupAdvance must diff against the restored (unscaled) baseline and
    // undo must restore the exact advance.
    const rootId = cm.rootChildren[0];
    const advBefore = cm.treeItems.get(rootId)?.advance;
    s = performance.now();
    CanvasDispatcher.requestSetGroupAdvance(rootId, advBefore + 55, { recordHistory: true });
    out.advanceSetMs = Math.round(performance.now() - s);
    const ea = lastEntry();
    out.entryAdvance = { commandName: ea?.commandName, fontSettingsEntry: ea?.fontSettingsEntry === true, patchCount: ea?.snapshotPatches?.length ?? null, patchesJsonLen: ea?.snapshotPatches ? JSON.stringify(ea.snapshotPatches).length : null, advanceNow: cm.treeItems.get(rootId)?.advance, advBefore };
    s = performance.now();
    await cv.editorStore.undo();
    out.advanceUndoMs = Math.round(performance.now() - s);
    await sleep(200);
    out.advanceAfterUndo = cm.treeItems.get(rootId)?.advance;
    const eaSnap = cv.currentStateObj?.snapshotObj?.glyphs?.[cm.treeItems.get(rootId)?.name] ?? cv.currentStateObj?.snapshotObj?.glyphs?.[rootId];
    out.advanceSnapAfterUndo = eaSnap?.advance ?? null;

    // ── H) multi-glyph snapshot-runtime consistency ──
    const mismatches = [];
    let checked = 0;
    for (const cur of cm.curveById.values()) {
        if (!cur?.startNode || checked >= 20) break;
        const item = [...cm.treeItems.values()].find(i => i.type === 'curve' && i.curveId === cur.id);
        const glyph = cv.currentStateObj?.snapshotObj?.glyphs?.[cur.groupId];
        if (!glyph?.children) continue;
        const path = glyph.children.find(c => c.type === 'path' && (c.name === item?.name || c.id === item?.id));
        const v = path?.vertices?.[0];
        if (!v) continue;
        checked++;
        if (v.x !== cur.startNode.x || v.y !== cur.startNode.y) {
            mismatches.push({ gid: cur.groupId, snap: [v.x, v.y], run: [cur.startNode.x, cur.startNode.y] });
        }
    }
    out.consistency = { checked, mismatches };

    mark('done');
    return JSON.stringify(out);
})()
`;

async function main() {
    let target;
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    const r2 = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    if (r2.result?.exceptionDetails) {
        console.log('PROBE EXCEPTION:', JSON.stringify(r2.result.exceptionDetails, null, 2));
    } else {
        const v = r2.result?.result?.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
    ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
