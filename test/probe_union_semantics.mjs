// Union semantics regression suite.
//
// Drives the real BooleanEngine._resolveUnion (js/core/boolean.js) with
// synthetic rings — no full app boot needed — and checks the measured
// paper.js invariants the union depends on:
//   - a hole drawn as its own reversed path stays a hole
//   - overlapping same-direction fills merge
//   - a fill crossing a hole consumes it where they overlap
//   - nested same-direction rings are solid
//   - self-intersecting rings resolve into their nonzero lobes
//
// Metric: the SIGNED area sum of the resulting rings = the nonzero region.
const WebSocket = (await import('ws')).default;
import { probePorts } from './probe_env.mjs';

const { port: PORT, srv: SRV } = probePorts();

for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let id = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalp = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/test/union_semantics_page.html?v=${Date.now()}` });
for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await evalp('!!window.__res || !!window.__err')) break;
}
const pageErr = await evalp('window.__err');
const res = await evalp('window.__res') || {};

const checks = [];
if (pageErr) {
    checks.push({ name: 'page-boot', ok: false, detail: String(pageErr).slice(0, 300) });
} else {
    for (const [name, v] of Object.entries(res)) {
        // Keys starting with "_" are recorded measurements of paper.js itself, not
        // assertions of this engine: they are printed, never failed on.
        if (name.startsWith('_')) {
            checks.push({ name, ok: true, detail: `measured: signed=${v.signed} rings=${v.rings} areas=${JSON.stringify(v.areas)}` });
            continue;
        }
        const areaOk = typeof v.gotSigned === 'number' && Math.abs(v.gotSigned - v.want) < 1;
        const ringsOk = v.wantRings == null || v.gotRings === v.wantRings;
        const ok = areaOk && ringsOk && !v.err;
        checks.push({
            name,
            ok,
            detail: v.err ? String(v.err).slice(0, 200)
                : `signed=${v.gotSigned} want=${v.want} rings=${v.gotRings}${v.wantRings == null ? '' : ' want=' + v.wantRings}`,
        });
    }
}

const failed = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`);
console.log(JSON.stringify({ checks, passed: checks.length - failed, total: checks.length, failedCount: failed }, null, 2));

ws.close();
process.exit(failed === 0 && checks.length > 0 ? 0 : 1);
