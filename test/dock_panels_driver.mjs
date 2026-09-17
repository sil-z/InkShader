// test/dock_panels_driver.mjs
// E2E probe for the Font/Kerning/Glyphs dock-panel conversion (Edit menu toggles).
// Pure-Node CDP driver: headless Chrome on :9222, dev server on :8123.
// Run:  node test/dock_panels_driver.mjs
//
// Prerequisites (see AGENTS.md session notes):
//   - headless Chrome:  --headless=new --remote-debugging-port=9222 --user-data-dir=...
//   - dev server:       python -m http.server 8123   (from InkShader\)

const CDP_PORT = 9222;
const APP_URL = "http://localhost:8123/";
const BASELINE = "/test/InkShader_project_2026-08-02T16-27-25.json";

// ── minimal CDP client ──────────────────────────────────────────────────────
let msgId = 0;
const pending = new Map();

function cdp(ws, method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error("CDP timeout: " + method));
            }
        }, 20000);
    });
}

async function evalJs(ws, expr) {
    const r = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
        throw new Error("EVAL EXCEPTION: " + JSON.stringify(r.exceptionDetails).slice(0, 600));
    }
    return r.result.value;
}

async function waitReady(ws) {
    const ok = await evalJs(ws, `(async () => {
        for (let i = 0; i < 600; i++) {
            if (window.__dock && window.__canvas && document.querySelector('.dock-container')) return true;
            await new Promise(r => setTimeout(r, 50));
        }
        return false;
    })()`);
    if (!ok) throw new Error("APP NEVER REACHED READY (__dock/__canvas missing)");
}

// ── test harness ────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  | " + JSON.stringify(detail) : ""));
}
const assert = (cond, name, detail) => check(name, !!cond, detail);

// ── main ────────────────────────────────────────────────────────────────────
const targets = await (await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
};

