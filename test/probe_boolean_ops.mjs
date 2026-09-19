// Regression suite: the non-union boolean operations (subtract / intersect /
// exclude) are REGION-based set operations. Their result must depend only on
// which points each operand encloses, never on the winding direction an operand
// was drawn with. That is exactly what makes them different from union, which
// must reproduce the selection's rendered, winding-sensitive appearance.
//
// Metric: the rasterized NONZERO REGION in square units (1 px == 1 unit).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { probePorts, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const { port: PORT, srv: SRV } = probePorts();

for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
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
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/test/boolean_ops_page.html?v=${Date.now()}` });
for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await evalp('!!window.__res || !!window.__err')) break;
}
const pageErr = await evalp('window.__err');
const res = await evalp('window.__res') || {};
try { writeFileSync(path.join(TMP_DIR, 'boolean_ops_raw.json'), JSON.stringify(res, null, 2)); } catch { }

const filledOf = (k) => (res[k] && !res[k].err && typeof res[k].filled === 'number') ? res[k].filled : null;
const ringsOf = (k) => (res[k] && !res[k].err) ? res[k].rings : null;
const TOL = 60; // rasterization / boundary rounding
const checks = [];
if (pageErr) {
    checks.push({ name: 'page-boot', ok: false, detail: String(pageErr).slice(0, 300) });
} else {
    const near = (name, got, want) => checks.push({
        name, ok: got != null && Math.abs(got - want) <= TOL, detail: `got=${got} want≈${want}`,
    });
    const same = (name, a, b) => checks.push({
        name, ok: a != null && a === b, detail: `${a} vs ${b}`,
    });

    near('operand A region', filledOf('operandA'), 40000);
    // Region algebra on two half-overlapping 200x200 squares (overlap 20000).
    near('subtract_sameDir', filledOf('subtract_sameDir'), 20000);
    near('subtract_oppositeDir', filledOf('subtract_oppositeDir'), 20000);
    near('subtract_reversedBase', filledOf('subtract_reversedBase'), 20000);
    near('intersect_sameDir', filledOf('intersect_sameDir'), 20000);
    near('intersect_oppositeDir', filledOf('intersect_oppositeDir'), 20000);
    near('exclude_sameDir', filledOf('exclude_sameDir'), 40000);
    near('exclude_oppositeDir', filledOf('exclude_oppositeDir'), 40000);

    // The decisive assertions: direction of an operand changes nothing.
    same('subtract orientation-independent', filledOf('subtract_sameDir'), filledOf('subtract_oppositeDir'));
    same('intersect orientation-independent', filledOf('intersect_sameDir'), filledOf('intersect_oppositeDir'));
    same('exclude orientation-independent', filledOf('exclude_sameDir'), filledOf('exclude_oppositeDir'));

    // An operand's own hole survives a binary op.
    near('donut operand keeps its hole', filledOf('donutHole_operand'), 30000);
    near('donut - cutter', filledOf('donutHole_minusCutter'), 8000);
    near('donut (same-dir inner) - cutter', filledOf('donutHole_minusCutter_sameDirInner'), 8000);
    near('donut & cutter', filledOf('donutHole_intersectCutter'), 22000);

    console.log(`rings: subtract=${ringsOf('subtract_sameDir')} intersect=${ringsOf('intersect_sameDir')} exclude=${ringsOf('exclude_sameDir')} donut=${ringsOf('donutHole_operand')}`);
    console.log('operand-consumption: ' + JSON.stringify({
        afterIntersect: res.afterIntersect, afterSubtract: res.afterSubtract,
        afterExclude: res.afterExclude, reuseBothBases: res.reuseBothBases,
    }));
}

const failed = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`);
console.log(JSON.stringify({ checks, passed: checks.length - failed, total: checks.length, failedCount: failed }, null, 2));
ws.close();
process.exit(failed === 0 && checks.length > 0 ? 0 : 1);
