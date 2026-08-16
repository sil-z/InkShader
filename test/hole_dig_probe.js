// Hole-dig verification probe v3 (single expression, no top-level imports):
// Checks:
// 1) OFESCREEN: combined single Path2D (addPath p4 + addPath reversed clone, ONE
//    nonzero fill) must cancel the overlap -> filled(combined) < filled(separate).
//    Uses PRODUCTION buildBooleanPath2D/Path2D objects only (no hand-rolled emit).
// 2) REAL UI chain: expand Path_4 (CCW) -> reversed expand output (clockwise)
//    overlapping phase-1 curves -> main canvas pixels MUST differ (hole dug).
//    Phase-2 target: closed && smart_stroke && stroke_width===0 (expand outputs);
//    area computed from node chain (no cached_boolean_geometry on outputs).
async (page) => {
    const out = {};
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    await page.goto('http://localhost:8123/?v=hole-dig-3', { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const pageProbe = `
(async () => {
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    const { canFillSmartStrokeWithPath2D } = await import('./js/canvas/rendering/curve_renderer.js');

    window.confirm = () => true;

    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await new Promise(r => setTimeout(r, 400));

    const curveById = () => cm.curveById || new Map();
    const count = () => curveById().size;
    const getCurve = (id) => curveById().get(id);
    const p4 = getCurve('Path_4');
    if (!p4) return JSON.stringify({ error: 'Path_4 not found' });

    const out = { did: { cvCtx: !!cv.ctx, cc: count(), p4groupId: p4.groupId } };

    const sample = (canvasEl) => {
        const w = canvasEl.width, h = canvasEl.height;
        const g = canvasEl.getContext('2d');
        const img = g.getImageData(0, 0, w, h).data;
        let filled = 0, hash = 0;
        const step = 4;
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const a = img[(y * w + x) * 4 + 3];
                if (a > 0) { filled++; hash = (hash * 31 + a) >>> 0; }
            }
        }
        return { filled, hash, w, h };
    };

    // area of a curve from its NODE chain (expand outputs have no boolean cache)
    const nodeArea = (cur) => {
        if (!cur?.startNode) return 0;
        let a = 0, n = cur.startNode, first = n;
        while (n) {
            const nx = n.nextOnCurve;
            if (!nx) break;
            a += n.x * nx.y - nx.x * n.y;
            n = nx;
        }
        if (cur.closed && first) a += n.x * first.y - first.x * n.y;
        return a;
    };

    // ── CHECK 1: offscreen combined-Path2D hole semantics (production Path2D only) ──
    const clone = cm.cloneCurveToGroup(p4, p4.groupId);
    await new Promise(r => setTimeout(r, 150));
    clone.smart_stroke_clockwise = true;
    clone.updateBooleanCache?.();
    await new Promise(r => setTimeout(r, 300));
    canFillSmartStrokeWithPath2D(clone);
    canFillSmartStrokeWithPath2D(p4);

    const offCv = document.createElement('canvas');
    offCv.width = 4200; offCv.height = 2600;
    const og = offCv.getContext('2d');

    out.check1 = {};
    // separate fills (union semantics)
    og.clearRect(0, 0, offCv.width, offCv.height);
    og.fillStyle = '#000';
    if (p4._booleanPath2D) og.fill(p4._booleanPath2D, 'nonzero');
    if (clone._booleanPath2D) og.fill(clone._booleanPath2D, 'nonzero');
    out.check1.separate = sample(offCv);
    // combined single Path2D (the fix)
    og.clearRect(0, 0, offCv.width, offCv.height);
    og.fillStyle = '#000';
    const combined = new Path2D();
    if (p4._booleanPath2D) combined.addPath(p4._booleanPath2D);
    if (clone._booleanPath2D) combined.addPath(clone._booleanPath2D);
    og.fill(combined, 'nonzero');
    out.check1.combined = sample(offCv);
    out.check1.verdict = (out.check1.combined.filled < out.check1.separate.filled)
        ? 'HOLE_DIGGED (combined < separate)'
        : 'NO_HOLE (combined >= separate)';

    // ── CHECK 2: real UI chain ──
    const renderFresh = async () => {
        cv.services.renderer.invalidateStableSceneCache?.();
        await new Promise(r => setTimeout(r, 350));
        cv.services.renderer.renderCanvas?.();
        await new Promise(r => setTimeout(r, 400));
        const canvasEl = cv.ctx?.canvas;
        return canvasEl ? sample(canvasEl) : { error: 'no canvas' };
    };
    const expandViaDispatcher = async (id, gid) => {
        await CanvasDispatcher.requestSetTreeSelection([id], gid);
        await new Promise(r => setTimeout(r, 250));
        await CanvasDispatcher.requestExpandStroke();
        await new Promise(r => setTimeout(r, 500));
        await CanvasDispatcher.requestChangeObjectSelection('replace', { curveIds: [], refIds: [] });
        await new Promise(r => setTimeout(r, 250));
    };

    // Phase 1: expand Path_4 (CCW) -> closed output rings.
    out.phase1 = { curvesBefore: count() };
    out.phase1.baselinePixels = await renderFresh();
    await expandViaDispatcher(p4.id, p4.groupId || cm.treeItems?.get(p4.id)?.parentId);
    out.phase1.curvesAfter = count();
    out.phase1.afterExpandPixels = await renderFresh();

    // pick the LARGEST expand output (stroke_width===0 closed smart curve)
    let target = null, bestArea = -Infinity;
    for (const cur of curveById().values()) {
        if (cur.id === p4.id) continue;
        if (!cur.closed || !cur.smart_stroke || cur.stroke_width !== 0) continue;
        const a = Math.abs(nodeArea(cur));
        if (a > bestArea) { bestArea = a; target = cur; }
    }
    out.phase2 = { targetFound: !!target };
    if (!target) {
        out.phase2.error = 'no expand output found (closed+smart+width0)';
    } else {
        out.phase2.target = { id: target.id, area: bestArea, nodeArea: nodeArea(target) };

        // Reversed directional expand output: clone the CCW output ring, flip winding,
        // expand it -> clockwise overlap over phase-1 rings -> must dig holes.
        const clone2 = cm.cloneCurveToGroup(target, target.groupId || cm.treeItems?.get(target.id)?.parentId);
        await new Promise(r => setTimeout(r, 150));
        clone2.smart_stroke_clockwise = true;
        clone2.updateBooleanCache?.();
        await new Promise(r => setTimeout(r, 300));
        const item = cm.treeItems?.get(clone2.id);
        const gid = item?.parentId ?? target.groupId;
        await expandViaDispatcher(clone2.id, gid);
        out.phase2.curvesAfter = count();
        out.phase2.afterExpandPixels = await renderFresh();

        const p1 = out.phase1.afterExpandPixels, p2 = out.phase2.afterExpandPixels;
        out.phase2.verdict = (p1 && p2 && (p1.filled !== p2.filled || p1.hash !== p2.hash))
            ? 'HOLE_DIGGED_ON_MAIN (phase2 differs from phase1)'
            : 'NO_DIFFERENCE_ON_MAIN';
    }

    return JSON.stringify(out);
})()
`;
    out.pageProbe = JSON.parse(await page.evaluate(pageProbe));
    if (errors.length) out.pageErrors = errors;
    return JSON.stringify(out, null, 2);
}