try {
    await cdp(ws, "Page.enable");
    await cdp(ws, "Runtime.enable");
    await cdp(ws, "Network.enable");
    await cdp(ws, "Network.clearBrowserCache");
    // Error + confirm patch installed on EVERY new document (survives reloads).
    await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: `
        window.__errs = [];
        window.addEventListener('error', e => { try { window.__errs.push('ERR:' + e.message); } catch (_) {} });
        window.addEventListener('unhandledrejection', e => { try { window.__errs.push('REJ:' + String((e.reason && e.reason.message) || e.reason)); } catch (_) {} });
        window.confirm = () => true;
    ` });

    await cdp(ws, "Page.navigate", { url: APP_URL });
    await waitReady(ws);
    // Wipe any stale localStorage (dock layout / lang / sample panel state) and reload clean.
    await evalJs(ws, `(async () => { localStorage.clear(); location.reload(); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    await waitReady(ws);

    // ── Phase A: fresh default state ──
    const A = await evalJs(ws, `(() => {
        const items = [...document.querySelectorAll('.top .item')]
            .filter(el => el.id !== 'brand_title')
            .map(el => el.getAttribute('data-i18n'));
        const leaves = ['font','kerning','glyphs'].map(id => !!document.querySelector('.dock-leaf[data-panel-id="' + id + '"]'));
        const comps = ['font-popup','kern-popup','glyph-popup'].map(sel => {
            const el = document.querySelector(sel);
            return el ? { exists: true, inDock: !!el.closest('.dock-content') } : { exists: false };
        });
        const titles = ['font-popup','kern-popup','glyph-popup'].map(sel => {
            const t = document.querySelector(sel + ' .panel_title');
            return t ? { text: t.textContent, key: t.getAttribute('data-i18n') } : null;
        });
        return {
            items,
            menuKern: !!document.getElementById('menu_kerning'),
            menuGlyphs: !!document.getElementById('menu_glyphs'),
            hidden: ['font','kerning','glyphs'].map(id => window.__dock.isPanelHidden(id)),
            leaves,
            comps,
            titles
        };
    })()`);
    assert(JSON.stringify(A.items) === JSON.stringify(["menu.file", "menu.edit", "menu.layout", "menu.prefs", "menu.help"]),
        "A1 menubar = File/Edit/Layout/Preferences/Help", A.items);
    assert(!A.menuKern && !A.menuGlyphs, "A2 #menu_kerning / #menu_glyphs removed from DOM");
    assert(A.hidden.every(Boolean), "A3 all three panels hidden by default", A.hidden);
    assert(A.leaves.every(l => !l), "A4 no font/kerning/glyphs dock leaves", A.leaves);
    assert(A.comps.every(c => c.exists && !c.inDock), "A5 components mounted in body, outside dock", A.comps);
    const wantTitles = [["Font","panel.font"],["Kerning","panel.kerning"],["Glyphs","panel.glyphs"]];
    assert(A.titles.every((t, i) => t && t.text === wantTitles[i][0] && t.key === wantTitles[i][1]),
        "A6 title bars present with i18n keys", A.titles);

    // Load the baseline project so glyph/kern content checks have data.
    await evalJs(ws, `(async () => {
        const txt = await (await fetch('${BASELINE}')).text();
        await window.__canvas.projectManager.loadFromFile(txt);
        await new Promise(r => setTimeout(r, 1200));
        return true;
    })()`);

    // ── Phase B: Edit menu toggles ──
    const B1 = await evalJs(ws, `(() => {
        document.getElementById('menu_layout').click();
        const dd = document.querySelector('dropdown-menu');
        const labels = [...dd.querySelectorAll('.save-dropdown-label')].map(e => e.textContent);
        return { visible: dd._visible, labels };
    })()`);
    assert(B1.visible, "B1 Edit menu opens");
    assert(B1.labels.includes('   Font') && B1.labels.includes('   Kerning') && B1.labels.includes('   Glyphs'),
        "B2 panel toggles present, unchecked (3-space prefix)", B1.labels.filter(l => /(Font|Kerning|Glyphs)$/.test(l)));

    const B3 = await evalJs(ws, `(() => {
        const dd = document.querySelector('dropdown-menu');
        const item = [...dd.querySelectorAll('.save-dropdown-item')]
            .find(d => (d.querySelector('.save-dropdown-label')?.textContent || '').includes('Font'));
        item.click();
        const stored = JSON.parse(localStorage.getItem('inkshader_dock_layout_v2'));
        const fp = document.querySelector('font-popup');
        return {
            hidden: window.__dock.isPanelHidden('font'),
            leaf: !!document.querySelector('.dock-leaf[data-panel-id="font"]'),
            inDock: !!fp.closest('.dock-content'),
            hiddenPanels: stored.hiddenPanels,
            pos: getComputedStyle(fp).position,
            disp: getComputedStyle(fp).display
        };
    })()`);
    assert(B3.hidden === false, "B3 Font panel shown after toggle");
    assert(B3.leaf && B3.inDock, "B4 Font leaf exists, component inside .dock-content", { leaf: B3.leaf, inDock: B3.inDock });
    assert(JSON.stringify(B3.hiddenPanels) === '["kerning","glyphs"]', "B5 storage hiddenPanels = [kerning,glyphs]", B3.hiddenPanels);
    assert(B3.pos === "static" && B3.disp === "flex", "B6 docked font-popup styled static/flex", { pos: B3.pos, disp: B3.disp });

    const B7 = await evalJs(ws, `(() => {
        document.getElementById('menu_layout').click();
        const dd = document.querySelector('dropdown-menu');
        const labels = [...dd.querySelectorAll('.save-dropdown-label')].map(e => e.textContent);
        return { font: labels.find(l => l.includes('Font')), kern: labels.find(l => l.includes('Kerning')) };
    })()`);
    assert(B7.font === '✓ Font' && B7.kern === '   Kerning', "B7 checkmark sync: Font checked, Kerning unchecked", B7);

    // Toggle Font back off (menu auto-hides after an item click).
    await evalJs(ws, `(() => {
        document.getElementById('menu_layout').click();
        const dd = document.querySelector('dropdown-menu');
        const item = [...dd.querySelectorAll('.save-dropdown-item')]
            .find(d => (d.querySelector('.save-dropdown-label')?.textContent || '').includes('Font'));
        item.click();
        return true;
    })()`);
    const B8 = await evalJs(ws, `(() => {
        const stored = JSON.parse(localStorage.getItem('inkshader_dock_layout_v2'));
        const leaf = document.querySelector('.dock-leaf[data-panel-id="font"]');
        return {
            hidden: window.__dock.isPanelHidden('font'),
            leaf: !!leaf,
            gone: !leaf,
            hosted: !!document.querySelector('#dock-hidden-host font-popup'),
            attached: !!document.querySelector('font-popup'),
            hiddenPanels: stored.hiddenPanels
        };
    })()`);
    assert(B8.hidden === true && B8.gone && B8.hosted && B8.attached,
        "B8 Font panel hidden again (leaf removed, component kept alive in hidden host)", B8);
    assert(JSON.stringify(B8.hiddenPanels) === '["kerning","glyphs","font"]', "B9 storage hiddenPanels now includes font", B8.hiddenPanels);

    // Show all three for content checks.
    await evalJs(ws, `(async () => {
        for (const label of ['Font', 'Kerning', 'Glyphs']) {
            document.getElementById('menu_layout').click();
            const dd = document.querySelector('dropdown-menu');
            const item = [...dd.querySelectorAll('.save-dropdown-item')]
                .find(d => (d.querySelector('.save-dropdown-label')?.textContent || '').includes(label));
            item.click();
            await new Promise(r => setTimeout(r, 150));
        }
        await new Promise(r => setTimeout(r, 1000));
        return true;
    })()`);
    const B10 = await evalJs(ws, `(() => {
        const grid = document.querySelector('glyph-popup .seq-menu-char-grid');
        const aItem = grid ? [...grid.children].find(c => (c.title || '').startsWith('A (65')) : null;
        const kernSel = document.querySelector('kern-popup .kern-left-select');
        const seqMenu = document.querySelector('glyph-popup .sequence-add-menu');
        return {
            hidden: ['font','kerning','glyphs'].map(id => window.__dock.isPanelHidden(id)),
            gridChildren: grid ? grid.children.length : 0,
            aItem: !!aItem,
            kernOpts: kernSel ? kernSel.options.length : 0,
            kernRows: document.querySelectorAll('kern-popup .kern-pair-row').length,
            upm: document.querySelector('#font_popup_upm')?.value,
            seqMenuPos: seqMenu ? getComputedStyle(seqMenu).position : null
        };
    })()`);
    assert(B10.hidden.every(h => !h), "B10 all three panels visible", B10.hidden);
    assert(B10.gridChildren >= 95, "B11 glyph grid rendered (>=95 cells)", B10.gridChildren);
    assert(B10.aItem, "B12 glyph grid maps group A to char 65");
    assert(B10.kernOpts >= 5, "B13 kern selects populated with root groups", B10.kernOpts);
    assert(B10.kernRows >= 1, "B14 kern pair rows rendered (fixture A->E -500)", B10.kernRows);
    assert(B10.upm === "1000", "B15 font popup fields loaded from project", B10.upm);
    assert(B10.seqMenuPos === "static", "B16 glyph sequence-add-menu overridden to static", B10.seqMenuPos);

    // i18n dynamic title translation (MutationObserver path).
    // English is the only shipped locale, so instead of switching languages we
    // inject a fresh node carrying a data-i18n attribute: the observer must
    // translate it without an explicit translateDOM() call.
    const B17 = await evalJs(ws, `(async () => {
        const probe = document.createElement('div');
        probe.setAttribute('data-i18n', 'panel.kerning');
        probe.textContent = 'PLACEHOLDER';
        document.querySelector('kern-popup').appendChild(probe);
        await new Promise(r => setTimeout(r, 50));
        const translated = probe.textContent;
        probe.remove();
        const titles = ['font-popup','kern-popup','glyph-popup'].map(s => document.querySelector(s + ' .panel_title').textContent);
        return { translated, titles };
    })()`);
    assert(B17.translated === 'Kerning', "B17 MutationObserver translates injected i18n nodes", B17.translated);
    assert(JSON.stringify(B17.titles) === '["Font","Kerning","Glyphs"]', "B18 title bars use the English table", B17.titles);

    // dataset.panelHidden lifecycle (Session 27): hiding removes the leaf from
    // the dock tree (no title, no space) but the component is kept ALIVE in the
    // body-level hidden host — document-internal move, never detached.
    const B19 = await evalJs(ws, `(() => {
        const comp = window.__dock._componentRefs.font;
        window.__dock.hidePanel('font');
        const flag = comp.dataset.panelHidden;
        const attached = !!document.querySelector('font-popup');
        const hosted = !!document.querySelector('#dock-hidden-host font-popup');
        const leafGone = !document.querySelector('.dock-leaf[data-panel-id="font"]');
        window.__dock.showPanel('font');
        const gone = !('panelHidden' in comp.dataset);
        const leafShown = !!document.querySelector('.dock-leaf[data-panel-id="font"]');
        const backInDock = !!document.querySelector('.dock-leaf[data-panel-id="font"] font-popup');
        return { flag, gone, attached, hosted, leafGone, leafShown, backInDock, shown: !window.__dock.isPanelHidden('font') };
    })()`);
    assert(B19.flag === "1" && B19.gone && B19.shown && B19.attached && B19.hosted && B19.leafGone && B19.leafShown && B19.backInDock,
        "B19 dataset.panelHidden lifecycle (flag set/removed, component kept alive in hidden host)", B19);

    // ├─ Phase C: persistence across reloads ──
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const C1 = await evalJs(ws, `(() => ({
        hidden: ['font','kerning','glyphs'].map(id => window.__dock.isPanelHidden(id)),
        leaves: ['font','kerning','glyphs'].map(id => !!document.querySelector('.dock-leaf[data-panel-id="' + id + '"]')),
        stored: JSON.parse(localStorage.getItem('inkshader_dock_layout_v2')).hiddenPanels
    }))()`);
    assert(C1.hidden.every(h => !h) && C1.leaves.every(Boolean), "C1 visible panels persist through reload", C1);
    assert(JSON.stringify(C1.stored) === "[]", "C2 stored hiddenPanels empty when all visible", C1.stored);

    // Hide all three, reload, expect all hidden.
    await evalJs(ws, `(async () => {
        for (const label of ['Font', 'Kerning', 'Glyphs']) {
            document.getElementById('menu_layout').click();
            const dd = document.querySelector('dropdown-menu');
            const item = [...dd.querySelectorAll('.save-dropdown-item')]
                .find(d => (d.querySelector('.save-dropdown-label')?.textContent || '').includes(label));
            item.click();
            await new Promise(r => setTimeout(r, 150));
        }
        return true;
    })()`);
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const C3 = await evalJs(ws, `(() => {
        const hosts = { font: 'font-popup', kerning: 'kern-popup', glyphs: 'glyph-popup' };
        return {
            hidden: ['font','kerning','glyphs'].map(id => window.__dock.isPanelHidden(id)),
            leaves: ['font','kerning','glyphs'].map(id => !!document.querySelector('.dock-leaf[data-panel-id="' + id + '"]')),
            hosted: ['font','kerning','glyphs'].map(id => !!document.querySelector('#dock-hidden-host ' + hosts[id]))
        };
    })()`);
    assert(C3.hidden.every(Boolean) && C3.leaves.every(l => !l) && C3.hosted.every(Boolean),
        "C3 hidden panels persist through reload (no dock leaves, components alive in hidden host)", C3);

    // Migration: old v2 layout WITHOUT hiddenPanels and without the three ids.
    await evalJs(ws, `(() => {
        localStorage.setItem('inkshader_dock_layout_v2', JSON.stringify({ tree: { type: 'leaf', id: 'canvas' }, floats: [] }));
        return true;
    })()`);
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const C4 = await evalJs(ws, `(() => ({
        hidden: ['font','kerning','glyphs'].map(id => window.__dock.isPanelHidden(id)),
        leaves: ['font','kerning','glyphs'].map(id => !!document.querySelector('.dock-leaf[data-panel-id="' + id + '"]'))
    }))()`);
    assert(C4.hidden.every(Boolean) && C4.leaves.every(l => !l), "C4 old layout migrates: optional panels auto-hidden", C4);

    // Restore a sane default for the real app: clear the dock layout key.
    await evalJs(ws, `(() => { localStorage.removeItem('inkshader_dock_layout_v2'); return true; })()`);

    const C5 = await evalJs(ws, `(() => {
        const benign = e => /ResizeObserver loop|favicon|Script error/i.test(e);
        const real = window.__errs.filter(e => !benign(e));
        return { total: window.__errs.length, real };
    })()`);
    assert(C5.real.length === 0, "C5 zero app errors during the whole session", C5);

    // ── Phase D: Session 24 — 8-panel Layout menu, core hide/show, resize
    // ── no-drift, min-size auto-tab, restore normalization ──
    // D1: Layout menu now toggles ALL eight panels.
    const D1 = await evalJs(ws, `(() => {
        document.getElementById('menu_layout').click();
        const dd = document.querySelector('dropdown-menu');
        const labels = [...dd.querySelectorAll('.save-dropdown-label')].map(e => e.textContent);
        const has = (s) => !!labels.find(l => l.includes(s));
        { document.getElementById('menu_layout').click(); } // close again
        return { canvas: has('Canvas'), objects: has('Objects'), properties: has('Properties'),
                 console: has('Console'), sample: has('Sample'), font: has('Font'),
                 kern: has('Kerning'), glyphs: has('Glyphs') };
    })()`);
    assert(D1.canvas && D1.objects && D1.properties && D1.console && D1.sample && D1.font && D1.kern && D1.glyphs,
        "D1 Layout menu has 8 panel toggles", D1);

    // English-only build: a leftover language setting from an older version must
    // not resurrect a removed locale (I18nManager.lang is fixed to 'en').
    const D2 = await evalJs(ws, `(() => {
        localStorage.setItem('InkShader_lang', 'zh');
        const lang = window.I18n.lang;
        const label = window.I18n.t('panel.canvas');
        const switched = (window.I18n.setLang('zh'), window.I18n.lang);
        localStorage.removeItem('InkShader_lang');
        return { lang, label, switched };
    })()`);
    assert(D2.lang === 'en' && D2.label === 'Canvas',
        "D2 English is the only locale (stale stored language ignored)", D2);

    // D3/D4: console is a CORE panel — hide/show must work like the trio.
    const D3 = await evalJs(ws, `(() => {
        window.__dock.hidePanel('console');
        const leaf = document.querySelector('.dock-leaf[data-panel-id="console"]');
        return {
            hidden: window.__dock.isPanelHidden('console'),
            leaf: !!leaf,
            gone: !leaf,
            compAttached: !!document.querySelector('logger-panel'),
            hosted: !!document.querySelector('#dock-hidden-host logger-panel'),
            refKept: !!window.__dock._componentRefs.console
        };
    })()`);
    assert(D3.hidden && D3.gone && D3.compAttached && D3.hosted && D3.refKept,
        "D3 console hidden (leaf removed, component kept alive in hidden host)", D3);

    const D4 = await evalJs(ws, `(() => {
        window.__dock.showPanel('console');
        const comp = document.querySelector('logger-panel');
        return {
            hidden: window.__dock.isPanelHidden('console'),
            leaf: !!document.querySelector('.dock-leaf[data-panel-id="console"]'),
            reattached: !!comp && !!comp.closest('.dock-content')
        };
    })()`);
    assert(!D4.hidden && D4.leaf && D4.reattached, "D4 console shown again", D4);

    // D5/D6: the canvas itself can be hidden and restored without breaking the app.
    const D5 = await evalJs(ws, `(() => {
        window.__dock.hidePanel('canvas');
        const leaf = document.querySelector('.dock-leaf[data-panel-id="canvas"]');
        return {
            hidden: window.__dock.isPanelHidden('canvas'),
            leaf: !!leaf,
            gone: !leaf,
            wrapAttached: !!document.querySelector('.canvas-wrap'),
            hosted: !!document.querySelector('#dock-hidden-host main-canvas'),
            canvasAlive: !!window.__canvas && !!window.__canvas.curve_manager
        };
    })()`);
    assert(D5.hidden && D5.gone && D5.wrapAttached && D5.hosted && D5.canvasAlive,
        "D5 canvas hidden (leaf removed, component alive in hidden host)", D5);

    const D6 = await evalJs(ws, `(() => {
        window.__dock.showPanel('canvas');
        const wrap = document.querySelector('.canvas-wrap');
        let renderOk = true, renderErr = null;
        try { window.__canvas.services.renderer.renderCanvas(); } catch (e) { renderOk = false; renderErr = String(e); }
        return {
            hidden: window.__dock.isPanelHidden('canvas'),
            leaf: !!document.querySelector('.dock-leaf[data-panel-id="canvas"]'),
            reattached: !!wrap && !!wrap.closest('.dock-content'),
            connected: !!window.__canvas && window.__canvas.isConnected,
            renderOk, renderErr
        };
    })()`);
    assert(!D6.hidden && D6.leaf && D6.reattached && D6.connected && D6.renderOk,
        "D6 canvas shown again, rendering still works", D6);

    // D7: aggressive splitter drags past the minimums — sizes must never drift
    // (the Session 24 clamp: capacity is floored at 0, sum stays 100).
    const D7 = await evalJs(ws, `(() => {
        const resizer = document.querySelector('.dock-resizer');
        if (!resizer) return { found: false };
        const r0 = resizer.getBoundingClientRect();
        const isH = resizer.parentElement.classList.contains('dock-split-h');
        const x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2;
        const fire = (type, x, y) => document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
        const P = (dx, dy) => [isH ? x0 + dx : x0, isH ? y0 : y0 + dy];
        resizer.dispatchEvent(new MouseEvent('mousedown', { clientX: x0, clientY: y0, bubbles: true }));
        let p = P(-500, -500); fire('mousemove', p[0], p[1]);
        p = P(500, 500); fire('mousemove', p[0], p[1]);
        for (let i = 0; i < 4; i++) { p = P(-500, -500); fire('mousemove', p[0], p[1]); }
        p = P(-500, -500); fire('mouseup', p[0], p[1]);
        const sumOf = (sizes) => sizes.reduce((a, b) => a + b, 0);
        const splits = [];
        const walk = (n) => {
            if (!n) return;
            if (n.type === 'split') {
                splits.push({ dir: n.direction, sizes: n.sizes, sum: sumOf(n.sizes || []) });
                (n.children || []).forEach(walk);
            } else if (n.type === 'tabs') {
                (n.children || []).forEach(walk);
            }
        };
        walk(window.__dock.serialize());
        return {
            found: true,
            allSum100: splits.every(s => Math.abs(s.sum - 100) < 1e-9),
            noNegative: splits.every(s => (s.sizes || []).every(v => v >= 0)),
            splits
        };
    })()`);
    assert(D7.found && D7.allSum100 && D7.noNegative,
        "D7 aggressive resize drags keep every split at sum=100 (no drift)", D7.splits);

    const D8 = await evalJs(ws, `(() => {
        const data = JSON.parse(localStorage.getItem('inkshader_dock_layout_v2'));
        const sumOf = (sizes) => sizes.reduce((a, b) => a + b, 0);
        const splits = [];
        const walk = (n) => {
            if (!n) return;
            if (n.type === 'split') {
                splits.push({ dir: n.direction, sizes: n.sizes, sum: sumOf(n.sizes || []) });
                (n.children || []).forEach(walk);
            } else if (n.type === 'tabs') {
                (n.children || []).forEach(walk);
            }
        };
        walk(data.tree);
        return { allSum100: splits.every(s => Math.abs(s.sum - 100) < 1e-9), splits };
    })()`);
    assert(D8.allSum100, "D8 resized layout persisted with sum=100", D8.splits);

    // D9: narrow window (420px) fresh layout — capacity 2 for h-splits.
    await cdp(ws, "Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await evalJs(ws, `(() => { localStorage.removeItem('inkshader_dock_layout_v2'); return true; })()`);
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const D9 = await evalJs(ws, `(() => {
        const d = window.__dock;
        const t = d.serialize();
        const sumOf = (sizes) => sizes.reduce((a, b) => a + b, 0);
        return {
            rootType: t.type,
            rootChildren: (t.children || []).length,
            sizes: t.sizes,
            sum100: Math.abs(sumOf(t.sizes || []) - 100) < 1e-9,
            hiddenTrio: ['font','kerning','glyphs'].map(id => d.isPanelHidden(id)),
            canvasLeaf: (() => { const w = (n) => { if (!n) return false; if (n.type === 'leaf') return n.id === 'canvas'; return (n.children || []).some(w); }; return w(t); })()
        };
    })()`);
    assert(D9.rootType === 'split' && D9.rootChildren === 2 && D9.sum100 && D9.hiddenTrio.every(Boolean) && D9.canvasLeaf,
        "D9 narrow fresh layout fits capacity, trio hidden", D9);

    // D10: dropping a panel INTO a full split (parallel zone) auto-tabs it.
    // A real drop source is always VISIBLE — clear the hidden flag first
    // (Session 27: hidden panels have no tree leaf; a hidden insert would be
    // reverted by _applyHiddenPanelPlacement during _rebuild).
    const D10 = await evalJs(ws, `(() => {
        const d = window.__dock;
        d._hiddenPanels.delete('font');
        d._insertAtPanel('font', 'canvas', 'right');
        const t = d.serialize();
        return { t, countLeaves: (() => { let c = 0; const w = (n) => { if (!n) return; if (n.type === 'leaf') c++; else (n.children || []).forEach(w); }; w(t); return c; })() };
    })()`);
    assert(D10.t.type === 'split' && (D10.t.children || []).length === 2 &&
        D10.t.children[0].type === 'tabs' &&
        D10.t.children[0].children.some(c => c.id === 'font') &&
        D10.t.children[0].children.some(c => c.id === 'canvas'),
        "D10 full split + parallel drop auto-tabs into tabs(canvas,font)", D10.t);

    // D11: perpendicular drop with room still wraps to a new v-split.
    const D11 = await evalJs(ws, `(() => {
        const d = window.__dock;
        d.hidePanel('font');
        d._hiddenPanels.delete('font'); // visible again before the drop (Session 27)
        d._insertAtPanel('font', 'canvas', 'top');
        const t = d.serialize();
        return t;
    })()`);
    assert(D11.type === 'split' && D11.children[0] && D11.children[0].type === 'split' &&
        D11.children[0].direction === 'v' && (D11.children[0].children || []).length === 2 &&
        D11.children[0].children[0].id === 'font',
        "D11 perpendicular drop with room wraps to a new v-split", D11);
    await evalJs(ws, `(() => { window.__dock.hidePanel('font'); return true; })()`);

    // D12: a crowded saved layout restores folded into tabs (min-size rule), persisted.
    await evalJs(ws, `(() => {
        localStorage.setItem('inkshader_dock_layout_v2', JSON.stringify({ tree: { type: 'split', direction: 'h', sizes: [25,25,25,25], children: [{type:'leaf',id:'canvas'},{type:'leaf',id:'objects'},{type:'leaf',id:'properties'},{type:'leaf',id:'console'}] }, floats: [] }));
        return true;
    })()`);
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const D12 = await evalJs(ws, `(() => {
        const d = window.__dock;
        const sumOf = (sizes) => sizes.reduce((a, b) => a + b, 0);
        const t = d.serialize();
        const root = t.type === 'split' ? t : null;
        const tabsNode = root ? (root.children || []).find(c => c.type === 'tabs') : null;
        const stored = JSON.parse(localStorage.getItem('inkshader_dock_layout_v2')).tree;
        return {
            rootChildren: root ? (root.children || []).length : 0,
            sum100: root ? Math.abs(sumOf(root.sizes || []) - 100) < 1e-9 : false,
            tabsCnt: tabsNode ? (tabsNode.children || []).length : 0,
            hasProperties: !!tabsNode && tabsNode.children.some(c => c.id === 'properties'),
            hasSample: !!tabsNode && tabsNode.children.some(c => c.id === 'sample'),
            hiddenTrio: ['font','kerning','glyphs'].map(id => d.isPanelHidden(id)),
            storedChildren: stored.type === 'split' ? (stored.children || []).length : 1,
            storedSum100: stored.type === 'split' ? Math.abs(sumOf(stored.sizes || []) - 100) < 1e-9 : false
        };
    })()`);
    assert(D12.rootChildren === 2 && D12.sum100 && D12.tabsCnt >= 3 && D12.hasProperties && D12.hasSample &&
        D12.hiddenTrio.every(Boolean) && D12.storedChildren === 2 && D12.storedSum100,
        "D12 crowded restore folds overflow into tabs and persists the normalization", D12);

    // D13: deserialize (view-state path) DROPS leaves of hidden panels — hiding
    // removes the panel from the docking system (Session 27); a view state
    // that still carries a hidden leaf must shed it, and the component goes
    // into the hidden host.
    const D13 = await evalJs(ws, `(() => {
        const d = window.__dock;
        d._hiddenPanels.add('font');
        d.deserialize({ type: 'split', direction: 'h', sizes: [50,50], children: [{type:'leaf',id:'canvas'},{type:'leaf',id:'font'}] });
        const t = d.serialize();
        const hasFont = (n) => { if (!n) return false; if (n.type === 'leaf') return n.id === 'font'; return (n.children || []).some(hasFont); };
        return { hasFont: hasFont(t), hidden: d.isPanelHidden('font'), hosted: !!document.querySelector('#dock-hidden-host font-popup') };
    })()`);
    assert(!D13.hasFont && D13.hidden && D13.hosted,
        "D13 deserialize drops hidden-panel leaves (component moved to hidden host)", D13);

    // D14: back to normal width, reload, zero app errors for the whole run.
    await cdp(ws, "Emulation.clearDeviceMetricsOverride");
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.reload");
    await waitReady(ws);
    const D14 = await evalJs(ws, `(() => {
        const benign = e => /ResizeObserver loop|favicon|Script error/i.test(e);
        const real = window.__errs.filter(e => !benign(e));
        return { total: window.__errs.length, real };
    })()`);
    assert(D14.real.length === 0, "D14 zero app errors through Phase D", D14);

    console.log("\n" + results.filter(r => r.ok).length + "/" + results.length + " checks passed");
    process.exitCode = results.every(r => r.ok) ? 0 : 1;
} catch (e) {
    console.error("DRIVER FAILURE:", e.message);
    process.exitCode = 1;
} finally {
    try { ws.close(); } catch (_) {}
    try { await fetch(`http://localhost:${CDP_PORT}/json/close/${targets.id}`); } catch (_) {}
}