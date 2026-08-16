// Sample-text panel CDP driver: pure Node (built-in WebSocket/fetch), no npm deps.
// Verifies the sample-text-panel dock component end-to-end:
//   1. panel mounts in the dock system with title bar / textarea / toggles / font-size input / canvas
//   2. typing sample text renders actual glyph outlines on the canvas (non-empty pixels)
//   3. SAME-ROW regression: multi-char text keeps glyphs on ONE row (user: "一个字母换一行")
//   4. font size is a SET value, independent of the component size (canvas height = rows*fontSize + 2*PAD;
//      wrap/component size unchanged when the font size changes)
//   5. vertical scrollbar: multi-line content taller than the wrap scrolls (overflow-y: auto)
//   6. kerning toggle changes the layout (A->B = -250 tightens the same-row gap)
//   7. metric guides toggle changes the canvas content
//   8. focusout persists sample_text via dispatcher (history entry + undo restores)
//   9. drag handle attached (prop_panel_title_wrapper)
//  10. i18n data-i18n translation applied
//  11. restoring an OLD saved dock layout (without the sample panel) re-adds the panel
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=sample-panel-2';

const PROBE_A = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    // 'ResizeObserver loop completed with undelivered notifications' is a benign Chrome
    // artifact on ANY observed-element size change; not an app error.
    window.addEventListener('error', e => { if (!e.message.includes('ResizeObserver loop')) out.errors.push('error: ' + e.message); });
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const cm = cv.curve_manager;
    window.confirm = () => true;

    // Clean slate: a PREVIOUS driver run may have left panel settings in localStorage;
    // connectedCallback restores them on mount, breaking default-state assumptions
    // (kerning OFF / fontSize 72 cascade into 4 spurious failures). Remove the key and
    // reset the controls to defaults (the panel never re-reads the key afterwards).
    localStorage.removeItem('inkshader_sample_panel_state');
    const panel = document.querySelector('sample-text-panel');
    if (panel) {
        panel.querySelector('#sample_font_size').value = '48';
        panel.querySelector('#sample_kerning').checked = true;
        panel.querySelector('#sample_guides').checked = true;
    }

    // 1. Panel presence + structure
    check('sample-text-panel exists', !!panel, null);
    const leaf = document.querySelector('.dock-leaf[data-panel-id="sample"]');
    check('sample panel has a dock leaf', !!leaf, null);
    check('panel is inside its dock leaf', !!leaf && leaf.querySelector('.dock-content').contains(panel), null);
    check('title bar present', !!panel.querySelector('.prop_panel_title_wrapper .panel_title'), null);
    check('textarea present', !!panel.querySelector('#sample_text_input'), null);
    check('kerning checkbox present', !!panel.querySelector('#sample_kerning'), null);
    check('guides checkbox present', !!panel.querySelector('#sample_guides'), null);
    check('font-size input present', !!panel.querySelector('#sample_font_size'), null);
    check('canvas present', !!panel.querySelector('#sample_canvas'), null);
    check('kerning toggle default ON', panel.querySelector('#sample_kerning').checked === true, panel.querySelector('#sample_kerning').checked);
    check('guides toggle default ON', panel.querySelector('#sample_guides').checked === true, panel.querySelector('#sample_guides').checked);
    check('font-size default 48', panel.querySelector('#sample_font_size').value === '48', panel.querySelector('#sample_font_size').value);

    // 2. Drag handle attached by the dock system
    const handle = panel.querySelector('.prop_panel_title_wrapper');
    check('drag handle wired to dock (has _dragPid)', !!handle && !!handle._dragPid, handle?._dragPid);

    // 3. i18n title applied (en default)
    await sleep(200);
    check('panel title translated', panel.querySelector('.panel_title').textContent === 'Sample Text', panel.querySelector('.panel_title').textContent);

    // 4. Load the baseline project (has glyph groups A-E with real outlines)
    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(600);

    // The fixture carries no canvas_size_height field; a stale IndexedDB cache entry
    // can leak an unrelated value (e.g. 12000) into it, which breaks the metric-frame
    // layout (glyphs are pushed off-canvas). Align it with the glyph space (upm).
    if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;

    const input = panel.querySelector('#sample_text_input');
    const canvas = panel.querySelector('#sample_canvas');
    const wrap = panel.querySelector('#sample_canvas_wrap');
    const ctx = canvas.getContext('2d');
    const px = (c) => {
        const d = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    };
    const type = async (text) => { input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300); };

    // 5. Type "AB" -> renders glyph outlines (non-empty pixels).
    //    Canvas height is CONTENT-driven: 1 row = fontSize + 2*PAD = 48 + 20 = 68px.
    await type('AB');
    const pxAB = px(ctx);
    check('canvas renders glyphs for "AB" (non-empty)', pxAB > 500, pxAB);
    check('canvas height = 1-row content (fontSize + 2*PAD = 68px)', canvas.height === 68, canvas.height);

    // 6. Metric guides toggle: guides ON adds dashed lines (more pixels)
    const pxGuidesOn = px(ctx);
    panel.querySelector('#sample_guides').click();
    await sleep(200);
    const pxGuidesOff = px(ctx);
    check('guides toggle changes canvas content', pxGuidesOn !== pxGuidesOff, { on: pxGuidesOn, off: pxGuidesOff });
    // keep guides OFF for the row/gap measurements (no horizontal lines crossing columns)

    // 7. SAME-ROW regression (user: every letter used to start a NEW line even with
    //    room left): "AB" must place B on the SAME row as A — the two ink bands'
    //    vertical extents must overlap.
    const rowInfo = () => {
        const W = canvas.width, H = canvas.height;
        const d = ctx.getImageData(0, 0, W, H).data;
        const colInk = (x) => { for (let y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 0) return true; return false; };
        const rowRange = (x0, x1) => {
            let lo = H, hi = -1;
            for (let y = 0; y < H; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (d[(y * W + x) * 4 + 3] > 0) { lo = Math.min(lo, y); hi = Math.max(hi, y); break; }
                }
            }
            return [lo, hi];
        };
        let x = 0;
        while (x < W && !colInk(x)) x++;
        const a0 = x;
        while (x < W && colInk(x)) x++;
        const a1 = x - 1;
        while (x < W && !colInk(x)) x++;
        const b0 = x;
        while (x < W && colInk(x)) x++;
        const b1 = x - 1;
        const [al, ah] = rowRange(a0, a1);
        const [bl, bh] = rowRange(b0, b1);
        // When kerning pulls B INTO A (overlap) there is no second ink band: b0 runs past the
        // canvas end. Treat that as a merged/overlapping pair (gap 0, same row by definition).
        const merged = b0 >= W || b1 < a1;
        return { a0, a1, b0, b1, al, ah, bl, bh, merged,
            sameRow: merged ? true : !(ah < bl || bh < al),
            gap: merged ? 0 : b0 - a1 - 1 };
    };
    const r1 = rowInfo();
    check('"AB" renders A and B on the SAME row (not one letter per line)', r1.sameRow, r1);

    // 8. Kerning: A->B = -250 must tighten the same-row inter-glyph gap
    const { CanvasDispatcher } = await import('./js/app/canvas_dispatcher.js');
    input.focus(); // keep activeElement on the textarea so STATE_CHANGED sync does not overwrite 'AB'
    await CanvasDispatcher.requestSetKerningPairs([{ left: 'A', right: 'B', value: -250 }], { recordHistory: true });
    await sleep(400);
    const gapKernOn = rowInfo().gap;
    panel.querySelector('#sample_kerning').click();
    await sleep(300);
    const gapKernOff = rowInfo().gap;
    check('kerning tightens same-row glyph gap', gapKernOn < gapKernOff, { on: gapKernOn, off: gapKernOff });
    check('canvas still renders with kerning OFF', px(ctx) > 100, px(ctx));
    panel.querySelector('#sample_kerning').click();
    await sleep(300);

    // 9. Font size is a SET value, independent of the component size: changing the
    //    control rescales the CONTENT (canvas height = rows*fontSize + 2*PAD) while
    //    the wrap (component) size stays fixed.
    const wrapH = wrap.clientHeight;
    const setSize = async (v) => {
        const inp = panel.querySelector('#sample_font_size');
        inp.value = String(v);
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
        return canvas.height;
    };
    const h48 = await setSize(48);
    const h96 = await setSize(96);
    check('content height tracks font size (h96 = rows*96 + 20 = 116, h48 = 68)', h48 === 68 && h96 === 116, { h48, h96 });
    check('wrap size unchanged (font size independent of component)', wrap.clientHeight === wrapH, { wrapH, wrapNow: wrap.clientHeight });
    // Compare ink against the guides-OFF baseline (pxGuidesOff), not pxAB (which included guides)
    check('larger font size renders more ink', px(ctx) > pxGuidesOff, { big: px(ctx), small: pxGuidesOff });

    // 10. Vertical scrollbar: tall multi-line content exceeds the wrap -> scrollable
    await setSize(48);
    await type('A\\nB\\nC\\nD\\nE\\nF\\nG\\nH');
    const sh = wrap.scrollHeight, ch = wrap.clientHeight;
    check('multi-line content exceeds wrap (scrollable)', sh > ch, { scrollHeight: sh, clientHeight: ch });
    check('wrap scrolls vertically (overflow-y auto)', getComputedStyle(wrap).overflowY === 'auto', getComputedStyle(wrap).overflowY);
    check('multi-line renders all rows (ink present)', px(ctx) > 200, px(ctx));

    // 10b. Unified styling: sample panel fields + scrollbars must match the existing
    //      panel conventions (property-panel fields, shared scrollbar group).
    const fontInp = panel.querySelector('#sample_font_size');
    const fc = getComputedStyle(fontInp);
    check('font-size input matches property-panel field styling',
        fc.height === '22px' && fc.borderRadius === '3px' && fc.fontFamily.includes('monospace'),
        { h: fc.height, r: fc.borderRadius, f: fc.fontFamily });
    const tc = getComputedStyle(input);
    check('sample textarea matches unified input styling',
        tc.borderRadius === '6px' && tc.padding === '6px 10px',
        { r: tc.borderRadius, p: tc.padding });
    const ssRules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
    const scrollbarRule = ssRules.some(r => r.selectorText && r.selectorText.includes('.sample-canvas-wrap') && r.selectorText.includes('::-webkit-scrollbar-thumb'));
    check('sample wrap has unified scrollbar styling', scrollbarRule, scrollbarRule);

    // 10b2. Textarea scrollbar: the textarea must be in the shared scrollbar control
    //       group (SCROLLABLE) AND styled like the other sample scrollbars — an
    //       unstyled textarea falls back to the OS overlay scrollbar (Windows Chrome:
    //       invisible until the mouse aims exactly at the scrollbar itself).
    const taRule = ssRules.some(r => r.selectorText && r.selectorText.includes('.sample-text-input') && r.selectorText.includes('::-webkit-scrollbar'));
    check('textarea has unified scrollbar styling', taRule, taRule);
    input.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    check('textarea gets data-scrollbar-visible on hover', input.hasAttribute('data-scrollbar-visible'), null);
    input.removeAttribute('data-scrollbar-visible');
    // Textarea keeps resize:vertical, so Chrome paints its DEFAULT gray ::-webkit-resizer
    // at the corner — an unstyled resizer sits on top of where the h/v scrollbars meet,
    // visually truncating both bars (the reported "both scrollbars wrong"). Must be styled.
    const resizerRule = ssRules.some(r => r.selectorText && r.selectorText.includes('.sample-text-input::-webkit-resizer'));
    check('textarea resizer styled (no default gray grip)', resizerRule, resizerRule);

    // 10b3. Wrap/body scrollbars: the preview wrap is scrollable, so it must be in the
    //       SCROLLABLE control group too — CSS rules alone left its thumb dependent on
    //       :hover on the container, which never engages data-scrollbar-visible (the
    //       scroll listener only handles SCROLLABLE members; probe: wrap attr stayed
    //       null after hover AND after scroll, thumb invisibly transparent).
    wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    check('wrap gets data-scrollbar-visible on hover', wrap.hasAttribute('data-scrollbar-visible'), null);
    wrap.removeAttribute('data-scrollbar-visible');
    wrap.scrollTop = 50;
    wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(200);
    check('wrap gets data-scrollbar-visible on scroll', wrap.hasAttribute('data-scrollbar-visible'), null);
    wrap.removeAttribute('data-scrollbar-visible');
    wrap.scrollTop = 0;

    // 10c. Min canvas width = at least one full natural line: a wrap narrower than the
    //      line scrolls horizontally instead of squeezing/wrapping the specimen.
    await type('AB');
    const em = await import('./js/app/editor_read_facade.js');
    const nat = em.measureSampleTextPreview('AB', { kerning: false, width: 60, fontSize: 48 });
    check('measure reports natural line width (min canvas width)', nat && Math.abs(nat.maxRowWidthPx - 116) < 1, nat && nat.maxRowWidthPx);
    if (panel.querySelector('#sample_kerning').checked) panel.querySelector('#sample_kerning').click(); // kerning OFF for an exact line width
    await sleep(300);
    wrap.style.flex = '0 0 60px';
    wrap.style.width = '60px';
    await sleep(300); // ResizeObserver -> re-render at the narrowed wrap
    const narrowW = canvas.getBoundingClientRect().width;
    check('canvas keeps one-full-line width when wrap is narrow', narrowW >= 115 && narrowW <= 117, narrowW);
    check('narrow wrap scrolls horizontally', wrap.scrollWidth > wrap.clientWidth, { sw: wrap.scrollWidth, cw: wrap.clientWidth });

    // 10c2. ROW-COUNT CONSISTENCY (user: guides 行数 ≠ 实际文本行数): the panel must
    //       measure at the SAME width it draws (contentW). Pre-fix it measured at
    //       wrapW (60 -> 'AB' wraps to 2 rows -> canvas height 116) but drew at
    //       contentW 116 (1 row) — canvas height, scrollbar and empty space all
    //       implied rows that don't exist. Post-fix: height = 1 row = 68.
    check('narrow wrap keeps ONE-row content height (measure == draw width)', canvas.height === 68, canvas.height);
    // Guides are drawn for exactly the drawn rows: at contentW this is 1 row -> 4 distinct
    // guide lines (ascender / baseline==cap(0) / descender / xHeight). Antialiasing spreads
    // each line over ~2 pixel rows, so CLUSTER the y positions (gap > 2 = new line).
    if (!panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);
    const dGuide = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const guideRows = new Set();
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (dGuide[i] > 200 && dGuide[i + 1] < 180 && dGuide[i + 2] < 120 && dGuide[i + 3] > 0) { guideRows.add(y); break; }
        }
    }
    const gys = [...guideRows].sort((a, b) => a - b);
    let guideClusters = 0, gPrev = -10;
    for (const y of gys) { if (y - gPrev > 2) guideClusters++; gPrev = y; }
    check('guides match drawn rows (1 row = 4 guide lines, no phantom rows)',
        guideClusters === 4, { guideLines: guideClusters, rawRows: gys.length, canvasH: canvas.height });
    if (panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);

    wrap.style.flex = '';
    wrap.style.width = '';
    if (!panel.querySelector('#sample_kerning').checked) panel.querySelector('#sample_kerning').click(); // back to ON
    await sleep(300);

    // 10f. TRAILING NEWLINE must NOT add a phantom row (user report: "把换行识别成整行
    //     然后额外+1" - "AB\\n" claimed TWO rows: a phantom guide line + canvas one row
    //      too tall). A newline only starts a new row if content follows it; the
    //      textarea's trailing empty line is not a row.
    const mTrail = em.measureSampleTextPreview('AB\\n', { kerning: false, width: 116, fontSize: 48 });
    check('trailing newline: measure reports 1 row (no phantom +1)', mTrail && mTrail.rows === 1, mTrail && mTrail.rows);
    check('trailing newline: content height = 1 row (68px)', mTrail && mTrail.contentHeight === 68, mTrail && mTrail.contentHeight);
    await type('AB\\n');
    check('trailing newline: canvas height stays 1 row (68px)', canvas.height === 68, canvas.height);
    // Guides over the same text: still 4 lines (ascender/baseline/descender/xHeight).
    if (!panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);
    const dT = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const tRows = new Set();
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (dT[i] > 200 && dT[i + 1] < 180 && dT[i + 2] < 120 && dT[i + 3] > 0) { tRows.add(y); break; }
        }
    }
    const tys = [...tRows].sort((a, b) => a - b);
    let trailClusters = 0, tPrev = -10;
    for (const y of tys) { if (y - tPrev > 2) trailClusters++; tPrev = y; }
    check('trailing newline: guides still 4 lines (no phantom row)', trailClusters === 4, { guideLines: trailClusters, canvasH: canvas.height });
    if (panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);
    // Middle newline KEEPS its row; only trailing ones are dropped: "A\\nB\\n" = 2 rows.
    const mMid = em.measureSampleTextPreview('A\\nB\\n', { kerning: false, width: 116, fontSize: 48 });
    check('middle newline keeps its row ("A\\nB\\n" = 2 rows)', mMid && mMid.rows === 2 && mMid.contentHeight === 116, mMid && { rows: mMid.rows, h: mMid.contentHeight });
    const mLone = em.measureSampleTextPreview('\\n', { width: 116, fontSize: 48 });
    check('lone newline is one empty row, no crash ("\\n" = 1 row)', mLone && mLone.rows === 1, mLone && mLone.rows);
    await type('AB');
    await sleep(300);

    // 10g. CROSS-NEWLINE PEN LEAK (user report: "metric 仍然比实际多一行" on multi-line
    //      text WITHOUT trailing newline): the row-counting walk in layoutSampleText
    //      kept penX/prevGlyph across newline tokens — a line that filled most of the
    //      canvas pushed the NEXT line's first glyph over the wrap threshold, phantom-
    //      wrapping it; following lines kept accumulating and wrapped again. The DRAW
    //      walk always reset the pen, so guides + content height claimed MORE rows than
    //      the drawn text. Pre-fix: the 3-line fox text measured 5 rows (canvas 260px,
    //      16 guide-line clusters); post-fix: 3 rows / 164px / 10 clusters (4 lines on
    //      the first row, 3 on each following row — desc/asc lines merge across rows).
    const fox = 'The quick brown fox\\nJumps over\\nThe lazy dog';
    const mFox = em.measureSampleTextPreview(fox, { kerning: false, width: 932, fontSize: 48 });
    check('long multi-line: measure reports 3 rows (no phantom wrap after a full line)',
        mFox && mFox.rows === 3, mFox && { rows: mFox.rows, h: mFox.contentHeight });
    check('long multi-line: content height = 3 rows (164px)', mFox && mFox.contentHeight === 164, mFox && mFox.contentHeight);
    check('long multi-line: widest natural line = one full line (~932px)', mFox && mFox.maxRowWidthPx > 920 && mFox.maxRowWidthPx < 945, mFox && mFox.maxRowWidthPx);
    await type(fox);
    check('long multi-line: canvas height = 164px (3 rows, no phantom row)', canvas.height === 164, canvas.height);
    check('long multi-line: canvas width = one natural line (~932px)', canvas.width > 920 && canvas.width < 945, canvas.width);
    if (!panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);
    const dF = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const fRows = new Set();
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (dF[i] > 200 && dF[i + 1] < 180 && dF[i + 2] < 120 && dF[i + 3] > 0) { fRows.add(y); break; }
        }
    }
    const fys = [...fRows].sort((a, b) => a - b);
    let foxClusters = 0, fPrev = -10;
    for (const y of fys) { if (y - fPrev > 2) foxClusters++; fPrev = y; }
    check('long multi-line: guides = 3 rows (10 clusters: desc/asc merge across rows)', foxClusters === 10, { guideLines: foxClusters, canvasH: canvas.height });
    if (panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
    await sleep(300);
    await type('AB');
    await sleep(300);

    // 10h. BACKSLASH SYNTAX (user): "\\xxx\\" = the WHOLE substring is a glyph ref;
    //      "\\\\" (two consecutive) = ONE literal backslash character; an isolated
    //      "\\" (no closing, not doubled) is ignored - parse left to right.
    //      Measurable via maxRowWidthPx (kerning OFF, width 300 - wide enough to
    //      avoid width-wraps; natural-line width is wrap-independent):
    //        'A\\B'  (isolated, '\\' dropped) = A+B = 2 tokens = 116px
    //        'A\\\\B' (escaped) = A+'\\'+B     = 3 tokens = 164px
    //        'AB\\'  (trailing isolated)      = A+B = 116px
    //        '\\\\nope\\\\' (no such group)   = n,o,p,e = 4 tokens = 212px
    //      Char 92 is built via String.fromCharCode to avoid template-literal
    //      escape gymnastics (a doubled backslash in THIS template renders as a
    //      SINGLE backslash inside the probe; a single one would be an invalid
    //      template escape and kill the driver at parse time).
    const BSL = String.fromCharCode(92);
    const hEsc = em.measureSampleTextPreview('A' + BSL + BSL + 'B', { kerning: false, width: 300, fontSize: 48 });
    check('backslash syntax: "\\\\" = ONE literal backslash glyph (3 tokens, 164px)',
        hEsc && hEsc.maxRowWidthPx === 164 && hEsc.rows === 1, hEsc && { w: hEsc.maxRowWidthPx, rows: hEsc.rows });
    const hIso = em.measureSampleTextPreview('A' + BSL + 'B', { kerning: false, width: 300, fontSize: 48 });
    check('backslash syntax: isolated "\\\\" dropped (A+B = 2 tokens, 116px)',
        hIso && hIso.maxRowWidthPx === 116 && hIso.rows === 1, hIso && { w: hIso.maxRowWidthPx, rows: hIso.rows });
    const hTrail = em.measureSampleTextPreview('AB' + BSL, { kerning: false, width: 300, fontSize: 48 });
    check('backslash syntax: trailing isolated "\\\\" ignored (116px, 1 row)',
        hTrail && hTrail.maxRowWidthPx === 116 && hTrail.rows === 1, hTrail && { w: hTrail.maxRowWidthPx, rows: hTrail.rows });
    const hUnk = em.measureSampleTextPreview(BSL + 'nope' + BSL, { kerning: false, width: 300, fontSize: 48 });
    check('backslash syntax: unresolved "\\\\nope\\\\" renders n,o,p,e literally (4 tokens, 212px)',
        hUnk && hUnk.maxRowWidthPx === 212 && hUnk.rows === 1, hUnk && { w: hUnk.maxRowWidthPx, rows: hUnk.rows });
    // End-to-end through the panel: narrow the wrap so canvas width follows the
    // natural line width (10c2 pattern), type both forms, assert the canvas width.
    // Kerning OFF for determinism: the A->B -250 pair from the earlier kerning
    // checks would otherwise shrink the natural width to 104px even for plain 'AB'.
    const kernWasOn = panel.querySelector('#sample_kerning').checked;
    if (kernWasOn) panel.querySelector('#sample_kerning').click();
    await sleep(300);
    wrap.style.width = '60px';
    await sleep(300);
    await type('A' + BSL + BSL + 'B');
    check('backslash syntax: typed "A\\\\B" -> canvas width 164px (backslash rendered)',
        canvas.width === 164, canvas.width);
    await type('A' + BSL + 'B');
    check('backslash syntax: typed "A\\\\B" -> canvas width 116px (isolated dropped)',
        canvas.width === 116, canvas.width);
    wrap.style.width = '';
    wrap.style.flex = '';
    if (kernWasOn) panel.querySelector('#sample_kerning').click();
    await type('AB');
    await sleep(300);

    // 10e. MIN-HEIGHT (user: 限制最小高度 — shrinking the panel height used to make
    //      the preview height 0): the wrap keeps a dynamic min-height of one full row
    //      (fontSize + 2*PAD). Collapsing the panel body must not zero the preview.
    //      body is a flex:1 item — override its flex-basis (NOT height, which flex
    //      ignores) to truly squeeze it.
    const bodyEl = panel.querySelector('.sample-panel-body');
    bodyEl.style.flex = '0 0 20px';
    await sleep(300);
    const minH48 = wrap.clientHeight;
    const bodyH = bodyEl.clientHeight;
    const inkCollapsed = px(ctx);
    check('body actually collapsed (squeezed to 20px)', bodyH < 100, { bodyH });
    check('wrap keeps >= one-row height when panel collapses (48px -> >= 68)', minH48 >= 68, { minH: minH48, bodyH });
    check('preview still renders when panel collapses', inkCollapsed > 100, inkCollapsed);
    const h96c = await setSize(96);
    await sleep(300);
    const minH96 = wrap.clientHeight;
    check('min-height tracks font size (96 -> >= 116)', minH96 >= 116, { minH: minH96 });
    bodyEl.style.flex = '';
    await setSize(48);
    await sleep(300);

    // 11. focusout persists sample_text via dispatcher (history entry). Headless Chrome
    //     does not synthesize real focus events, so dispatch FocusEvent explicitly.
    const stack0 = cv.commandStack ? cv.commandStack.length : -1;
    await type('ABE');
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await sleep(400);
    check('sample_text persisted to fontSettings', cv.fontSettings.sample_text === 'ABE', cv.fontSettings.sample_text);
    check('history entry recorded for save', cv.commandStack ? cv.commandStack.length === stack0 + 1 : false, { stack0, stack: cv.commandStack?.length });
    // Undo restores the sample_text that was current BEFORE the save ('ABCDEFG' from the fixture)
    await CanvasDispatcher.requestUndo();
    await sleep(500);
    check('undo restores previous sample_text', cv.fontSettings.sample_text === 'ABCDEFG', cv.fontSettings.sample_text);
    await CanvasDispatcher.requestRedo();
    await sleep(500);
    check('redo reapplies sample_text', cv.fontSettings.sample_text === 'ABE', cv.fontSettings.sample_text);

    // 12. \\name\\ reference token renders (test group)
    await type('AB\\\\test\\\\');
    const pxRef = px(ctx);
    check('\\\\name\\\\ ref token renders (test group)', pxRef > 50, pxRef);

    // 13. Multi-line: newline breaks rows without crashing
    await type('A\\nB');
    check('multi-line render survives', px(ctx) > 100, px(ctx));

    // 10d. Panel settings (font size / kerning / guides) persist to localStorage.
    //      Leave the NON-default values in place so Phase B can verify the restore.
    //      Idempotent toggles + before/after state capture so a failure pinpoints
    //      whether a click actually toggled (component) or the state diverged (driver).
    const fsi = panel.querySelector('#sample_font_size');
    fsi.value = '72';
    fsi.dispatchEvent(new Event('change', { bubbles: true }));
    const guidesChk = panel.querySelector('#sample_guides');
    const kernChk = panel.querySelector('#sample_kerning');
    const gBefore = guidesChk.checked, kBefore = kernChk.checked;
    if (guidesChk.checked) guidesChk.click(); // ensure OFF
    if (kernChk.checked) kernChk.click(); // ensure OFF
    await sleep(300);
    const stored = JSON.parse(localStorage.getItem('inkshader_sample_panel_state'));
    check('panel settings persisted to localStorage',
        stored && stored.fontSize === 72 && stored.kerning === false && stored.guides === false,
        { ...stored, gBefore, gAfter: guidesChk.checked, kBefore, kAfter: kernChk.checked, instances: document.querySelectorAll('sample-text-panel').length });

    // Remember the fixture we set for phase B (old-layout restore check)
    window.__sampleProbeState = { sampleText: cv.fontSettings.sample_text };

    return JSON.stringify(out);
})()
`;

const PROBE_B = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    window.addEventListener('error', e => { if (!e.message.includes('ResizeObserver loop')) out.errors.push('error: ' + e.message); });
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // An OLD layout (v2 key, no sample panel) was written to localStorage before reload
    const leaf = document.querySelector('.dock-leaf[data-panel-id="sample"]');
    check('sample panel re-added after restoring old layout', !!leaf, !!leaf);
    const panel = document.querySelector('sample-text-panel');
    check('panel component re-mounted', !!panel, null);
    check('panel placed inside its leaf', !!leaf && leaf.querySelector('.dock-content').contains(panel), null);
    // Legacy panels survived the restore too
    check('legacy panels intact', !!document.querySelector('.dock-leaf[data-panel-id="console"]'), null);
    check('canvas panel intact', !!document.querySelector('.dock-leaf[data-panel-id="canvas"]'), null);
    // Panel settings restored from localStorage (Phase A left 72 / OFF / OFF)
    const fsb = panel.querySelector('#sample_font_size');
    check('panel settings restored from localStorage after reload',
        fsb.value === '72' && !panel.querySelector('#sample_kerning').checked && !panel.querySelector('#sample_guides').checked,
        { v: fsb.value, k: panel.querySelector('#sample_kerning').checked, g: panel.querySelector('#sample_guides').checked });

    return JSON.stringify(out);
})()
`;

