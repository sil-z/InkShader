// 端到端验证本轮三处修复（必须禁用 HTTP 缓存 + 全新 profile，否则页面跑旧 JS）：
//  A) Unlink Reference：ref 行必须从对象树消失、克隆出的真实路径必须立刻出现在树中，
//     且树选中集合里不能再留下已删除的 ref id（= 那个点不动也删不掉的“幽灵引用”）。
//  B) 序列条字形菜单的 Other Groups：长名字不得把网格撑出菜单宽度，必须换行 + 省略号。
//  C) 序列条上的字形名标签：文字必须在虚线框内裁剪（overflow hidden + ellipsis）。
const WebSocket = (await import('ws')).default;
import { exampleProject } from './probe_env.mjs';
const PORT = Number(process.env.PROBE_PORT || 9226);
const SRV = Number(process.env.PROBE_SRV || 8132);
const APP = `http://127.0.0.1:${SRV}/index.html?v=ulwrap-${Date.now()}`;
const all = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of all.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = all[all.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        logs.push((m.params.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 600) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
// 清掉上一个 run 残留的项目缓存/localStorage，保证每次从同一初始状态开始
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

// ---------- A) Unlink Reference ----------
const A = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const Dispatcher = (await import('/js/app/canvas_dispatcher.js')).CanvasDispatcher;
    const out = {};
    const tag = Date.now().toString(36);
    const mkHost = (id) => {
        cm.treeItems.set(id, { id, type: 'group', name: id, charCode: null, parentId: null,
            children: [], isRef: false, collapsed: false, advance: 1000, is_modified: true });
        cm.rootChildren.push(id);
        return id;
    };
    // 每组全新命名，避免上一次运行残留的状态干扰断言
    const srcGid = mkHost('Src_' + tag), dstGid = mkHost('Dst_' + tag);
    const seqText = String.fromCharCode(92) + dstGid + String.fromCharCode(92);
    Dispatcher.requestSetSequenceEditorState({ text: seqText, activeIndices: [0] }, { recordHistory: false });
    cm.notifyTreeUpdate();
    await sleep(900);

    // 1) 造一条真实曲线（走应用自己的 cloneCurveToGroup，不手写底层 marker API）
    const mk = (x, y) => ({ x, y, smooth: false, control_mode: 0, control1: null, control2: null, nextOnCurve: null });
    const n1 = mk(100, 100), n2 = mk(400, 120), n3 = mk(350, 500), n4 = mk(120, 460);
    n1.nextOnCurve = n2; n2.nextOnCurve = n3; n3.nextOnCurve = n4;
    const fake = { startNode: n1, endNode: n4, closed: true, stroke_width: 60, smart_stroke: false, visible: true, locked: false };
    out.sourceCurveCreated = !!cm.cloneCurveToGroup(fake, srcGid);

    // 2) dst 里放一个对 src 的引用
    const refId = cm.pasteGroupRef(srcGid, dstGid);
    cm.notifyTreeUpdate();
    await sleep(700);
    out.refId = refId;
    out.refInTreeBefore = cm.treeItems.has(refId);
    out.dstChildrenBefore = [...(cm.treeItems.get(dstGid)?.children || [])];
    out.refRowInDomBefore = !!document.querySelector('[data-id="' + refId + '"]');
    out.dstInTreeDom = !!document.querySelector('[data-id="' + dstGid + '"]');

    // 3) 选中该 ref，执行 Unlink Reference
    Dispatcher.requestSetTreeSelection([refId]);
    await sleep(500);
    const beforeState = cv.editorStore.getState();
    out.selectedBefore = [...(beforeState.selectedTreeIds || [])];
    Dispatcher.requestUnlink([refId]);
    await sleep(1400);
    const afterState = cv.editorStore.getState();

    out.treeRevisionBumped = afterState.treeRevision > beforeState.treeRevision;
    out.refInTreeAfter = cm.treeItems.has(refId);
    out.refRowInDomAfter = !!document.querySelector('[data-id="' + refId + '"]');
    out.dstChildrenAfter = [...(cm.treeItems.get(dstGid)?.children || [])];
    out.clonedCurves = out.dstChildrenAfter.filter(id => id !== refId);
    const firstClone = cm.treeItems.get(out.clonedCurves[0]);
    out.cloneIsRealCurve = !!firstClone && firstClone.type === 'curve'
        && !!cm.curveById.get(firstClone.curveId)?.startNode;
    out.cloneCurveHasNodes = (() => {
        const c = firstClone ? cm.curveById.get(firstClone.curveId) : null;
        let n = 0, cur = c && c.startNode;
        const seen = new Set();
        while (cur && !seen.has(cur)) { seen.add(cur); n++; cur = cur.nextOnCurve; }
        return n;
    })();
    out.selectedTreeIdsAfter = [...(afterState.selectedTreeIds || [])];
    out.selectionHasDeadRef = out.selectedTreeIdsAfter.includes(refId);
    // 清理
    try {
        cm.treeItems.delete('Src_' + tag); cm.treeItems.delete('Dst_' + tag);
        for (const id of ['Src_' + tag, 'Dst_' + tag]) {
            const k = cm.rootChildren.indexOf(id); if (k >= 0) cm.rootChildren.splice(k, 1);
        }
        Dispatcher.requestSetSequenceEditorState({ text: '', activeIndices: [] }, { recordHistory: false });
        cm.notifyTreeUpdate();
    } catch (e) { out.cleanupErr = String(e).slice(0, 120); }
    return out;
})()`);

// ---------- A2) 对照组：只改数据不经过命令层 → 幽灵行（证明修的就是"树通知"） ----------
const A2 = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const Dispatcher = (await import('/js/app/canvas_dispatcher.js')).CanvasDispatcher;
    const out = {};
    const tag = 'ctl' + Date.now().toString(36);
    const mkHost = (id) => {
        cm.treeItems.set(id, { id, type: 'group', name: id, charCode: null, parentId: null,
            children: [], isRef: false, collapsed: false, advance: 1000, is_modified: true });
        cm.rootChildren.push(id);
        return id;
    };
    const srcGid = mkHost('Src_' + tag), dstGid = mkHost('Dst_' + tag);
    Dispatcher.requestSetSequenceEditorState(
        { text: String.fromCharCode(92) + dstGid + String.fromCharCode(92), activeIndices: [0] },
        { recordHistory: false });
    const mk = (x, y) => ({ x, y, smooth: false, control_mode: 0, control1: null, control2: null, nextOnCurve: null });
    const a = mk(100, 100), b = mk(400, 120), c = mk(350, 500), d = mk(120, 460);
    a.nextOnCurve = b; b.nextOnCurve = c; c.nextOnCurve = d;
    cm.cloneCurveToGroup({ startNode: a, endNode: d, closed: true, stroke_width: 60, smart_stroke: false, visible: true, locked: false }, srcGid);
    const refId = cm.pasteGroupRef(srcGid, dstGid);
    cm.notifyTreeUpdate();
    await sleep(900);
    out.refRowInDomBefore = !!document.querySelector('[data-id="' + refId + '"]');
    const ver0 = cv.editorStore.getState().treeRevision;
    // 旧行为：直接调 manager 层，只改数据，不发 TREE_UPDATED
    cm.unlinkReferenceDeep(refId);
    await sleep(900);
    out.refInTreeAfter = cm.treeItems.has(refId);
    out.treeRevisionUnchanged = cv.editorStore.getState().treeRevision === ver0;
    out.refRowInDomAfter = !!document.querySelector('[data-id="' + refId + '"]');
    out.ghostRowReproduced = out.refRowInDomAfter === true && out.refInTreeAfter === false;
    // 清理
    try {
        for (const id of ['Src_' + tag, 'Dst_' + tag]) {
            cm.treeItems.delete(id);
            const k = cm.rootChildren.indexOf(id); if (k >= 0) cm.rootChildren.splice(k, 1);
        }
        Dispatcher.requestSetSequenceEditorState({ text: '', activeIndices: [] }, { recordHistory: false });
        cm.notifyTreeUpdate();
    } catch (e) { out.cleanupErr = String(e).slice(0, 120); }
    return out;
})()`);

