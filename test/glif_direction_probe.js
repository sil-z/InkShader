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
    const { CanvasDispatcher } = await import('/js/app/canvas_dispatcher.js');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const getP4 = () => Array.from(cm.curveStore.curves.values()).find(cur => cur.id === 'Path_4');
    const p4 = getP4();
    if (!p4) return out;

    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
      if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) { parentGid = tid; break; }
    }

    // Expand Path_4 with sw=false (CCW default)
    p4.smart_stroke_clockwise = false;
    CanvasDispatcher.requestSetTreeSelection([p4.id], parentGid);
    await sleep(120);
    CanvasDispatcher.requestExpandStroke();
    await sleep(1000);

    // Trigger GLIF export cache build
    await c.io.exportToUFO();
    const cache = cm._glifExportCache || new Map();
    out.cacheSize = cache.size;
    out.glyphKeys = Array.from(cache.keys());

    // Parse test2 GLIF: contour winding via shoelace
    const test2Xml = cache.get('test2');
    if (test2Xml) {
      const xml = Array.isArray(test2Xml) ? test2Xml[1] : test2Xml;
      out.test2HasXml = typeof xml === 'string';
      if (typeof xml === 'string') {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const contours = doc.getElementsByTagName('contour');
        const areas = [];
        for (const ct of contours) {
          const pts = ct.getElementsByTagName('point');
          const coords = [];
          for (const p of pts) {
            if (p.getAttribute('type') === 'offcurve') continue;
            coords.push([parseFloat(p.getAttribute('x')), parseFloat(p.getAttribute('y'))]);
          }
          let a = 0;
          for (let i = 0; i < coords.length; i++) {
            const p1 = coords[i]; const p2 = coords[(i + 1) % coords.length];
            a += p1[0] * p2[1] - p2[0] * p1[1];
          }
          areas.push({ n: coords.length, area: a / 2 });
        }
        out.test2ContourAreas = areas;
      }
    }
    return out;
  });

  return JSON.stringify(result, null, 1);
}