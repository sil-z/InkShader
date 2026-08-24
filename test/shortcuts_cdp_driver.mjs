// Shortcuts CDP driver: pure Node (built-in WebSocket/fetch), no npm deps.
// Verifies the global keyboard shortcut system added in the shortcuts session:
//  - tool switching V/A/P/O/M -> requestSetToolMode
//  - NODE-tool extras C/S/Y (node modes) + I/J/B (insert/join/break node)
//  - boolean family Ctrl+U / Ctrl+Shift+U / Ctrl+Alt+U / Ctrl+Alt+Shift+U
//  - file ops Ctrl+N (new), Ctrl+O (load), Ctrl+Shift+S (export SVG)
//  - expand stroke Ctrl+Shift+X
//  - Escape: cancel interaction + drop uncommitted draw path + clear selection
//  - Space: temporary pan (spaceDown flag + space+drag mousedown -> PANNING)
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=shortcuts-1';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const c = cv;
    window.confirm = () => true;

    // Listen for dispatcher events on window (emitRequest dispatches CustomEvent)
    const evCounts = {};
    const evNames = ['request-set-tool-mode', 'request-set-node-mode', 'request-insert-node',
        'request-join-node', 'request-break-node', 'request-boolean-union',
        'request-boolean-intersection', 'request-boolean-difference', 'request-boolean-exclusion',
        'request-expand-stroke', 'request-new-project', 'request-load',
        'request-change-object-selection', 'request-change-node-selection'];
    const evListeners = [];
    for (const n of evNames) {
        const fn = () => { evCounts[n] = (evCounts[n] || 0) + 1; };
        window.addEventListener(n, fn);
        evListeners.push([n, fn]);
    }
    // Wrap exportToSVG to count calls (avoid real downloads in headless)
    let exportSvgCalls = 0;
    if (typeof c.io.exportToSVG === 'function') {
        const orig = c.io.exportToSVG.bind(c.io);
        c.io.exportToSVG = () => { exportSvgCalls++; try { return Promise.resolve(orig()).catch(() => null); } catch (e) { return null; } };
    }

    const load = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await load.text());
    await sleep(600);

    const key = (opts) => {
        const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts));
        window.dispatchEvent(e);
        return e;
    };
    const toolOf = () => c.getActiveTool ? c.getActiveTool() : (c.editorStore?.getState?.()?.currentTool);

    // ── 1. Tool switching: V / A / P / O / M ──
    const switchSeq = [
        ['KeyV', 'v', 'SELECT'], ['KeyA', 'a', 'NODE'], ['KeyP', 'p', 'DRAW'],
        ['KeyO', 'o', 'ELLIPSE'], ['KeyM', 'm', 'MEASURE'], ['KeyV', 'v', 'SELECT']
    ];
    for (const [code, k, expected] of switchSeq) {
        key({ code, key: k });
        await sleep(180);
        check('tool switch ' + code + ' -> ' + expected, toolOf() === expected, { got: toolOf(), expected });
    }
    check('tool switch dispatched request-set-tool-mode', (evCounts['request-set-tool-mode'] || 0) >= 6, evCounts['request-set-tool-mode']);

    // ── 2. NODE-tool extras: C/S/Y modes, I/J/B ops ──
    key({ code: 'KeyA', key: 'a' });
    await sleep(180);
    const modeSeq = [['KeyC', 'c', 0], ['KeyS', 's', 1], ['KeyY', 'y', 2]];
    for (const [code, k, expected] of modeSeq) {
        const before = evCounts['request-set-node-mode'] || 0;
        key({ code, key: k });
        await sleep(150);
        check('node mode ' + code + ' dispatched', (evCounts['request-set-node-mode'] || 0) === before + 1, { before, after: evCounts['request-set-node-mode'] });
    }
    const opSeq = [['KeyI', 'i', 'request-insert-node'], ['KeyJ', 'j', 'request-join-node'], ['KeyB', 'b', 'request-break-node']];
    for (const [code, k, evName] of opSeq) {
        const before = evCounts[evName] || 0;
        key({ code, key: k });
        await sleep(150);
        check('node op ' + code + ' dispatched', (evCounts[evName] || 0) === before + 1, { before, after: evCounts[evName] });
    }
    // These single keys must NOT fire while tool is NOT NODE
    key({ code: 'KeyV', key: 'v' });
    await sleep(150);
    const notNodeBefore = evCounts['request-insert-node'] || 0;
    key({ code: 'KeyI', key: 'i' });
    await sleep(150);
    check('I does nothing outside NODE tool', (evCounts['request-insert-node'] || 0) === notNodeBefore, evCounts['request-insert-node']);

    // ── 3. Boolean family ──
    const boolSeq = [
        [{ ctrlKey: true, code: 'KeyU', key: 'u' }, 'request-boolean-union'],
        [{ ctrlKey: true, shiftKey: true, code: 'KeyU', key: 'U' }, 'request-boolean-intersection'],
        [{ ctrlKey: true, altKey: true, code: 'KeyU', key: 'u' }, 'request-boolean-difference'],
        [{ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyU', key: 'U' }, 'request-boolean-exclusion']
    ];
    for (const [opts, evName] of boolSeq) {
        const before = evCounts[evName] || 0;
        key(opts);
        await sleep(150);
        check('boolean ' + evName + ' dispatched', (evCounts[evName] || 0) === before + 1, { before, after: evCounts[evName] });
    }
    check('plain Ctrl+U not counted twice (no double dispatch)', evCounts['request-boolean-union'] === 1, evCounts['request-boolean-union']);

    // ── 5. Escape: clear selection (SELECT tool) ──
    key({ code: 'KeyV', key: 'v' });
    await sleep(180);
    // Select an object via dispatcher
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    const rootKids = c.curve_manager.rootChildren;
    const gid = rootKids[0];
    await CanvasDispatcher.requestSetTreeSelection([gid], gid);
    await sleep(300);
    const selLenBefore = (c.editorStore?.getState?.()?.selectedTreeIds || []).length;
    key({ code: 'Escape', key: 'Escape' });
    await sleep(300);
    const selLenAfter = (c.editorStore?.getState?.()?.selectedTreeIds || []).length;
    check('Escape clears selection', selLenBefore > 0 && selLenAfter === 0, { selLenBefore, selLenAfter });

    // ── 6. Escape: drop uncommitted draw path ──
    key({ code: 'KeyP', key: 'p' });
    await sleep(180);
    // Click on the INNER canvas (canvasObj) to start a path (DRAW tool).
    // NOTE: the mousedown listener is bound on c.canvasObj, a CHILD of
    // main-canvas — dispatching on main-canvas never reaches it (bubbling
    // goes upward, not downward).
    // Find an EMPTY canvas spot first (corner candidates, hit-test verified):
    // clicking a curve would route to handleNodeHitMouseDown instead.
    const findEmptyClientPoint = () => {
        const r = c.canvasObj.getBoundingClientRect();
        const cands = [[r.left + 40, r.top + 40], [r.left + 40, r.top + r.height - 40],
            [r.left + r.width - 40, r.top + 40], [r.left + r.width - 40, r.top + r.height - 40]];
        for (const [cx, cy] of cands) {
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(cx, cy, { clientX: cx, clientY: cy });
            if (!c.utils.hitTestNode(pointer.x, pointer.y) && !c.utils.hitTestCurve(pointer.x, pointer.y)) return { cx, cy };
        }
        return { cx: cands[0][0], cy: cands[0][1] };
    };
    const cRect = c.canvasObj.getBoundingClientRect();
    const drawPt = findEmptyClientPoint();
    const mx = drawPt.cx;
    const my = drawPt.cy;
    c.canvasObj.dispatchEvent(new MouseEvent('mousedown', { clientX: mx, clientY: my, button: 0, bubbles: true, cancelable: true }));
    await sleep(250);
    check('draw started (current_curve present)', !!(c.current_curve && c.current_curve.startNode), { hasCurve: !!c.current_curve });
    key({ code: 'Escape', key: 'Escape' });
    await sleep(300);
    check('Escape drops uncommitted draw path', c.current_curve === null, c.current_curve);
    check('Escape resets interaction state to IDLE', c.current_state === 'IDLE', c.current_state);

    // ── 7. Space temporary pan ──
    key({ code: 'Space', key: ' ' });
    check('Space keydown sets _spaceDown', c._spaceDown === true, c._spaceDown);
    // Space+drag on empty canvas -> PANNING
    key({ code: 'KeyV', key: 'v' });
    await sleep(180);
    const panPt = findEmptyClientPoint();
    const emptyX = panPt.cx;
    const emptyY = panPt.cy;
    c.canvasObj.dispatchEvent(new MouseEvent('mousedown', { clientX: emptyX, clientY: emptyY, button: 0, bubbles: true, cancelable: true }));
    await sleep(200);
    check('Space+drag pans (PANNING)', c.current_state === 'PANNING', c.current_state);
    // Release the space-drag (mouseup -> PANNING exits to IDLE) so the next
    // plain mousedown is a fresh click, not a continuation of the pan.
    c.canvasObj.dispatchEvent(new MouseEvent('mouseup', { clientX: emptyX, clientY: emptyY, button: 0, bubbles: true, cancelable: true }));
    const keyup = new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    window.dispatchEvent(keyup);
    await sleep(100);
    check('Space keyup clears _spaceDown', c._spaceDown === false, c._spaceDown);
    // Plain left-drag without space must NOT pan
    c.canvasObj.dispatchEvent(new MouseEvent('mousedown', { clientX: emptyX, clientY: emptyY, button: 0, bubbles: true, cancelable: true }));
    await sleep(200);
    check('plain left-drag does NOT pan', c.current_state !== 'PANNING', c.current_state);

    // ── 8. Space must not fire while typing in an input ──
    const ta = document.createElement('input');
    document.body.appendChild(ta);
    ta.focus();
    const sp = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    ta.dispatchEvent(sp);
    check('Space ignored inside input', c._spaceDown !== true, c._spaceDown);
    ta.remove();

    // ── 9. File ops: Ctrl+N, Ctrl+O, Ctrl+Shift+S (export SVG), Ctrl+Shift+X ──
    // NOTE: runs LAST — Ctrl+N (requestNewProject) wipes the loaded fixture,
    // so nothing state-dependent may follow it.
    const nBefore = evCounts['request-new-project'] || 0;
    key({ ctrlKey: true, code: 'KeyN', key: 'n' });
    await sleep(150);
    check('Ctrl+N dispatches new project', (evCounts['request-new-project'] || 0) === nBefore + 1, evCounts['request-new-project']);
    const oBefore = evCounts['request-load'] || 0;
    key({ ctrlKey: true, code: 'KeyO', key: 'o' });
    await sleep(150);
    check('Ctrl+O dispatches load', (evCounts['request-load'] || 0) === oBefore + 1, evCounts['request-load']);
    const svgBefore = exportSvgCalls;
    key({ ctrlKey: true, shiftKey: true, code: 'KeyS', key: 'S' });
    await sleep(200);
    check('Ctrl+Shift+S calls exportToSVG', exportSvgCalls === svgBefore + 1, { before: svgBefore, after: exportSvgCalls });
    const xBefore = evCounts['request-expand-stroke'] || 0;
    key({ ctrlKey: true, shiftKey: true, code: 'KeyX', key: 'X' });
    await sleep(150);
    check('Ctrl+Shift+X dispatches expand stroke', (evCounts['request-expand-stroke'] || 0) === xBefore + 1, evCounts['request-expand-stroke']);
    // Plain Ctrl+S (save) unchanged: triggerSave exists
    const saveBefore = typeof c.io.triggerSave === 'function';
    check('Ctrl+S still wired (triggerSave exists)', saveBefore, saveBefore);

    for (const [n, fn] of evListeners) window.removeEventListener(n, fn);
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
