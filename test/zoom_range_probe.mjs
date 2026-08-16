// Verification: zoom range widened - scale_min 0.02 -> 0.001, scale_max 50 -> 500.
// Checks: constants, zoomTicksToScale clamp, real Ctrl+wheel zoom to both extremes,
// ruler safety at 0.001 (Session 18 powers-of-10 extension), render at 500.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=zoom-range-1';

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
    const evT = async (expression, label, timeoutMs = 20000) => {
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

    // 1. Constants applied
    const limits = await evT(`(() => { const cv = document.querySelector('main-canvas'); return { min: cv.scale_min, max: cv.scale_max, scale: cv.scale, base: cv.scaleBase }; })()`, 'constants');
    check('scale_min = 0.001', limits?.min === 0.001, `got ${limits?.min}`);
    check('scale_max = 500', limits?.max === 500, `got ${limits?.max}`);

    // 2. zoomTicksToScale clamp boundaries
    const clamps = await evT(`(() => { const cv = document.querySelector('main-canvas'); const snapBase = cv.scaleBase; cv.scaleBase = 1.0; const snap = cv.zoomTicksToScale(0); cv.scaleBase = snapBase; return { lo: cv.zoomTicksToScale(-200), hi: cv.zoomTicksToScale(200), atMin: cv.zoomTicksToScale(0), snap }; })()`, 'clamp math');
    check('clamp to min 0.001', clamps?.lo === 0.001, `got ${clamps?.lo}`);
    check('clamp to max 500', clamps?.hi === 500, `got ${clamps?.hi}`);
    check('base scale intact', Math.abs((clamps?.atMin ?? 0) - 0.4) < 1e-12, `got ${clamps?.atMin}`);
    check('100% snap works', Math.abs((clamps?.snap ?? 0) - 1.0) < 1e-9, `got ${clamps?.snap}`);

    // 3. Real Ctrl+wheel zoom OUT to the floor (0.4 -> clamp 0.001), ~70 ticks needed
    await evT(`(() => { const cv = document.querySelector('main-canvas'); const el = cv.canvasObj; const rect = el.getBoundingClientRect(); for (let i = 0; i < 160; i++) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, altKey: false, clientX: rect.left + 100, clientY: rect.top + 100, bubbles: true, cancelable: true })); } return 'dispatched'; })()`, 'wheel-out x160');
    const afterOut = await evT(`(() => { const cv = document.querySelector('main-canvas'); return { scale: cv.scale, ticks: cv.zoomTicks, finite: Number.isFinite(cv.scale) && Number.isFinite(cv.scaleBase) && Number.isFinite(cv.zoomTicks) }; })()`, 'state after zoom-out');
    check('zoom-out clamped at 0.001', Math.abs((afterOut?.scale ?? 9) - 0.001) < 1e-9, `got ${afterOut?.scale}`);
    check('state finite after zoom-out', afterOut?.finite === true);

    // 4. Ruler safety at the new floor (Session 18 powers-of-10 extension)
    await evT(`(() => { const cv = document.querySelector('main-canvas'); const svc = (cv.services?.renderer?.update_ruler) ? cv.services.renderer : cv.renderer; const t0 = performance.now(); svc.update_ruler?.(); const dt = performance.now() - t0; const lines = document.querySelectorAll('#rulers line, #rulers line, svg line').length; return { dt, lines: Math.min(lines, 5000) }; })()`, 'ruler at 0.001');
    // NOTE: line count above is coarse (page-wide); the real assertion is wall time.
    // Re-measure precisely via renderer internals in next step instead.
    const ruler = await evT(`(() => { const cv = document.querySelector('main-canvas'); const svc = (cv.services?.renderer?.update_ruler) ? cv.services.renderer : cv.renderer; const t0 = performance.now(); svc.update_ruler?.(); const dt = performance.now() - t0; const el = document.querySelector('#rulers') || document.querySelector('.ruler') || document.querySelector('main-canvas'); const ticks = el ? el.querySelectorAll('line').length : -1; return { dt, ticks }; })()`, 'ruler precise');
    check('ruler completes fast at 0.001', typeof ruler?.dt === 'number' && ruler.dt < 1000, `${ruler?.dt}ms`);

    // 5. Real Ctrl+wheel zoom IN to the ceiling (0.001 -> clamp 500), ~95 ticks from floor
    await evT(`(() => { const cv = document.querySelector('main-canvas'); const el = cv.canvasObj; const rect = el.getBoundingClientRect(); for (let i = 0; i < 200; i++) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, altKey: false, clientX: rect.left + 100, clientY: rect.top + 100, bubbles: true, cancelable: true })); } return 'dispatched'; })()`, 'wheel-in x200');
    const afterIn = await evT(`(() => { const cv = document.querySelector('main-canvas'); return { scale: cv.scale, ticks: cv.zoomTicks, finite: Number.isFinite(cv.scale) && Number.isFinite(cv.scaleBase) && Number.isFinite(cv.zoomTicks) }; })()`, 'state after zoom-in');
    check('zoom-in clamped at 500', Math.abs((afterIn?.scale ?? 0) - 500) < 1e-6, `got ${afterIn?.scale}`);
    check('state finite after zoom-in', afterIn?.finite === true);

    // 6. Render completes at 500 (real renderCanvas call, wall time)
    const renderHi = await evT(`(() => { const cv = document.querySelector('main-canvas'); const svc = (cv.services?.renderer?.renderCanvas) ? cv.services.renderer : cv.renderer; const t0 = performance.now(); svc.renderCanvas?.(); const dt = performance.now() - t0; return { dt, scale: cv.scale }; })()`, 'render at 500');
    check('render completes at scale 500', typeof renderHi?.dt === 'number' && renderHi.dt < 5000, `${renderHi?.dt}ms`);
    // sanity: wheel zoom still works BOTH directions after extreme excursions
    // (clamp math: from 500 (ticks=75), zoom-out n -> 0.4*1.1^(75-n); zoom-in at the
    // ceiling stays clamped at 500 by design - clamp-revert, not a stuck zoom)
    await evT(`(() => { const cv = document.querySelector('main-canvas'); const el = cv.canvasObj; const rect = el.getBoundingClientRect(); for (let i = 0; i < 3; i++) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: rect.left + 100, clientY: rect.top + 100, bubbles: true, cancelable: true })); } return 'out3'; })()`, 'wheel-out x3 from 500');
    const recover = await evT(`(() => { const cv = document.querySelector('main-canvas'); const expected = 0.4 * Math.pow(cv.zoomFactor, 72); return Math.abs(cv.scale - expected) < 1e-3 ? 'ok' : 'stuck:' + cv.scale; })()`, 'zoom recovers from ceiling');
    check('zoom recovers from ceiling (zoom-out works)', recover === 'ok', `got ${recover}`);

    const appErrors = events.filter(e => e.startsWith('EXC:')).slice(0, 5);
    check('no runtime exceptions', appErrors.length === 0, appErrors.join(' | '));

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    ws.close();
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('PROBE CRASH:', e); process.exit(2); });