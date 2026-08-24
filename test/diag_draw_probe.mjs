// Draw-flow diagnostic: why does a DRAW-tool mousedown fail to create current_curve?
// Pure-Node CDP driver; requires headless Chrome :9222 + server :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=diag-draw-1';

const PROBE = `
(async () => {
    const out = { errors: [], info: {} };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const c = document.querySelector('main-canvas');
    window.confirm = () => true;

    const load = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await c.projectManager.loadFromFile(await load.text());
    await sleep(600);

    // Baseline state
    out.info.storeActiveGroupId = c.commandHostPort?.getStoreState?.()?.activeGroupId ?? null;
    out.info.managerActiveGroupId = c.curve_manager.activeGroupId ?? null;
    out.info.ensureActiveGroup = c.curve_manager.ensureActiveGroup() ?? null;
    out.info.seqTokens = (c.curve_manager.sequenceTokens || []).map(t => t.value || t.name || String(t));
    out.info.rootChildren = c.curve_manager.rootChildren;
    out.info.tool = c.getActiveTool ? c.getActiveTool() : '?';

    // Switch to DRAW like the shortcuts driver does
    const key = (opts) => { const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts)); window.dispatchEvent(e); return e; };
    key({ code: 'KeyP', key: 'p' });
    await sleep(250);
    out.info.toolAfterP = c.getActiveTool ? c.getActiveTool() : '?';

    // Simulate the driver's findEmptyClientPoint candidates
    const r = c.canvasObj.getBoundingClientRect();
    out.info.canvasObjRect = { left: r.left, top: r.top, w: r.width, h: r.height };
    const cands = [[r.left + 40, r.top + 40], [r.left + 40, r.top + r.height - 40],
        [r.left + r.width - 40, r.top + 40], [r.left + r.width - 40, r.top + r.height - 40]];
    for (let i = 0; i < cands.length; i++) {
        const [cx, cy] = cands[i];
        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(cx, cy, { clientX: cx, clientY: cy });
        const hitNode = c.utils.hitTestNode(pointer.x, pointer.y);
        const hitCurve = c.utils.hitTestCurve(pointer.x, pointer.y);
        out.info['cand' + i] = { cx, cy, pointer, hitNode: !!hitNode, hitCurve: !!hitCurve };
    }

    // Try the FIRST candidate like the driver's findEmptyClientPoint would
    const first = cands.find(([cx, cy], i) => {
        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(cx, cy, { clientX: cx, clientY: cy });
        return !c.utils.hitTestNode(pointer.x, pointer.y) && !c.utils.hitTestCurve(pointer.x, pointer.y);
    }) || cands[0];
    out.info.usedPoint = first;
    c.canvasObj.dispatchEvent(new MouseEvent('mousedown', { clientX: first[0], clientY: first[1], button: 0, bubbles: true, cancelable: true }));
    await sleep(300);

    out.info.current_curve = c.current_curve ? { id: c.current_curve.id, hasStart: !!c.current_curve.startNode, groupId: c.current_curve.groupId } : null;
    out.info.commands_current_curve = c.commands.current_curve ? { id: c.commands.current_curve.id } : null;
    out.info.current_state = c.current_state;
    out.info.last_on_curve_node_marker = c.last_on_curve_node_marker ?? null;
    out.info.storeActiveGroupIdAfter = c.commandHostPort?.getStoreState?.()?.activeGroupId ?? null;

    return JSON.stringify(out);
})()
`;

async function main() {
    let target;
    try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await res.json();
    } catch (e) {
        console.error('Cannot create tab:', e.message);
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
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager`,
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
