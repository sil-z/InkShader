// glyph_cols_title_probe.mjs — CDP driver for Session 30 verification:
// ① "Add Kerning" title removed from kern-popup; ② "Add Glyph" title removed
// from BOTH the glyph dock panel AND the sequence-bar add menu (openable at
// many positions); ③ glyph dock panel grid columns now width-dynamic
// (ResizeObserver on the dock leaf) while the sequence-bar add menu keeps its
// fixed 8-column sizing (widths unchanged — cols only shrink when the window
// itself has no room, that legacy logic untouched).
//
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=glyph-cols-1';

const PROBE = `
(async () => {
    const out = { checks: [], errors: [] };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', e => out.errors.push('unhandledrejection: ' + String(e.reason)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = document.querySelector('main-canvas');
    const dock = window.__dock;
    const check = (name, ok, detail) => out.checks.push({ name, ok, detail });
    const waitFrames = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };
    const bodyText = () => document.body.innerText.replace(/\\s+/g, ' ');

    window.confirm = () => true;
    const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
    await cv.projectManager.loadFromFile(await resp.text());
    await sleep(400);

    // ── 1. Kern panel: title gone, structure intact ──
    dock.showPanel('kerning');
    await waitFrames(4);
    const kern = document.querySelector('kern-popup');
    check('kern panel attached', !!kern && kern.isConnected);
    check('kern: no Add Kerning text', !bodyText().includes('Add Kerning'),
        bodyText().match(/.{0,30}Add Kerning.{0,30}/)?.[0] ?? 'none');
    check('kern: no .seq-menu-header', !kern.querySelector('.seq-menu-header'));
    check('kern: add row + list present',
        !!kern.querySelector('.kern-popup-add-row') && !!kern.querySelector('.kern-popup-list'));
    check('kern: pair rows render', kern.querySelectorAll('.kern-pair-row').length >= 1,
        'rows=' + kern.querySelectorAll('.kern-pair-row').length);
    dock.hidePanel('kerning');
    await waitFrames(2);

    // ── 2. Glyph dock panel: title gone, cols dynamic ──
    dock.showPanel('glyphs');
    await waitFrames(4);
    const gp = document.querySelector('glyph-popup');
    check('glyph panel attached', !!gp && gp.isConnected);
    check('glyph: no Add Glyph text', !bodyText().includes('Add Glyph'),
        bodyText().match(/.{0,30}Add Glyph.{0,30}/)?.[0] ?? 'none');
    check('glyph: no .seq-menu-header .seq-menu-title', !gp.querySelector('.seq-menu-header, .seq-menu-title'));
    const grid = gp.querySelector('.seq-menu-char-grid');
    check('glyph: 95 char cells', grid.querySelectorAll('.seq-menu-char-item').length === 95,
        'cells=' + grid.querySelectorAll('.seq-menu-char-item').length);

    const colsInfo = () => {
        const gridEl = gp.querySelector('.seq-menu-char-grid');
        const w = gridEl.clientWidth;
        const expect = Math.max(1, Math.floor((w + gp.constructor.GRID_GAP) / (gp.constructor.COLUMN_W + gp.constructor.GRID_GAP)));
        return { w, expect, actual: gp._cols, css: gridEl.style.gridTemplateColumns };
    };
    let ci = colsInfo();
    check('glyph: cols match width formula', ci.actual === ci.expect && ci.css === 'repeat(' + ci.actual + ', 68px)', JSON.stringify(ci));

    // Resize the dock leaf (narrow then wide) → cols must follow. The leaf may
    // sit in a horizontal OR vertical split (flex-basis then controls height),
    // so force the width explicitly to make the test orientation-agnostic.
    const leaf = gp.closest('.dock-leaf');
    const origFlex = leaf.style.flex;
    const origW = leaf.style.width;
    const setLeafW = (w) => { leaf.style.flex = '0 0 ' + w + 'px'; leaf.style.width = w + 'px'; };
    setLeafW(160);
    await waitFrames(4);
    ci = colsInfo();
    check('glyph: cols shrink on narrow leaf', ci.actual === ci.expect && ci.actual < 8 && ci.css === 'repeat(' + ci.actual + ', 68px)',
        Object.assign({ leafParent: leaf.parentElement.className }, ci));
    const narrowCols = ci.actual;
    setLeafW(640);
    await waitFrames(4);
    ci = colsInfo();
    check('glyph: cols grow on wide leaf', ci.actual === ci.expect && ci.actual > narrowCols && ci.css === 'repeat(' + ci.actual + ', 68px)', JSON.stringify(ci));
    leaf.style.flex = origFlex;
    leaf.style.width = origW;
    await waitFrames(4);
    ci = colsInfo();
    check('glyph: cols return after restore', ci.actual === ci.expect && ci.css === 'repeat(' + ci.actual + ', 68px)', JSON.stringify(ci));

    // ── Geometry stability between column thresholds (the user requirement):
    //    at two widths with the SAME column count, item width, inter-item gap
    //    and the last column's right edge must be IDENTICAL — the extra width
    //    accumulates at the right of the grid, never in the columns/gaps. ──
    const pair = [];
    for (const lw of [340, 360, 380, 400, 420, 440]) {
        setLeafW(lw);
        await waitFrames(4);
        pair.push({ lw, ci: colsInfo() });
    }
    let geomPair = null;
    for (let i = 1; i < pair.length; i++) {
        if (pair[i].ci.expect === pair[i - 1].ci.expect) { geomPair = { a: pair[i - 1], b: pair[i] }; break; }
    }
    const geom = () => {
        const items = Array.from(gp.querySelectorAll('.seq-menu-char-item'));
        const r0 = items[0].getBoundingClientRect();
        const r1 = items[1].getBoundingClientRect();
        const rLast = items[geomPair.a.ci.expect - 1].getBoundingClientRect();
        return { itemW: items[0].offsetWidth, gap: +(r1.left - r0.right).toFixed(2), lastRight: +(rLast.right - r0.left).toFixed(2) };
    };
    const gA = geom();
    setLeafW(geomPair.b.lw);
    await waitFrames(4);
    const gB = geom();
    check('glyph: geometry identical between thresholds (fixed cols/gap, leftover right)',
        gA.itemW === gB.itemW && Math.abs(gA.gap - gB.gap) < 0.01 && Math.abs(gA.lastRight - gB.lastRight) < 0.01
            && geomPair.b.ci.w > geomPair.a.ci.w,
        JSON.stringify({ a: Object.assign({ lw: geomPair.a.lw }, gA), b: Object.assign({ lw: geomPair.b.lw }, gB) }));
    setLeafW(geomPair.a.lw);
    await waitFrames(2);
    dock.hidePanel('glyphs');
    await waitFrames(2);

    // ── 3. Sequence-bar add menu: title gone, close btn kept, FIXED 8 cols ──
    const insBtn = document.querySelector('glyph-sequence-bar .seq-bar-ins-btn');
    check('seq bar has insert button', !!insBtn);
    const r = insBtn.getBoundingClientRect();
    insBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 2, clientY: r.y + 2 }));
    await waitFrames(4);
    const menus = document.querySelectorAll('body > .sequence-add-menu');
    const menu = menus[menus.length - 1];
    check('add menu opened', !!menu && menu.isConnected);
    check('add menu: no Add Glyph title', !(menu.textContent || '').includes('Add Glyph'));
    check('add menu: close button kept', !!menu.querySelector('.seq-menu-close-btn'));
    check('add menu: NO .seq-menu-title', !menu.querySelector('.seq-menu-title'));
    const mGrid = menu.querySelector('.seq-menu-char-grid');
    const mWidth = parseFloat(menu.style.width);
    check('add menu: fixed width 556 (8*68+12)', Math.round(mWidth) === 556, 'menuWidth=' + mWidth);
    check('add menu: fixed repeat(8,1fr)', mGrid.style.gridTemplateColumns === 'repeat(8, 1fr)', mGrid.style.gridTemplateColumns);
    check('add menu: 95 char cells', mGrid.querySelectorAll('.seq-menu-char-item').length === 95,
        'cells=' + mGrid.querySelectorAll('.seq-menu-char-item').length);
    menu.querySelector('.seq-menu-close-btn').click();
    await waitFrames(2);
    check('add menu closes via X', !menu.isConnected);

    out.finalBodyText = bodyText();
    return JSON.stringify(out);
})()
`;

async function main() {
    const target = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager && !!window.__dock`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1200));

    const res = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
        console.log('PROBE EXCEPTION:', JSON.stringify(res.result.exceptionDetails, null, 2));
    } else {
        const v = JSON.parse(res.result?.result?.value);
        let pass = 0, fail = 0;
        for (const c of v.checks) {
            console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail !== undefined ? '  ' + JSON.stringify(c.detail) : ''}`);
            c.ok ? pass++ : fail++;
        }
        console.log(`\nerrors: ${JSON.stringify(v.errors)}`);
        console.log(`\nSUMMARY: ${pass}/${v.checks.length} passed${fail ? `, ${fail} FAILED` : ''}`);
        process.exit(fail ? 1 : 0);
    }
    ws.close();
}

main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });