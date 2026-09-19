// Regression suite for the smart-expand outline DIRECTION invariant.
//
// The user-facing "Stroke Direction" property (curve.smart_stroke_clockwise) must
// reach the cached boolean geometry: the outer contour of a smart expand must come
// out clockwise when the flag is true and counter-clockwise when it is false, and
// that direction must not change when the geometry is merely nudged.
//
// Measured on example/bug_test.json, whose Path_4 / Path_5 are 2-node closed loops
// whose control points make them self-intersect. Those are the shapes where the
// cache's region-preservation guard around `reorient` could silently drop the
// requested direction and leave it to whatever Paper's booleans happened to
// produce — which is what made the rendered winding (and therefore whether two
// overlapping objects cancel) flip between edits.
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9233);
const SRV = Number(process.env.PROBE_SRV || 8141);
const APP = `http://127.0.0.1:${SRV}/index.html?v=smartdir-${Date.now()}`;
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const inkErrors = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        const t = (m.params.args || []).map(a => a.value ?? a.description).join(' ');
        if (t.includes('[InkShader:')) inkErrors.push(t.slice(0, 200));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 700) };
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
    const { getPaperScope } = await import('/js/core/paper_scope.js');
    const pScope = getPaperScope();
    try { localStorage.removeItem('__ink_error_log'); } catch (e) { }
    window.__inkErrorLog.length = 0;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);

    const byId = {}; for (const c of cm.curveStore.curves) byId[c.id] = c;
    const paths = ['Path_4', 'Path_5'].map(id => byId[id]).filter(Boolean);

    // Rebuild the cache with a given flag and report the paper area of every ring.
    const build = (curve, cw) => {
        curve.smart_stroke_clockwise = cw;
        curve.invalidateBooleanCache();
        curve.updateBooleanCache();
        const g = curve.cached_boolean_geometry || [];
        return g.map(r => {
            const p = new pScope.Path({ closed: true });
            for (const s of r.segments) p.add(new pScope.Segment(new pScope.Point(s.x, s.y), new pScope.Point(s.inX, s.inY), new pScope.Point(s.outX, s.outY)));
            const area = p.area;
            p.remove();
            return area;
        });
    };

    const directionRows = [];
    for (const c of paths) {
        if (!c || !c.closed || !c.smart_stroke || !(c.stroke_width > 0)) continue;
        const ccw = build(c, false);
        const cw = build(c, true);
        directionRows.push({
            id: c.id,
            ccwRings: ccw.length, ccwAreas: ccw.map(a => Math.round(a)), ccwSigns: ccw.map(a => (a > 0 ? '+' : '-')).join(''),
            cwRings: cw.length, cwAreas: cw.map(a => Math.round(a)), cwSigns: cw.map(a => (a > 0 ? '+' : '-')).join(''),
            // region must not change when only the direction flips: |sum| equal and
            // the outermost ring changes sign.
            sameAbsArea: ccw.length > 0 && cw.length > 0
                && Math.abs(Math.abs(ccw[0]) - Math.abs(cw[0])) <= Math.max(50, Math.abs(ccw[0]) * 0.001),
            flipped: ccw.length > 0 && cw.length > 0 && Math.sign(ccw[0]) === -Math.sign(cw[0])
        });
    }

    // Direction stability under node nudges (the reported "hole appears / disappears").
    const stabilityRows = [];
    for (const c of paths) {
        if (!c) continue;
        c.smart_stroke_clockwise = false;
        const base = [];
        let n = c.startNode, seen = new Set();
        while (n && !seen.has(n)) { seen.add(n); base.push([n, n.x, n.y]); n = n.nextOnCurve; }
        const signs = [];
        for (let k = 0; k <= 8; k++) {
            for (const [node, x, y] of base) node.y = y + k * 3;
            const areas = build(c, false);
            signs.push(areas.map(a => (a > 0 ? '+' : '-')).join('') + '|' + areas.length);
        }
        for (const [node, x, y] of base) node.y = y;
        stabilityRows.push({ id: c.id, signs, stable: signs.every(s => s === signs[0]) });
    }

    // The union / expand result keeps smart_stroke but has stroke_width 0. Its cached
    // outline is the operand the union engine reads next, so it must carry the
    // declared Stroke Direction like any other smart path.
    const treeIdOf = (curve) => { for (const [id, item] of cm.treeItems) if (item.type === 'curve' && item.curveId === curve.id) return id; return null; };
    const byId2 = {}; for (const c of cm.curveStore.curves) byId2[c.id] = c;
    const D = await import('/js/app/canvas_dispatcher.js');
    const sel = ['Path_4', 'Path_5'].map(n => byId2[n]).filter(Boolean).map(treeIdOf).filter(Boolean);
    D.CanvasDispatcher.requestSetTreeSelection(sel, 'zero');
    await sleep(300);
    const unionOk = cv.commands.booleanUnionSelectedCurves();
    await sleep(800);
    const made = cm.curveStore.curves.filter(c => c.id && c.id.startsWith('Bool_'));
    const unionResult = made.map(c => {
        c.invalidateBooleanCache(); c._booleanEmptyHash = null; c.updateBooleanCache();
        const areas = (c.cached_boolean_geometry || []).map(r => {
            const p = new pScope.Path({ closed: true });
            for (const s of r.segments) p.add(new pScope.Segment(new pScope.Point(s.x, s.y), new pScope.Point(s.inX, s.inY), new pScope.Point(s.outX, s.outY)));
            const a = p.area; p.remove(); return a;
        });
        return {
            id: c.id, smart: !!c.smart_stroke, strokeWidth: c.stroke_width,
            cw: c.smart_stroke_clockwise !== false,
            rings: areas.length, areas: areas.map(a => Math.round(a)),
            signs: areas.map(a => (a > 0 ? '+' : '-')).join('')
        };
    });

    return { directionRows, stabilityRows, unionOk: !!unionOk, unionResult, inkErrorCount: window.__inkErrorLog.length, messages: window.__inkErrorLog.map(e => (e.message || '').slice(0, 120)) };
})()`);

if (out && out.__exc) {
    console.log('FAIL probe threw: ' + out.__exc);
    console.log(JSON.stringify({ tag: 'smart-direction', checks: [{ name: 'probe executed', ok: false }] }));
    ws.close();
    process.exit(1);
}

const checks = [];
checks.push({ name: 'measured two self-intersecting smart paths', ok: (out.directionRows || []).length >= 2 });
for (const r of out.directionRows || []) {
    checks.push({ name: `${r.id}: stroke direction "counter-clockwise" yields a negative outer ring`, ok: r.ccwRings > 0 && r.ccwSigns[0] === '-' , got: r.ccwSigns });
    checks.push({ name: `${r.id}: stroke direction "clockwise" yields a positive outer ring`, ok: r.cwRings > 0 && r.cwSigns[0] === '+', got: r.cwSigns });
    checks.push({ name: `${r.id}: flipping the direction preserves the region`, ok: r.sameAbsArea });
}
for (const r of out.stabilityRows || []) {
    checks.push({ name: `${r.id}: cached direction is stable across node edits`, ok: r.stable, got: r.signs });
}
for (const r of out.unionResult || []) {
    const want = r.cw ? '+' : '-';
    checks.push({
        name: `union result (${r.id}) carries its declared stroke direction (${r.cw ? 'clockwise' : 'counter-clockwise'})`,
        ok: r.rings > 0 && r.signs[0] === want,
        got: r.signs
    });
}
checks.push({ name: 'union of two counter-clockwise objects produced a result', ok: (out.unionResult || []).length > 0 });
checks.push({ name: 'no boolean cache error reports', ok: (out.inkErrorCount || 0) === 0 && inkErrors.filter(t => t.includes('boolean_geometry_cache')).length === 0 });

console.log(JSON.stringify({ tag: 'smart-direction', directionRows: out.directionRows, stabilityRows: out.stabilityRows, unionResult: out.unionResult, checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
