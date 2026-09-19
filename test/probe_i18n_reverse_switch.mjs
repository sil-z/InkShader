// Suite: switching zh -> en WITHOUT reloading must leave no Chinese UI text.
//
// `probe_i18n_live_switch.mjs` measures en -> zh (English left behind); this one measures
// the reverse direction, which is where components that bake translated text at build
// time (module-level templates, cached row signatures, DOM sections preserved across
// renders) keep the language they were built with.
//
// The page is booted *in Chinese* first: a component only exposes the bug when it was
// constructed while Chinese, and a probe that merely calls setLang on an English boot
// cannot see it. The example project is loaded and a path selected so the docked panels
// (properties among them) actually have content.
//
//  Requires the probe environment:  node test/run_probes.mjs --only i18n_reverse_switch
import { readFileSync, writeFileSync } from 'node:fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const OUT_FILE = process.env.PROBE_I18N_REVERSE_OUT || tmpFile('i18n_reverse_switch.json');

const projectJson = readFileSync(exampleProject(), 'utf-8');

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const I18n = window.I18n;
    const cv = window.__canvas;
    if (!I18n || !cv) return JSON.stringify({ error: 'app not booted' });

    const CJK = /[\\u3400-\\u9fff\\uf900-\\ufaff]/;
    const skip = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE']);

    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        roots[i].querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
    }
    const where = (el) => {
        const parts = [];
        let n = el;
        while (n && n !== document.body) {
            parts.push(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\\s+/)[0] : ''));
            n = n.parentElement || n.host || null;
        }
        return parts.slice().reverse().join('>');
    };
    const scan = () => {
        const found = [];
        const push = (kind, text, el) => {
            const s = String(text).trim();
            if (!s || !CJK.test(s)) return;
            found.push(kind + '  ' + JSON.stringify(s) + '   @ ' + where(el));
        };
        // Language names are endonyms: the picker lists "English" and "简体中文" in
        // every locale on purpose, so its rows are not evidence of a stale switch.
        const isLanguagePicker = (el) => {
            if (el.closest && el.closest('#pref_lang')) return true;
            const panel = el.closest && el.closest('.cs-panel');
            return !!(panel && panel.dataset && panel.dataset.csFor === 'pref_lang');
        };
        roots.forEach(root => {
            root.querySelectorAll('*').forEach(el => {
                if (skip.has(el.tagName)) return;
                if (isLanguagePicker(el)) return;
                if (!el.children.length) {
                    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
                    if (own.trim()) push('text', own, el);
                }
                ['data-tip', 'title', 'placeholder', 'aria-label'].forEach(a => {
                    const v = el.getAttribute && el.getAttribute(a);
                    if (v) push(a, v, el);
                });
                if (el.tagName === 'OPTION') push('option', el.textContent, el);
                if (el.tagName === 'INPUT' && typeof el.value === 'string') push('input.value', el.value, el);
            });
        });
        return found;
    };

    // A real project, then one path selected, so the properties panel is populated.
    // Boot in Chinese first: components that bake text at construction time are only
    // exposed when they were built under the language being left behind.
    if (I18n.lang !== 'zh') { I18n.setLang('zh'); return '__REBOOT__'; }
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(exampleProject())} });
    await sleep(3000);

    const mod = await import('/js/app/canvas_dispatcher.js');
    const facade = await import('/js/app/editor_read_facade.js');

    // Pick a curve through the same read facade the panel uses, so the selection
    // does not depend on which tree rows happen to be expanded.
    // The tree snapshot lists groups; curve rows only appear inside an expanded group,
    // so pick the first group that actually has curves and select its first curve.
    const items = facade.getTreeItemsMap();
    const entries = items instanceof Map ? [...items.entries()] : Object.entries(items || {});
    const groups = entries.filter(([, it]) => it && it.type === 'group' && !it.isRef);
    let picked = null;
    let curveId = null;
    for (const [treeId] of groups) {
        const curves = cv.curve_manager.getCurvesForGroup(treeId) || [];
        if (!curves.length) continue;
        // Curve rows only exist inside an expanded group, and only a curve row makes
        // the panel render its path section.
        mod.CanvasDispatcher.requestToggleGroupCollapsed(treeId);
        await sleep(700);
        const now = facade.getTreeItemsMap();
        const nowEntries = now instanceof Map ? [...now.entries()] : [];
        const curveItem = nowEntries.find(([, it]) => it && it.type === 'curve' && it.parentId === treeId)
            || nowEntries.find(([, it]) => it && it.type === 'curve');
        if (!curveItem) continue;
        picked = { id: curveItem[0], type: 'curve', groupId: treeId, curveId: curveItem[1].curveId };
        curveId = curveItem[1].curveId;
        cv.commands.setActiveGroup(treeId);
        await sleep(250);
        mod.CanvasDispatcher.requestSetTreeSelection([curveItem[0]], treeId);
        await sleep(700);
        break;
    }

    // Node mode + a node selection: this is what makes the panel render its path
    // section, which is the part that used to keep the old language.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    await sleep(500);
    const cm = cv.curve_manager;
    let nodeCount = 0;
    try {
        let curve = curveId ? facade.getCurveById(curveId) : null;
        if (!curve && picked) curve = cm.getCurvesForGroup(picked.groupId)?.[0]?.curve;
        const nodes = [];
        let n = curve && curve.startNode;
        const seen = new Set();
        while (n && !seen.has(n)) { seen.add(n); nodes.push(n); n = n.nextOnCurve; }
        nodeCount = nodes.length;
        if (nodes.length) {
            const ids = nodes.slice(0, 2).map(x => x.main_node && x.main_node.id).filter(Boolean);
            mod.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: ids });
            await sleep(900);
        }
    } catch (e) { /* node selection is best effort */ }

    // A path section on screen is what makes this probe meaningful; without it the
    // scan would silently pass on an empty panel.
    let pathSection = !!document.querySelector('#main_property_panel [data-section="ppp"]');
    for (let i = 0; i < 10 && !pathSection; i++) {
        await sleep(400);
        pathSection = !!document.querySelector('#main_property_panel [data-section="ppp"]');
    }
    picked = picked ? { ...picked, nodeCount, pathSection } : picked;

    // Bring the hidden-by-default panels into the DOM so their JS-built strings are
    // part of the scan (the kerning dropdowns are the known offender here).
    try {
        window.__dock?.showPanel?.('kerning');
        window.__dock?.showPanel?.('font');
        await sleep(600);
    } catch (e) { /* dock API is best effort */ }

    const panel = document.querySelector('.property_panel');
    const panelVisible = !!panel && panel.getBoundingClientRect().width > 0;

    const inArea = (list, needle) => list.filter(l => l.includes(needle)).length;
    const zhScan = scan();
    const whileZh = zhScan;
    // Which of the components that build text in JS were on screen during the Chinese
    // pass — a switch can only go wrong where something was actually rendered.
    const coverage = {
        propertiesPanel: inArea(zhScan, 'main_property_panel'),
        objectTree: inArea(zhScan, 'object_tree'),
        kerningPanel: inArea(zhScan, 'kern-popup'),
        preferences: inArea(zhScan, 'app_preferences_popup'),
    };

    const panelEl = document.querySelector('#main_property_panel');
    const panelDebug = panelEl ? {
        renderPending: panelEl._renderPending,
        lastSignature: panelEl.lastSignature,
        lastStructSig: panelEl._lastStructSig,
        focusedInput: panelEl._focusedInput ? (panelEl._focusedInput.id || true) : null,
        pathPropsDocked: panelEl._pathPropsDocked,
        nodePropsDocked: panelEl._nodePropsDocked,
    } : null;

    I18n.setLang('en');
    await sleep(1000);
    const left = scan();
    // Second stage: force a rebuild by hand. If the text turns English only now, the
    // component's own language hook never reached the rebuild; if it stays Chinese,
    // the rebuild itself draws from stale text.
    let forcedLeft = null;
    if (panelEl) {
        panelEl.lastSignature = '';
        panelEl._lastStructSig = null;
        panelEl._lastPathSig = null;
        panelEl.render();
        await sleep(800);
        forcedLeft = scan().length;
    }

    return JSON.stringify({
        picked, panelVisible, panelDebug, coverage,
        stillChineseAfterForcedPanelRebuild: forcedLeft,
        chineseWhileZh: whileZh.length,
        stillChineseAfterEn: left,
    });
})()
`;

async function main() {
    const target = await (await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evalp = async (expression, awaitPromise = true) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 600) };
        return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const boot = async () => {
        await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?v=i18nrev-${Date.now()}` });
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (await evalp('!!window.__canvas && !!window.I18n', false)) break;
        }
        await new Promise(r => setTimeout(r, 1500));
    };

    await boot();
    // First pass only records the language switch; the reload is what puts the
    // components into the "built while Chinese" state.
    if (await evalp(PROBE) === '__REBOOT__') await boot();

    const raw = await evalp(PROBE);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { error: 'unparsable', raw }; }

    const lines = [];
    let checks;
    if (parsed.error) {
        lines.push('ERROR: ' + JSON.stringify(parsed).slice(0, 800));
        checks = [{ name: 'probe completed', ok: false }];
    } else {
        const stale = parsed.stillChineseAfterEn;
        const cov = parsed.coverage || {};
        checks = [
            { name: 'booted in Chinese with the properties panel painted', ok: !!parsed.panelVisible },
            { name: 'the Chinese pass saw translated text to switch back', ok: parsed.chineseWhileZh > 100 },
            { name: 'the properties panel was in scope of the scan', ok: (cov.propertiesPanel || 0) > 0 },
            { name: 'the object tree was in scope of the scan', ok: (cov.objectTree || 0) > 0 },
            { name: 'the kerning panel was in scope of the scan', ok: (cov.kerningPanel || 0) > 0 },
            { name: 'no Chinese UI text survives the switch to English', ok: stale.length === 0 },
        ];
        lines.push(`selected: ${JSON.stringify(parsed.picked)}   properties panel painted: ${parsed.panelVisible}`);
        lines.push(`Chinese strings available while in zh: ${parsed.chineseWhileZh}  coverage: ${JSON.stringify(parsed.coverage)}`);
        lines.push(`stale after switching to en: ${stale.length}`);
        for (const l of stale) lines.push('  ' + l);
        if (stale.length) {
            lines.push(`  (reported without a forced panel rebuild: ${parsed.stillChineseAfterForcedPanelRebuild})`);
        }
    }
    const report = lines.join('\n') + '\n';
    writeFileSync(OUT_FILE, report, 'utf8');
    console.log(report);
    console.log(JSON.stringify({ checks }, null, 2));
    ws.close();
    process.exit(checks.every(c => c.ok) ? 0 : 1);
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
