// Verify the single-rebuild fix: record/undo/redo each rebuild the spatial
// grid exactly ONCE (via notifyTreeUpdate), all correctness holds, and
// timing improved vs the double-rebuild baseline (2.5s grid work → ~1s).
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=single-rebuild';

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;

    const resp = await fetch('/test/huge_project.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(800);

    // --- instrument AFTER load ---
    let rebuildCalls = 0, rebuildMs = 0;
    const origRebuild = cm.rebuildSpatialGrid.bind(cm);
    cm.rebuildSpatialGrid = function (dirtyIds) {
        rebuildCalls++;
        const t = performance.now();
        const r = origRebuild(dirtyIds);
        rebuildMs += performance.now() - t;
        return r;
    };
    let treeNotifyCalls = 0;
    const origTreeNotify = cm.notifyTreeUpdate.bind(cm);
    cm.notifyTreeUpdate = function () { treeNotifyCalls++; return origTreeNotify(); };

    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    const startNode = () => {
        const root = cm.rootChildren[0];
        const cd = cm.treeStore.getCurvesForGroup(root)[0];
        return cd.curve.startNode;
    };
    const gridSanity = () => {
        // every node indexed is queryable at its own world coords
        let found = 0, total = 0;
        cm.spatialGrid.forEach((entry) => {
            total++;
            if (cm.spatialGrid.queryProximity(entry.worldX, entry.worldY, 1).length > 0) found++;
        });
        return { total, found, size: cm.spatialGrid.size };
    };
    const gridSize = () => cm.spatialGrid.size;

    const results = {};
    const n0 = startNode();
    const x0 = n0.x, y0 = n0.y;
    const jsonLen0 = cv.currentStateObj.json.length;
    const canvasH0 = cv.canvas_size_height;

    // ---- 1) RECORD: 1000 -> 2000 ----
    rebuildCalls = 0; rebuildMs = 0; treeNotifyCalls = 0;
    let t = performance.now();
    CanvasDispatcher.requestSetFontSettings({ upm: 2000 }, { recordHistory: true });
    results.record = {
        ms: Math.round(performance.now() - t),
        rebuildCalls, treeNotifyCalls, rebuildMs: Math.round(rebuildMs),
        gridSize: gridSize(), upm: cv.fontSettings.upm,
        canvasH: cv.canvas_size_height,
        entryCompact: cv.commandStack.at(-1)?.fontSettingsEntry === true,
        entryLen: cv.commandStack.at(-1) ? JSON.stringify(cv.commandStack.at(-1)).length : -1
    };
    await sleep(400);

    // ---- 2) UNDO: 2000 -> 1000 ----
    rebuildCalls = 0; rebuildMs = 0; treeNotifyCalls = 0;
    t = performance.now();
    await cv.editorStore.undo();
    await sleep(400);
    const n1 = startNode();
    results.undo = {
        ms: Math.round(performance.now() - t),
        rebuildCalls, treeNotifyCalls, rebuildMs: Math.round(rebuildMs),
        gridSize: gridSize(), upm: cv.fontSettings.upm,
        canvasH: cv.canvas_size_height,
        xExact: n1.x === x0, yExact: n1.y === y0,
        x: n1.x, y: n1.y,
        jsonLenExact: cv.currentStateObj.json.length === jsonLen0,
        jsonLen: cv.currentStateObj.json.length
    };

    // ---- 3) REDO: 1000 -> 2000 ----
    rebuildCalls = 0; rebuildMs = 0; treeNotifyCalls = 0;
    t = performance.now();
    await cv.editorStore.redo();
    await sleep(400);
    const n2 = startNode();
    results.redo = {
        ms: Math.round(performance.now() - t),
        rebuildCalls, treeNotifyCalls, rebuildMs: Math.round(rebuildMs),
        gridSize: gridSize(), upm: cv.fontSettings.upm,
        canvasH: cv.canvas_size_height,
        xDoubled: Math.abs(n2.x - x0 * 2) < 1e-9, yDoubled: Math.abs(n2.y - y0 * 2) < 1e-9
    };

    // ---- 4) CHAIN: 2000 -> 3000 -> undo -> undo -> 1000 ----
    CanvasDispatcher.requestSetFontSettings({ upm: 3000 }, { recordHistory: true });
    await sleep(400);
    rebuildCalls = 0; treeNotifyCalls = 0;
    await cv.editorStore.undo();
    await sleep(400);
    const undo1Ms = performance.now() - t;
    t = performance.now();
    rebuildCalls = 0; treeNotifyCalls = 0;
    await cv.editorStore.undo();
    await sleep(400);
    const n3 = startNode();
    results.chain = {
        undo1Ms: Math.round(undo1Ms),
        undo2Ms: Math.round(performance.now() - t),
        rebuildCallsUndo2: rebuildCalls, treeNotifyUndo2: treeNotifyCalls,
        upm: cv.fontSettings.upm,
        backTo1000: Math.abs(n3.x - x0) < 1e-9 && Math.abs(n3.y - y0) < 1e-9,
        jsonLenExact: cv.currentStateObj.json.length === jsonLen0,
        commandStackLen: cv.commandStack.length,
        redoStackLen: cv.redoCommandStack.length
    };

    // ---- 5) grid usable after everything ----
    const gs = gridSanity();
    results.gridSanity = gs;

    return JSON.stringify(results);
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

    const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    console.log(r.result?.result?.value ?? JSON.stringify(r.result));
    ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
