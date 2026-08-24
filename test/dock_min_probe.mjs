// test/dock_min_probe.mjs
// Session 31: dock resize min-width instability reproduction.
// User reports:
//   (1) dragging a panel to its min width should keep compressing the other
//       side, but sometimes the drag just stops (dead seams);
//   (2) multi-tab merged panels sometimes end up BELOW the 200px minimum.
//
// Root cause (Session 31, from code): _onResizeMove clamps every child of a
// split against ONE flat minPct (200px of the split's own extent), treating a
// nested subtree as an atomic unit. A same-direction nested split's TRUE
// minimum is the SUM of its children's minimums + resizer gaps (e.g. 406px
// for [tabs | console]). The flat clamp crushes such a subtree to 200px, so
// its inner panels land at ~100px each (symptom 2); once every inner child
// sits below its local minimum, capacity sums to 0 and the seam locks dead in
// BOTH directions (symptom 1).
//
// Seeding note: deserialize() runs _normalizeOverflowingSplits(), which FOLDS
// an over-capacity nested split into tabs — the violating state can never be
// reached through deserialize. This probe therefore seeds by DIRECT tree
// mutation (d.root = tree; d._buildDOM()), exactly how runtime drags/drops
// leave the tree (the normalizer only runs at restore/deserialize time).
//
// Pure-Node CDP driver: headless Chrome :9222, dev server :8123.
// Run:  node test/dock_min_probe.mjs

