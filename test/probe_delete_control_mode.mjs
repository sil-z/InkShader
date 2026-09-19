// Deleting a control point must change the owning node's control_mode.
//
// Drives the real CurveStore.deleteControlNode on synthetic curves and asserts
// the mode the node is left in. Spec: 0=corner, 1=smooth (two collinear
// handles), 2=symmetric (two mirrored handles) — a node left with fewer than
// two handles satisfies neither, so it degrades to corner.
//
// Regression guard for two bugs:
//   - a corner node was promoted to smooth just for losing a handle
//   - a smooth/symmetric node kept its mode after losing a handle
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
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/test/delete_control_mode_page.html?v=${Date.now()}` });
for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await evalp('!!window.__res || !!window.__err')) break;
}
const pageErr = await evalp('window.__err');
const res = await evalp('window.__res') || {};

const checks = [];
if (pageErr) {
    checks.push({ name: 'page-boot', ok: false, detail: String(pageErr).slice(0, 300) });
} else {
    for (const [name, v] of Object.entries(res)) {
        checks.push({
            name,
            ok: !!v.ok,
            detail: `mode=${v.got} want=${v.want}${v.handlesLeft == null ? '' : ` handlesLeft=${v.handlesLeft}`}`,
        });
    }
}

const failed = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`);
console.log(JSON.stringify({ checks, passed: checks.length - failed, total: checks.length, failedCount: failed }, null, 2));

ws.close();
process.exit(failed === 0 && checks.length > 0 ? 0 : 1);
