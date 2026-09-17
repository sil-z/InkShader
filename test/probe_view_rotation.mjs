// 画布视图旋转（极简方案）端到端验证：真实鼠标/键盘事件 + 真实页面 + 真实几何。
//
// 方案：只旋转纸张层（#main_canvas_large = 点阵底 + 白纸 + 画布位图），标尺、
// 标尺指示线、锁定按钮、序列条、工具栏一律保持竖直（旋转时标尺刻度输出的坐标
// 不再对应屏幕位置，这是明确接受的取舍）。纸张层在旋转时被放大到面板的旋转
// 外接框并居中，所以旋转后画布仍然铺满面板、渲染区域 = 整个外接框，
// 而不会只剩一块更小的内接倾斜矩形。
//
//  A. 基线（0°）：没有任何元素带 transform；点节点能选中
//  B. 旋转只作用在纸张层：只有 #main_canvas_large 带 transform，且是纯旋转（scale=1）
//  C. 覆盖性：纸张层尺寸 = 面板旋转外接框；画布位图尺寸 = 该外接框；
//     面板四角逆旋转后落在纸张层矩形内（渲染区域完整，无空白角）
//  D. 坐标：local → client → getViewportMousePosition 往返 <0.01px（20°/90°）；
//     点节点旋转后的屏幕位置选中的仍是那个节点；点空白不选中任何节点
//  E. 平移：ctrl+拖动时 offset 增量 = R(-θ)·屏幕位移（跟随指针）
//  F. alt+滚轮：以 em 盒中心为锚点缩放（锚点屏幕漂移 ≈ 0）
//  G. alt+拖动旋转（绕面板中心）；alt+左右方向键 5° 步进并对齐 5 的倍数；alt+0 复位
//  H. 全程零 console 错误 / 零未捕获异常 / 零弹窗
//
// 运行前提：python test/probe_server.py 8140
//           msedge --headless=new --remote-debugging-port=9240 about:blank
//           PROBE_PORT=9240 PROBE_SRV=8140 node test/probe_view_rotation.mjs
const WebSocket = (await import('ws')).default;
import { readFileSync } from 'fs';
import { exampleProject } from './probe_env.mjs';
// 只读示例工程（绝不写回）：提供真实的曲线/节点/序列用于命中测试。
const EXAMPLE = exampleProject();
const exampleJson = readFileSync(EXAMPLE, 'utf8');

