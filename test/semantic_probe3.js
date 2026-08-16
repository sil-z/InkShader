async (page) => {
  const result = await page.evaluate(async () => {
    const out = {};
    const c = document.querySelector('main-canvas');
    window.confirm = () => true;
    try {
      const resp = await fetch('test/InkShader_project_2026-08-02T16-27-25.json');
      await c.projectManager.loadFromFile(await resp.text());
    } catch (e) { out.loadError = String(e); }
    const cm = c.curve_manager;
    const { appendCurveFillPath } = await import('/js/canvas/rendering/curve_renderer.js');
    const getP4 = () => Array.from(cm.curveStore.curves.values()).find(cur => cur.id === 'Path_4');
    const p4 = getP4();
    if (!p4) return out;
    p4.smart_stroke_clockwise = false;
    p4.updateBooleanCache();

    // Build a REAL reversed curve: clone + toggle + refresh boolean cache.
    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
      if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) { parentGid = tid; break; }
    }
    const rev = cm.cloneCurveToGroup(p4, parentGid);
    rev.smart_stroke_clockwise = true;
    rev.updateBooleanCache();

    const subpathAreas = (curve) => (curve.cached_boolean_geometry || []).map((sp) => {
      const segs = sp.segments || [];
      let a = 0;
      for (let i = 0; i < segs.length; i++) {
        const s1 = segs[i]; const s2 = segs[(i + 1) % segs.length];
        a += s1.x * s2.y - s2.x * s1.y;
      }
      return a / 2;
    });
    out.p4Areas = subpathAreas(p4);
    out.revAreas = subpathAreas(rev);

    // Transparent canvas; count alpha>0 (black fill vs transparent bg).
    const renderCurves = (curves, { shared = false } = {}) => {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const cur of curves) {
        for (const sp of (cur.cached_boolean_geometry || [])) {
          for (const s of (sp.segments || [])) {
            b.minX = Math.min(b.minX, s.x); b.maxX = Math.max(b.maxX, s.x);
            b.minY = Math.min(b.minY, s.y); b.maxY = Math.max(b.maxY, s.y);
          }
        }
      }
      const PAD = 4;
      const W = Math.ceil(b.maxX - b.minX) + PAD * 2, H = Math.ceil(b.maxY - b.minY) + PAD * 2;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const vp = { scale: 1, offsetX: -b.minX + PAD, offsetY: -b.minY + PAD, seqOffsetX: 0, matrix: null };
      ctx.fillStyle = '#000';
      if (shared) {
        ctx.beginPath();
        for (const cur of curves) appendCurveFillPath(ctx, cur, vp);
        ctx.fill('nonzero');
      } else {
        for (const cur of curves) {
          ctx.beginPath();
          appendCurveFillPath(ctx, cur, vp);
          ctx.fill('nonzero');
        }
      }
      const data = ctx.getImageData(0, 0, W, H).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) n++;
      return { filled: n, W, H };
    };

    out.single = renderCurves([p4]);
    out.pairIndependent = renderCurves([p4, rev]);
    out.pairShared = renderCurves([p4, rev], { shared: true });
    out.revOnly = renderCurves([rev]);

    // Hole check: subpaths with <30 segments are counters; their centroid must be transparent (alpha 0) in single render.
    const holeCheck = (() => {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const sp of p4.cached_boolean_geometry) for (const s of (sp.segments || [])) {
        b.minX = Math.min(b.minX, s.x); b.maxX = Math.max(b.maxX, s.x);
        b.minY = Math.min(b.minY, s.y); b.maxY = Math.max(b.maxY, s.y);
      }
      const PAD = 4;
      const W = Math.ceil(b.maxX - b.minX) + PAD * 2, H = Math.ceil(b.maxY - b.minY) + PAD * 2;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const vp = { scale: 1, offsetX: -b.minX + PAD, offsetY: -b.minY + PAD, seqOffsetX: 0, matrix: null };
      ctx.fillStyle = '#000';
      ctx.beginPath();
      appendCurveFillPath(ctx, p4, vp);
      ctx.fill('nonzero');
      return p4.cached_boolean_geometry.filter(sp => (sp.segments || []).length < 30).map(sp => {
        const segs = sp.segments;
        const cx = segs.reduce((a, s) => a + s.x, 0) / segs.length;
        const cy = segs.reduce((a, s) => a + s.y, 0) / segs.length;
        const px = Math.round(cx - b.minX + PAD), py = Math.round(cy - b.minY + PAD);
        const d = cv.getContext('2d').getImageData(px, py, 1, 1).data;
        return { n: segs.length, alpha: d[3] };
      });
    })();
    out.holes = holeCheck;

    return out;
  });

  return JSON.stringify(result, null, 1);
}