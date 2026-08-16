// Probe E: UFO round-trip consistency after tolerance change (expect 0/581)
async (page) => {
  const r = await page.evaluate(async () => {
    const c = window.__canvas;
    const out = {};
    // 0. load baseline JSON (string path)
    const jsonStr = await (await fetch('http://localhost:8123/test/InkShader_project_2026-08-02T16-27-25.json')).text();
    await c.projectManager.loadFromFile(jsonStr);
    // 1. export -> glif cache
    c.io.exportToUFO();
    const cache = c.curve_manager._glifExportCache;
    out.cacheSize = cache ? cache.size : -1;
    // 2. rebuild zip from cache XML
    const zip = new JSZip();
    const ufoRoot = ['font.ufo', 'font.ufo/glyphs'];
    for (const f of ufoRoot) zip.folder(f);
    const glyphNames = [];
    let entryCount = 0;
    for (const [glyph, data] of cache) {
      glyphNames.push(glyph);
      const [advance, xml] = data;
      entryCount++;
      zip.file('font.ufo/glyphs/' + glyph.replace(/_/g, '__') + (glyph.length === 1 || /[a-z]|[0-9]/.test(glyph[glyph.length - 1]) ? '.glif' : '_.glif'), xml);
    }
    // contents.plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>glyphs</key><dict>${glyphNames.map(g => `<key>${g}</key><string>${g.replace(/_/g, '__')}${g.length === 1 || /[a-z]|[0-9]/.test(g[g.length - 1]) ? '.glif' : '_.glif'}</string>`).join('')}</dict></dict></plist>`;
    zip.file('font.ufo/fontinfo.plist', '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>familyName</key><string>Probe</string><key>unitsPerEm</key><integer>1000</integer><key>ascender</key><integer>800</integer><key>descender</key><integer>-200</integer></dict></plist>');
    zip.file('font.ufo/metainfo.plist', '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>creator</key><string>probe</string><key>formatVersion</key><integer>3</integer></dict></plist>');
    zip.file('font.ufo/glyphs/contents.plist', plist);
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const rebuilt = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    out.entryCount = entryCount;
    // 3. import the rebuilt UFO
    await c.io._importUFOFromZip(rebuilt);
    // 4. compare: each imported node's importedSmooth vs final control_mode
    //    (attr=yes -> mode 1|2; attr=no -> mode 0)
    let total = 0, mismatch = 0;
    const mis = [];
    const curves = [...c.curve_manager.curveStore.curves.values()];
    for (const cu of curves) {
      let node = cu.startNode;
      const seen = new Set();
      while (node && !seen.has(node)) {
        seen.add(node);
        total++;
        const attr = node.importedSmooth;
        if (attr === true) {
          if (node.control_mode === 0) { mismatch++; mis.push(`attr=yes mode=0 (${node.x.toFixed(1)},${node.y.toFixed(1)}) h=${node.control1 ? 1 : 0}${node.control2 ? 1 : 0}`); }
        } else if (attr === false) {
          if (node.control_mode > 0) { mismatch++; mis.push(`attr=no mode=${node.control_mode} (${node.x.toFixed(1)},${node.y.toFixed(1)})`); }
        } else {
          // null -> geometry fallback (not applicable for round-trip of own export)
          mismatch++; mis.push(`attr=null`); 
        }
        if (node === cu.endNode) break;
        node = node.nextOnCurve;
      }
    }
    out.total = total;
    out.mismatch = mismatch;
    out.mis = mis.slice(0, 10);
    return JSON.stringify(out);
  });
  return r;
}