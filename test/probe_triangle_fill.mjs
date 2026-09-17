// 判定「新画的闭合 smart 路径到底有没有被填」：
// 用点击的三个屏幕点组成三角形，直接数三角形内部的“不透明深色像素”
// （画布是透明的，白纸来自 CSS；必须先按 alpha 过滤，否则透明底会被算成黑色）。
// 然后再拖动其中一个节点，逐帧重复同样的计数。
const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9231);
const SRV = Number(process.env.PROBE_SRV || 8138);
const APP = `http://127.0.0.1:${SRV}/index.html?v=trifill-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hover = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
const press = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
const release = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
const moveTo = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
const click = async (x, y, button = 'left') => {
    await hover(x, y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
    await sleep(350);
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true;` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(7000);

const HELPERS = `(() => {
    const c = window.__canvas;
    window.__T = {
        // 三角形内部的“不透明深色像素”比例（客户端坐标 → 设备像素）
        triFill(p1, p2, p3) {
            const el = c.canvasObj;
            const r = el.getBoundingClientRect();
            const { width: uw, height: uh } = c.viewportService.getCanvasUserSpaceSize();
            const dpr = c.viewportConfig.devicePixelRatio || 1;
            const toDev = (x, y) => ({ x: (x - r.left) * (uw / r.width) * dpr, y: (y - r.top) * (uh / r.height) * dpr });
            const A = toDev(p1.x, p1.y), B = toDev(p2.x, p2.y), C = toDev(p3.x, p3.y);
            const minX = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)));
            const maxX = Math.min(el.width, Math.ceil(Math.max(A.x, B.x, C.x)));
            const minY = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)));
            const maxY = Math.min(el.height, Math.ceil(Math.max(A.y, B.y, C.y)));
            if (maxX <= minX || maxY <= minY) return { error: 'empty box' };
            const d = c.ctx.getImageData(minX, minY, maxX - minX, maxY - minY).data;
            const w = maxX - minX;
            const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
            let inside = 0, insideDark = 0, insideOpaque = 0;
            for (let y = minY; y < maxY; y++) {
                for (let x = minX; x < maxX; x++) {
                    const d1 = sign(x + 0.5, y + 0.5, A.x, A.y, B.x, B.y);
                    const d2 = sign(x + 0.5, y + 0.5, B.x, B.y, C.x, C.y);
                    const d3 = sign(x + 0.5, y + 0.5, C.x, C.y, A.x, A.y);
                    const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
                    const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
                    if (neg && pos) continue;
                    inside++;
                    const i = ((y - minY) * w + (x - minX)) * 4;
                    if (d[i + 3] > 128) {
                        insideOpaque++;
                        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140) insideDark++;
                    }
                }
            }
            return { insidePx: inside, insideOpaque, insideDark, fillRatio: inside ? +(insideDark / inside).toFixed(4) : null };
        },
        total() {
            const d = c.ctx.getImageData(0, 0, c.canvasObj.width, c.canvasObj.height).data;
            let dark = 0, opaque = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] > 128) { opaque++; if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140) dark++; }
            }
            return { dark, opaque };
        },
        curveInfo(curveId) {
            const cm = c.curve_manager;
            const cv = cm.curveById.get(curveId) || cm.curves.find(x => x.id === curveId);
            if (!cv) return { missing: true };
            let k = 0, p = cv.startNode, seen = new Set();
            while (p && !seen.has(p)) { seen.add(p); k++; if (p === cv.endNode) break; p = p.nextOnCurve; }
            return {
                curveId, gesture: c.current_state, closed: !!cv.closed, startEqEnd: cv.startNode === cv.endNode, endNode: !!cv.endNode,
                smart: !!cv.smart_stroke, sw: cv.stroke_width, nodes: k, visible: cv.visible !== false,
                cache: Array.isArray(cv.cached_boolean_geometry) ? cv.cached_boolean_geometry.length : (cv.cached_boolean_geometry === null ? null : 'na'),
                cacheMatch: cv._booleanContentHash === cv.getGeometryHash(),
                strokePreview: !!c.isCurveInInteractiveStrokePreview(cv.id),
                node0: { x: +cv.startNode.x.toFixed(2), y: +cv.startNode.y.toFixed(2) }
            };
        }
    };
    return true;
})()`;
await evalp(HELPERS);

