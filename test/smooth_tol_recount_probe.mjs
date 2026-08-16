// Probe D: full 581-node recount vs GLIF truth (post-fix, real code path)
async (page) => {
  const r = await page.evaluate(async () => {
    const c = window.__canvas;
    const out = {};
    const svg = await (await fetch('http://localhost:8123/test/svg_session9_fixed.svg')).text();
    await c.io._importSVGFontFromString(svg);
    // ── truth from GLIF zip ──
    const zipBuf = await (await fetch('http://localhost:8123/test/roundtrip_smooth_v2.ufo.zip')).arrayBuffer();
    const zip = await JSZip.loadAsync(zipBuf);
    const glifEntries = Object.entries(zip.files).filter(([k, v]) => !v.dir && k.endsWith('.glif'));
    const truth = {}; // glyphName -> contours: [{pts: [{x,y,smooth}]}]
    for (const [k, f] of glifEntries) {
      const xml = await f.async('string');
      const raw = k.split('/').pop().replace(/\.glif$/, '');
      // UFO filename convention: "_" escapes (A -> A_.glif, A_D -> A__D_.glif).
      // Reverse: "__" -> "_", then strip the trailing escape underscore.
      const glyphName = raw.replace(/__/g, '_').replace(/_$/, '');
      const contours = [];
      const cRe = /<contour>([\s\S]*?)<\/contour>/g;
      let m;
      while ((m = cRe.exec(xml))) {
        const pts = [];
        const pRe = /<point\s+([^>]*?)\/>/g;
        let pm;
        while ((pm = pRe.exec(m[1]))) {
          const a = pm[1];
          const g = (k2) => { const rr = new RegExp('\\b' + k2 + '="([^"]*)"').exec(a); return rr ? rr[1] : null; };
          pts.push({ x: parseFloat(g('x')), y: parseFloat(g('y')), type: g('type') || '', smooth: g('smooth') });
        }
        contours.push(pts);
      }
      truth[glyphName] = contours;
    }
    // ── curves per glyph (insertion order = contour order) ──
    const curves = [...c.curve_manager.curveStore.curves.values()];
    const byGlyph = {};
    for (const cu of curves) (byGlyph[cu.groupId] = byGlyph[cu.groupId] || []).push(cu);
    let totalNodes = 0, totalMismatch = 0;
    const misses = []; // truth smooth but corner
    const falses = []; // truth corner but smooth
    const details = [];
    const glyphRows = [];
    for (const [glyph, gCurves] of Object.entries(byGlyph)) {
      const contours = truth[glyph] || [];
      let gNodes = 0, gMiss = 0;
      for (let s = 0; s < Math.min(contours.length, gCurves.length); s++) {
        const truthOn = contours[s].filter(p => p.type !== 'offcurve' && p.type !== '');
        // walk curve nodes
        const nodes = [];
        let node = gCurves[s].startNode;
        const seen = new Set();
        while (node && !seen.has(node)) {
          seen.add(node);
          nodes.push(node);
          if (node === gCurves[s].endNode) break;
          node = node.nextOnCurve;
        }
        if (nodes.length !== truthOn.length) { glyphRows.push(`${glyph} s${s}: CURVE${nodes.length} vs TRUTH${truthOn.length} (skip)`); continue; }
        for (let i = 0; i < nodes.length; i++) {
          const t = truthOn[i];
          const truthSmooth = t.smooth === 'yes';
          const mode = c.io._classifyControlModeFromGeometry(nodes[i]);
          const isSmooth = mode > 0;
          totalNodes++; gNodes++;
          if (truthSmooth !== isSmooth) {
            gMiss++; totalMismatch++;
            const c1 = nodes[i].control1, c2 = nodes[i].control2;
            const v1 = c1 ? [c1.x - nodes[i].x, c1.y - nodes[i].y] : null;
            const v2 = c2 ? [c2.x - nodes[i].x, c2.y - nodes[i].y] : null;
            const l1 = v1 ? Math.hypot(v1[0], v1[1]) : 0;
            const l2 = v2 ? Math.hypot(v2[0], v2[1]) : 0;
            const sinAng = (v1 && v2 && l1 > 0 && l2 > 0) ? +((Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2)).toFixed(8)) : null;
            const row = `  ${glyph} c${s}[${i}] (${nodes[i].x.toFixed(2)},${nodes[i].y.toFixed(2)}) truth=${t.smooth} mode=${mode} sinAng=${sinAng}`;
            details.push(row);
            if (truthSmooth) misses.push(row); else falses.push(row);
          }
        }
      }
      glyphRows.push(`${glyph}: curves=${gCurves.length} contours=${contours.length} nodes=${gNodes} mismatch=${gMiss}`);
    }
    out.glyphRows = glyphRows;
    out.details = details;
    out.totalNodes = totalNodes;
    out.totalMismatch = totalMismatch;
    out.missCount = misses.length;
    out.falseCount = falses.length;
    return JSON.stringify(out);
  });
  return r;
}