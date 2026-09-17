// Headless E2E probe for item F: ruler persistence in file + undo, image/undo decoupling.
const DEBUG_PORT = 9222;
const APP_URL = 'http://127.0.0.1:8129/index.html?v=fprobe-9';

const PROBE = `
(async () => {
    const out = { steps: [] };
    const log = (k, v) => out.steps.push([k, v]);
    window.confirm = () => true;
    window.alert = (m) => log('ALERT', String(m));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    const pm = cv.projectManager;
    const Dispatcher = (await import('./js/app/canvas_dispatcher.js')).CanvasDispatcher;
    const step = async (name, fn) => {
        try { await fn(); } catch (e) { log('ERR:' + name, e && e.message || String(e)); }
    };

    await step('load', async () => {
        const resp = await fetch('/test/small_project.json');
        await pm.loadFromFile(await resp.text());
        await sleep(600);
    });
    log('rulers empty after load', (cv.rulers || []).length === 0);

    // Simulate creating a ruler directly + commit (mirrors MeasureTool.handleMouseUp)
    await step('createRuler', async () => {
        cv.rulers.push({ id: cv._nextRulerId++, x1: 100, y1: 200, x2: 500, y2: 200 });
        Dispatcher.requestHistoryCommit("createRuler", { id: cv.rulers[0].id });
        await sleep(300);
    });
    log('ruler count 1', (cv.rulers || []).length === 1);
    log('dirty after createRuler', pm.isDirty() === true);

    // Undo removes the ruler (file data participates in undo)
    await step('undoRuler', async () => { await cv.editorStore.undo(); await sleep(500); });
    log('ruler removed by undo', (cv.rulers || []).length === 0);

    // Redo brings it back
    await step('redoRuler', async () => { await cv.editorStore.redo(); await sleep(500); });
    log('ruler restored by redo', (cv.rulers || []).length === 1);

    // Move ruler endpoint + commit (mirrors MeasureTool drag)
    await step('moveRuler', async () => {
        cv.rulers[0].x2 = 700;
        Dispatcher.requestHistoryCommit("moveRuler", { id: cv.rulers[0].id, before: { x1: 100, y1: 200, x2: 500, y2: 200 } });
        await sleep(300);
    });
    log('ruler moved x2', cv.rulers[0].x2 === 700);

    await step('undoMove', async () => { await cv.editorStore.undo(); await sleep(500); });
    log('ruler move undone', cv.rulers[0] && cv.rulers[0].x2 === 500);

    // File persistence: saved file must contain editor_rulers
    await step('saveFile', async () => {
        const jsonStr = cv.io.save_file({});
        const parsed = JSON.parse(jsonStr);
        log('file has editor_rulers', Array.isArray(parsed.editor_rulers) && parsed.editor_rulers.length === 1);
        log('file ruler coords ok', parsed.editor_rulers?.[0]?.x1 === 100 && parsed.editor_rulers?.[0]?.x2 === 500);
    });

    // Image decoupling: import an image (simulated tree item), then undo/redo
    // a geometry command — image must survive.
    await step('imageSurvivesUndo', async () => {
        const fakeImg = { width: 10, height: 10 };
        const imgId = cm.importImageToCurrentGroup(fakeImg, 'probe.png', null);
        await sleep(200);
        const countBefore = Array.from(cm.treeItems.values()).filter(i => i.type === 'image').length;
        log('image imported', countBefore === 1);
        // Make a geometry edit, then undo it — image must stay.
        const firstCurve = cm.curves.find(c => c.startNode);
        const marker = firstCurve.startNode.main_node;
        cv.commands.changeControlNodePosition(marker, firstCurve.startNode.x + 5, firstCurve.startNode.y + 5);
        await sleep(300);
        await cv.editorStore.undo();
        await sleep(500);
        const countAfter = Array.from(cm.treeItems.values()).filter(i => i.type === 'image').length;
        log('image survives undo', countAfter === 1);
        await cv.editorStore.redo();
        await sleep(400);
        await cv.editorStore.undo();
        await sleep(400);
        const countAfter2 = Array.from(cm.treeItems.values()).filter(i => i.type === 'image').length;
        log('image survives undo2', countAfter2 === 1);
        // cleanup image
        const imgItem = Array.from(cm.treeItems.values()).find(i => i.type === 'image');
        if (imgItem) cm.treeStore.deleteTreeItem(imgItem.id);
    });

    return JSON.stringify(out);
})()
`;

async function main() {
    const hardStop = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(1); }, 90000);
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
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
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Runtime.enable');
    await send('Page.navigate', { url: APP_URL });

    {
        const t0 = Date.now();
        let ready = false;
        while (Date.now() - t0 < 40000) {
            await new Promise(r2 => setTimeout(r2, 1000));
            const r = await send('Runtime.evaluate', {
                expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager`,
                returnByValue: true
            });
            if (r.result?.result?.value === true) { ready = true; break; }
        }
        if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    }
    await new Promise(r2 => setTimeout(r2, 1200));

    const evalP = send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve({ result: { result: { value: '{"steps":[["WATCHDOG","no finish in 55s"]]}' } } }), 55000));
    const r = await Promise.race([evalP, timeoutP]);
    console.log(r.result?.result?.value ?? JSON.stringify(r.result));
    ws.close();
    clearTimeout(hardStop);
}

main().catch(e => { console.error(e); process.exit(1); });
