// v3: reproduce hang, then Debugger.pause to capture the blocked main-thread stack.
// Params via env: RECORD=(true|false) SCALE=(0.05|0.4) UPM=(10000)
const DEBUG_PORT = 9222;
const RECORD = process.env.RECORD !== 'false';
const SCALE = Number(process.env.SCALE ?? '0.05');
const UPM = Number(process.env.UPM ?? '10000');
const APP_URL = `http://localhost:8123/?v=zoom-dbg3`;

async function main() {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const pausedFrames = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.method === 'Debugger.paused') {
            const frames = (msg.params.callFrames || []).slice(0, 20).map(f => {
                const fn = f.functionName || '(anon)';
                const loc = f.url ? `${f.url.split('/').pop()}:${f.location.lineNumber + 1}` : '?';
                return `${fn} @ ${loc}`;
            });
            pausedFrames.push(...frames);
        }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evT = async (expression, label, timeoutMs = 12000) => {
        const t0 = Date.now();
        const r = await Promise.race([
            send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
            new Promise((resolve) => setTimeout(() => resolve({ TIMEOUT: true }), timeoutMs))
        ]);
        if (r.TIMEOUT) { console.log(`-- ${label}: *** TIMEOUT (${Date.now() - t0}ms) ***`); return { TIMEOUT: true }; }
        console.log(`-- ${label}: ${Date.now() - t0}ms =>`, JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result?.exceptionDetails?.text ?? '(no value)'));
        return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Debugger.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    console.log(`-- cfg: RECORD=${RECORD} SCALE=${SCALE} UPM=${UPM} ready=${ready}`);
    await new Promise(r2 => setTimeout(r2, 800));

    await evT(`window.confirm = () => true; fetch('/test/InkShader_project_2026-08-02T16-27-25.json').then(r => r.text()).then(async t => { await document.querySelector('main-canvas').projectManager.loadFromFile(t); return 'loaded'; })`, 'load');
    await evT(`(() => { const cv = document.querySelector('main-canvas'); cv.scale = ${SCALE}; cv.scaleBase = ${SCALE}; cv.zoomTicks = 0; cv.offset = { x: 123, y: 456 }; return 'view set'; })()`, 'set-view');
    await evT(`import('./js/app/canvas_dispatcher.js').then(m => { m.CanvasDispatcher.requestSetFontSettings({ upm: ${UPM} }, { recordHistory: ${RECORD} }); return 'dispatched'; })`, 'upm-dispatch');

    // Poll until blocked
    let blocked = false;
    for (let i = 0; i < 5; i++) {
        const v = await evT(`document.querySelector('main-canvas').fontSettings?.upm`, `poll upm (${i})`, 6000);
        if (v === UPM) { console.log('-- upm reached', UPM, '- NO hang'); break; }
        if (v?.TIMEOUT || v === undefined) { blocked = true; break; }
        await new Promise(r2 => setTimeout(r2, 300));
    }
    if (blocked) {
        console.log('-- main thread BLOCKED. Sending Debugger.pause...');
        await send('Debugger.pause');
        await new Promise(r2 => setTimeout(r2, 3000));
        console.log('-- STACK (top 20):');
        pausedFrames.forEach(f => console.log('   ' + f));
        if (pausedFrames.length === 0) console.log('   (no paused event - thread may be inside native/WebGL)');
        await send('Debugger.resume');
        console.log('-- liveness after resume:', await evT('1+1', 'liveness', 5000) === 2);
    }
    ws.close();
    console.log('DONE');
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
