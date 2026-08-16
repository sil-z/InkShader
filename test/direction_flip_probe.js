async (page) => {
  const result = await page.evaluate(async () => {
    const out = {};
    const c = document.querySelector('main-canvas');
    window.confirm = () => true;
    try {
      const resp = await fetch('test/InkShader_project_2026-08-02T16-27-25.json');
      const json = await resp.text();
      await c.projectManager.loadFromFile(json);
    } catch (e) {
      out.loadError = String(e);
    }
    const cm = c.curve_manager;
    const getP4 = () => {
      for (const cur of cm.curveStore.curves.values()) {
        if (cur.id === 'Path_4') return cur;
      }
      return null;
    };
    let p4 = getP4();
    out.foundP4 = !!p4;
    if (!p4) return out;

    // cached_boolean_geometry = [{ closed, segments: [{x,y,inX,inY,outX,outY}] }]
    const orient = () => {
      const geo = p4.cached_boolean_geometry;
      if (!geo) return null;
      return geo.map(sub => {
        const pts = sub.segments;
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          s += a.x * b.y - b.x * a.y;
        }
        return { n: pts.length, area: Number((s / 2).toFixed(1)) };
      });
    };
    const refresh = () => { p4.updateBooleanCache(); return orient(); };

    const fillPixels = () => {
      const geo = p4.cached_boolean_geometry;
      if (!geo) return null;
      const cv = document.createElement('canvas');
      cv.width = 2000; cv.height = 2000;
      const ctx = cv.getContext('2d');
      const b = new Path2D();
      for (const sub of geo) {
        const segs = sub.segments;
        if (!segs.length) return null;
        b.moveTo(segs[0].x, segs[0].y);
        for (let i = 1; i < segs.length; i++) {
          const prev = segs[i - 1];
          b.bezierCurveTo(
            prev.x + prev.outX, prev.y + prev.outY,
            segs[i].x + segs[i].inX, segs[i].y + segs[i].inY,
            segs[i].x, segs[i].y
          );
        }
        b.closePath();
      }
      ctx.fillStyle = '#000';
      ctx.fill(b);
      return ctx.getImageData(0, 0, 2000, 2000).data;
    };
    const pxDiff = (a, b) => {
      if (!a || !b) return -1;
      let d = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) d++;
      return d;
    };

    out.props = { smart: p4.smart_stroke, w: p4.stroke_width, closed: p4.closed, sw: p4.smart_stroke_clockwise };
    out.baseline = { sw: p4.smart_stroke_clockwise, orient: refresh() };

    // 1) Direct toggle false -> true -> false
    const pxBase = fillPixels();
    p4.smart_stroke_clockwise = true;
    out.directFlip = { orientationTrue: refresh() };
    const pxTrue = fillPixels();
    out.visual = { diffTrueVsBase: pxDiff(pxTrue, pxBase) };
    p4.smart_stroke_clockwise = false;
    out.directFlip.orientationFalse = refresh();
    out.visual.diffFalseVsBase = pxDiff(fillPixels(), pxBase);

    // 2) Real UI chain (popup -> dispatcher -> command -> tree_store)
    try {
      const popup = document.querySelector('path-property-popup');
      if (popup && typeof popup._handleSmartWindingToggle === 'function') {
        popup._selectedTreeIds = [p4.id];
        popup._selectedCurveIds = [p4.id];
        popup._handleSmartWindingToggle();
        await new Promise(r => setTimeout(r, 150));
        const live = getP4();
        out.uiChain = { sameObj: live === p4, sw: live ? live.smart_stroke_clockwise : null };
        p4 = live || p4;
        out.uiChain.orientAfterRefresh = refresh();
      } else {
        out.uiChain = 'popup-not-available';
      }
    } catch (e) {
      out.uiChainError = String(e);
    }

    // 3) Closed-path sanity
    p4.closed = true;
    p4.smart_stroke_clockwise = false;
    p4.updateBooleanCache();
    out.closedCase = { swFalse: orient() };
    p4.smart_stroke_clockwise = true;
    p4.updateBooleanCache();
    out.closedCase.swTrue = orient();

    // 4) Restore
    p4.smart_stroke_clockwise = false;
    p4.closed = false;
    p4.updateBooleanCache();
    out.restored = { sw: p4.smart_stroke_clockwise, closed: p4.closed, orient: orient() };

    return out;
  });

  return JSON.stringify(result, null, 1);
}