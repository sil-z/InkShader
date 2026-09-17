// 用户报告：拖动一个（主）节点时，其控制点角度发生变化，松开后又变回去；
// 且拖动主节点不应修改控制点的相对坐标。
//
// 用真实鼠标事件（CDP Input.dispatchMouseEvent）拖动一个“当前显示字形”里带控制柄的主节点，
// 在拖动前 / 拖动中每一帧 / 松开后分别读取模型中的控制点相对量与角度，以及节点属性弹窗显示的
// in/out 角度文本。
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('han_probe.json');
copyFileSync(SRC, TMP);                             // 绝不动用户原文件
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();
const APP = process.env.APP_URL || `http://127.0.0.1:${SRV}/index.html?v=han-${Date.now()}`;

const all = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of all.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = all[all.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        console.error('[probe] dialog ->', m.params && m.params.message);
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
});
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 700) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const READ = `(() => {
    const cv = window.__canvas;
    const n = cv.curve_manager.find_node_by_curve(window.__probeTarget.markerId);
    if (!n) return 'node-gone';
    const ang = (c) => c ? Math.atan2(c.y - n.y, c.x - n.x) * 180 / Math.PI : null;
    // 用户实际看到的是“停靠”在属性面板里的节点属性区（id 前缀 prop_），浮窗是 npp_
    const panel = document.querySelector('property-panel');
    const popup = document.querySelector('node-property-popup');
    const val = (id) => {
        const el = (panel && panel.querySelector('#' + id)) || (popup && popup.querySelector('#' + id));
        return el ? el.value : null;
    };
    const raw = (c) => c ? { x: +c.x.toFixed(9), y: +c.y.toFixed(9) } : null;
    return {
        x: +n.x.toFixed(9), y: +n.y.toFixed(9),
        c1: n.control1 ? { dx: +(n.control1.x - n.x).toFixed(9), dy: +(n.control1.y - n.y).toFixed(9), a: ang(n.control1), raw: raw(n.control1) } : null,
        c2: n.control2 ? { dx: +(n.control2.x - n.x).toFixed(9), dy: +(n.control2.y - n.y).toFixed(9), a: ang(n.control2), raw: raw(n.control2) } : null,
        focused: document.activeElement && document.activeElement.id,
        panelAngleIn: val('prop_in_a'), panelAngleOut: val('prop_out_a'),
        panelInX: val('prop_in_x'), panelInY: val('prop_in_y'),
        panelOutX: val('prop_out_x'), panelOutY: val('prop_out_y'),
        panelNodeX: val('prop_x'), panelNodeY: val('prop_y'),
        popupVisible: popup ? getComputedStyle(popup).display : null,
        state: cv.current_state
    };
})()`;

const setup = await evalp(`(async()=>{
    const cv = window.__canvas;
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await new Promise(r=>setTimeout(r,3000));
    const cm = cv.curve_manager;
    const tokens = cm.sequenceTokens || [];
    // 只挑“当前显示在画布上的字形”里的节点：否则它根本没被绘制，命中测试必然落空
    const shownGroupIds = new Set();
    tokens.forEach((t) => {
        if (t.isChar) { const gid = cm.getDefaultGroupForChar ? cm.getDefaultGroupForChar(t.value) : null; if (gid) shownGroupIds.add(gid); }
        else shownGroupIds.add(t.value);
    });
    const cands = [];
    for (const [markerId, node] of cm.domMap.entries()) {
        if (!node || node.type === null || !node.control1 || !node.control2) continue;
        const gid = node.curve && node.curve.groupId;
        if (!gid || !shownGroupIds.has(gid)) continue;
        // 该字形在序列里的下标 → 水平偏移
        let seqIdx = -1;
        tokens.forEach((t, i) => {
            const g = t.isChar ? (cm.getDefaultGroupForChar ? cm.getDefaultGroupForChar(t.value) : null) : t.value;
            if (g === gid && seqIdx < 0) seqIdx = i;
        });
        cands.push({ markerId, gid, curveId: node.curve.id, x: node.x, y: node.y, seqIdx, seqOffset: seqIdx >= 0 && cm.getSeqOffset ? cm.getSeqOffset(seqIdx) : 0 });
    }
    if (!cands.length) return { error: 'no-shown-handled-node', tokens: tokens.length };

    // 视图：把整个序列缩放到可见
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const c2 of cands) { minX=Math.min(minX,c2.x+c2.seqOffset); maxX=Math.max(maxX,c2.x+c2.seqOffset); minY=Math.min(minY,c2.y); maxY=Math.max(maxY,c2.y); }
    const user = cv.viewportService.getCanvasUserSpaceSize(); const ruler = cv.ruler_size;
    const scale = Math.max(0.02, Math.min(4, Math.min(user.width*0.5/Math.max(1,maxX-minX), user.height*0.5/Math.max(1,maxY-minY))));
    cv.scale = scale;
    cv.offset.x = user.width/2 - ((minX+maxX)/2)*scale - ruler;
    cv.offset.y = user.height/2 - ((minY+maxY)/2)*scale - ruler;
    cv.is_dirty = true;
    await new Promise(r=>setTimeout(r,700));

    const rect = cv.canvasObj.getBoundingClientRect();
    const off = cv.utils.getLogicalOffset();
    const u = cv.viewportService.getCanvasUserSpaceSize();
    const results = [];
    let chosen = null;
    for (const c2 of cands) {
        const ux = (c2.x + c2.seqOffset) * cv.scale + off.x;
        const uy = c2.y * cv.scale + off.y;
        const hit = cv.utils.hitTestNode(ux, uy);
        const hitId = hit && hit.marker ? (hit.marker.id || String(hit.marker)) : null;
        const want = c2.markerId.id || String(c2.markerId);
        results.push({ gid: c2.gid, seqIdx: c2.seqIdx, ux, uy, hit: hitId === want ? 'self' : (hitId || 'none') });
        if (hitId === want && !chosen) {
            chosen = { ...c2, clientX: rect.left + ux * (rect.width/u.width), clientY: rect.top + uy * (rect.height/u.height) };
        }
    }
    if (!chosen) return { error: 'no-hit', user, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height }, scale: cv.scale, off, cands: cands.length, results: results.slice(0, 8) };
    window.__probeTarget = { markerId: chosen.markerId, curveId: chosen.curveId, groupId: chosen.gid };
    return { chosen, user, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height }, scale: cv.scale, off, cands: cands.length, hitReport: results };
})()`);

