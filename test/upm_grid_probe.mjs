// Instrument addCurve during a single rebuildSpatialGrid to find the true cost.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=grid-prof';

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;
    const resp = await fetch('/test/huge_project.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(800);

    const grid = cm.spatialGrid;
    const origAddCurve = grid.addCurve.bind(grid);
    let calls = 0, totalCells = 0, maxCells = 0, maxCellsId = null;
    const dist = {};
    grid.addCurve = function (curveId, minX, minY, maxX, maxY, meta = {}) {
        calls++;
        const pad = Number.isFinite(meta.pad) ? meta.pad : 0;
        const minCx = Math.floor((minX - pad) / grid.cellSize);
        const maxCx = Math.floor((maxX + pad) / grid.cellSize);
        const minCy = Math.floor((minY - pad) / grid.cellSize);
        const maxCy = Math.floor((maxY + pad) / grid.cellSize);
        const span = (maxCx - minCx + 1) * (maxCy - minCy + 1);
        const cells = span > 4096 ? 1 : span;
        totalCells += cells;
        if (cells > maxCells) { maxCells = cells; maxCellsId = curveId; }
        const bucket = cells <= 4 ? '1-4' : cells <= 64 ? '5-64' : cells <= 1024 ? '65-1024' : cells <= 4096 ? '1025-4096' : 'clamped';
        dist[bucket] = (dist[bucket] || 0) + 1;
        return origAddCurve(curveId, minX, minY, maxX, maxY, meta);
    };
    const nodeOrig = grid.add.bind(grid);
    let nodeCalls = 0;
    grid.add = function (markerId, wx, wy, meta = {}) { nodeCalls++; return nodeOrig(markerId, wx, wy, meta); };

    const t0 = performance.now();
    cm.rebuildSpatialGrid(null); // full rebuild, same as scaleAllCoordinates does
    const fullMs = performance.now() - t0;

    // incremental rebuild like notifyTreeUpdate does
    const dirty = new Set(cm.rootChildren);
    const t1 = performance.now();
    cm.rebuildSpatialGrid(dirty);
    const incMs = performance.now() - t1;

    return JSON.stringify({
        fullMs: Math.round(fullMs), incMs: Math.round(incMs),
        addCurveCalls: calls, totalCells, maxCells, maxCellsId: String(maxCellsId).slice(-8),
        dist, nodeCalls,
        tokens: cm.seqService.sequenceTokens.length,
        activeIndices: cm.seqService.activeSequenceIndices.size,
        rootChildren: cm.rootChildren.length
    });
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
