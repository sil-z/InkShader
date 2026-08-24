// test/canvas_hide_sync_probe.mjs
// Diagnostic: what breaks when the CANVAS panel is hidden (Session 24 follow-up,
// user: "隐藏组件需要处理同步问题...隐藏画布立刻引发大量问题").
// Pure-Node CDP: headless Chrome :9222, dev server :8123.
// Run: node test/canvas_hide_sync_probe.mjs

const CDP_PORT = 9222;
const APP_URL = "http://localhost:8123/";
const BASELINE = "/test/InkShader_project_2026-08-02T16-27-25.json";

let msgId = 0;
const pending = new Map();
function cdp(ws, method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 20000);
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("EVAL EXCEPTION: " + JSON.stringify(r.exceptionDetails).slice(0, 800));
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
    if (!ok) throw new Error("APP NEVER REACHED READY");
}

// Dock layout facts: serialized tree, split flex basis, leaf geometry.
const DOCK_FACTS = `(() => {
    const d = window.__dock;
    if (!d) return { ready: false };
    const splitInfo = [...document.querySelectorAll('.dock-split-h, .dock-split-v')].map(el => ({
        cls: el.className,
        children: [...el.children].map(ch => ({
            cls: ch.className || ch.tagName,
            panel: ch.dataset.panelId || null,
            flex: getComputedStyle(ch).flex,
            flexBasis: getComputedStyle(ch).flexBasis,
            w: Math.round(ch.getBoundingClientRect().width),
            h: Math.round(ch.getBoundingClientRect().height)
        }))
    }));
    return {
        ready: true,
        hidden: [...(d._hiddenPanels || [])],
        tree: d.root ? (() => {
            const walk = (n) => {
                if (!n) return null;
                const o = { type: n.type, id: n.id || null };
                if (n.sizes && Array.isArray(n.sizes)) o.sizes = n.sizes;
                if (n.children && Array.isArray(n.children)) o.children = n.children.map(walk);
                if (n.tabs && Array.isArray(n.tabs)) o.tabs = n.tabs.map(t => ({ id: t.id }));
                return o;
            };
            return walk(d.root);
        })() : null,
        serialized: (typeof d.serialize === "function") ? JSON.parse(JSON.stringify(d.serialize())) : null,
        splits: splitInfo
    };
})()`;

// Dispatch the REAL user path: window CustomEvent with {updates, options} payload.
const DISPATCH_FONT_SETTINGS = (updatesJson, optionsJson) => `(() => {
    window.dispatchEvent(new CustomEvent('request-set-font-settings', {
        detail: { updates: ${updatesJson}, options: ${optionsJson} }
    }));
    return true;
})()`;

// Canvas facts (DOM position, visibility, backing store, runtime loop).
const CANVAS_FACTS = `(() => {
    const el = document.querySelector('main-canvas');
    if (!el) return { inDOM: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inner = el.querySelector('canvas');
    const rt = window.__canvas ? Object.keys(window.__canvas.renderRuntimeService) : [];
    return {
        inDOM: true,
        parent: el.parentElement ? el.parentElement.className || el.parentElement.tagName : null,
        parentChain: (() => { const out = []; let p = el.parentElement; while (p && out.length < 6) { out.push(p.className || p.tagName); p = p.parentElement; } return out; })(),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display, visibility: cs.visibility, position: cs.position,
        backing: inner ? [inner.width, inner.height] : null,
        loopKeys: rt, loopRunning: window.__canvas ? !!window.__canvas.renderRuntimeService.running : null,
        isDirty: window.__canvas ? window.__canvas.is_dirty : null,
        scale: window.__canvas ? window.__canvas.scale : null,
        offset: window.__canvas ? JSON.parse(JSON.stringify(window.__canvas.offset)) : null,
        upm: window.__canvas ? window.__canvas.fontSettings.upm : null,
        historyLen: window.__canvas ? window.__canvas.commandStack.length : null,
        hidden: window.__dock.isPanelHidden('canvas')
    };
})()`;

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

