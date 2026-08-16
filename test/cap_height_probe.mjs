// cap-height import bug verification probe (pure Node CDP, no npm deps).
// Root cause fixed: SVG import used `parseInt(cap-height) || 0` — a MISSING or
// "0" cap-height attribute (optional in SVG fonts, and written as "0" by our own
// OLD exporter) imported as cap_height 0, permanently persisted by save/load.
// Now falls back to 0.7*UPM (cap) / 0.5*UPM (x-height) when missing/zero.
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=capheight-1';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    window.addEventListener('error', e => { if (!e.message.includes('ResizeObserver loop')) out.errors.push('error: ' + e.message); });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;

    // Baseline: load the real fixture, then import a real exported SVG (new_font_export.svg,
    // which carries cap-height="0" — the OLD exporter's output that manufactured the bug).
    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(600);
    if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;

    // Note the fixture itself carries cap_height: 0 (already corrupted by the bug).
    check('fixture baseline cap_height is 0 (the bug was real)', cv.fontSettings.cap_height === 0, cv.fontSettings.cap_height);

    const svgResp = await fetch('/test/new_font_export.svg');
    const svg = await svgResp.text();
    check('fixture SVG has cap-height="0" (old exporter output)', svg.includes('cap-height="0"'), null);

    // Case A: import the OLD export AS-IS (cap-height="0") — post-fix this must
    // self-heal to 700 (0.7 * upm 1000) instead of importing 0.
    await cv.io._importSVGFontFromString(svg);
    await sleep(600);
    check('A: cap-height="0" imports as 700 (0 is treated as missing)', cv.fontSettings.cap_height === 700, cv.fontSettings.cap_height);
    check('A: x-height="500" passes through', cv.fontSettings.x_height === 500, cv.fontSettings.x_height);
    check('A: saved JSON keeps cap_height 700 (never 0)', JSON.parse(cv.io.save_file()).cap_height === 700, JSON.parse(cv.io.save_file()).cap_height);

    // Case B: explicit REAL cap-height="800" must win over the fallback.
    await cv.io._importSVGFontFromString(svg.replace('cap-height="0"', 'cap-height="800"'));
    await sleep(600);
    check('B: explicit cap-height="800" imported', cv.fontSettings.cap_height === 800, cv.fontSettings.cap_height);

    // Case C: attribute REMOVED entirely (typical external tool output) -> 700 fallback.
    await cv.io._importSVGFontFromString(svg.replace('cap-height="0" ', ''));
    await sleep(600);
    check('C: missing cap-height imports as 700', cv.fontSettings.cap_height === 700, cv.fontSettings.cap_height);
    check('C: missing x-height imports as 500', cv.fontSettings.x_height === 500, cv.fontSettings.x_height);

    // Case D: export side — the exporter must never write "0" for a missing value
    // (old code: cap_height || 0). Capture the blob export via patched env.
    window.__svgCap = null;
    const origURL = cv.env.createObjectURL;
    cv.env.createObjectURL = (blob) => { blob.text().then(t => { window.__svgCap = t; }); return 'blob:mock'; };
    const origCreate = cv.env.createDOMElement;
    cv.env.createDOMElement = (tag) => {
        const el = document.createElement(tag || 'a'); // real Node (appendChild requires one)
        el.click = () => { }; // suppress the actual download
        return el;
    };
    cv.env.revokeObjectURL = () => {};
    // Strip cap_height/x_height from fontSettings (missing-value export scenario)
    delete cv.fontSettings.cap_height;
    delete cv.fontSettings.x_height;
    cv.io.exportToSVG();
    await sleep(400);
    cv.env.createObjectURL = origURL;
    cv.env.createDOMElement = origCreate;
    check('D: export writes cap-height="700" for missing value', !!window.__svgCap && window.__svgCap.includes('cap-height="700"'), window.__svgCap && window.__svgCap.match(/cap-height="\d+"/)?.[0]);
    check('D: export writes x-height="500" for missing value', !!window.__svgCap && window.__svgCap.includes('x-height="500"'), window.__svgCap && window.__svgCap.match(/x-height="\d+"/)?.[0]);

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
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) {
            return { error: JSON.stringify(r.result.exceptionDetails, null, 2) };
        }
        return { value: r.result?.result?.value };
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
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    const a = await evaluate(PROBE);
    if (a.error) { console.log('PROBE EXCEPTION:', a.error); }
    else console.log(a.value);

    ws.close();
    process.exit(0);
}

main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