const CDP_PORT = 9222;
const APP_URL = "http://localhost:8123/";

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
            if (window.__dock && document.querySelector('.dock-container')) return true;
            await new Promise(r => setTimeout(r, 50));
        }
        return false;
    })()`);
    if (!ok) throw new Error("APP NEVER REACHED READY");
}

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  | " + JSON.stringify(detail) : ""));
}

// Shared page helpers — installed on window.__dockH so every eval sees them.
const HELPERS = `window.__dockH = (() => {
    const d = window.__dock;
    const walkTree = (n, out) => {
        if (!n) return out;
        if (n.type === 'split') {
            out.push({ dir: n.direction, sizes: n.sizes, sum: n.sizes ? +(n.sizes.reduce((a, b) => a + b, 0).toFixed(6)) : null, childTypes: n.children.map(c => c.type) });
            n.children.forEach(c => walkTree(c, out));
        } else if (n.type === 'tabs') {
            out.push({ t: 'tabs', n: n.children.length });
            n.children.forEach(c => walkTree(c, out));
        }
        return out;
    };
    const snapshot = () => {
        const leafW = {};
        document.querySelectorAll('.dock-leaf').forEach(l => {
            const w = l.getBoundingClientRect().width;
            if (w > 0) leafW[l.dataset.panelId] = +(w.toFixed(1)); // visible leaves only (hidden tab = display:none)
        });
        const tabsW = [...document.querySelectorAll('.dock-tabs')].map(t => ({
            n: t.querySelectorAll('.dock-tab').length,
            w: +(t.getBoundingClientRect().width.toFixed(1))
        }));
        return { leafW, tabsW, splits: walkTree(d.serialize(), []) };
    };
    const drag = (resizerSel, dx, dy, nth = 0) => {
        const all = document.querySelectorAll(resizerSel);
        const resizer = all[nth] || null;
        if (!resizer) return { found: false, idx: resizerSel };
        const r0 = resizer.getBoundingClientRect();
        const isH = resizer.parentElement.classList.contains('dock-split-h');
        const x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2;
        const fire = (type, x, y) => document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
        const P = (px, py) => [isH ? x0 + px : x0, isH ? y0 : y0 + py];
        resizer.dispatchEvent(new MouseEvent('mousedown', { clientX: x0, clientY: y0, bubbles: true }));
        let p = P(dx, dy); fire('mousemove', p[0], p[1]);
        p = P(dx, dy); fire('mouseup', p[0], p[1]);
        return { found: true };
    };
    // Direct tree mutation + full DOM rebuild — NO deserialize, so the
    // restore-time normalizer cannot fold the nested split into tabs.
    const setTree = (tree) => { d.root = tree; d._buildDOM(); };
    return { snapshot, drag, setTree };
})()`;

// ── main ──
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

// ── Scenario trees ──
// R1 core: whatever the user actually builds — a same-direction nested split.
//   root h [canvas 50 | inner-h [tabs(properties,objects) 50, console 50] 50]
//   The inner h-split's TRUE width min = 200 + 200 + 6 (gap) = 406px.
const R1_TREE = { type: 'split', direction: 'h', sizes: [50, 50], children: [
    { type: 'leaf', id: 'canvas' },
    { type: 'split', direction: 'h', sizes: [50, 50], children: [
        { type: 'tabs', activeIndex: 0, children: [
            { type: 'leaf', id: 'properties' }, { type: 'leaf', id: 'objects' } ] },
        { type: 'leaf', id: 'console' } ] }
] };

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
    // Realistic dock width: 1400px.
    await cdp(ws, "Emulation.setDeviceMetricsOverride", { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 300));

    // ── R1: same-direction nesting — h-split inside an h-split ──
    await evalJs(ws, `(() => { ${HELPERS}; window.__dockH.setTree(${JSON.stringify(R1_TREE)}); return true; })()`);
    const base = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const treeOk = base.splits.filter(s => s.dir).length === 2
        && base.splits[1].childTypes.length === 2
        && (base.tabsW.find(t => t.n > 1) || { n: 0 }).n === 2;
    check("R1a tree intact after direct-mutation seed (inner h-split has 2 children, tabs n=2)", treeOk,
        { splits: base.splits, tabsW: base.tabsW, leafW: base.leafW });

    // Sanity: the inner seam is ALIVE while the subtree is wide (700px).
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', -150, 0, 1)`);
    const innerAlive = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const aliveMoved = JSON.stringify(base.splits) !== JSON.stringify(innerAlive.splits);
    check("R1a2 sanity: inner seam drags while subtree is wide", aliveMoved,
        { before: base.splits, after: innerAlive.splits, leafW: innerAlive.leafW });
    await evalJs(ws, `(() => { ${HELPERS}; window.__dockH.setTree(${JSON.stringify(R1_TREE)}); return true; })()`); // restore

    // Crush: drag the ROOT seam +400px (rightward shrinks the right subtree).
    // Pre-fix: the flat clamp treats the subtree as a 200px unit → stops at
    // ~300px → tabs/console at ~150px EACH (below 200 → SYMPTOM 2).
    // Post-fix: subtree clamps at its true minimum 406px → inner panels 200px.
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', 400, 0, 0)`);
    const afterCrush = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const viol = Object.entries(afterCrush.leafW).filter(([id, w]) => w < 199)
        .concat((afterCrush.tabsW.filter(t => t.n > 1) || []).filter(t => t.w < 199).map(t => ['tabs', t.w]));
    check("R1b SYMPTOM 2: nested same-direction panels stay >= 200px after outer crush",
        viol.length === 0, { leafW: afterCrush.leafW, tabsW: afterCrush.tabsW, viol, splits: afterCrush.splits });

    // After the crush, attempt inner-seam drags in BOTH directions. Pre-fix
    // the inner children sit below their local min → capacity 0 → dead seam
    // (SYMPTOM 1 evidence: no movement). Post-fix the subtree stops at its
    // true minimum, so this drag must NEVER push any panel below 200 either.
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', 150, 0, 1)`);
    const deadA = await evalJs(ws, `(${HELPERS}).snapshot()`);
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', -150, 0, 1)`);
    const deadB = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const r1cAfter = deadB;
    const r1cViol = Object.entries(r1cAfter.leafW).filter(([id, w]) => w < 199)
        .concat((r1cAfter.tabsW.filter(t => t.n > 1) || []).filter(t => t.w < 199).map(t => ['tabs', t.w]));
    check("R1c SYMPTOM 1: inner seam never pushes panels below 200 (dead-seam evidence)",
        r1cViol.length === 0,
        { afterRight: deadA.leafW, afterBoth: r1cAfter.leafW, viol: r1cViol, splits: r1cAfter.splits });

    // Recovery: growing the subtree back must always work (grow path untouched).
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', -500, 0, 0)`);
    const recovered = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const recViol = Object.entries(recovered.leafW).filter(([id, w]) => w < 199);
    check("R1d recovery: root seam grows the subtree back, panels legal",
        recViol.length === 0 && recovered.splits[0].sizes[1] > 40,
        { leafW: recovered.leafW, splits: recovered.splits });

    // ── R2: flat 3-split cascade (CONTROL — flat clamp behavior unchanged) ──
    await evalJs(ws, `(() => { ${HELPERS}; window.__dockH.setTree({ type: 'split', direction: 'h', sizes: [40, 30, 30], children: [
        { type: 'leaf', id: 'canvas' }, { type: 'leaf', id: 'properties' }, { type: 'leaf', id: 'objects' } ] }); return true; })()`);
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', -400, 0, 1)`);
    const flat = await evalJs(ws, `(${HELPERS}).snapshot()`);
    check("R2 control: flat 3-split cascade works (canvas ~200, props 200, objects ~820)",
        flat.leafW.canvas >= 199 && flat.leafW.properties >= 199 && flat.leafW.objects > 600,
        { leafW: flat.leafW, splits: flat.splits });

    // ── R3: nested, squeeze the OTHER side (CONTROL — shrink side is flat) ──
    await evalJs(ws, `(() => { ${HELPERS}; window.__dockH.setTree({ type: 'split', direction: 'h', sizes: [40, 30, 30], children: [
        { type: 'leaf', id: 'canvas' },
        { type: 'leaf', id: 'properties' },
        { type: 'split', direction: 'h', sizes: [50, 50], children: [
            { type: 'leaf', id: 'objects' }, { type: 'leaf', id: 'console' } ] } ] }); return true; })()`);
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', -500, 0, 1)`);
    const nested = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const nestedViol = Object.entries(nested.leafW).filter(([id, w]) => w < 199);
    check("R3 control: growth-into-subtree keeps all leaves legal",
        nestedViol.length === 0, { leafW: nested.leafW, viol: nestedViol, splits: nested.splits });

    // ── R4: tabs group as a FLAT child — unit min holds (CONTROL) ──
    await evalJs(ws, `(() => { ${HELPERS}; window.__dockH.setTree({ type: 'split', direction: 'h', sizes: [75, 25], children: [
        { type: 'leaf', id: 'canvas' },
        { type: 'tabs', activeIndex: 0, children: [
            { type: 'leaf', id: 'properties' }, { type: 'leaf', id: 'objects' }, { type: 'leaf', id: 'console' } ] } ] }); return true; })()`);
    await evalJs(ws, `(${HELPERS}).drag('.dock-resizer', 300, 0, 0)`);
    const tabs = await evalJs(ws, `(${HELPERS}).snapshot()`);
    const merged = (tabs.tabsW || []).find(t => t.n > 1);
    check("R4 control: flat tabs group holds unit min (>= 199, < 250)",
        merged && merged.w >= 199 && merged.w < 250,
        { leafW: tabs.leafW, tabsW: tabs.tabsW, splits: tabs.splits });

    // ── final error sweep ──
    const finalErrs = await evalJs(ws, `(() => {
        const benign = e => /ResizeObserver loop|favicon|Script error/i.test(e);
        return window.__errs.filter(e => !benign(e));
    })()`);
    check("final zero app errors", finalErrs.length === 0, finalErrs);

    console.log("\n" + results.filter(r => r.ok).length + "/" + results.length + " checks passed");
    process.exitCode = results.every(r => r.ok) ? 0 : 1;
} catch (e) {
    console.error("DRIVER FAILURE:", e.message);
    process.exitCode = 1;
} finally {
    try { ws.close(); } catch (_) {}
    try { await fetch(`http://localhost:${CDP_PORT}/json/close/${targets.id}`); } catch (_) {}
}