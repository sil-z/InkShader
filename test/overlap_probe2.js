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
    const p4 = getP4();
    if (!p4) return out;

    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
      if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) {
        parentGid = tid;
        break;
      }
    }

    const copy = cm.cloneCurveToGroup(p4, parentGid);
    let n = copy.startNode;
    while (n) {
      n.x += 100;
      if (n.control1) n.control1.x += 100;
      if (n.control2) n.control2.x += 100;
      n = n.nextOnCurve;
    }
    copy.smart_stroke_clockwise = true;
    copy.updateBooleanCache();
    p4.updateBooleanCache();

    const { drawSequenceGroupPreview } = await import('/js/presentation/sequence/sequence_group_preview.js');
    const newCanvas = () => {
      const cv = document.createElement('canvas');
      cv.width = 300; cv.height = 300;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 300, 300);
      return cv;
    };
    // dark pixel = red channel low on white background
    const scan = (cv) => {
      const ctx = cv.getContext('2d');
      const data = ctx.getImageData(0, 0, 300, 300).data;
      const dark = new Uint8Array(300 * 300);
      let filled = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        if (data[i] < 128) { dark[p] = 1; filled++; }
      }
      return { filled, dark };
    };

    const renderPreview = (sw) => {
      copy.smart_stroke_clockwise = sw;
      copy.updateBooleanCache();
      const cv = newCanvas();
      const ctx = cv.getContext('2d');
      drawSequenceGroupPreview(ctx, cm, parentGid);
      return scan(cv);
    };

    const opposite = renderPreview(true);   // copy CW, p4 CCW -> opposite root orientations
    const same = renderPreview(false);      // both CCW -> same orientation

    let diff = 0;
    for (let p = 0; p < 300 * 300; p++) {
      if (opposite.dark[p] !== same.dark[p]) diff++;
    }
    out.preview = {
      filledOpposite: opposite.filled,
      filledSame: same.filled,
      diffPx: diff
    };

    // Same test at model level: single shared Path2D with both geometries (what the
    // preview does conceptually), nonzero fill, pixel-compare at 1024x1024 with known offsets.
    const { buildBooleanPath2D } = await import('/js/core/bezier/path_emitter.js');
    const renderModel = (sw) => {
      copy.smart_stroke_clockwise = sw;
      copy.updateBooleanCache();
      const geo = [p4.cached_boolean_geometry, copy.cached_boolean_geometry];
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 1024;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1024, 1024);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      let any = false;
      for (const g of geo) {
        const p2d = buildBooleanPath2D(g);
        if (!p2d) continue;
        ctx.transform(0.4, 0, 0, 0.4, -300, 100);
        ctx.fill(p2d, 'nonzero');
        any = true;
      }
      const data = ctx.getImageData(0, 0, 1024, 1024).data;
      let filled = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) filled++;
      return { filled };
    };
    out.model = {
      opposite: renderModel(true),
      same: renderModel(false)
    };

    return out;
  });

  return JSON.stringify(result, null, 1);
}