// Deterministic test for "Delete segment has no effect", through the REAL mouse flow:
//   1. node tool
//   2. click node A on the canvas  (replace selection)
//   3. ctrl-click adjacent node B  (toggle -> add)
//   4. click the Delete Segment toolbar button
// and a programmatic control variant for comparison.
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('del_seg_ui_probe.json');
copyFileSync(SRC, TMP);
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();

for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const dialogs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(m.params && m.params.message);
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
});
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 800) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null; window.alert=()=>{};' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?v=delsegui-${Date.now()}` });
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await evalp('!!window.__canvas')) break;
}
await new Promise(r => setTimeout(r, 2000));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = { a: null, b: null, dialogs };

await evalp(`(async () => {
    window.__dsH = {
        chainOf(curve) { const o = []; let n = curve.startNode; const s = new Set();
            while (n && !s.has(n)) { s.add(n); o.push(n); n = n.nextOnCurve; } return o; },
        state(cm, gid) { let cs = []; try { cs = cm.getCurvesForGroup(gid) || []; } catch (e) {}
            return cs.map(cd => { const c = cd.curve; const ns = window.__dsH.chainOf(c);
                return { id: c.id, closed: !!c.closed, count: ns.length,
                    start: c.startNode && c.startNode.id, end: c.endNode && c.endNode.id }; }); },
    };
    const cv = window.__canvas;
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await new Promise(r => setTimeout(r, 2500));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 500));
})()`);
await sleep(1200);

// ---------- A: programmatic selection + real ALLOWED selection + button click ----------
out.a = await evalp(`(async () => {
    const cv = window.__canvas, cm = cv.curve_manager, H = window.__dsH;
    const mod = await import('/js/app/canvas_dispatcher.js');
    let pick = null;
    for (const tok of (cm.sequenceTokens || [])) {
        const gid = tok.isChar ? cm.getDefaultGroupForChar(tok.value) : tok.value;
        if (!gid) continue;
        cv.commands.setActiveGroup(gid);
        await new Promise(r => setTimeout(r, 100));
        const cs = H.state(cm, gid);
        const closed = cs.find(c => c.closed && c.count >= 3);
        if (closed) { pick = { gid, curveId: closed.id }; break; }
    }
    if (!pick) return { error: 'no-closed-glyph' };
    cv.commands.setActiveGroup(pick.gid);
    await new Promise(r => setTimeout(r, 250));
    const curves = cm.getCurvesForGroup(pick.gid) || [];
    const curve = curves.map(cd => cd.curve).find(c => c.id === pick.curveId);
    const ns = H.chainOf(curve);
    window.__dsPick = { gid: pick.gid, curveId: pick.curveId, ns };
    mod.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: [ns[0].main_node.id] });
    mod.CanvasDispatcher.requestChangeNodeSelection('add', { markerIds: [ns[1].main_node.id] });
    await new Promise(r => setTimeout(r, 500));
    const btn = document.getElementById('btn_action_delete_segment');
    const r = btn.getBoundingClientRect();
    return { gid: pick.gid, before: H.state(cm, pick.gid).find(x => x.id === pick.curveId),
             sel: [...(cv.commandHostPort.getInteractionSnapshot().selectedNodeMarkerIds || [])].map(m => m && (m.id || m)),
             btnRect: { x: r.x, y: r.y, w: r.width, h: r.height } };
})()`);
if (out.a && !out.a.error) {
    const r = out.a.btnRect; const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(900);
    out.a.after = await evalp(`window.__dsH.state(window.__canvas.curve_manager, ${JSON.stringify(out.a.gid)})`);
}

// Reload the document so variant B starts from the untouched fixture (A mutated it).
await evalp(`(async () => {
    await window.__canvas.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await new Promise(r => setTimeout(r, 2000));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 400));
})()`);
await sleep(1000);