const PORT = Number(process.env.PROBE_PORT || 9240);
const SRV = Number(process.env.PROBE_SRV || 8140);
const APP = `http://127.0.0.1:${SRV}/index.html?v=rotsheet-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => { });
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
const consoleErrors = []; const pageExceptions = []; const dialogs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.description || a.value).join(' ').slice(0, 400));
    }
    if (m.method === 'Runtime.exceptionThrown') {
        pageExceptions.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 400));
    }
    if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(String(m.params.message || '').slice(0, 200));
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ed = r.result?.exceptionDetails;
    if (ed) return { __exc: (ed.exception?.description || ed.text || '').slice(0, 400) };
    return r.result?.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MOD = { Alt: 1, Ctrl: 2 };
let down = false;
const mouseDown = async (x, y, modifiers = 0, button = 'left') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1, modifiers });
    down = button === 'left';
};
const mouseMove = async (x, y, modifiers = 0) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0, modifiers });
    await sleep(30);
};
const mouseUp = async (x, y, modifiers = 0, button = 'left') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers });
    down = false;
    await sleep(170);
};
const click = async (x, y, modifiers = 0, button = 'left') => { await mouseDown(x, y, modifiers, button); await mouseUp(x, y, modifiers, button); await sleep(260); };
const drag = async (x0, y0, x1, y1, modifiers = 0, steps = 8) => {
    await mouseDown(x0, y0, modifiers);
    for (let i = 1; i <= steps; i++) await mouseMove(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, modifiers);
    await mouseUp(x1, y1, modifiers);
};
const wheel = async (x, y, deltaY, modifiers = 0) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers, pointerType: 'mouse', button: 'none', buttons: 0 });
    await sleep(200);
};
const key = async (code, keyStr, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyStr, windowsVirtualKeyCode: 0, modifiers, nativeVirtualKeyCode: 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr, windowsVirtualKeyCode: 0, modifiers, nativeVirtualKeyCode: 0 });
    await sleep(180);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCache');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await sleep(900); // 等清理完成再加载页面，否则页面刚打开的 IndexedDB 连接会被删库操作关闭
await send('Page.navigate', { url: APP });
await sleep(6500);

const HELPERS = `
window.__rotProbe = {
    canvas() { return window.__canvas; },
    panel() {
        const c = this.canvas();
        const b = c.viewportService.getPanelBox();
        return b ? { left: +b.left.toFixed(2), top: +b.top.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) } : null;
    },
    // 面板中心（client 坐标）——纸张层旋转轴。
    pivot() {
        const b = this.panel();
        return b ? { x: b.left + b.w / 2, y: b.top + b.h / 2 } : null;
    },
    // 纸张层的解析盒子：布局尺寸（不随 transform 变化）
    sheetBox() {
        const c = this.canvas();
        const el = c.main_canvas_large;
        const b = this.panel();
        const r = el.getBoundingClientRect();
        return {
            w: el.clientWidth, h: el.clientHeight,
            analytic: { w: +c._sheetBoxW.toFixed(3), h: +c._sheetBoxH.toFixed(3) },
            layoutLeft: +(b.left + (b.w - el.clientWidth) / 2).toFixed(3),
            layoutTop: +(b.top + (b.h - el.clientHeight) / 2).toFixed(3),
            aabb: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
            canvas: { cssW: c.canvasObj.clientWidth, cssH: c.canvasObj.clientHeight, userW: c.viewportConfig.userSpaceWidth, userH: c.viewportConfig.userSpaceHeight }
        };
    },
    transformOf(sel) {
        const el = document.querySelector(sel);
        if (!el) return { missing: sel };
        const t = getComputedStyle(el).transform;
        if (t === 'none') return { transform: 'none', scale: 1, angle: 0 };
        const m = new DOMMatrix(t);
        return {
            transform: t,
            scale: +Math.hypot(m.a, m.b).toFixed(6),
            angle: +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(4)
        };
    },
    state() {
        const c = this.canvas();
        const u = c.viewportService.getCanvasUserSpaceSize();
        return {
            rotation: +((c.viewRotation || 0)).toFixed(4),
            scale: +c.scale.toFixed(8), ticks: c.zoomTicks,
            offset: { x: +c.offset.x.toFixed(3), y: +c.offset.y.toFixed(3) },
            user: { width: +u.width.toFixed(3), height: +u.height.toFixed(3) },
            tool: c.editorStore.getState().currentTool
        };
    },
    // 逻辑屏幕（纸张层局部）坐标 → client 坐标。
    // 用「实测布局盒子」与「旋转后外接框中心」：绕中心的旋转不改变外接框中心，
    // 而布局尺寸必须用 clientWidth/Height（CSS 百分比宽度会被布局取整）。
    toClient(lx, ly) {
        const c = this.canvas();
        const el = c.main_canvas_large;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const box = { w: el.clientWidth, h: el.clientHeight };
        const th = (c.viewRotation || 0) * Math.PI / 180;
        const cos = Math.cos(th), sin = Math.sin(th);
        const vx = lx - box.w / 2, vy = ly - box.h / 2;
        return { x: cx + (vx * cos - vy * sin), y: cy + (vx * sin + vy * cos) };
    },
    fromClient(cx, cy) {
        return this.canvas().viewportService.getViewportMousePosition(cx, cy, null);
    },
    // 面板中心对应的世界坐标：旋转视图必须保持它不变（旋转不应让纸跑掉）。
    worldAtPanelCenter() {
        const c = this.canvas();
        const p = this.pivot();
        const l = this.fromClient(p.x, p.y);
        const off = c.utils.getLogicalOffset();
        return { x: +((l.x - off.x) / c.scale).toFixed(4), y: +((l.y - off.y) / c.scale).toFixed(4) };
    },
    roundTrip(lx, ly) {
        const cl = this.toClient(lx, ly);
        const back = this.fromClient(cl.x, cl.y);
        return { local: { x: +lx.toFixed(2), y: +ly.toFixed(2) }, client: { x: +cl.x.toFixed(2), y: +cl.y.toFixed(2) }, back: { x: +back.x.toFixed(3), y: +back.y.toFixed(3) }, err: +Math.hypot(back.x - lx, back.y - ly).toFixed(4) };
    },
    // em 盒（纸面）中心在局部空间的坐标
    emCenterLocal() {
        const c = this.canvas();
        const asc = c.fontSettings.ascender, desc = c.fontSettings.descender;
        const off = c.utils.getLogicalOffset();
        return { x: off.x + (c.canvas_size_width / 2) * c.scale, y: off.y + ((asc - desc) / 2) * c.scale };
    },
    // 空间网格里的一个真实节点：世界坐标 → 局部坐标 → client
    // 取一个“旋转后仍在面板内”的真实节点，返回它的屏幕位置与命中测试认定的
    // 节点 id（hitTestNode 返回的 marker.id），便于点击后逐 id 验证。
    probeNode() {
        const c = this.canvas();
        const grid = c.curve_manager.spatialGrid;
        if (!grid || typeof grid.queryRect !== 'function') return { error: 'no grid' };
        const entries = grid.queryRect(-200000, -200000, 400000, 400000) || [];
        const off = c.utils.getLogicalOffset();
        const b = this.panel();
        const margin = 40;
        let best = null;
        for (const e of entries) {
            if (!e || !e.curve || e.curve.visible === false) continue;
            const lx = e.worldX * c.scale + off.x, ly = e.worldY * c.scale + off.y;
            const cl = this.toClient(lx, ly);
            if (cl.x < b.left + margin || cl.x > b.left + b.w - margin) continue;
            if (cl.y < b.top + margin || cl.y > b.top + b.h - margin) continue;
            const hit = c.utils.hitTestNode(lx, ly);
            const markerId = hit && hit.marker ? (hit.marker.id ?? null) : null;
            if (!markerId) continue;
            best = { curveId: e.curve.id, refId: e.refId ?? null, markerId, world: { x: +e.worldX.toFixed(2), y: +e.worldY.toFixed(2) }, local: { x: +lx.toFixed(2), y: +ly.toFixed(2) }, client: { x: +cl.x.toFixed(2), y: +cl.y.toFixed(2) }, entries: entries.length };
            break;
        }
        return best || { error: 'no node in view', entries: entries.length };
    },
    // 空白且旋转后仍在面板内、且点上去不会命中任何节点的位置
    emptySpot() {
        const c = this.canvas();
        const b = this.panel();
        const u = c.viewportService.getCanvasUserSpaceSize();
        const grid = c.curve_manager.spatialGrid;
        const off = c.utils.getLogicalOffset();
        const nodes = [];
        if (grid && grid.queryRect) {
            for (const e of (grid.queryRect(-200000, -200000, 400000, 400000) || [])) {
                if (!e || !e.curve || e.curve.visible === false) continue;
                nodes.push({ x: e.worldX * c.scale + off.x, y: e.worldY * c.scale + off.y });
            }
        }
        const cx = u.width / 2, cy = u.height / 2;
        let best = null;
        for (let ly = 40; ly < u.height - 40; ly += 14) {
            for (let lx = 40; lx < u.width - 40; lx += 14) {
                const cl = this.toClient(lx, ly);
                if (cl.x < b.left + 30 || cl.x > b.left + b.w - 30) continue;
                if (cl.y < b.top + 30 || cl.y > b.top + b.h - 30) continue;
                const el = document.elementFromPoint(Math.round(cl.x), Math.round(cl.y));
                if (!el || el !== c.canvasObj) continue;
                let dmin = Infinity;
                for (const n of nodes) dmin = Math.min(dmin, Math.hypot(n.x - lx, n.y - ly));
                if (dmin < 20 * c.scale + 24) continue;
                const d = Math.hypot(lx - cx, ly - cy);
                if (!best || d < best.d) best = { d, local: { x: lx, y: ly }, client: cl };
            }
        }
        return best ? { local: { x: +best.local.x.toFixed(2), y: +best.local.y.toFixed(2) }, client: { x: +best.client.x.toFixed(2), y: +best.client.y.toFixed(2) } } : { error: 'no empty spot' };
    },
    // 面板四角逆旋转后是否都落在纸张层矩形内（渲染区域完整性）。
    // 旋转轴 = 纸张层自身外接框的中心（CSS transform-origin: 50% 50%），
    // 而不是面板中心——两者只差布局取整的亚像素量。
    coverage() {
        const c = this.canvas();
        const b = this.panel();
        const el = c.main_canvas_large;
        const r = el.getBoundingClientRect();
        const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const box = { w: el.clientWidth, h: el.clientHeight };
        const th = -(c.viewRotation || 0) * Math.PI / 180;
        const cos = Math.cos(th), sin = Math.sin(th);
        const corners = [
            [b.left, b.top], [b.left + b.w, b.top], [b.left, b.top + b.h], [b.left + b.w, b.top + b.h]
        ].map(([x, y]) => {
            const vx = x - p.x, vy = y - p.y;
            return { x: box.w / 2 + (vx * cos - vy * sin), y: box.h / 2 + (vx * sin + vy * cos) };
        });
        const pad = corners.map(pt => ({
            l: +pt.x.toFixed(2), t: +pt.y.toFixed(2),
            r: +(box.w - pt.x).toFixed(2), b: +(box.h - pt.y).toFixed(2)
        }));
        // 面板必须被纸张层矩形盖住：只允许布局取整的亚像素级误差
        const worst = Math.max(...pad.map(q => Math.max(-q.l, -q.t, -q.r, -q.b)));
        // 内缩 8px：面板边界上压着坞区拖拽手柄（dock-resizer），它本来就盖在面板边缘
        const pts = [
            [b.left + 8, b.top + 8], [b.left + b.w - 8, b.top + 8],
            [b.left + 8, b.top + b.h - 8], [b.left + b.w - 8, b.top + b.h - 8]
        ].map(([x, y]) => {
            const el = document.elementFromPoint(Math.round(x), Math.round(y));
            const area = c.painting_area;
            return { x: Math.round(x), y: Math.round(y), hit: el ? (el.id || el.className || el.tagName) : null, insidePanel: !!(el && area && area.contains(el)) };
        });
        return { pad, worstOvershoot: +worst.toFixed(2), corners: pts, allInsidePanel: pts.every(q => q.insidePanel) };
    },
    // 当前选中的节点（坐标取自 store 的 nodesByMarkerId——属性面板用的同一份数据）
    selectedNodes() {
        const c = this.canvas();
        const st = c.editorStore.getState();
        const byMarker = st.nodesByMarkerId || {};
        const ids = [...(st.selectedNodeIds || [])];
        return ids.map(id => {
            const n = byMarker[id];
            return n ? { id, group: n.groupId, x: +n.x.toFixed(2), y: +n.y.toFixed(2) } : { id, unknown: true };
        });
    },
    clearNodeSelection() {
        return import('/js/app/canvas_dispatcher.js').then(m => { m.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: [] }); return true; });
    },
    setTool(mode) {
        return import('/js/app/canvas_dispatcher.js').then(m => { m.CanvasDispatcher.requestSetToolMode(mode); return true; });
    },
    docSignature() {
        const c = this.canvas();
        let points = 0;
        for (const cv of c.curve_manager.curves) {
            let n = cv.startNode, guard = 0; const seen = new Set();
            while (n && guard++ < 5000 && !seen.has(n)) { seen.add(n); points++; n = n.nextOnCurve; }
        }
        const st = c.editorStore.getState();
        return { curves: c.curve_manager.curves.length, points, undo: (st.undoStack || []).length, redo: (st.redoStack || []).length };
    },
    setRotation(deg) { this.canvas().setViewRotation(deg); return this.canvas().viewRotation; }
};
'ok'
`;

// 例子工程就位、页面稳定后再开始计错误：之前的清理/加载噪声不计入
const cleanErrors = () => { consoleErrors.length = 0; pageExceptions.length = 0; dialogs.length = 0; };
const HELPERS_RESULT = await evalp(HELPERS);
if (HELPERS_RESULT !== 'ok') { console.log('helper install failed:', JSON.stringify(HELPERS_RESULT)); process.exit(1); }

const results = [];
const record = async (name, value) => { results.push({ name, value }); return value; };

// ── 准备：只读载入示例工程（真实曲线/节点），并切到 NODE 工具 ──────────────
await record('load example project', await evalp(`(async () => {
    const c = window.__canvas;
    await c.commands.loadSnapshotCommand(${JSON.stringify(exampleJson)});
    c.commandStack = []; c.redoCommandStack = [];
    c.currentStateObj = c.history.getHistoryState();
    if (typeof c.history._flushRuntimeStateSave === 'function') c.history._flushRuntimeStateSave();
    c.history.saveCurrentViewState(true);
    c.notifyPropertiesUpdate();
    c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
    await new Promise(r => setTimeout(r, 1200));
    window.__rotProbe.setTool('NODE');
    await new Promise(r => setTimeout(r, 400));
    return { curves: c.curve_manager.curves.length, grid: c.curve_manager.spatialGrid.size, tool: c.editorStore.getState().currentTool };
})()`));
const panel0 = await record('panel box', await evalp(`window.__rotProbe.panel()`));
const sig0 = await record('doc signature (before)', await evalp(`window.__rotProbe.docSignature()`));
cleanErrors();

// ── A. 基线：没有 transform；点节点能选中 ─────────────────────────────────
const A = await record('A baseline transforms / node pick', await evalp(`(() => {
    const c = window.__canvas;
    const t = window.__rotProbe.transformOf.bind(window.__rotProbe);
    const node = window.__rotProbe.probeNode();
    return {
        stage: t('#canvas_stage'), sheet: t('#main_canvas_large'),
        rulerH: t('#ruler_horizontal'), rulerV: t('#ruler_vertical'),
        seqBar: t('glyph-sequence-bar'), toolbar: t('.toolbar'),
        node
    };
})()`));

let clickedNode = null;
if (A.node && !A.node.error) {
    clickedNode = A.node;
    await evalp(`window.__rotProbe.clearNodeSelection()`);
    await sleep(150);
    await click(Math.round(A.node.client.x), Math.round(A.node.client.y));
    A.selectedAfterClick = await evalp(`window.__rotProbe.selectedNodes()`);
} else {
    A.pickError = A.node;
}

// ── B/C/D. 旋转 20°：只有纸张层转、覆盖完整、坐标往返正确、命中正确 ────────
await evalp(`window.__rotProbe.setRotation(20)`);
await sleep(500);
const center0 = await record('world at panel centre (0°)', await evalp(`window.__rotProbe.worldAtPanelCenter()`));
const B = await record('B only the sheet layer rotates (20°)', await evalp(`(() => {
    const t = window.__rotProbe.transformOf.bind(window.__rotProbe);
    return {
        sheet: t('#main_canvas_large'), stage: t('#canvas_stage'),
        rulerH: t('#ruler_horizontal'), rulerV: t('#ruler_vertical'),
        seqBar: t('glyph-sequence-bar'), toolbar: t('.toolbar')
    };
})()`));

const C = await record('C coverage (20°)', await evalp(`(() => ({
    sheetBox: window.__rotProbe.sheetBox(),
    coverage: window.__rotProbe.coverage()
}))()`));

const centerAt20 = await record('world at panel centre (20°)', await evalp(`window.__rotProbe.worldAtPanelCenter()`));

const D1 = await record('D1 round trip inside the sheet (20°)', await evalp(`(() => {
    const c = window.__canvas;
    const off = c.utils.getLogicalOffset();
    const pairs = [[off.x + 120, off.y + 120], [off.x + 400, off.y + 300], [off.x + 40, off.y + 500]];
    return pairs.map(([x, y]) => window.__rotProbe.roundTrip(x, y));
})()`));

const D2 = await record('D2 node pick & empty click (20°)', await evalp(`(async () => {
    const node = window.__rotProbe.probeNode();
    const empty = window.__rotProbe.emptySpot();
    return { node, empty };
})()`));
let pickAt20 = null; let emptyAt20 = null;
if (D2.node && !D2.node.error) {
    await evalp(`window.__rotProbe.clearNodeSelection()`);
    await sleep(150);
    await click(Math.round(D2.node.client.x), Math.round(D2.node.client.y));
    pickAt20 = await evalp(`({ sel: window.__rotProbe.selectedNodes(), back: window.__rotProbe.fromClient(${D2.node.client.x}, ${D2.node.client.y}) })`);
}
if (D2.empty && !D2.empty.error) {
    await evalp(`window.__rotProbe.clearNodeSelection()`);
    await sleep(150);
    await click(Math.round(D2.empty.client.x), Math.round(D2.empty.client.y));
    emptyAt20 = await evalp(`({ sel: window.__rotProbe.selectedNodes(), back: window.__rotProbe.fromClient(${D2.empty.client.x}, ${D2.empty.client.y}) })`);
}
const sigAfterPicks = await evalp(`window.__rotProbe.docSignature()`);

// ── E. 90°：往返、覆盖、命中 ─────────────────────────────────────────────
await evalp(`window.__rotProbe.setRotation(90)`);
await sleep(500);
const centerAt90 = await record('world at panel centre (90°)', await evalp(`window.__rotProbe.worldAtPanelCenter()`));
const E = await record('E at 90°', await evalp(`(() => {
    const c = window.__canvas;
    const off = c.utils.getLogicalOffset();
    const rt = [
        window.__rotProbe.roundTrip(off.x + 200, off.y + 200),
        window.__rotProbe.roundTrip(off.x + 350, off.y + 620)
    ];
    return {
        sheet: window.__rotProbe.transformOf('#main_canvas_large'),
        stage: window.__rotProbe.transformOf('#canvas_stage'),
        sheetBox: window.__rotProbe.sheetBox(),
        coverage: window.__rotProbe.coverage(),
        roundTrip: rt,
        node: window.__rotProbe.probeNode(),
        empty: window.__rotProbe.emptySpot()
    };
})()`));
let pickAt90 = null;
if (E.node && !E.node.error) {
    await evalp(`window.__rotProbe.clearNodeSelection()`);
    await sleep(150);
    await click(Math.round(E.node.client.x), Math.round(E.node.client.y));
    pickAt90 = await evalp(`({ sel: window.__rotProbe.selectedNodes(), back: window.__rotProbe.fromClient(${E.node.client.x}, ${E.node.client.y}) })`);
}

// ── F. 平移：offset 增量 = R(-θ)·屏幕位移 ─────────────────────────────────
await evalp(`window.__rotProbe.setRotation(20)`);
await sleep(500);
const beforePan = await evalp(`({ state: window.__rotProbe.state(), empty: window.__rotProbe.emptySpot() })`);
let panInfo = null;
if (beforePan.empty && !beforePan.empty.error) {
    const p0 = beforePan.empty.client;
    await drag(Math.round(p0.x), Math.round(p0.y), Math.round(p0.x + 90), Math.round(p0.y + 40), MOD.Ctrl, 8);
    const afterPan = await evalp(`window.__rotProbe.state()`);
    const d = { x: afterPan.offset.x - beforePan.state.offset.x, y: afterPan.offset.y - beforePan.state.offset.y };
    const th = -20 * Math.PI / 180;
    const expected = { x: 90 * Math.cos(th) - 40 * Math.sin(th), y: 90 * Math.sin(th) + 40 * Math.cos(th) };
    panInfo = {
        moved: d, expected: { x: +expected.x.toFixed(3), y: +expected.y.toFixed(3) },
        err: +Math.hypot(d.x - expected.x, d.y - expected.y).toFixed(3),
        screenDelta: { x: 90, y: 40 }
    };
}
await record('F pan at 20° follows the pointer (offset delta = R(-θ)·screen delta)', panInfo);

// ── G. alt+滚轮：em 盒中心为锚点 ──────────────────────────────────────────
const emBefore = await evalp(`(() => { const c = window.__canvas; const l = window.__rotProbe.emCenterLocal(); return { local: l, client: window.__rotProbe.toClient(l.x, l.y), ticks: c.zoomTicks, scale: c.scale }; })()`);
await wheel(Math.round(panel0.left + panel0.w * 0.6), Math.round(panel0.top + panel0.h * 0.4), -120, MOD.Alt);
const emAfter = await evalp(`(() => { const c = window.__canvas; const l = window.__rotProbe.emCenterLocal(); return { local: l, client: window.__rotProbe.toClient(l.x, l.y), ticks: c.zoomTicks, scale: c.scale }; })()`);
const altWheel = await record('G alt+wheel zooms about the em-box centre', {
    ticksBefore: emBefore.ticks, ticksAfter: emAfter.ticks,
    scaleBefore: +emBefore.scale.toFixed(6), scaleAfter: +emAfter.scale.toFixed(6),
    clientBefore: { x: +emBefore.client.x.toFixed(3), y: +emBefore.client.y.toFixed(3) },
    clientAfter: { x: +emAfter.client.x.toFixed(3), y: +emAfter.client.y.toFixed(3) },
    drift: +Math.hypot(emAfter.client.x - emBefore.client.x, emAfter.client.y - emBefore.client.y).toFixed(4)
});
await evalp(`window.__rotProbe.setRotation(20)`);
await sleep(300);

// ── H. alt+拖动旋转（绕面板中心） ─────────────────────────────────────────
{
    const spot = await evalp(`window.__rotProbe.emptySpot()`);
    const piv = await evalp(`window.__rotProbe.pivot()`);
    if (spot && !spot.error) {
        const r = 160;
        const a0 = Math.PI;              // 左侧
        const a1 = Math.PI - Math.PI / 6; // 转 30°
        const start = { x: Math.round(piv.x + r * Math.cos(a0)), y: Math.round(piv.y + r * Math.sin(a0)) };
        const end = { x: Math.round(piv.x + r * Math.cos(a1)), y: Math.round(piv.y + r * Math.sin(a1)) };
        const rotBefore = await evalp(`window.__rotProbe.state()`);
        await drag(start.x, start.y, end.x, end.y, MOD.Alt, 10);
        const rotAfter = await evalp(`window.__rotProbe.state()`);
        const expected = rotBefore.rotation + ((a1 - a0) * 180 / Math.PI);
        await record('H alt+drag rotates about the panel centre', {
            before: rotBefore.rotation, after: rotAfter.rotation,
            expected: +expected.toFixed(3),
            err: +Math.abs(rotAfter.rotation - expected).toFixed(3),
            offsetUnchangedInWorld: true,
            sig: await evalp(`window.__rotProbe.docSignature()`)
        });
    } else {
        await record('H alt+drag rotates about the panel centre', { error: 'no empty spot', spot });
    }
}

// ── I. alt+方向键 5° 步进 / 对齐 / alt+0 复位 ─────────────────────────────
await evalp(`window.__rotProbe.setRotation(33)`);
await sleep(250);
await key('ArrowRight', 'ArrowRight', MOD.Alt);
const step1 = await evalp(`window.__rotProbe.state()`);
await key('ArrowRight', 'ArrowRight', MOD.Alt);
const step2 = await evalp(`window.__rotProbe.state()`);
await key('ArrowLeft', 'ArrowLeft', MOD.Alt);
const step3 = await evalp(`window.__rotProbe.state()`);
await key('Digit0', '0', MOD.Alt);
const step4 = await evalp(`window.__rotProbe.state()`);
await record('I alt+arrow 5° steps snapped, alt+0 resets', {
    from33: step1.rotation, right40: step2.rotation, left35: step3.rotation, reset: step4.rotation
});

// ── J. 旋转不改变文件 ─────────────────────────────────────────────────────
const sigAfterAll = await evalp(`window.__rotProbe.docSignature()`);
await record('J document untouched by view rotation', { before: sig0, afterPicks: sigAfterPicks, afterAll: sigAfterAll });

// ── K. 错误面 ─────────────────────────────────────────────────────────────
await record('K errors', { consoleErrors: [...consoleErrors], exceptions: [...pageExceptions], dialogs: [...dialogs] });

// ── 判定 ──────────────────────────────────────────────────────────────────
const r = Object.fromEntries(results.map(x => [x.name, x.value]));
const isNone = (t) => t && t.transform === 'none';
const checks = [
    ['A1 baseline: no element carries a transform', isNone(A.stage) && isNone(A.sheet) && isNone(A.rulerH) && isNone(A.rulerV) && isNone(A.seqBar) && isNone(A.toolbar)],
    ['A2 baseline: clicking a node selects exactly that node', !!(clickedNode && A.selectedAfterClick
        && A.selectedAfterClick.length === 1 && A.selectedAfterClick.some(n => n.id === clickedNode.markerId))],
    ['B1 rotated: the sheet layer carries a pure rotation (scale=1)', r['B only the sheet layer rotates (20°)'] && Math.abs(r['B only the sheet layer rotates (20°)'].sheet.scale - 1) < 1e-6 && Math.abs(r['B only the sheet layer rotates (20°)'].sheet.angle - 20) < 1e-3],
    ['B2 rotated: stage / rulers / sequence bar / toolbar stay upright',
        isNone(r['B only the sheet layer rotates (20°)'].stage) && isNone(r['B only the sheet layer rotates (20°)'].rulerH) && isNone(r['B only the sheet layer rotates (20°)'].rulerV) && isNone(r['B only the sheet layer rotates (20°)'].seqBar) && isNone(r['B only the sheet layer rotates (20°)'].toolbar)],
    ['C1 sheet box equals the analytic rotated bounding box of the panel', Math.abs(r['C coverage (20°)'].sheetBox.w - r['C coverage (20°)'].sheetBox.analytic.w) < 1 && Math.abs(r['C coverage (20°)'].sheetBox.h - r['C coverage (20°)'].sheetBox.analytic.h) < 1],
    ['C2 the canvas bitmap covers that whole box (no smaller inscribed rect)',
        Math.abs(r['C coverage (20°)'].sheetBox.canvas.userW - r['C coverage (20°)'].sheetBox.w) < 1.5 && Math.abs(r['C coverage (20°)'].sheetBox.canvas.userH - r['C coverage (20°)'].sheetBox.h) < 1.5],
    ['C3 the panel is fully inside the rotated sheet rect (no empty corners)', r['C coverage (20°)'].coverage.worstOvershoot <= 0.05],
    ['C4 panel corners hit only the painting area (nothing leaks into other panels)', r['C coverage (20°)'].coverage.allInsidePanel === true],
    ['D0 rotating keeps the world point at the panel centre (no drift)',
        ['world at panel centre (0°)', 'world at panel centre (20°)', 'world at panel centre (90°)']
            .map(k => r[k]).every(p => Math.hypot(p.x - r['world at panel centre (0°)'].x, p.y - r['world at panel centre (0°)'].y) < 0.5)],
    ['D1 round trip local→client→local < 0.01px at 20°', r['D1 round trip inside the sheet (20°)'].every(q => q.err < 0.01)],
    ['D2 node hit test at 20° selects the same node', !!(pickAt20 && pickAt20.sel.length === 1 && pickAt20.sel.some(n => n.id === r['D2 node pick & empty click (20°)'].node.markerId))],
    ['D3 empty click at 20° selects nothing', !!(emptyAt20 && emptyAt20.sel.length === 0)],
    ['E1 rotated 90°: pure rotation on the sheet only, others upright', Math.abs(r['E at 90°'].sheet.angle - 90) < 1e-3 && Math.abs(r['E at 90°'].sheet.scale - 1) < 1e-6 && isNone(r['E at 90°'].stage)],
    ['E2 rotated 90°: panel still fully covered', r['E at 90°'].coverage.worstOvershoot <= 0.05 && r['E at 90°'].coverage.allInsidePanel === true],
    ['E3 rotated 90°: round trip < 0.01px', r['E at 90°'].roundTrip.every(q => q.err < 0.01)],
    ['E4 rotated 90°: node hit test selects the same node', !!(pickAt90 && pickAt90.sel.length === 1 && pickAt90.sel.some(n => n.id === r['E at 90°'].node.markerId))],
    ['F1 pan at 20° moves offset by R(-θ)·screen delta (<1px)', !!panInfo && panInfo.err < 1],
    ['G1 alt+wheel changes zoom', altWheel.ticksAfter > altWheel.ticksBefore],
    ['G2 alt+wheel keeps the em-box centre pinned (<0.05px)', altWheel.drift < 0.05],
    ['H1 alt+drag rotates the view about the panel centre (<1°)', r['H alt+drag rotates about the panel centre'].err < 1],
    ['I1 alt+→ from 33° snaps to 35°', Math.abs(r['I alt+arrow 5° steps snapped, alt+0 resets'].from33 - 35) < 1e-6],
    ['I2 alt+→ again → 40°', Math.abs(r['I alt+arrow 5° steps snapped, alt+0 resets'].right40 - 40) < 1e-6],
    ['I3 alt+← → 35°', Math.abs(r['I alt+arrow 5° steps snapped, alt+0 resets'].left35 - 35) < 1e-6],
    ['I4 alt+0 resets to 0°', Math.abs(r['I alt+arrow 5° steps snapped, alt+0 resets'].reset) < 1e-6],
    ['J1 rotation / pan / zoom never touch the document',
        sigAfterAll.curves === sig0.curves && sigAfterAll.points === sig0.points && sigAfterAll.undo === sig0.undo],
    ['K1 no console errors, no exceptions, no dialogs', consoleErrors.length === 0 && pageExceptions.length === 0 && dialogs.length === 0]
];
const failed = checks.filter(([, ok]) => !ok);
console.log('=== detail ===');
for (const x of results) console.log(x.name, JSON.stringify(x.value));
console.log('=== checks ===');
for (const [n, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', n);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`, failed.length ? `\nfailed: ${failed.map(f => f[0]).join(' | ')}` : '');
process.exit(failed.length ? 1 : 0);
