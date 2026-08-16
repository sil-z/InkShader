// Post-fix verification: UPM change must keep scale/scaleBase/zoomTicks/offset
// unchanged; zoom must keep working at small scale; rulers must never freeze.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=zoom-fix3';
const EPS = 1e-9;

async function main() {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params?.exceptionDetails;
            events.push(`EXC: ${d?.exception?.description || d?.text || '?'}`);
        }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evT = async (expression, label, timeoutMs = 15000) => {
        const t0 = Date.now();
        const r = await Promise.race([
            send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
            new Promise((resolve) => setTimeout(() => resolve({ TIMEOUT: true }), timeoutMs))
        ]);
        if (r.TIMEOUT) { console.log(`-- ${label}: *** TIMEOUT ***`); return { TIMEOUT: true }; }
        const v = r.result?.result?.value;
        console.log(`-- ${label}: ${Date.now() - t0}ms =>`, JSON.stringify(v ?? r.result?.exceptionDetails?.exception?.description ?? r.result?.exceptionDetails?.text ?? '(no value)'));
        return v;
    };
    let failures = 0;
    const check = (name, cond, detail = '') => {
        console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
        if (!cond) failures++;
    };

    await send('Page.enable');
    await send('Runtime.enable');
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
    check('app bootstrap', ready);
    await new Promise(r2 => setTimeout(r2, 800));

    const SVC = `(() => { const cv = document.querySelector('main-canvas'); const s = cv.services?.renderer; return (s && typeof s.change_canvas_size === 'function') ? 'services.renderer' : 'renderer'; })()`;
    const svcName = await evT(SVC, 'renderer accessor');
    const R = svcName === 'services.renderer' ? `cv.services.renderer` : `cv.renderer`;

    await evT(`window.confirm = () => true; fetch('/test/InkShader_project_2026-08-02T16-27-25.json').then(r => r.text()).then(async t => { await document.querySelector('main-canvas').projectManager.loadFromFile(t); return 'loaded'; })`, 'load-baseline');

    // Phase 1: UPM change at small zoom with recordHistory - must COMPLETE, no hang
    await evT(`(() => { const cv = document.querySelector('main-canvas'); cv.scale = 0.05; cv.scaleBase = 0.05; cv.zoomTicks = 0; cv.offset = { x: 123, y: 456 }; return 'view set'; })()`, 'set-view(0.05)');
    await evT(`import('./js/app/canvas_dispatcher.js').then(m => { m.CanvasDispatcher.requestSetFontSettings({ upm: 10000 }, { recordHistory: true }); return 'dispatched'; })`, 'upm-dispatch');
    const upmDeadline = Date.now() + 30000;
    let upmDone = false;
    while (Date.now() < upmDeadline) {
        const v = await evT(`document.querySelector('main-canvas').fontSettings?.upm`, 'poll upm', 8000);
        if (v === 10000) { upmDone = true; break; }
        if (v?.TIMEOUT) break;
        await new Promise(r2 => setTimeout(r2, 300));
    }
    check('UPM command completes (no freeze)', upmDone);
    const st1 = await evT(`(() => { const cv = document.querySelector('main-canvas'); return { scale: cv.scale, scaleBase: cv.scaleBase, ticks: cv.zoomTicks, off: cv.offset }; })()`, 'post-upm state');
    check('scale unchanged 0.05', st1 && Math.abs(st1.scale - 0.05) < EPS, `scale=${st1?.scale}`);
    check('scaleBase unchanged 0.05', st1 && Math.abs(st1.scaleBase - 0.05) < EPS, `scaleBase=${st1?.scaleBase}`);
    check('zoomTicks unchanged 0', st1 && st1.ticks === 0, `ticks=${st1?.ticks}`);
    check('offset unchanged {123,456}', st1 && st1.off?.x === 123 && st1.off?.y === 456, JSON.stringify(st1?.off));

    // Phase 2: wheel zoom in/out at the SAME (small) scale - must work, no clamp death
    let s = 0.05;
    const zoomSeq = [];
    for (let k = 0; k < 3; k++) {
        const r = await evT(`(() => { const cv = document.querySelector('main-canvas'); ${R}.change_canvas_size(-1, 300, 200); return { scale: cv.scale, ticks: cv.zoomTicks }; })()`, `zoom-in ${k + 1}`);
        s *= 1.1;
        zoomSeq.push(r?.scale);
        check(`zoom-in ${k + 1} -> ~${s.toFixed(6)}`, r && Math.abs(r.scale - s) < 1e-9, `scale=${r?.scale} ticks=${r?.ticks}`);
    }
    for (let k = 0; k < 3; k++) {
        const r = await evT(`(() => { const cv = document.querySelector('main-canvas'); ${R}.change_canvas_size(1, 300, 200); return { scale: cv.scale, ticks: cv.zoomTicks }; })()`, `zoom-out ${k + 1}`);
        s /= 1.1;
        check(`zoom-out ${k + 1} -> ~${s.toFixed(6)}`, r && Math.abs(r.scale - s) < 1e-9, `scale=${r?.scale} ticks=${r?.ticks}`);
    }

    // Phase 3: undo/redo of the compact font-settings entry
    const offBefore = await evT(`(() => { const cv = document.querySelector('main-canvas'); return cv.offset; })()`, 'offset before undo');
    const u = await evT(`(async () => { const cv = document.querySelector('main-canvas'); await cv.editorStore.undo(); return { upm: cv.fontSettings?.upm, scale: cv.scale, off: cv.offset }; })()`, 'undo');
    check('undo -> upm 1000', u && u.upm === 1000, `upm=${u?.upm}`);
    check('undo keeps scale', u && Math.abs(u.scale - s) < EPS, `scale=${u?.scale}`);
    check('undo keeps offset (pre-undo value)', u && offBefore && u.off?.x === offBefore.x && u.off?.y === offBefore.y, `off=${JSON.stringify(u?.off)} pre=${JSON.stringify(offBefore)}`);
    await new Promise(r2 => setTimeout(r2, 150)); // is_restoring resets on rAF+setTimeout(0)
    const rd = await evT(`(async () => { const cv = document.querySelector('main-canvas'); await cv.editorStore.redo(); return { upm: cv.fontSettings?.upm, scale: cv.scale, off: cv.offset }; })()`, 'redo');
    check('redo -> upm 10000', rd && rd.upm === 10000, `upm=${rd?.upm}`);
    check('redo keeps scale', rd && Math.abs(rd.scale - s) < EPS, `scale=${rd?.scale}`);

    // Phase 4: ruler safety at pathological small scales (old compensation values)
    await evT(`(() => { const cv = document.querySelector('main-canvas'); cv.viewportConfig = { viewportWidth: 800, viewportHeight: 500, rulerWidth: 30, rulerHeight: 30 }; return 'vp set'; })()`, 'set viewportConfig');
    for (const sc of [0.05, 0.005, 0.002]) {
        const r = await evT(`(() => { const cv = document.querySelector('main-canvas'); cv.scale = ${sc}; cv.scaleBase = ${sc}; cv.zoomTicks = 0; ${R}.update_ruler(); const svg = cv.ruler_horizontal.firstElementChild; const n = svg ? svg.childElementCount : -1; return { ticks: n, svgNodes: cv.ruler_horizontal.childElementCount }; })()`, `ruler @ scale ${sc}`, 8000);
        check(`ruler completes @ ${sc} (<= 200 ticks)`, r && r.TIMEOUT !== true && r.ticks > 0 && r.ticks <= 200, `ticks=${r?.ticks}`);
    }

    // Phase 5: UPM change at the MINIMUM UI zoom (0.02) - edge that used to be reachable
    await evT(`(() => { const cv = document.querySelector('main-canvas'); cv.scale = 0.02; cv.scaleBase = 0.02; cv.zoomTicks = 0; cv.offset = { x: 123, y: 456 }; return 'view set'; })()`, 'set-view(0.02)');
    await evT(`import('./js/app/canvas_dispatcher.js').then(m => { m.CanvasDispatcher.requestSetFontSettings({ upm: 2000 }, { recordHistory: true }); return 'dispatched'; })`, 'upm 2000 dispatch');
    const d2 = Date.now() + 20000;
    let upm2 = false;
    while (Date.now() < d2) {
        const v = await evT(`document.querySelector('main-canvas').fontSettings?.upm`, 'poll upm2', 8000);
        if (v === 2000) { upm2 = true; break; }
        if (v?.TIMEOUT) break;
        await new Promise(r2 => setTimeout(r2, 300));
    }
    check('UPM 2000 completes @ 0.02', upm2);
    const st2 = await evT(`(() => { const cv = document.querySelector('main-canvas'); return { scale: cv.scale, ticks: cv.zoomTicks }; })()`, 'post-upm2 state');
    check('scale unchanged 0.02', st2 && Math.abs(st2.scale - 0.02) < EPS, `scale=${st2?.scale}`);
    const z = await evT(`(() => { const cv = document.querySelector('main-canvas'); ${R}.change_canvas_size(-1, 300, 200); return { scale: cv.scale }; })()`, 'zoom @ 0.02');
    check('zoom works after UPM @ 0.02 -> 0.022', z && Math.abs(z.scale - 0.022) < 1e-9, `scale=${z?.scale}`);

    ws.close();
    console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ====`);
    if (events.length) console.log('EVENTS:\n' + events.join('\n'));
    process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
