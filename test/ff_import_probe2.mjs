async (page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await page.goto('http://localhost:8123/?v=ff4');
  await page.waitForSelector('main-canvas');
  const result = await page.evaluate(async () => {
    window.confirm = () => true;
    const c = document.querySelector('main-canvas');
    const r = await fetch('test/new_font_export.svg');
    const svgStr = await r.text();
    const before = c.curve_manager.rootChildren.length;
    const glyphCount = await c.io._importSVGFontFromString(svgStr);
    const cm = c.curve_manager;
    const all = Array.from(cm.treeItems.values());
    const hidden = all.filter(t => t.hidden_by_sequence === true).length;
    const groups = all.filter(t => t.type === 'group');
    const kidsOf = (name) => {
      const g = groups.find(t => t.name === name);
      if (!g) return 'MISSING';
      return (g.children || []).map(id => {
        const ch = cm.treeItems.get(id);
        return ch ? (ch.type === 'group' ? (ch.isRef ? 'REF:' + ch.name : 'GRP:' + ch.name) : 'curve') : '?';
      }).join(',');
    };
    const refs = groups.filter(t => t.isRef).map(t => t.name + '->' + t.refId).slice(0, 10);
    return {
      beforeRoots: before,
      glyphCount,
      roots: cm.rootChildren.length,
      rootNames: cm.rootChildren.map(id => cm.treeItems.get(id)?.name),
      hiddenCount: hidden,
      seq: cm.seqService.sequenceText,
      testKids: kidsOf('test'),
      test1Kids: kidsOf('test1'),
      test2Kids: kidsOf('test2'),
      AGKids: kidsOf('A_D'),
      GKids: kidsOf('G'),
      refsFound: refs
    };
  });
  return result;
}