// ---------- B) 序列条菜单 Other Groups 换行 ----------
const B = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const out = {};
    const LONG = 'Probe_Extremely_Long_Glyph_Name_That_Must_Not_Widen_The_Grid';
    const ids = [];
    for (let i = 0; i < 10; i++) {
        const id = LONG + '_' + i;
        cm.treeItems.set(id, { id, type: 'group', name: id, charCode: null, parentId: null,
            children: [], isRef: false, collapsed: false, advance: 1000, is_modified: true });
        cm.rootChildren.push(id);
        ids.push(id);
    }
    cm.notifyTreeUpdate();
    await sleep(500);

    const bar = document.querySelector('glyph-sequence-bar');
    if (!bar) return { skip: 'no sequence bar' };
    if (bar._activeMenu) { bar._activeMenu.remove(); bar._activeMenu = null; }
    bar._addMenu(60, 60, 0, null);
    await sleep(400);
    const menu = document.querySelector('.sequence-add-menu');
    out.menuOpened = !!menu;
    if (!menu) return out;
    const grid = menu.querySelector('.seq-menu-existing-groups .seq-menu-grid');
    out.hasOtherGroupsGrid = !!grid;
    if (!grid) return out;
    const mr = menu.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    const items = [...grid.children];
    out.itemCount = items.length;
    out.gridScrollOverflowX = grid.scrollWidth - grid.clientWidth;
    out.menuWidth = Math.round(mr.width);
    out.gridWidth = Math.round(gr.width);
    // 关键判据：所有格子必须落在网格/菜单右边界之内（修复前长名字把网格撑爆 → 向右跑出去）
    const rights = items.map(el => el.getBoundingClientRect().right);
    out.maxItemRight = Math.round(Math.max(...rights));
    out.gridRight = Math.round(gr.right);
    out.menuRight = Math.round(mr.right);
    out.itemsInsideGrid = rights.every(r => r <= gr.right + 1.5);
    out.itemsInsideMenu = rights.every(r => r <= mr.right + 1.5);
    // 行数必须 > 1（10 个格子、cols<=8）
    const tops = new Set(items.map(el => Math.round(el.getBoundingClientRect().top)));
    out.rows = tops.size;
    out.wraps = tops.size > 1;
    const nameEl = items[0].querySelector('.seq-menu-name');
    out.nameEllipsis = getComputedStyle(nameEl).textOverflow;
    out.nameOverflowHidden = getComputedStyle(nameEl).overflow;
    // 清理
    menu.remove(); bar._activeMenu = null;
    for (const id of ids) { cm.treeItems.delete(id); const k = cm.rootChildren.indexOf(id); if (k >= 0) cm.rootChildren.splice(k, 1); }
    cm.notifyTreeUpdate();
    return out;
})()`);

// ---------- C) 序列条标签裁剪契约 ----------
const C = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    const Dispatcher = (await import('/js/app/canvas_dispatcher.js')).CanvasDispatcher;
    const out = {};
    const NAME = 'Probe_Very_Long_Token_Name_Overflowing_Its_Dashed_Label';
    cm.treeItems.set(NAME, { id: NAME, type: 'group', name: NAME, charCode: null, parentId: null,
        children: [], isRef: false, collapsed: false, advance: 1000, is_modified: true });
    cm.rootChildren.push(NAME);
    Dispatcher.requestSetSequenceEditorState({ text: '\\\\' + NAME + '\\\\', activeIndices: [0] }, { recordHistory: false });
    cm.notifyTreeUpdate();
    await sleep(900);
    const pos = document.querySelector('.seq-bar-pos');
    const nameEl = pos && pos.querySelector('.seq-bar-name');
    out.hasToken = !!nameEl;
    if (nameEl) {
        // 人为压缩 token 宽度，模拟“画布缩放导致空间变小”
        pos.style.maxWidth = '140px';
        await sleep(200);
        const cs = getComputedStyle(nameEl);
        out.overflow = cs.overflow;
        out.textOverflow = cs.textOverflow;
        out.whiteSpace = cs.whiteSpace;
        out.display = cs.display;
        out.clientWidth = nameEl.clientWidth;
        out.scrollWidth = nameEl.scrollWidth;
        out.posWidth = Math.round(pos.getBoundingClientRect().width);
        // 文字比框宽时必须被裁剪（overflow:hidden）而不是画到虚线框外
        out.textIsClipped = nameEl.scrollWidth > nameEl.clientWidth && cs.overflow === 'hidden';
        // 名字盒子（含被裁剪的文字）绝不能越出 token 右边界
        out.nameBoxInsidePos = nameEl.getBoundingClientRect().right <= pos.getBoundingClientRect().right + 1;
        // 逐像素证据：token 右边界外 2px 处不应被这个名字的文字覆盖
        const pr = pos.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.min(pr.right + 2, window.innerWidth - 1), pr.top + pr.height / 2);
        out.pointRightOfPosHits = hit ? (hit.className || hit.tagName) : null;
        out.pointRightOfPosIsName = !!(hit && hit.classList && hit.classList.contains('seq-bar-name'));
    }
    // 清理
    Dispatcher.requestSetSequenceEditorState({ text: '', activeIndices: [] }, { recordHistory: false });
    await sleep(400);
    cm.treeItems.delete(NAME);
    const k = cm.rootChildren.indexOf(NAME); if (k >= 0) cm.rootChildren.splice(k, 1);
    cm.notifyTreeUpdate();
    return out;
})()`);