const setup = await evalp(`(async () => {
    const D = await import('/js/app/canvas_dispatcher.js');
    const cm = window.__canvas.curve_manager;
    const groups = [...cm.treeItems.values()].filter(i => i.type === 'group' && !i.isRef);
    const target = groups.find(g => !g.hidden_by_sequence) || groups[0] || null;
    if (target) { D.CanvasDispatcher.requestSetTreeSelection([target.id], target.id); await new Promise(r => setTimeout(r, 250)); }
    D.CanvasDispatcher.requestSetToolMode('DRAW');
    await new Promise(r => setTimeout(r, 300));
    const c = window.__canvas;
    c.drawToolSettings.stroke_width = 16; c.drawToolSettings.closed = true; c.drawToolSettings.smart_expand = true; c.is_dirty = true;
    D.CanvasDispatcher.requestSetTreeSelection([], null);
    await new Promise(r => setTimeout(r, 200));
    return { tool: c.editorStore.getState().currentTool, scale: c.scale };
})()`);
console.log('setup:', JSON.stringify(setup));

const rect = await evalp(`(() => { const r = window.__canvas.canvasObj.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
const P1 = { x: Math.round(rect.l + rect.w * 0.20), y: Math.round(rect.t + rect.h * 0.20) };
const P2 = { x: Math.round(rect.l + rect.w * 0.72), y: Math.round(rect.t + rect.h * 0.26) };
const P3 = { x: Math.round(rect.l + rect.w * 0.42), y: Math.round(rect.t + rect.h * 0.76) };
const out0 = { rect, P1, P2, P3 };
console.log('points:', JSON.stringify(out0));

const baseTotal = await evalp(`window.__T.total()`);
// 清空默认文档里已有的路径（画布透明，模板字形会把测试三角区整块盖成黑色，
// 导致“内部深色像素”无法归因给新画的路径）。
const cleared = await evalp(`(async () => {
    const D = await import('/js/app/canvas_dispatcher.js');
    const cm = window.__canvas.curve_manager;
    const ids = cm.curves.map(cv => cv.id);
    if (ids.length) D.CanvasDispatcher.requestDeleteSelectedObjects(ids);
    await new Promise(r => setTimeout(r, 800));
    return { deleted: ids.length, remaining: cm.curves.length, total: window.__T.total() };
})()`);
console.log('cleared:', JSON.stringify(cleared));
let triBase = await evalp(`window.__T.triFill(${JSON.stringify(P1)}, ${JSON.stringify(P2)}, ${JSON.stringify(P3)})`);
await click(P1.x, P1.y);
await click(P2.x, P2.y);
await click(P3.x, P3.y);
await click(P3.x, P3.y, 'right');
await sleep(1000);
await hover(P3.x + 8, P3.y + 8);
await sleep(400);

const drawn = await evalp(`(() => { const cm = window.__canvas.curve_manager; const cv = cm.curves[cm.curves.length - 1]; return { id: cv.id, groupId: cv.groupId }; })()`);
const out = { baseTotal, cleared, triBase, drawn, steps: [], checks: [] };
const snap = async (label) => {
    const s = await evalp(`(async () => ({ label: ${JSON.stringify(label)}, tri: window.__T.triFill(${JSON.stringify(P1)}, ${JSON.stringify(P2)}, ${JSON.stringify(P3)}), total: window.__T.total(), ...window.__T.curveInfo(${JSON.stringify(drawn.id)}) }))()`);
    s.triDelta = s.tri.insideDark - triBase.insideDark;
    s.triFillOfNewPath = +(s.triDelta / s.tri.insidePx).toFixed(4);
    out.steps.push(s); return s;
};

await snap('settled right after drawing');
out.settled = out.steps[0];

// 拖动其中一个节点
await evalp(`(async () => { const D = await import('/js/app/canvas_dispatcher.js'); D.CanvasDispatcher.requestSetToolMode('NODE'); await new Promise(r => setTimeout(r, 350)); return true; })()`);
await hover(P1.x, P1.y);
await sleep(350);
await snap('hover node (NODE tool)');
await press(P1.x, P1.y);
await sleep(150);
await snap('mouse down');
for (let i = 1; i <= 5; i++) {
    await moveTo(P1.x + 9 * i, P1.y + 6 * i);
    await sleep(130);
    await snap(`drag frame ${i}`);
}
await release(P1.x + 45, P1.y + 30);
await sleep(1000);
await snap('after release');

const push = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const settled = out.steps[0];
push('newly drawn triangle is actually filled (>=80% of its interior painted)', settled.triFillOfNewPath >= 0.8, { fill: settled.triFillOfNewPath, tri: settled.tri });
const frames = out.steps.filter(s => s.label.startsWith('drag frame'));
push('no fill collapse during node drag (>=80% of interior painted each frame)',
    frames.length > 0 && frames.every(f => f.triFillOfNewPath >= 0.8),
    frames.map(f => ({ fill: f.triFillOfNewPath, sp: f.strokePreview, totalDark: f.total.dark })));
push('fill restored after release', out.steps[out.steps.length - 1].triFillOfNewPath >= 0.8, { fill: out.steps[out.steps.length - 1].triFillOfNewPath });
out.failed = out.checks.filter(c => !c.ok).map(c => c.name);
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
