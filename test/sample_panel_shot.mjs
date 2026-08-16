// Visual snapshot of the sample-text panel (for the visual QA record).
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=sample-panel-shot';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    window.confirm = () => true;
    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(600);
    if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;

    const panel = document.querySelector('sample-text-panel');
    const input = panel.querySelector('#sample_text_input');
    input.focus();
    input.value = 'ABCDEFG';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);

    const r = panel.getBoundingClientRect();
    out.panelRect = { x: r.x, y: r.y, w: r.width, h: r.height };
    out.canvasRect = (() => { const c = panel.querySelector('#sample_canvas').getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; })();
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
            expression: `!!document.querySelector('main-canvas')?.curve_manager?.seqService`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));
    const res = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    const info = res.result?.result?.value;
    console.log('INFO:', typeof info === 'string' ? info : JSON.stringify(info));

    // Screenshot the whole page; the panel sits in the right dock column.
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync('test/sample_panel_shot.png', Buffer.from(shot.result.data, 'base64'));
    console.log('saved test/sample_panel_shot.png');
    ws.close();
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