// ---------- B: real mouse box-selection of two adjacent nodes, then button ----------
out.b = await evalp(`(async () => {
    const cv = window.__canvas, cm = cv.curve_manager, H = window.__dsH;
    // Every main node currently mapped, with the sequence offset of its glyph.
    const cands = [];
    for (const [markerId, node] of cm.domMap.entries()) {
        if (!node || node.type === null) continue;              // main nodes only
        const gid = node.curve && node.curve.groupId;
        if (!gid) continue;
        let seqIdx = -1;
        (cm.sequenceTokens || []).forEach((t, i) => {
            const g = t.isChar ? cm.getDefaultGroupForChar(t.value) : t.value;
            if (g === gid && seqIdx < 0) seqIdx = i;
        });
        if (seqIdx < 0) continue;                                // not shown on canvas
        cands.push({ markerId, gid, curveId: node.curve.id, closed: !!node.curve.closed,
                     x: node.x, y: node.y, seqOffset: cm.getSeqOffset(seqIdx) });
    }
    if (!cands.length) return { error: 'no-cands' };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c2 of cands) { minX = Math.min(minX, c2.x + c2.seqOffset); maxX = Math.max(maxX, c2.x + c2.seqOffset);
        minY = Math.min(minY, c2.y); maxY = Math.max(maxY, c2.y); }
    const user = cv.viewportService.getCanvasUserSpaceSize(); const ruler = cv.ruler_size || 0;
    const scale = Math.max(0.02, Math.min(4, Math.min(user.width * 0.4 / Math.max(1, maxX - minX), user.height * 0.4 / Math.max(1, maxY - minY))));
    cv.scale = scale;
    cv.offset.x = user.width / 2 - ((minX + maxX) / 2) * scale - ruler;
    cv.offset.y = user.height / 2 - ((minY + maxY) / 2) * scale - ruler;
    cv.is_dirty = true;
    await new Promise(r => setTimeout(r, 800));

    // First closed curve whose first two adjacent main nodes are both mapped & shown.
    const byCurve = new Map();
    for (const c2 of cands) { if (!byCurve.has(c2.curveId)) byCurve.set(c2.curveId, []); byCurve.get(c2.curveId).push(c2); }
    const rr = cv.canvasObj.getBoundingClientRect();
    const off = cv.utils.getLogicalOffset();
    let chosen = null, candInfo = [];
    for (const [curveId, arr] of byCurve) {
        const cd = (cm.getCurvesForGroup(arr[0].gid) || []).find(x => x.curve.id === curveId);
        candInfo.push({ curveId, arr: arr.length, closed: !!(cd && cd.curve.closed) });
        if (!cd || !cd.curve.closed || arr.length < 3) continue;
        const ns = H.chainOf(cd.curve);
        const m0 = ns[0].main_node, m1 = ns[1].main_node;
        const a = arr.find(c2 => c2.markerId === m0);
        const b = arr.find(c2 => c2.markerId === m1);
        if (a && b) { chosen = { curveId, gid: arr[0].gid, a, b, nodes: ns.length }; break; }
    }
    if (!chosen) return { error: 'no-adjacent-pair', candInfo, cands: cands.length };
    const toClient = (c2) => ({
        x: rr.left + ((c2.x + c2.seqOffset) * cv.scale + off.x) * (rr.width / user.width),
        y: rr.top + (c2.y * cv.scale + off.y) * (rr.height / user.height),
    });
    const pa = toClient(chosen.a), pb = toClient(chosen.b);
    const la = { x: (chosen.a.x + chosen.a.seqOffset) * cv.scale + off.x, y: chosen.a.y * cv.scale + off.y };
    const lb = { x: (chosen.b.x + chosen.b.seqOffset) * cv.scale + off.x, y: chosen.b.y * cv.scale + off.y };
    const hitA = cv.utils.hitTestNode(la.x, la.y);
    const hitB = cv.utils.hitTestNode(lb.x, lb.y);
    return { curveId: chosen.curveId, gid: chosen.gid, nodes: chosen.nodes,
             before: H.state(cm, chosen.gid).find(x => x.id === chosen.curveId),
             pa, pb, la, lb, rr: { l: rr.left, t: rr.top, w: rr.width, h: rr.height }, user,
             hitA: hitA && hitA.marker && hitA.marker.id, wantA: chosen.a.markerId.id,
             hitB: hitB && hitB.marker && hitB.marker.id, wantB: chosen.b.markerId.id };
})()`);

if (out.b && !out.b.error) {
    // Marquee around just the two nodes (box-select replaces the selection).
    const { pa, pb } = out.b;
    const x0 = Math.min(pa.x, pb.x) - 14, y0 = Math.min(pa.y, pb.y) - 14;
    const x1 = Math.max(pa.x, pb.x) + 14, y1 = Math.max(pa.y, pb.y) + 14;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 5, y: y0 + (y1 - y0) * i / 5, button: 'left', buttons: 1 });
        await sleep(80);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
    await sleep(600);
    out.b.selBox = await evalp(`[...(window.__canvas.commandHostPort.getInteractionSnapshot().selectedNodeMarkerIds || [])].map(m => m && (m.id || m))`);
    const brect = await evalp(`(() => { const r = document.getElementById('btn_action_delete_segment').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const cx = brect.x + brect.w / 2, cy = brect.y + brect.h / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(900);
    out.b.after = await evalp(`window.__dsH.state(window.__canvas.curve_manager, ${JSON.stringify(out.b.gid)})`);
}

console.log(JSON.stringify({ tag: 'delete-segment-ui', out, dialogs }, null, 2));
ws.close(); process.exit(0);