const out = { setup };
if (!setup || setup.__exc || setup.error || typeof setup === 'string') {
    console.log(JSON.stringify({ tag: 'drag-handle-angle', out }, null, 2));
    ws.close(); process.exit(0);
}

const key2 = async (type) => send('Input.dispatchKeyEvent', { type, key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50, ...(type === 'keyDown' ? { text: '2', unmodifiedText: '2' } : {}) });
await key2('keyDown'); await key2('keyUp');
await new Promise(r => setTimeout(r, 600));

const { clientX: x, clientY: y } = setup.chosen;
out.before = await evalp(READ);

// 点一下选中该节点
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 800));
out.selected = await evalp(READ);

// 拖动主节点
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));
out.afterDown = await evalp(READ);
out.during = [];
for (let i = 1; i <= 3; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 5, y: y + i * 4, button: 'left', buttons: 1 });
    await new Promise(r => setTimeout(r, 300));
    out.during.push(await evalp(READ));
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 15, y: y + 12, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 900));
out.after = await evalp(READ);

// 再拖一次：按住 Ctrl（轴向锁定）
const afterObj = out.after;
if (afterObj && typeof afterObj === 'object' && afterObj.x !== undefined) {
    const p = await evalp(`(() => {
        const cv = window.__canvas;
        const n = cv.curve_manager.find_node_by_curve(window.__probeTarget.markerId);
        const t = cv.curve_manager.sequenceTokens || [];
        let seqOffset = 0;
        for (let i = 0; i < t.length; i++) {
            const g = t[i].isChar ? cv.curve_manager.getDefaultGroupForChar(t[i].value) : t[i].value;
            if (g === (n.curve && n.curve.groupId)) { seqOffset = cv.curve_manager.getSeqOffset(i); break; }
        }
        const rect = cv.canvasObj.getBoundingClientRect();
        const u = cv.viewportService.getCanvasUserSpaceSize();
        const off = cv.utils.getLogicalOffset();
        const ux = (n.x + seqOffset) * cv.scale + off.x, uy = n.y * cv.scale + off.y;
        return { x: rect.left + ux * (rect.width/u.width), y: rect.top + uy * (rect.height/u.height) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: 2 });
    out.duringCtrl = [];
    for (let i = 1; i <= 3; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + i * 6, y: p.y + i * 6, button: 'left', buttons: 1, modifiers: 2 });
        await new Promise(r => setTimeout(r, 300));
        out.duringCtrl.push(await evalp(READ));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 18, y: p.y + 18, button: 'left', clickCount: 1, modifiers: 2 });
    await new Promise(r => setTimeout(r, 900));
    out.afterCtrl = await evalp(READ);
}

// 第二轮：Ctrl 拖动【控制点】，瞄准“对侧控制柄的相反方向”，观察角度是否变成精确对侧、
// 以及松开后是否又被改写（这是用户报的“角度变了 / 松开又变回去”最可能对应的场景）。
const afterCtrlObj = out.afterCtrl;
if (afterCtrlObj && typeof afterCtrlObj === 'object' && afterCtrlObj.c1) {
    const p = await evalp(`(() => {
        const cv = window.__canvas;
        const n = cv.curve_manager.find_node_by_curve(window.__probeTarget.markerId);
        const t = cv.curve_manager.sequenceTokens || [];
        let seqOffset = 0;
        for (let i = 0; i < t.length; i++) {
            const g = t[i].isChar ? cv.curve_manager.getDefaultGroupForChar(t[i].value) : t[i].value;
            if (g === (n.curve && n.curve.groupId)) { seqOffset = cv.curve_manager.getSeqOffset(i); break; }
        }
        const rect = cv.canvasObj.getBoundingClientRect();
        const u = cv.viewportService.getCanvasUserSpaceSize();
        const off = cv.utils.getLogicalOffset();
        const toClient = (wx, wy) => ({
            x: rect.left + ((wx + seqOffset) * cv.scale + off.x) * (rect.width / u.width),
            y: rect.top + (wy * cv.scale + off.y) * (rect.height / u.height)
        });
        const nodeP = toClient(n.x, n.y);
        const c1P = toClient(n.control1.x, n.control1.y);
        // 目标：让 in 柄与 out 柄完全共线（角度 = out 角 + 180°），长度不变
        const oppA = Math.atan2(n.control2.y - n.y, n.control2.x - n.x);
        const len1 = Math.hypot(n.control1.x - n.x, n.control1.y - n.y);
        const tx = n.x + len1 * Math.cos(oppA), ty = n.y + len1 * Math.sin(oppA);
        return { nodeScreen: nodeP, c1Screen: c1P, target: toClient(tx, ty), c2Angle: oppA * 180 / Math.PI, nodeMode: n.control_mode, len1 };
    })()`);
    out.controlPointPlan = p;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.c1Screen.x, y: p.c1Screen.y, button: 'left', clickCount: 1, modifiers: 2 });
    out.cpBefore = await evalp(READ);
    out.cpDuring = [];
    for (let i = 1; i <= 3; i++) {
        const x = p.c1Screen.x + (p.target.x - p.c1Screen.x) * (i / 3);
        const y = p.c1Screen.y + (p.target.y - p.c1Screen.y) * (i / 3);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers: 2 });
        await new Promise(r => setTimeout(r, 300));
        out.cpDuring.push(await evalp(READ));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.target.x, y: p.target.y, button: 'left', clickCount: 1, modifiers: 2 });
    await new Promise(r => setTimeout(r, 900));
    out.cpAfter = await evalp(READ);
}

// 第三轮：把“角度输入框”先聚焦（每个输入框自然会发生的事），然后再拖主节点，
// 看拖动过程中面板字段是否会冻结 / 拖动后是否会提交一个陈旧的显示值而把控制点角度改写。
{
    const p = await evalp(`(() => {
        const cv = window.__canvas;
        const n = cv.curve_manager.find_node_by_curve(window.__probeTarget.markerId);
        const t = cv.curve_manager.sequenceTokens || [];
        let seqOffset = 0;
        for (let i = 0; i < t.length; i++) {
            const g = t[i].isChar ? cv.curve_manager.getDefaultGroupForChar(t[i].value) : t[i].value;
            if (g === (n.curve && n.curve.groupId)) { seqOffset = cv.curve_manager.getSeqOffset(i); break; }
        }
        const rect = cv.canvasObj.getBoundingClientRect();
        const u = cv.viewportService.getCanvasUserSpaceSize();
        const off = cv.utils.getLogicalOffset();
        const panel = document.querySelector('property-panel');
        const inX = panel && panel.querySelector('#prop_in_x');
        if (inX) {
            inX.focus();
            if (document.activeElement !== inX) return { focused: 'failed', active: document.activeElement && document.activeElement.id };
        }
        const ux = (n.x + seqOffset) * cv.scale + off.x, uy = n.y * cv.scale + off.y;
        return { focused: document.activeElement && document.activeElement.id, hasPanel: !!panel, hasField: !!inX,
                 screen: { x: rect.left + ux * (rect.width / u.width), y: rect.top + uy * (rect.height / u.height) } };
    })()`);
    out.focusPlan = p;
    if (p && p.screen) {
        const { x, y } = p.screen;
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        out.ffAfterDown = await evalp(READ);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 12, y: y + 9, button: 'left', buttons: 1 });
        await new Promise(r => setTimeout(r, 300));
        out.ffDuring = await evalp(READ);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 12, y: y + 9, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 700));
        out.ffAfter = await evalp(READ);
        // 再点击面板外（如画布空白）引发 blur→change，看模型角度是否被陈値改写
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + 180, y: y + 120, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 180, y: y + 120, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 800));
        out.ffAfterBlur = await evalp(READ);
    }
}

console.log(JSON.stringify({ tag: 'drag-handle-angle', out }, null, 2));
ws.close(); process.exit(0);
