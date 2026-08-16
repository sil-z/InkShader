// kern-history CDP driver: pure Node (built-in WebSocket/fetch), no npm deps.
// Verifies the SET_KERNING_PAIRS command pipeline: dispatcher -> command ->
// history commit -> undo/redo restore (both set & remove paths), sequence
// offsets refresh, STATE_CHANGED emission for the kern popup refresh.
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=kern-hist-1';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    const { appEventBus } = await import('./js/app/event_bus.js');
    const { CANVAS_EVENTS } = await import('./js/app/canvas_events.js');
    window.confirm = () => true;

    // Listen for STATE_CHANGED (kern popup refresh depends on it)
    let stateChangedCount = 0;
    let seqChangedCount = 0;
    const off1 = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, () => stateChangedCount++);
    const off2 = appEventBus.on(CANVAS_EVENTS.SEQUENCE_CHANGED, () => seqChangedCount++);

    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(500);

    const km = cm.kerningManager;
    check('kerning manager present', !!km, null);
    // Baseline fixture carries A->E = -500 itself; A->B is absent (adjacent pair in
    // sequence ABCDE..., so it exercises the sequence-offset refresh).
    check('baseline pair A->B absent', km.getPair('A', 'B') === 0, km.getPair('A', 'B'));
    check('baseline pair A->E = -500 (fixture)', km.getPair('A', 'E') === -500, km.getPair('A', 'E'));
    const baselineOffsets = [...cm.seqService.sequenceOffsets];
    const stack0 = cv.commandStack ? cv.commandStack.length : -1;

    // ── 1. set pair A->B = -250 (a REAL change) via dispatcher ──
    await CanvasDispatcher.requestSetKerningPairs([{ left: 'A', right: 'B', value: -250 }], { recordHistory: true });
    await sleep(350);
    check('pair set after command', km.getPair('A', 'B') === -250, km.getPair('A', 'B'));
    check('history entry recorded', cv.commandStack ? cv.commandStack.length === stack0 + 1 : false, { stack0, stack: cv.commandStack?.length });
    check('sequence offsets changed (kerning applied to preview)', JSON.stringify(cm.seqService.sequenceOffsets) !== JSON.stringify(baselineOffsets), cm.seqService.sequenceOffsets);
    const seqOffAfterSet = [...cm.seqService.sequenceOffsets];

    // ── 2. undo: pair must return to absent, offsets restored ──
    await CanvasDispatcher.requestUndo();
    await sleep(500);
    check('undo removes pair', km.getPair('A', 'B') === 0, km.getPair('A', 'B'));
    check('undo restores sequence offsets', JSON.stringify(cm.seqService.sequenceOffsets) === JSON.stringify(baselineOffsets), cm.seqService.sequenceOffsets);
    check('undo pops stack', cv.commandStack ? cv.commandStack.length === stack0 : false, cv.commandStack?.length);

    // ── 3. redo: pair restored ──
    await CanvasDispatcher.requestRedo();
    await sleep(500);
    check('redo restores pair', km.getPair('A', 'B') === -250, km.getPair('A', 'B'));
    check('redo restores sequence offsets', JSON.stringify(cm.seqService.sequenceOffsets) === JSON.stringify(seqOffAfterSet), cm.seqService.sequenceOffsets);

    // ── 4. remove path via dispatcher, then undo restores it ──
    await CanvasDispatcher.requestSetKerningPairs([{ left: 'A', right: 'B', remove: true }], { recordHistory: true });
    await sleep(350);
    check('remove works through command', km.getPair('A', 'B') === 0, km.getPair('A', 'B'));
    await CanvasDispatcher.requestUndo();
    await sleep(500);
    check('undo restores removed pair', km.getPair('A', 'B') === -250, km.getPair('A', 'B'));
    await CanvasDispatcher.requestRedo();
    await sleep(500);
    check('redo removes again', km.getPair('A', 'B') === 0, km.getPair('A', 'B'));

    // ── 5. no-op set (same value 0): data unchanged, NO empty history entry ──
    // (recordHistory empty-diff guard returns false; command convention returns
    // recordHistory=true — matching setGroupAdvance — but no entry is created)
    const stack1 = cv.commandStack ? cv.commandStack.length : -1;
    await CanvasDispatcher.requestSetKerningPairs([{ left: 'A', right: 'B', value: 0 }], { recordHistory: true });
    await sleep(350);
    check('no-op set keeps data', km.getPair('A', 'B') === 0, km.getPair('A', 'B'));
    check('no-op set records NO empty entry', cv.commandStack ? cv.commandStack.length === stack1 : false, { stack1, stack: cv.commandStack?.length });
    // undo after the no-op pops the PREVIOUS remove entry (restores -250); must not DEV-ALERT
    const alertSpy = [];
    const origAlert = window.alert;
    window.alert = (m) => alertSpy.push(m);
    await CanvasDispatcher.requestUndo();
    await sleep(500);
    window.alert = origAlert;
    check('undo after no-op does not DEV-ALERT', alertSpy.length === 0, alertSpy);
    check('undo after no-op restores previous state', km.getPair('A', 'B') === -250, km.getPair('A', 'B'));

    // ── 6. JSON export includes the kerning change (file-level persistence) ──
    await CanvasDispatcher.requestSetKerningPairs([{ left: 'A', right: 'E', value: -250 }], { recordHistory: true });
    await sleep(350);
    const json = JSON.parse(cv.io.save_file());
    check('kerning exported to JSON file', json.kerning?.A?.E === -250, json.kerning);

    // ── 7. STATE_CHANGED emitted for popup refresh ──
    check('STATE_CHANGED emitted during session', stateChangedCount >= 4, stateChangedCount);

    off1(); off2();
    return JSON.stringify(out);
})()
`;

async function main() {
    let target;
    try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await res.json();
    } catch (e) {
        console.error('Cannot create tab (is Chrome running with --remote-debugging-port=' + DEBUG_PORT + '?):', e.message);
        process.exit(1);
    }

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

    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager && !!document.querySelector('main-canvas').services?.renderer`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    const res = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
        console.log('PROBE EXCEPTION:', JSON.stringify(res.result.exceptionDetails, null, 2));
    } else {
        const v = res.result?.result?.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
    ws.close();
}

main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