let errs = "n/a";
const grabErrs = () => evalJs(ws, `(() => { const e = window.__errs || []; window.__errs = []; return e.length ? e.slice(0, 25) : []; })()`).catch(() => []);

try {
    await cdp(ws, "Page.enable");
    await cdp(ws, "Runtime.enable");
    await cdp(ws, "Network.enable");
    await cdp(ws, "Network.clearBrowserCache");
    await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: `
        window.__errs = [];
        window.addEventListener('error', e => { try { window.__errs.push('ERR:' + e.message); } catch (_) {} });
        window.addEventListener('unhandledrejection', e => { try { window.__errs.push('REJ:' + String((e.reason && e.reason.message) || e.reason)); } catch (_) {} });
        window.confirm = () => true;
    ` });
    await cdp(ws, "Page.navigate", { url: APP_URL });
    await waitReady(ws);
    await evalJs(ws, `(async () => { localStorage.clear(); location.reload(); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    await waitReady(ws);
    await evalJs(ws, `(async () => {
        const txt = await (await fetch('${BASELINE}')).text();
        await window.__canvas.projectManager.loadFromFile(txt);
        await new Promise(r => setTimeout(r, 1000));
        return true;
    })()`);
    errs = await grabErrs();
    console.log("STAGE0 boot+baseline errs:", JSON.stringify(errs));

    console.log("S1 canvas visible:", JSON.stringify(await evalJs(ws, CANVAS_FACTS)));
    console.log("S1 dock facts:", JSON.stringify(await evalJs(ws, DOCK_FACTS)));

    // ── S1b: VISIBLE baseline — the REAL dispatch path (window CustomEvent) ──
    console.log("S1b dispatch setFontSettings VISIBLE:", JSON.stringify(await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        ${DISPATCH_FONT_SETTINGS("{ upm: 2000 }", "{ recordHistory: true }")}
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm };
    })()`)));
    errs = await grabErrs();
    console.log("S1b errs after dispatch visible:", JSON.stringify(errs));
    console.log("S1b undo visible baseline:", JSON.stringify(await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        await window.__canvas.history.undo();
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm };
    })()`)));
    errs = await grabErrs();
    console.log("S1b errs after undo visible:", JSON.stringify(errs));

    // ── Stage 2: runtime hide ──
    await evalJs(ws, `(() => { window.__dock.hidePanel('canvas'); return true; })()`);
    await new Promise(r => setTimeout(r, 400));
    errs = await grabErrs();
    console.log("S2 errs after hide:", JSON.stringify(errs));
    console.log("S2 canvas after runtime hide:", JSON.stringify(await evalJs(ws, CANVAS_FACTS)));
    console.log("S2 dock facts:", JSON.stringify(await evalJs(ws, DOCK_FACTS)));
    console.log("S2 dock leaves:", JSON.stringify(await evalJs(ws, `(() => [...document.querySelectorAll('.dock-leaf')].map(l => l.dataset.panelId))()`)));
    console.log("S2 other panels alive:", JSON.stringify(await evalJs(ws, `(() => ({
        objectTree: !!document.querySelector('object-tree') && document.querySelector('object-tree').offsetParent !== null,
        propPanel: !!document.querySelector('.property_panel') && document.querySelector('.property_panel').offsetParent !== null
    }))()`)));
    console.log("S2 fontPopup canvas ref detached?", JSON.stringify(await evalJs(ws, `(() => {
        const fp = document.querySelector('font-popup');
        return { hasRef: !!fp && !!fp._canvas, refInDOM: fp && fp._canvas && document.contains(fp._canvas) };
    })()`)));

    // ── Stage 3: real usage while canvas hidden ──
    console.log("S3a object-tree click:", JSON.stringify(await evalJs(ws, `(() => {
        const rows = [...document.querySelectorAll('object-tree .tree_item')];
        if (rows.length) rows[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        return { rows: rows.length };
    })()`)));
    await new Promise(r => setTimeout(r, 300));
    errs = await grabErrs();
    console.log("S3a errs after tree click:", JSON.stringify(errs));
    const s3b = await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        ${DISPATCH_FONT_SETTINGS("{ upm: 2000 }", "{ recordHistory: true }")}
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm, dirty: window.__canvas.is_dirty, loop: window.__canvas.renderRuntimeService.running };
    })()`);
    console.log("S3b dispatch setFontSettings HIDDEN (real path):", JSON.stringify(s3b));
    errs = await grabErrs();
    console.log("S3b errs after dispatch hidden:", JSON.stringify(errs));
    const s3c = await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        await window.__canvas.history.undo();
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm, dirty: window.__canvas.is_dirty, loop: window.__canvas.renderRuntimeService.running };
    })()`);
    console.log("S3c undo while hidden:", JSON.stringify(s3c));
    errs = await grabErrs();
    console.log("S3c errs after undo:", JSON.stringify(errs));
    console.log("S3d seq-bar click:", JSON.stringify(await evalJs(ws, `(() => {
        const bar = document.querySelector('glyph-sequence-bar');
        const slot = bar ? bar.querySelector('.seq-bar-item, .seq-bar-slot, [class*="seq-bar"]') : null;
        if (slot) { slot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        return { hasBar: !!bar, hasSlot: !!slot, canvasRefNull: !!bar && bar._canvas === null };
    })()`)));
    await new Promise(r => setTimeout(r, 300));
    errs = await grabErrs();
    console.log("S3d errs after seq-bar click:", JSON.stringify(errs));

    // ── Stage 4: show again ──
    await evalJs(ws, `(() => { window.__dock.showPanel('canvas'); return true; })()`);
    await new Promise(r => setTimeout(r, 700));
    errs = await grabErrs();
    console.log("S4 errs after show:", JSON.stringify(errs));
    const s4 = await evalJs(ws, CANVAS_FACTS);
    const s4dock = await evalJs(ws, DOCK_FACTS);
    console.log("S4 canvas after show:", JSON.stringify(s4));
    console.log("S4 dock facts:", JSON.stringify(s4dock));
    console.log("S4b dispatch setFontSettings AFTER re-show:", JSON.stringify(await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        ${DISPATCH_FONT_SETTINGS("{ upm: 1500 }", "{ recordHistory: true }")}
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm };
    })()`)));
    errs = await grabErrs();
    console.log("S4b errs after dispatch re-shown:", JSON.stringify(errs));
    console.log("S4c undo after re-show:", JSON.stringify(await evalJs(ws, `(async () => {
        const before = window.__canvas.commandStack.length;
        await window.__canvas.history.undo();
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__canvas.commandStack.length, upm: window.__canvas.fontSettings.upm };
    })()`)));
    errs = await grabErrs();
    console.log("S4c errs after undo re-shown:", JSON.stringify(errs));

    // ── Stage 6: REAL DOM interactions after re-show (user-visible: zoom, undo) ──
    console.log("S6 real ctrl+wheel zoom:", JSON.stringify(await evalJs(ws, `(async () => {
        const c = window.__canvas;
        const before = c.scale;
        const cv = c.querySelector('canvas');
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 300));
        return { before, after: c.scale, changed: Math.abs(c.scale - before) > 1e-9 };
    })()`)));
    errs = await grabErrs();
    console.log("S6 errs after wheel:", JSON.stringify(errs));
    console.log("S6 real ctrl+wheel zoom-back:", JSON.stringify(await evalJs(ws, `(async () => {
        const c = window.__canvas;
        const before = c.scale;
        c.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 300));
        return { before, after: c.scale, changed: Math.abs(c.scale - before) > 1e-9 };
    })()`)));
    console.log("S6 real keydown Ctrl+Z (no state pollution):", JSON.stringify(await evalJs(ws, `(async () => {
        const c = window.__canvas;
        // ensure a history entry exists (dispatcher path), then press real Ctrl+Z via keydown
        ${DISPATCH_FONT_SETTINGS("{ upm: 1500 }", "{ recordHistory: true }")}
        await new Promise(r => setTimeout(r, 300));
        const afterSet = c.fontSettings.upm;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        return { afterSet, upm: c.fontSettings.upm, stack: c.commandStack.length, tool: c.getActiveTool ? c.getActiveTool() : null };
    })()`)));
    errs = await grabErrs();
    console.log("S6 errs after keydown undo:", JSON.stringify(errs));
    const s6zoom = await evalJs(ws, `(async () => {
        const c = window.__canvas;
        const before = c.scale;
        c.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 300));
        const mid = c.scale;
        c.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 300));
        const after = c.scale;
        return { before, mid, after, zoomIn: mid > before, restored: Math.abs(after - before) < 1e-9 };
    })()`);
    const s6undo = await evalJs(ws, `(async () => {
        const c = window.__canvas;
        ${DISPATCH_FONT_SETTINGS("{ upm: 1500 }", "{ recordHistory: true }")}
        await new Promise(r => setTimeout(r, 300));
        const afterSet = c.fontSettings.upm;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        return { afterSet, upm: c.fontSettings.upm, stack: c.commandStack.length };
    })()`);
    console.log("S4 render ink:", JSON.stringify(await evalJs(ws, `(async () => {
        window.__canvas.is_dirty = true;
        await new Promise(r => setTimeout(r, 400));
        const cv = window.__canvas.querySelector('canvas');
        if (!cv || cv.width < 50) return { tiny: true, w: cv && cv.width };
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0, nonBg = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i+3] > 0) { ink++; if (!(d[i] > 245 && d[i+1] > 245 && d[i+2] > 245)) nonBg++; } }
        return { w: cv.width, h: cv.height, ink, nonBg };
    })()`)));

    // ── Stage 5: hide → RELOAD (persisted hidden canvas at boot) ──
    await evalJs(ws, `(() => { window.__dock.hidePanel('canvas'); return true; })()`);
    await new Promise(r => setTimeout(r, 300));
    errs = await grabErrs();
    console.log("S5 pre-reload errs:", JSON.stringify(errs));
    await evalJs(ws, `(() => { location.reload(); return true; })()`);
    await new Promise(r => setTimeout(r, 700));
    await waitReady(ws);
    await new Promise(r => setTimeout(r, 500));
    errs = await grabErrs();
    console.log("S5 boot errs (canvas hidden at boot):", JSON.stringify(errs));
    console.log("S5 canvas at boot (hidden):", JSON.stringify(await evalJs(ws, CANVAS_FACTS)));
    console.log("S5 seqBar canvasRefNull at boot:", JSON.stringify(await evalJs(ws, `(() => {
        const bar = document.querySelector('glyph-sequence-bar');
        return { null: !!bar && bar._canvas === null, hasBar: !!bar };
    })()`)));
    // Session 27 semantics: reload keeps the hidden canvas OUT of the dock
    // tree — its component lives in the body-level hidden host (connected,
    // alive) and the serialized sibling-root slot memory restores the [75,25]
    // split on re-show. Verify the re-show BEFORE any other layout mutation —
    // showing font first would legitimately re-split the root (Session 24
    // capacity: 762px fits 3 slots of 200px) and squeeze the restored canvas.
    console.log("S5 show canvas at boot:", JSON.stringify(await evalJs(ws, `(async () => {
        window.__dock.showPanel('canvas');
        await new Promise(r => setTimeout(r, 700));
        return true;
    })()`)));
    errs = await grabErrs();
    console.log("S5 errs after show (post-reload):", JSON.stringify(errs));
    const s5s = await evalJs(ws, CANVAS_FACTS);
    console.log("S5 canvas after show (post-reload):", JSON.stringify(s5s));
    console.log("S5 open font panel then interact (after canvas restore):", JSON.stringify(await evalJs(ws, `(async () => {
        window.__dock.showPanel('font');
        await new Promise(r => setTimeout(r, 300));
        const fp = document.querySelector('font-popup');
        const c0 = window.__canvas.commandStack.length;
        // Real interaction: change UPM field value + dispatch focusout (Session 21 convention)
        const input = fp && fp.querySelector('input[name="upm"], [data-i18n="font.upm"], input[type="number"]') || (fp && fp.querySelector('input'));
        if (input) { input.value = '1500'; input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
        await new Promise(r => setTimeout(r, 400));
        return { canvasRefNull: !!fp && fp._canvas === null, upm: window.__canvas.fontSettings.upm, stack: [c0, window.__canvas.commandStack.length] };
    })()`)));
    errs = await grabErrs();
    console.log("S5 errs after font interaction:", JSON.stringify(errs));
    console.log("S5 render ink after show:", JSON.stringify(await evalJs(ws, `(async () => {
        await new Promise(r => setTimeout(r, 500));
        const cv = window.__canvas.querySelector('canvas');
        if (!cv || cv.width < 50) return { tiny: true, w: cv && cv.width };
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0, nonBg = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i+3] > 0) { ink++; if (!(d[i] > 245 && d[i+1] > 245 && d[i+2] > 245)) nonBg++; } }
        return { w: cv.width, h: cv.height, ink, nonBg, upm: window.__canvas.fontSettings.upm, stack: window.__canvas.commandStack.length };
    })()`)));

    // ── Summary: hard assertions (Session 27 remove-style + keep-alive) ──
    const geometry = (f) => !!f && f.inDOM && f.backing && f.backing[0] >= 500 && f.backing[1] >= 250;
    const canvasInTabs = (n) => {
        if (!n) return false;
        if (n.type === "tabs" && n.children.some(c => c.type === "leaf" && c.id === "canvas")) return true;
        if (n.children) return n.children.some(canvasInTabs);
        return false;
    };
    const restoredLayout = (d) => !!d && !!d.tree && d.tree.type === "split" && d.tree.sizes && d.tree.sizes[0] === 75
        && Array.isArray(d.tree.children) && d.tree.children[0] && d.tree.children[0].type === "leaf" && d.tree.children[0].id === "canvas"
        && !canvasInTabs(d.tree);
    let failed = 0;
    const chk = (name, ok, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  | " + detail : "")); if (!ok) failed++; };
    chk("S3b dispatch applies while canvas HIDDEN (stack +1, upm 2000)", !!s3b && s3b.upm === 2000 && s3b.after === s3b.before + 1, JSON.stringify(s3b));
    chk("S3c undo works while canvas HIDDEN (stack -1, upm 1000)", !!s3c && s3c.upm === 1000 && s3c.after === s3c.before - 1, JSON.stringify(s3c));
    chk("S4 re-show restores canvas geometry (backing >= 500x250)", geometry(s4), JSON.stringify(s4 && s4.backing));
    chk("S4 re-show restores 75/25 h-split layout (canvas as left leaf)", restoredLayout(s4dock), JSON.stringify(s4dock && s4dock.tree && { type: s4dock.tree.type, sizes: s4dock.tree.sizes }));
    chk("S5 post-reload re-show restores canvas geometry (persisted tree slot)", geometry(s5s), JSON.stringify(s5s && s5s.backing));
    chk("S6 real wheel events zoom the canvas after re-show", !!s6zoom && s6zoom.zoomIn && s6zoom.restored, JSON.stringify(s6zoom));
    chk("S6 real keydown Ctrl+Z undoes after re-show (upm 1500->1000)", !!s6undo && s6undo.afterSet === 1500 && s6undo.upm === 1000 && s6undo.stack === 0, JSON.stringify(s6undo));

    console.log("FINAL errs:", JSON.stringify(await grabErrs()));
    if (failed > 0) { console.log(`SUMMARY: ${failed} CHECK(S) FAILED`); process.exitCode = 1; }
    else console.log("SUMMARY: all canvas hide/sync checks passed");
    console.log("DONE");
} catch (e) {
    console.error("PROBE CRASH:", e.message);
    process.exitCode = 1;
} finally {
    ws.close();
    try { await fetch(`http://localhost:${CDP_PORT}/json/close/` + targets.id); } catch (_) {}
}