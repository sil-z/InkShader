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
    const pokeRender = () => {
      // Real pointermove on the canvas forces the interaction/render loop to run
      const canvas = c.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const ev = new PointerEvent('pointermove', {
        bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      });
      canvas.dispatchEvent(ev);
    };

    out.base = { curves: curveCount(), pixels: canvasPixels() };

    // Full dispatcher path (the real UI chain)
    CanvasDispatcher.requestSetTreeSelection([p4.id], parentGid);
    await sleep(120);
    CanvasDispatcher.requestExpandStroke();
    await sleep(1000);
    pokeRender();
    await sleep(400);
    out.afterExpandDispatcher = { curves: curveCount(), pixels: canvasPixels() };

    // check test2 children after expand
    const g = cm.treeItems.get(parentGid);
    out.test2Children = g?.children ? [...g.children] : null;

    return out;
  });

  return JSON.stringify(result, null, 1);
}