async (page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await page.goto('http://localhost:8123/?v=ff2');
  await page.waitForSelector('main-canvas');
  const loaded = await page.evaluate(async () => {
    window.confirm = () => true;
    const c = document.querySelector('main-canvas');
    const r = await fetch('test/InkShader_project_2026-08-02T16-27-25.json');
    const json = await r.text();
    await c.projectManager.loadFromFile(json);
    const cm = c.curve_manager;
    return { roots: cm.rootChildren.length, seq: cm.seqService.sequenceText };
  });
  const dlP = page.waitForEvent('download');
  await page.evaluate(() => {
    window.confirm = () => true;
    document.querySelector('main-canvas').io.exportToSVG();
  });
  const dl = await dlP;
  let path = null;
  try { path = await dl.path(); } catch (e) { path = 'path-error: ' + e.message; }
  return { loaded, suggested: dl.suggestedFilename(), path };
}
