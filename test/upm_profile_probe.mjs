// UPM undo CPU profile: find the true hot spots in the compact undo path.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=freeze-prof';

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;
    const resp = await fetch('/test/huge_project.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(800);
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    CanvasDispatcher.requestSetFontSettings({ upm: 2000 }, { recordHistory: true });
    await sleep(300);
    await cv.editorStore.undo();
    await sleep(400);
    await cv.editorStore.redo();
    await sleep(400);
    return JSON.stringify({ ready: true, upm: cv.fontSettings?.upm });
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

    await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });

    // Profile one undo
    await send('Profiler.enable');
    await send('Profiler.start');
    const t0 = Date.now();
    await send('Runtime.evaluate', {
        expression: `(async () => { const cv = document.querySelector('main-canvas'); const s = performance.now(); await cv.editorStore.undo(); return { undoMs: Math.round(performance.now() - s), upm: cv.fontSettings?.upm }; })()`,
        awaitPromise: true, returnByValue: true
    });
    const prof = await send('Profiler.stop');
    const profile = prof.result?.profile || {};
    const nodes = profile.nodes || [];
    const samples = profile.samples || [];
    const timeDeltas = profile.timeDeltas || [];

    // Aggregate self time by function name
    const byId = new Map(nodes.map(n => [n.id, n]));
    const selfTime = new Map();
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
        const dt = timeDeltas[i] || 0;
        total += dt;
        const n = byId.get(samples[i]);
        const cf = n?.callFrame;
        const key = cf ? `${cf.functionName || '(anon)'} @ ${cf.url.split('/').pop()}:${cf.lineNumber}` : '(unknown)';
        selfTime.set(key, (selfTime.get(key) || 0) + dt);
    }
    const rows = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    console.log('TOTAL_PROFILE_US', total);
    for (const [k, v] of rows) {
        console.log(`${(v / 1000).toFixed(0).padStart(8)} ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
    ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
