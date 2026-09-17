// Headless E2E probe: verifies item I (dirty-on-undo -> clean) end-to-end in the
// real app, plus item D (ascender change must not move nodes) sanity checks.
// Robustness: overrides confirm/alert (headless dialogs hang forever), wraps each
// step in try/catch, and races a watchdog so partial progress is always reported.
const DEBUG_PORT = 9222;
const APP_URL = 'http://127.0.0.1:8129/index.html?v=dfix-9';

const PROBE = `
(async () => {
    const out = { steps: [] };
    const log = (k, v) => out.steps.push([k, v]);
    // Headless Chrome cannot answer dialogs -> they hang the tab forever.
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

    // Load a small real-derived project (2 glyphs)
    await step('load', async () => {
        const resp = await fetch('/test/small_project.json');
        await pm.loadFromFile(await resp.text());
        await sleep(600);
    });
    log('loaded clean', pm.isDirty() === false);

    const firstCurve = cm.curves && cm.curves.find(c => c.startNode);
    // Geometry fingerprint via the app's own serializer (robust across undo snapshots).
    // Sum of all numeric values — sensitive to any coordinate change.
    const geoHash = () => {
        const st = cv.history.getHistoryState(false);
        const g = st.snapshotObj && st.snapshotObj.glyphs;
        let sum = 0;
        const walk = (v) => {
            if (typeof v === 'number') sum += v;
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(g);
        return Math.round(sum * 1000);
    };
    log('hasCurve', !!firstCurve);

    // 1) Edit -> dirty
    await step('edit', async () => {
        const marker = firstCurve.startNode.main_node;
        if (!marker) throw new Error('no main_node marker on startNode');
        const n = firstCurve.startNode;
        const ok = cv.commands.changeControlNodePosition(marker, n.x + 10, n.y + 10);
        if (!ok) throw new Error('changeControlNodePosition returned false');
        await sleep(300);
    });
    log('dirty after edit', pm.isDirty() === true);
    const geoAfterEdit = geoHash();

    // 2) Undo -> clean again (item I under test)
    await step('undo', async () => { await cv.editorStore.undo(); await sleep(500); });
    log('clean after undo', pm.isDirty() === false);
    log('geometry restored after undo', geoHash() !== geoAfterEdit);
    const geoAfterUndo = geoHash();

    // 3) Redo -> dirty; 4) Undo -> clean
    await step('redo', async () => { await cv.editorStore.redo(); await sleep(500); });
    log('dirty after redo', pm.isDirty() === true);
    await step('undo2', async () => { await cv.editorStore.undo(); await sleep(500); });
    log('clean after undo2', pm.isDirty() === false);

    // 5) Ascender change: node coordinates must NOT change (item D)
    await step('ascender', async () => {
        const ascBefore = cv.fontSettings.ascender;
        Dispatcher.requestSetFontSettings({ ascender: ascBefore + 100 }, { recordHistory: true });
        await sleep(600);
        log('ascender changed', cv.fontSettings.ascender === ascBefore + 100);
        log('geometry unchanged after ascender', geoHash() === geoAfterUndo);
    });

    // 6) UPM change SHOULD scale nodes (existing contract)
    await step('upm', async () => {
        const upmBefore = cv.fontSettings.upm;
        Dispatcher.requestSetFontSettings({ upm: upmBefore * 2 }, { recordHistory: true });
        await sleep(800);
        log('upm scales nodes', geoHash() !== geoAfterUndo);
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

    // Poll readiness
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

    // Watchdog inside CDP: if evaluate never returns, still print partial state.
    const evalP = send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve({ result: { result: { value: '{"steps":[["WATCHDOG","probe did not finish in 55s"]]}' } } }), 55000));
    const r = await Promise.race([evalP, timeoutP]);
    console.log(r.result?.result?.value ?? JSON.stringify(r.result));
    ws.close();
    clearTimeout(hardStop);
}

main().catch(e => { console.error(e); process.exit(1); });
