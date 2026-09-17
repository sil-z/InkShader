// Verifies the js/vendor import convention:
//   - js/vendor/paper.js and js/vendor/jszip.js must return the same objects as
//     the globals created by index.html's classic <script> tags;
//   - js/vendor/svgpath.js must be the working entry point for svgpath.
//
// Run: python test/probe_server.py 8138
//      msedge --headless=new --remote-debugging-port=9241 --user-data-dir=... about:blank
//      PROBE_PORT=9241 PROBE_SRV=8138 node test/probe_vendor_esm.mjs
const WebSocket = (await import('ws')).default;

const PORT = Number(process.env.PROBE_PORT || 9241);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=vendor-esm-${Date.now()}`;

const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' });
const tab = await res.json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

let msgId = 0; const pending = new Map(); const consoleErrors = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
    }
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 300) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await sleep(3500);

const checks = [];
const paperIdentity = await evalp(`import('/js/vendor/paper.js').then(m => m.default === window.paper)`);
checks.push({ name: 'vendor/paper.js exports the same object as window.paper', ok: paperIdentity === true, got: paperIdentity });

const jszipIdentity = await evalp(`import('/js/vendor/jszip.js').then(m => m.default === window.JSZip)`);
checks.push({ name: 'vendor/jszip.js exports the same object as window.JSZip', ok: jszipIdentity === true, got: jszipIdentity });

const svgpathType = await evalp(`import('/js/vendor/svgpath.js').then(m => typeof m.default)`);
checks.push({ name: 'vendor/svgpath.js default export is a function', ok: svgpathType === 'function', got: svgpathType });

const svgpathWorks = await evalp(`import('/js/vendor/svgpath.js').then(m => m.default('M0 0L10 0L10 10Z').translate(5, 5).round(1).toString())`);
// Accept separator variants ("M5 5L15 5L15 15Z" vs "M5 5L15 5 15 15Z"): assert on the numbers.
const svgNumbers = String(svgpathWorks).match(/-?\d+(?:\.\d+)?/g)?.join(',') ?? '';
checks.push({ name: 'svgpath transform pipeline works through the adapter', ok: svgNumbers === '5,5,15,5,15,15', got: svgpathWorks });

const appBooted = await evalp(`(!!document.querySelector('main-canvas') && !!window.paper && !!window.JSZip && typeof document.querySelector('main-canvas').curve_manager === 'object')`);
checks.push({ name: 'app booted with both globals present', ok: appBooted === true, got: appBooted });

const ioUsesAdapter = await evalp(`fetch('/js/canvas/services/canvas_io_service.js').then(r => r.text()).then(t => /vendor\\/svgpath\\.js/.test(t))`);
checks.push({ name: 'canvas_io_service imports vendor/svgpath.js', ok: ioUsesAdapter === true, got: ioUsesAdapter });

checks.push({ name: 'no console errors / exceptions during load', ok: consoleErrors.length === 0, got: consoleErrors.slice(0, 3) });

console.log(JSON.stringify({ checks, failed: checks.filter(c => !c.ok).map(c => c.name) }, null, 2));
await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => { });
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
