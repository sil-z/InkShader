// Diagnose the chain jsonLen drift: diff the final undo snapshot against the
// loaded snapshot to identify which fields differ and by how much.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=chain-diff';

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;

    const resp = await fetch('/test/huge_project.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(800);
    const loadSnap = JSON.parse(JSON.stringify(cv.currentStateObj.snapshotObj));

    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    CanvasDispatcher.requestSetFontSettings({ upm: 2000 }, { recordHistory: true });
    await sleep(400);
    await cv.editorStore.undo();
    await sleep(400);
    await cv.editorStore.redo();
    await sleep(400);
    CanvasDispatcher.requestSetFontSettings({ upm: 3000 }, { recordHistory: true });
    await sleep(400);
    await cv.editorStore.undo();
    await sleep(400);
    await cv.editorStore.undo();
    await sleep(400);

    const finalSnap = cv.currentStateObj.snapshotObj;
    // diff leaf values
    const diffs = [];
    const walk = (a, b, path) => {
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            if (Array.isArray(a) && Array.isArray(b)) {
                const n = Math.max(a.length, b.length);
                for (let i = 0; i < n; i++) {
                    if (i >= a.length || i >= b.length) { diffs.push([path + '[' + i + ']', a[i], b[i], 'LEN']); }
                    else walk(a[i], b[i], path + '[' + i + ']');
                }
                return;
            }
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            for (const k of keys) {
                if (!(k in a)) diffs.push([path + '.' + k, undefined, b[k], 'MISSING_A']);
                else if (!(k in b)) diffs.push([path + '.' + k, a[k], undefined, 'MISSING_B']);
                else walk(a[k], b[k], path + '.' + k);
            }
            return;
        }
        if (a !== b) diffs.push([path, a, b, typeof a]);
    };
    walk(loadSnap, finalSnap, 'snap');

    // summarize: count + max relative delta for numbers
    let numDiffs = 0, maxRel = 0, maxRelPath = '', lenDiffs = 0, otherDiffs = [];
    for (const [path, a, b, kind] of diffs) {
        if (typeof a === 'number' && typeof b === 'number') {
            numDiffs++;
            const rel = Math.abs(a - b) / Math.max(Math.abs(a), 1e-12);
            if (rel > maxRel) { maxRel = rel; maxRelPath = path; }
        } else if (kind === 'LEN') { lenDiffs++; }
        else otherDiffs.push([path, a, b, kind]);
    }
    return JSON.stringify({
        totalDiffs: diffs.length, numDiffs, maxRel, maxRelPath,
        lenDiffs, otherDiffs: otherDiffs.slice(0, 5),
        jsonLenLoad: cv.currentStateObj ? null : null,
        upm: cv.fontSettings.upm
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
