// Stability cache invalidation: the rendered frame must be re-derived whenever
// geometry changed, never served from a stale blit.
//
// The stable-scene / node-layer caches were validated with
//     epoch = curve_manager._geometryEpoch ^ canvas._geometryEpoch
// bumpGeometryEpoch() increments BOTH counters by one, so `n ^ n` is unchanged
// and the "epoch" never moved for edits that only bump both — the cache served
// the old pixels until a pan (offset check) happened to invalidate it. The key is
// now the tuple [cm._geometryEpoch, canvas._geometryEpoch], which changes when
// EITHER counter moves.
//
// This drives the REAL renderer and asserts the invalidation contract directly.
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=stableinv-${Date.now()}`;
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.alert=()=>{};` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1200);
    const r = cv.renderer;
    const render = () => (cv.renderCanvas ? cv.renderCanvas() : r.renderCanvas());
    const result = {};

    render(); await sleep(120);
    result.cacheCaptured = !!r._stableSceneCache;
    result.validImmediately = r._epochKeyMatches(r._stableSceneCache.geometryEpochs, cv);

    // The previous key (XOR of the counters) is blind whenever the counters are
    // equal — exactly what bumpGeometryEpoch() keeps them while no
    // single-counter bump has drifted them apart. Pure arithmetic, no state.
    result.xorBlindWhenEqual = (5 ^ 5) === (6 ^ 6);

    // Edit that only bumps BOTH counters (bumpGeometryEpoch) — must invalidate.
    const before = [cm._geometryEpoch || 0, cv._geometryEpoch || 0];
    const cacheRef = r._stableSceneCache;
    cv.bumpGeometryEpoch();
    const after = [cm._geometryEpoch || 0, cv._geometryEpoch || 0];
    result.bothCountersMoved = before[0] !== after[0] && before[1] !== after[1];
    result.staleRejected = !r._epochKeyMatches(cacheRef.geometryEpochs, cv);
    result.stableSceneRejected = r._tryRenderFromStableScene() === false;

    // A fresh render after the bump must capture a valid cache again.
    render(); await sleep(120);
    result.recapturedValid = !!r._stableSceneCache && r._epochKeyMatches(r._stableSceneCache.geometryEpochs, cv);

    // A bump of the CURVE MANAGER counter alone (manager.js does this) must
    // invalidate too — the tuple key catches either counter, the XOR did not.
    const cacheRef2 = r._stableSceneCache;
    cm._geometryEpoch = (cm._geometryEpoch || 0) + 1;
    result.singleCounterRejected = !r._epochKeyMatches(cacheRef2.geometryEpochs, cv);

    // And with no change at all, the cache must stay reusable (no needless full redraw).
    render(); await sleep(120);
    result.reuseWhenUnchanged = r._tryRenderFromStableScene() === true;
    return result;
})()`);

if (out && out.__exc) { console.log('probe threw: ' + out.__exc); process.exit(1); }

const checks = [
    { name: 'stable scene captured by a full render', ok: out.cacheCaptured === true },
    { name: 'cache valid immediately after capture', ok: out.validImmediately === true },
    { name: 'bumpGeometryEpoch moves both counters', ok: out.bothCountersMoved === true },
    { name: 'XOR key is blind while both counters are equal (regression context)', ok: out.xorBlindWhenEqual === true },
    { name: 'cache rejected after the bump (either counter changed ⇒ stale)', ok: out.staleRejected === true },
    { name: 'stable-scene blit rejected after the bump', ok: out.stableSceneRejected === true },
    { name: 're-render captures a valid cache again', ok: out.recapturedValid === true },
    { name: 'cache rejected when only one counter moved', ok: out.singleCounterRejected === true },
    { name: 'cache reused when nothing changed', ok: out.reuseWhenUnchanged === true }
];
console.log(JSON.stringify({ tag: 'stable-scene-invalidation', out, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
