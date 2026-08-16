// diag-19 CDP driver: pure Node (built-in WebSocket/fetch), no npm deps.
// Requires: Chrome running with --remote-debugging-port=9222, server on :8123.
// Replicates diag-18 scenario (clone Path_4, shift anchors+controls -600, expand
// sw=true) with full diagnostics: shift-delta verification, per-ring cache bounds,
// expand-output bounds, canvas fill bbox.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=diag-19c';

const PROBE = `
(async () => {
    const out = { errors: [] };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    window.confirm = () => true;

    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(400);

    const getById = (id) => { for (const cur of cm.curveStore.curves.values()) if (cur.id === id) return cur; return null; };
    const p4 = getById('Path_4');
    if (!p4) return JSON.stringify({ fatal: 'Path_4 not found' });

    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
        if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) { parentGid = tid; break; }
    }
    out.parentGid = parentGid;

    // sequence token lookup: property is sequenceTokens (array of {value, isChar, ...})
    const tokens = cm.seqService?.sequenceTokens || [];
    out.tokens = tokens.map(t => ({ value: t.value, isChar: t.isChar }));
    let tokIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const gid = t.isChar ? (cm.seqService.getDefaultGroupForChar?.(t.value) ?? t.value) : t.value;
        if (gid === parentGid) { tokIdx = i; break; }
    }
    const seqOffset = tokIdx >= 0 ? cm.seqService.getSeqOffset(tokIdx) : 0;
    out.tokIdx = tokIdx; out.seqOffset = seqOffset;

    // node-chain bounds (anchors + controls)
    const chainBounds = (cur) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cnt = 0, ctrlInChain = 0;
        let n = cur.startNode;
        while (n) {
            cnt++;
            if (n.type != null) ctrlInChain++;
            for (const x of [n.x, n.control1?.x, n.control2?.x]) if (x != null) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
            for (const y of [n.y, n.control1?.y, n.control2?.y]) if (y != null) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
            n = n.nextOnCurve;
        }
        return { minX, minY, maxX, maxY, nodes: cnt, ctrlInChain };
    };
    const p4b = chainBounds(p4);
    out.p4bounds = p4b;

    // ── pan viewport to test2 world region (runtime logical dims) ──
    // Renderer offset source: c.utils.getLogicalOffset() = { x: ruler + c.offset.x, ... }
    // (canvas_utils_service.js L17-21) — c.offset is an OBJECT, NOT offsetX/offsetY scalars.
    const canvasEl = cv.ctx?.canvas;
    const dpr = window.devicePixelRatio || 1;
    const logicalW = canvasEl.width / dpr, logicalH = canvasEl.height / dpr;
    const ruler = 18, scale = 0.3;
    // center on the union of Path_4 and the upcoming -600-shifted clone
    // (bands: left strip < 957.8, overlap 957.8..2320.3, right strip > 2320.3)
    const worldCX = ((p4b.minX - 600 + p4b.maxX) / 2) + seqOffset;
    const worldCY = (p4b.minY + p4b.maxY) / 2;
    cv.scale = scale;
    cv.offset = cv.offset || {};
    cv.offset.x = logicalW / 2 - worldCX * scale - ruler;
    cv.offset.y = logicalH / 2 - worldCY * scale - ruler;
    out.pan = { logicalW, logicalH, dpr, ruler_size: cv.ruler_size, worldCX, worldCY, offsetX: cv.offset.x, offsetY: cv.offset.y,
        renderedOffsetX: ruler + cv.offset.x, renderedOffsetY: ruler + cv.offset.y };

    const renderFresh = async () => {
        cv.services.renderer.invalidateStableSceneCache?.();
        await sleep(250);
        cv.services.renderer.renderCanvas?.();
        await sleep(400);
    };

    // sampler with banded regions (local coords, test2 group: world = local + seqOffset)
    // bands: left strip (clone-only, local x < 957.8), overlap band (957.8..2320.3),
    // right strip (Path_4-only, 2320.3..2920.3)
    const sample = (label) => {
        const w = canvasEl.width, h = canvasEl.height;
        const g = canvasEl.getContext('2d');
        const img = g.getImageData(0, 0, w, h).data;
        const b0 = (x, y) => { const i = (y * w + x) * 4; return [img[i], img[i + 1], img[i + 2]]; };
        const bg = b0(2, 2);
        const isFilled = (x, y) => {
            const i = (y * w + x) * 4;
            return Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]) > 24;
        };
        let filled = 0, hash = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
        const bands = { left: 0, overlap: 0, right: 0 };
        const step = 2;
        const xBand = (sx) => (sx - (ruler + cv.offset.x)) / scale - seqOffset; // local x from screen x
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                if (!isFilled(x, y)) continue;
                filled++;
                hash = (hash * 31 + img[(y * w + x) * 4 + 3]) >>> 0;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                const lx = xBand(x);
                if (lx < 957.8) bands.left++;
                else if (lx <= 2320.3) bands.overlap++;
                else bands.right++;
            }
        }
        out[label] = { filled, hash, w, h, bands,
            bbox: (filled ? { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 } : null) };
    };

    // ── base (calibration: expect ~27941 like diag-14) ──
    await renderFresh();
    sample('base');

    // ── clone Path_4, shift anchors AND controls by -600, verify deltas ──
    const clone = cm.cloneCurveToGroup(p4, parentGid);
    await sleep(150);
    const shift = -600;
    const before = [];
    let m = clone.startNode;
    while (m) { before.push({ x: m.x, c1x: m.control1?.x, c2x: m.control2?.x, type: m.type ?? null }); m = m.nextOnCurve; }
    let k = clone.startNode;
    while (k) {
        k.x += shift;
        if (k.control1) k.control1.x += shift;
        if (k.control2) k.control2.x += shift;
        k = k.nextOnCurve;
    }
    const after = [];
    m = clone.startNode;
    while (m) { after.push({ x: m.x, c1x: m.control1?.x, c2x: m.control2?.x }); m = m.nextOnCurve; }
    const deltas = before.map((b, i) => ({
        x: after[i].x - b.x,
        c1: after[i].c1x != null ? after[i].c1x - b.c1x : null,
        c2: after[i].c2x != null ? after[i].c2x - b.c2x : null
    }));
    const bad = deltas.filter(d => d.x !== shift || (d.c1 !== null && d.c1 !== shift) || (d.c2 !== null && d.c2 !== shift));
    out.shift = {
        count: deltas.length,
        typesInChain: before.filter(b => b.type != null).length,
        allClean: bad.length === 0,
        badDeltas: bad.slice(0, 8)
    };
    out.cloneBoundsAfterShift = chainBounds(clone);

    // ── cache geometry: p4 vs shifted clone ──
    const geoDump = (cur) => {
        const geo = cur.cached_boolean_geometry;
        if (!geo) return null;
        return geo.map(sub => {
            const pts = sub.segments;
            let area = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                area += a.x * b.y - b.x * a.y;
                for (const pp of [a, b]) {
                    if (pp.x < minX) minX = pp.x; if (pp.x > maxX) maxX = pp.x;
                    if (pp.y < minY) minY = pp.y; if (pp.y > maxY) maxY = pp.y;
                }
            }
            return { segs: pts.length, area: Number((area / 2).toFixed(1)), bounds: { minX: Number(minX.toFixed(1)), minY: Number(minY.toFixed(1)), maxX: Number(maxX.toFixed(1)), maxY: Number(maxY.toFixed(1)) } };
        });
    };
    p4.updateBooleanCache?.();
    await sleep(300);
    out.p4geo = geoDump(p4);
    clone.smart_stroke_clockwise = true;
    clone.updateBooleanCache?.();
    await sleep(300);
    out.cloneGeo = geoDump(clone);
    const cg = out.cloneGeo, pg = out.p4geo;
    out.cloneSanity = (cg && pg && cg.length === pg.length) ? {
        sameSubpathCount: true,
        areaSignFlipped: cg.every((s, i) => Math.abs(s.area + pg[i].area) < Math.abs(pg[i].area) * 0.001),
        xShifted600: cg.every((s, i) => Math.abs((s.bounds.minX - pg[i].bounds.minX) - shift) < 1 && Math.abs((s.bounds.maxX - pg[i].bounds.maxX) - shift) < 1),
        ySame: cg.every((s, i) => Math.abs(s.bounds.minY - pg[i].bounds.minY) < 1 && Math.abs(s.bounds.maxY - pg[i].bounds.maxY) < 1),
        segsMatch: cg.every((s, i) => s.segs === pg[i].segs)
    } : (cg && pg ? { mismatch: { clone: cg.length, p4: pg.length } } : null);

    // ── phase CW: expand the shifted clone (sw=true) via dispatcher ──
    const expandViaDispatcher = async (id, gid) => {
        await CanvasDispatcher.requestSetTreeSelection([id], gid);
        await sleep(250);
        await CanvasDispatcher.requestExpandStroke();
        await sleep(500);
        await CanvasDispatcher.requestChangeObjectSelection('replace', { curveIds: [], refIds: [] });
        await sleep(250);
    };
    const beforeExpand = [...cm.treeItems.get(parentGid).children];
    await expandViaDispatcher(clone.id, parentGid);
    const afterExpand = [...cm.treeItems.get(parentGid).children];
    out.phaseCW = { newIds: afterExpand.filter(id => !beforeExpand.includes(id)) };
    // dump expand outputs (closed, smart_stroke, stroke_width===0)
    const outs = [];
    for (const id of out.phaseCW.newIds) {
        const cur = getById(id);
        if (!cur) continue;
        outs.push({ id, bounds: chainBounds(cur) });
    }
    out.phaseCW.outputs = outs;
    await renderFresh();
    sample('afterCW');

    // ── phase BOTH: expand original Path_4 (sw=false) too ──
    await expandViaDispatcher(p4.id, parentGid);
    await renderFresh();
    sample('afterBoth');

    return JSON.stringify(out);
})()
`;

async function main() {
    // create a fresh tab (PUT required by modern Chrome)
    let target;
    try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await res.json();
    } catch (e) {
        console.error('Cannot create tab (is Chrome running with --remote-debugging-port=' + DEBUG_PORT + '?):', e.message);
        process.exit(1);
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager && !!document.querySelector('main-canvas').services?.renderer`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    const res = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
        console.log('PROBE EXCEPTION:', JSON.stringify(res.result.exceptionDetails, null, 2));
    } else {
        const v = res.result?.result?.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
    ws.close();
}

main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
