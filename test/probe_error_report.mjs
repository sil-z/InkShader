// 布尔缓存「不变量」回归探针（不再用人为构造的假失败来测报错通道 —— 那部分由
// test/probe_error_dialog.mjs 直接测 reportFatalError 覆盖）。
//
// 这里断言的是报错的**触发条件**本身：
//   A) 钢笔刚落下第一个节点（startNode 有、endNode 为 null、链上一个线段都没有）
//      → 没有任何可画几何 = 合法状态，不报错、缓存保持空（这条就是用户遇到的
//      「一尝试绘制新路径就立刻弹 smart expand: no geometry generated」）。
//   B) 同一几何反复重建 → 依然不报错（不发散、不刷屏）。
//   C) 开放路径 + smart_stroke 但 stroke_width=0 / 或 smart 关闭 → 既没有填充环也没有
//      描边带 = 该缓存对它不适用，静默保持空。
//   D) 真实有几何的形状（闭合 smart 环、含描边带）→ 必须产出非空缓存，且不报错。
//   E) 示例工程 → 所有 smart 曲线缓存非空，零弹窗、零日志。
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';

const PORT = Number(process.env.PROBE_PORT || 9227);
const SRV = Number(process.env.PROBE_SRV || 8140);
const APP = `http://127.0.0.1:${SRV}/index.html?v=cacheinv-${Date.now()}`;
const EXAMPLE = exampleProject();
const jsonText = readFileSync(EXAMPLE, 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const consoleErrors = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 600) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
// 报错对话框会同步弹出并阻塞：探针里改成 silent 记录（window.alert 也接管）
await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };
             window.confirm = () => true; window.prompt = () => null;
             // 尽早接管 console.error（早于任何页面脚本），才能捕获启动阶段的报错
             window.__phase = 'pre-boot';
             window.__inkConsoleErrors = [];
             (function () {
                 const orig = console.error;
                 console.error = function (...a) {
                     const text = a.map(x => String(x && x.message || x)).join(' ');
                     if (text.includes('[InkShader:')) window.__inkConsoleErrors.push({ phase: window.__phase, text: text.slice(0, 220) });
                     return orig.apply(this, a);
                 };
             })();`
});
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

await evalp(`(window.__phase = 'boot-settled', true)`);

const R = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const node = (x, y) => ({ x, y, smooth: false, control_mode: 0, control1: null, control2: null, nextOnCurve: null });
    const groupId = cm.treeItems.has('A') ? 'A' : [...cm.treeItems.values()].find(i => i.type === 'group' && !i.isRef)?.id;
    const created = [];
    const mkCurve = (nodes, closed, sw, smart) => {
        for (let i = 0; i < nodes.length - 1; i++) nodes[i].nextOnCurve = nodes[i + 1];
        const c = cm.cloneCurveToGroup({
            startNode: nodes[0],
            endNode: nodes.length > 1 ? nodes[nodes.length - 1] : null,
            closed, stroke_width: sw, smart_stroke: smart, visible: true, locked: false
        }, groupId);
        created.push(c.id);
        return c;
    };
    const reset = () => {
        window.__inkErrorLog.length = 0;
        document.querySelectorAll('.ink-error-overlay').forEach(n => n.remove());
    };
    const observe = (label, c) => {
        const entries = window.__inkErrorLog.slice();
        return {
            label,
            rings: Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry.length : null,
            logs: entries.length,
            messages: entries.map(e => e.message),
            hashes: entries.map(e => e.detail && e.detail.geometryHash).filter(h => h !== undefined),
            dialogs: document.querySelectorAll('.ink-error-overlay').length
        };
    };
    // 直接走缓存重建（等价于渲染循环里的 ensureBooleanCache 会做的事），
    // 并额外让渲染帧跑一遍，确保渲染路径也覆盖到。
    const rebuild = async (c, label) => {
        reset();
        c._lastHash = null; c._booleanContentHash = null; c._booleanEmptyHash = null;
        c.updateBooleanCache();
        cv.is_dirty = true;
        await sleep(350);
        return observe(label, c);
    };

    const out = {};
    out.bootInkErrors = window.__inkConsoleErrors.slice();
    // A) 真实命令层（钢笔点第一下）：1 个节点、endNode 为 null、链上无任何线段
    window.__phase = 'A-pen-first-node';
    cv.drawToolSettings.stroke_width = 16; cv.drawToolSettings.closed = true; cv.drawToolSettings.smart_expand = true;
    cv.commands.syncActiveGroupForDraw(groupId);
    cv.commands.startAddingPath(groupId, 0);
    cv.commands.addMainNode(200, 100);
    const pen = cv.commands.current_curve;
    out.a_singleNode = await rebuild(pen, 'A pen first node');
    out.a_singleNode.endNodeNull = pen.endNode === null;
    out.a_singleNode.skeletonSegments = pen.getSkeletonBezierSegments().length;
    // B) 同一几何反复重建（渲染循环每帧都会校验）
    window.__phase = 'B-repeat';
    reset();
    pen._lastHash = null; pen._booleanEmptyHash = null; pen.updateBooleanCache();
    pen._lastHash = null; pen._booleanEmptyHash = null; pen.updateBooleanCache();
    await sleep(300);
    out.b_repeatSameGeometry = observe('B repeated rebuild of 1-node curve', pen);

    // C) 有线段但该缓存不适用的两种曲线
    window.__phase = 'C-open-paths';
    const openSmartZero = mkCurve([node(100, 100), node(300, 120), node(200, 400)], false, 0, true);
    out.c_openSmartZeroWidth = await rebuild(openSmartZero, 'C1 open smart sw0');
    const openPlainWide = mkCurve([node(500, 100), node(700, 120), node(600, 400)], false, 8, false);
    out.c_openPlainWide = await rebuild(openPlainWide, 'C2 open plain sw8');

    // D) 真实几何（同一支钢笔继续点第二下）：有线段，必须产出非空缓存
    window.__phase = 'D-pen-second-node';
    reset();
    cv.commands.addMainNode(600, 400);
    pen.invalidateBooleanCache(); pen._booleanEmptyHash = null;
    pen.updateBooleanCache();
    cv.is_dirty = true;
    await sleep(500);
    out.d_penSecondNode = observe('D pen second node (2-node closed smart sw16)', pen);
    out.d_penSecondNode.endNodeNull = pen.endNode === null;
    out.d_penSecondNode.skeletonSegments = pen.getSkeletonBezierSegments().length;
    reset();
    await cv.commands.finishAddingPathCommand();
    pen.invalidateBooleanCache(); pen._booleanEmptyHash = null;
    pen.updateBooleanCache();
    cv.is_dirty = true;
    await sleep(500);
    out.d_penFinished = observe('D2 pen path finished', pen);

    // E) 合成几何：闭合 smart 三角环（3 节点）
    window.__phase = 'E-closed-ring';
    const tri = mkCurve([node(1200, 100), node(1500, 200), node(1300, 500)], true, 16, true);
    out.e_closedSmartRing = await rebuild(tri, 'E closed smart 3-node ring sw16');
    // 退化：两个节点重合的闭合环（信息性，不断言）
    window.__phase = 'X-coincident';
    const coincident = mkCurve([node(2400, 100), node(2400, 100)], true, 16, true);
    out.x_coincidentRing = await rebuild(coincident, 'X closed smart coincident nodes');

    for (const id of created) { try { cm.treeStore.deleteTreeItem(id); } catch (e) { out.cleanupErr = String(e).slice(0, 120); } }
    try { cm.treeStore.deleteTreeItem(pen.id); } catch (e) { }
    try { cm.notifyTreeUpdate(); } catch (e) { }
    return out;
})()`);

