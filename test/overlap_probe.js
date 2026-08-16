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

    // 1) Parent group of Path_4 (expected: test2)
    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
      if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) {
        parentGid = tid;
        break;
      }
    }
    out.parentGid = parentGid;

    // 2) Clone Path_4 into the same group, translate +100 x so it overlaps
    let copy = null;
    try {
      copy = cm.cloneCurveToGroup(p4, parentGid);
    } catch (e) {
      out.cloneError = String(e);
    }
    if (!copy) return out;
    let n = copy.startNode;
    const copyId = copy.id;
    while (n) {
      n.x += 100;
      if (n.control1) n.control1.x += 100;
      if (n.control2) n.control2.x += 100;
      n = n.nextOnCurve;
    }
    out.copy = { id: copyId, swOnClone: copy.smart_stroke_clockwise };
    copy.smart_stroke_clockwise = true; // opposite to p4's false (default)
    copy.updateBooleanCache();
    p4.updateBooleanCache();

    const orient = (cur) => {
      const geo = cur.cached_boolean_geometry;
      if (!geo) return null;
      return geo.map(sub => {
        const pts = sub.segments;
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          s += a.x * b.y - b.x * a.y;
        }
        return Number((s / 2).toFixed(1));
      });
    };
    out.orient = { p4: orient(p4), copy: orient(copy) };

    // 3) Sequence preview — shared path + one nonzero fill
    const { drawSequenceGroupPreview } = await import('/js/presentation/sequence/sequence_group_preview.js');
    const renderPreview = () => {
      const cv = document.createElement('canvas');
      cv.width = 300; cv.height = 300;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 300, 300);
      drawSequenceGroupPreview(ctx, cm, parentGid);
      const data = ctx.getImageData(0, 0, 300, 300).data;
      let filled = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) filled++;
      return { data, filled };
    };
    const opposite = renderPreview(); // copy CW, p4 CCW
    copy.smart_stroke_clockwise = false;
    copy.updateBooleanCache();
    const same = renderPreview(); // both CCW
    copy.smart_stroke_clockwise = true;
    copy.updateBooleanCache();
    let diff = 0;
    for (let i = 3; i < opposite.data.length; i += 4) {
      if (opposite.data[i] !== same.data[i]) diff++;
    }
    out.preview = { filledOpposite: opposite.filled, filledSame: same.filled, diffPx: diff };

    // 4) GLIF export — contour directions inside the glyph XML
    try {
      await c.io.exportToUFO();
    } catch (e) {
      out.exportError = String(e);
    }
    const cache = cm._glifExportCache;
    out.glifCacheSize = cache ? cache.size : null;
    if (cache) {
      for (const [gid, entry] of cache) {
        if (gid === parentGid) {
          const xml = entry[1];
          const doc = new DOMParser().parseFromString(xml, 'application/xml');
          const contours = doc.querySelectorAll('contour');
          out.glifContours = [];
          for (const ct of contours) {
            const pts = [...ct.querySelectorAll('point')];
            const onCurve = pts.filter(p => !p.hasAttribute('type') || p.getAttribute('type') === 'line' || p.getAttribute('type') === 'curve')
              .map(p => ({ x: parseFloat(p.getAttribute('x')), y: parseFloat(p.getAttribute('y')) }));
            if (onCurve.length < 3) { out.glifContours.push({ n: pts.length, onCurve: onCurve.length, area: 'skip' }); continue; }
            let s = 0;
            for (let i = 0; i < onCurve.length; i++) {
              const a = onCurve[i], b = onCurve[(i + 1) % onCurve.length];
              s += a.x * b.y - b.x * a.y;
            }
            out.glifContours.push({ n: pts.length, onCurve: onCurve.length, area: Number((s / 2).toFixed(1)) });
          }
          out.glifXmlLen = xml.length;
        }
      }
    }

    // cleanup: remove cloned curve from the group so the project stays clean
    try {
      const item = cm.treeItems.get(copyId);
      if (item) {
        const g = cm.treeItems.get(parentGid);
        if (g && Array.isArray(g.children)) {
          g.children = g.children.filter(id => id !== copyId);
        }
        cm.treeItems.delete(copyId);
      }
    } catch (e) {
      out.cleanupError = String(e);
    }

    return out;
  });

  return JSON.stringify(result, null, 1);
}