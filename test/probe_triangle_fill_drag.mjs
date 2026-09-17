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
// 三角形内部在“还没画任何东西”时的深色像素数：模板自带的字形会落在同一片区域，
// 必须扣掉这个底数，delta 才是新画路径自己画出来的填充。
let triBase = null;

// 用“拖动落点”的方式画（这是用户说的“拖动新节点”）：
// 每次 press→move→release 都会把刚落下的主节点拉出控制柄（PAINTING_HANDLE）。
const drag = async (x0, y0, x1, y1, onFrame) => {
    await hover(x0, y0);
    await press(x0, y0);
    await sleep(140);
    if (onFrame) await onFrame(0);
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
        await moveTo(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
        await sleep(130);
        if (onFrame) await onFrame(i);
    }
    await release(x1, y1);
    await sleep(300);
};

const out = { baseTotal, steps: [], checks: [] };
const snap = async (label, tri) => {
    const s = await evalp(`(async () => {
        const cur = window.__canvas.current_curve;
        const count = (node) => { let k = 0, p = node, seen = new Set(); while (p && !seen.has(p)) { seen.add(p); k++; if (p === cur.endNode) break; p = p.nextOnCurve; } return k; };
        return {
            label: ${JSON.stringify(label)},
            tri: window.__T.triFill(${JSON.stringify(tri[0])}, ${JSON.stringify(tri[1])}, ${JSON.stringify(tri[2])}),
            total: window.__T.total(),
            gesture: window.__canvas.current_state,
            current: cur ? { id: cur.id, closed: !!cur.closed, nodes: count(cur.startNode), endNode: !!cur.endNode, sw: cur.stroke_width, cache: Array.isArray(cur.cached_boolean_geometry) ? cur.cached_boolean_geometry.length : (cur.cached_boolean_geometry === null ? null : 'na'), match: cur._booleanContentHash === cur.getGeometryHash() } : null
        };
    })()`);
    s.triDelta = triBase ? s.tri.insideDark - triBase.insideDark : null;
    s.triFillOfNewPath = triBase && s.tri.insidePx ? +(s.triDelta / s.tri.insidePx).toFixed(4) : null;
    out.steps.push(s); return s;
};

const push = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });

const A = { x: Math.round(rect.l + rect.w * 0.20), y: Math.round(rect.t + rect.h * 0.20) };
const B = { x: Math.round(rect.l + rect.w * 0.74), y: Math.round(rect.t + rect.h * 0.26) };
const C0 = { x: Math.round(rect.l + rect.w * 0.46), y: Math.round(rect.t + rect.h * 0.78) };

// 先把默认文档里已有的路径全部删掉：画布是透明的（白纸来自 CSS），模板自带的字形
// 会把我这个测试三角形区域整块盖成黑色，delta 就失去了意义。
const cleared = await evalp(`(async () => {
    const D = await import('/js/app/canvas_dispatcher.js');
    const cm = window.__canvas.curve_manager;
    const ids = cm.curves.map(cv => cv.id);
    if (ids.length) D.CanvasDispatcher.requestDeleteSelectedObjects(ids);
    await new Promise(r => setTimeout(r, 800));
    return { deleted: ids.length, remaining: cm.curves.length, total: window.__T.total() };
})()`);
console.log('cleared:', JSON.stringify(cleared));
triBase = await evalp(`window.__T.triFill(${JSON.stringify(A)}, ${JSON.stringify(B)}, ${JSON.stringify(C0)})`);
out.triBase = triBase;
console.log('triBase:', JSON.stringify(triBase));
await drag(A.x, A.y, A.x + 30, A.y + 20);
await snap('node1 placed by drag', [A, B, C0]);
await drag(B.x, B.y, B.x - 30, B.y + 24);
await snap('node2 placed by drag', [A, B, C0]);
// 第三个节点：按住拖动 —— 此刻三角形已经闭合，内部应当有填充
const dragFrames = [];
await drag(C0.x, C0.y, C0.x + 20, C0.y - 26, async (i) => {
    const t = [{ x: A.x, y: A.y }, { x: B.x, y: B.y }, { x: C0.x, y: C0.y }];
    const s = await snap(`placing node3, drag frame ${i}`, t);
    dragFrames.push(s);
});
await snap('node3 placed', [A, B, C0]);
await click(C0.x + 20, C0.y - 26, 'right');
await sleep(1000);
await hover(A.x + 8, A.y + 8);
await sleep(300);
await snap('after finishing (reference)', [A, B, C0]);

const minFill = Math.min(...dragFrames.map(f => f.triFillOfNewPath));
push('while dragging the new node, the closed ring interior is filled by the new path (>=80%)', dragFrames.length > 0 && minFill >= 0.8,
    { minFill, triBase, frames: dragFrames.map(f => ({ label: f.label, fillOfNewPath: f.triFillOfNewPath, delta: f.triDelta, nodes: f.current?.nodes, cache: f.current?.cache, match: f.current?.match })) });
const lastStep = out.steps[out.steps.length - 1];
push('after finishing, interior filled by the new path (>=80%)', lastStep.triFillOfNewPath >= 0.8, { fillOfNewPath: lastStep.triFillOfNewPath, tri: lastStep.tri });

out.failed = out.checks.filter(c => !c.ok).map(c => c.name);
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