// ---------- D) 回归：示例工程里 smart 对象的布尔缓存必须仍然正常产出 ----------
const EXAMPLE = process.env.PROBE_JSON || exampleProject();
const jsonText = (await import('fs')).readFileSync(EXAMPLE, 'utf8');
const D = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1500);
    cv.is_dirty = true;
    await sleep(1200);
    const out = { smartCurves: 0, caches: [], emptyFallbacks: 0, nullCaches: 0 };
    for (const c of cm.curveStore.curves) {
        if (!c.smart_stroke) continue;
        out.smartCurves++;
        const geo = c.cached_boolean_geometry;
        const rings = Array.isArray(geo) ? geo.length : -1;
        const minSegs = Array.isArray(geo) && geo.length
            ? Math.min(...geo.map(r => (r.segments || []).length)) : 0;
        out.caches.push({ id: c.id, rings, minSegs, emptyHash: !!c._booleanEmptyHash });
        if (c._booleanEmptyHash) out.emptyFallbacks++;
        if (rings === 0 || rings === -1) out.nullCaches++;
    }
    return out;
})()`);

console.log(JSON.stringify({ tag: 'unlink-glyphwrap', A, A2, B, C, D, errors: logs.slice(0, 12) }, null, 2));
ws.close(); process.exit(0);