// ---------- E) 示例工程不得报错 ----------
const E = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    window.__phase = 'F-example-project';
    window.__inkErrorLog.length = 0;
    document.querySelectorAll('.ink-error-overlay').forEach(n => n.remove());
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1800);
    cv.is_dirty = true;
    await sleep(1200);
    const out = { smartCurves: 0, rings: [], emptyHash: 0 };
    for (const c of cm.curveStore.curves) {
        if (!c.smart_stroke) continue;
        out.smartCurves++;
        out.rings.push(Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry.length : null);
        if (c._booleanEmptyHash) out.emptyHash++;
    }
    out.logs = window.__inkErrorLog.length;
    out.messages = window.__inkErrorLog.map(e => e.message);
    out.dialogs = document.querySelectorAll('.ink-error-overlay').length;
    return out;
})()`);

await new Promise(r => setTimeout(r, 500));

const A = R.a_singleNode || {}, B = R.b_repeatSameGeometry || {};
const C1 = R.c_openSmartZeroWidth || {}, C2 = R.c_openPlainWide || {};
const D = R.d_penSecondNode || {}, D2 = R.d_penFinished || {}, E1 = R.e_closedSmartRing || {}, X = R.x_coincidentRing || {};
const inkErrors = consoleErrors.filter(t => t.includes('[InkShader:'));
const allInkErrors = await evalp(`window.__inkConsoleErrors`) || [];

const checks = [
    { name: 'A: pen first node has endNode=null and no skeleton segment', ok: A.endNodeNull === true && A.skeletonSegments === 0 },
    { name: 'A: "nothing to draw yet" is silent (0 log entries)', ok: A.logs === 0 },
    { name: 'A: no error dialog', ok: A.dialogs === 0 },
    { name: 'A: cache stays empty', ok: A.rings === null },
    { name: 'B: rebuilding the same 1-node geometry stays silent', ok: B.logs === 0 && B.dialogs === 0 },
    { name: 'C1: open smart path with width 0 is silent', ok: C1.logs === 0 && C1.rings === null },
    { name: 'C2: open plain path with width 8 is silent', ok: C2.logs === 0 && C2.rings === null },
    { name: 'D: pen second node (2-node closed smart path) caches rings', ok: D.rings >= 1 && D.logs === 0 },
    { name: 'D2: finished 2-node pen path keeps its rings', ok: D2.rings >= 1 && D2.logs === 0 },
    { name: 'E: closed smart 3-node ring caches a non-empty ring set', ok: E1.rings >= 1 && E1.logs === 0 },
    // 不写死曲线条数：示例工程会随编辑增减，断言的是「每条 smart 曲线都有环」这个不变量。
    { name: 'F: every smart curve of the example project has rings', ok: E.smartCurves >= 1 && E.rings.length === E.smartCurves && E.rings.every(n => n >= 1) },
    { name: 'F: example project reports nothing', ok: E.logs === 0 && E.dialogs === 0 },
    { name: 'no InkShader error reports anywhere in the session', ok: inkErrors.length === 0 && allInkErrors.length === 0 }
];

console.log(JSON.stringify({
    tag: 'boolean-cache-invariant',
    detail: { R, E, consoleErrors: consoleErrors.slice(0, 6) },
    informational: {
        coincidentRing: X, cdpInkErrors: inkErrors, bootInkErrors: R.bootInkErrors,
        allInkErrors,
        cdpConsoleErrors: consoleErrors.slice(0, 8)
    },
    message: undefined,
    checks, failed: checks.filter(c => !c.ok).length
}, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
