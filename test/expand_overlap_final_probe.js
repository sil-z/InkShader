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
    const { CanvasDispatcher } = await import('/js/app/canvas_dispatcher.js');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const getById = (id) => {
      for (const cur of cm.curveStore.curves.values()) {
        if (cur.id === id) return cur;
      }
      return null;
    };
    const p4 = getById('Path_4');
    if (!p4) return out;

    let parentGid = null;
    for (const [tid, item] of cm.treeItems) {
      if (item.type === 'group' && Array.isArray(item.children) && item.children.includes(p4.id)) {
        parentGid = tid;
        break;
      }
    }

    const curveCount = () => Array.from(cm.curveStore.curves.keys()).length;
    const canvasPixels = () => {
      const canvas = c.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let h = 0, filled = 0;
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (a > 128) filled++;
        h = (h * 31 + a) >>> 0;
      }
      return { filled, hash: h };
    };
    const clearSelection = async () => {
      CanvasDispatcher.requestSetTreeSelection([], parentGid);
      await sleep(150);
    };
    const expandCurve = async (cur, sw) => {
      cur.smart_stroke_clockwise = sw;
      CanvasDispatcher.requestSetTreeSelection([cur.id], parentGid);
      await sleep(120);
      CanvasDispatcher.requestExpandStroke();
      await sleep(1000);
    };

    out.base = { curves: curveCount(), pixels: canvasPixels() };

    // Phase 1: expand Path_4 (CCW, default) => 4 new curves
    await expandCurve(p4, false);
    const p4New = cm.treeItems.get(parentGid).children.filter(id => id.startsWith('Path_') && id !== 'Path_4');
    out.p4New = p4New.length;
    await clearSelection();
    await sleep(300);
    out.phase1 = { curves: curveCount(), pixels: canvasPixels(), treeChildren: [...cm.treeItems.get(parentGid).children] };

    // Phase 2: clone one expand output as CW source, expand at same position (opposite winding overlap)
    const src = getById(p4New[0]);
    const copy1 = cm.cloneCurveToGroup(src, parentGid);
    await expandCurve(copy1, true);
    await clearSelection();
    await sleep(300);
    out.phase2 = { curves: curveCount(), pixels: canvasPixels(), treeChildren: [...cm.treeItems.get(parentGid).children] };

    return out;
  });

  return JSON.stringify(result, null, 1);
}