async function main() {
    let target;
    try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await res.json();
    } catch (e) {
        console.error('Cannot create tab (is Chrome running with --remote-debugging-port=' + DEBUG_PORT + '?):', e.message);
        process.exit(1);
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) {
            return { error: JSON.stringify(r.result.exceptionDetails, null, 2) };
        }
        return { value: r.result?.result?.value };
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager && !!document.querySelector('main-canvas').services?.renderer`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    // ── Phase A ──
    const a = await evaluate(PROBE_A);
    if (a.error) { console.log('PROBE_A EXCEPTION:', a.error); }
    else console.log('--- PHASE A ---\n' + a.value);

    // ── Seed an OLD layout (v2 key, no sample panel) and reload ──
    const seed = await evaluate(`(() => {
        const oldTree = { type: 'split', direction: 'h', sizes: [75, 25],
            children: [
                { type: 'leaf', id: 'canvas' },
                { type: 'split', direction: 'v', sizes: [33.33, 33.33, 33.33],
                    children: [ { type: 'leaf', id: 'objects' }, { type: 'leaf', id: 'properties' }, { type: 'leaf', id: 'console' } ] }
            ] };
        localStorage.setItem('inkshader_dock_layout_v2', JSON.stringify({ tree: oldTree, floats: [] }));
        return 'seeded';
    })()`);
    console.log('seed old layout:', seed.error || seed.value);

    await send('Page.navigate', { url: APP_URL + '&b=2' });
    await new Promise(r2 => setTimeout(r2, 4000));

    // ── Phase B ──
    const b = await evaluate(PROBE_B);
    if (b.error) { console.log('PROBE_B EXCEPTION:', b.error); }
    else console.log('--- PHASE B ---\n' + b.value);

    ws.close();
}

main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
