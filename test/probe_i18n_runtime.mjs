// i18n runtime probe (pure Node CDP, no npm deps):
//  - t(key, fallback) prefers the table, falls back to the literal, then to the key
//  - translateDOM keeps an element's own text when its key is unknown, instead of
//    writing the raw key into the DOM
//  - table values actually reach the DOM (the toolbar difference tooltip keeps the
//    authored "(bottom minus top)" hint — that string used to be overwritten)
//  - no user-visible attribute is left holding a bare key
//  - the help modal lists every shortcut and carries the rotation note
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
import { probePorts } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const APP_URL = `http://localhost:${SRV}/?v=i18nrt-1`;

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => {
        out.checks.push({ name, ok, detail });
        if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail));
    };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const I18n = window.I18n;
    check('i18n manager present', !!I18n);
    if (!I18n) return JSON.stringify(out);

    // --- lookup fallback contract ---
    check('unknown key returns the caller fallback', I18n.t('no.such.key', 'Fallback') === 'Fallback',
        I18n.t('no.such.key', 'Fallback'));
    check('unknown key with no fallback returns the key itself', I18n.t('no.such.key') === 'no.such.key',
        I18n.t('no.such.key'));
    check('known key wins over the fallback', I18n.t('menu.file', 'WRONG') === 'File', I18n.t('menu.file', 'WRONG'));

    // --- translateDOM keeps inline text for a missing key ---
    const probeEl = document.createElement('div');
    probeEl.setAttribute('data-i18n', 'no.such.key');
    probeEl.textContent = 'Inline English';
    document.body.appendChild(probeEl);
    I18n.translateDOM();
    check('missing key leaves the markup text alone', probeEl.textContent === 'Inline English', probeEl.textContent);

    const knownEl = document.createElement('div');
    knownEl.setAttribute('data-i18n', 'tool.node');
    knownEl.textContent = 'stale';
    document.body.appendChild(knownEl);
    I18n.translateDOM();
    check('known key replaces the markup text', knownEl.textContent === I18n.t('tool.node'), knownEl.textContent);
    probeEl.remove(); knownEl.remove();

    // --- the regression that started this: table values must win, not markup ---
    const diff = document.querySelector('#btn_action_difference');
    const diffTip = diff && diff.getAttribute('data-tip');
    check('difference tooltip keeps the operand-order hint',
        !!diffTip && diffTip.includes('bottom minus top'), diffTip);
    check('difference tooltip carries its shortcut',
        !!diffTip && diffTip.includes('Ctrl+Alt+U'), diffTip);

    // --- no bare key left in any user-visible attribute ---
    const keyish = /^[a-z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+$/;
    const leaks = [];
    const attrs = ['data-tip', 'title', 'placeholder'];
    for (const a of attrs) {
        document.querySelectorAll('[' + a + ']').forEach(el => {
            const v = (el.getAttribute(a) || '').trim();
            if (keyish.test(v)) leaks.push(a + '=' + v + ' on #' + (el.id || el.tagName.toLowerCase()));
        });
    }
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const v = el.textContent.trim();
        if (keyish.test(v)) leaks.push('text=' + v + ' on #' + (el.id || el.tagName.toLowerCase()));
    });
    check('no user-visible attribute holds a bare key', leaks.length === 0, leaks);

    // --- native-title tooltips stay in sync with the table ---
    const nativeTips = [...document.querySelectorAll('[data-i18n-tip][title]')];
    check('elements using native title tooltips exist', nativeTips.length > 0, nativeTips.length);
    const titleMismatch = nativeTips
        .filter(el => el.getAttribute('title') !== I18n.t(el.getAttribute('data-i18n-tip')))
        .map(el => (el.id || el.tagName.toLowerCase()) + ': ' + el.getAttribute('title'));
    check('every native title matches its table value', titleMismatch.length === 0, titleMismatch);

    // --- help modal ---
    const hm = document.querySelector('help-modal');
    const lis = hm ? [...hm.querySelectorAll('.help_list li')] : [];
    check('help modal lists shortcuts (>= 20)', lis.length >= 20, lis.length);
    const note = hm && hm.querySelector('.help_note');
    check('rotation caveat is a note, not a shortcut row',
        !!note && note.textContent.trim() === I18n.t('help.notes.rotation'),
        note && note.textContent.trim().slice(0, 60));
    check('no shortcut row is unresolved',
        lis.every(li => !keyish.test(li.textContent.trim())), lis.map(li => li.textContent.trim()).filter(t => keyish.test(t)));
    const rows = lis.map(li => li.textContent.trim());
    check('all four boolean shortcuts are listed',
        rows.some(r => r.startsWith('Ctrl+U')) && rows.some(r => r.startsWith('Ctrl+Shift+U')) &&
        rows.some(r => r.startsWith('Ctrl+Alt+U')) && rows.some(r => r.startsWith('Ctrl+Alt+Shift+U')),
        rows.filter(r => /^Ctrl\+.*U/.test(r)));

    // --- locale switch: table, markup, JS-built labels, document metadata ---
    const prefs = document.querySelector('#app_preferences_popup');
    const storedBefore = localStorage.getItem('InkShader_lang');
    const switched = I18n.setLang('zh');
    check('setLang accepts a shipped locale and persists it',
        switched === true && I18n.lang === 'zh' && localStorage.getItem('InkShader_lang') === 'zh',
        I18n.lang + ' / ' + localStorage.getItem('InkShader_lang'));
    check('zh table lookup', I18n.t('menu.file') === '文件' && I18n.t('panel.canvas') === '画布',
        [I18n.t('menu.file'), I18n.t('panel.canvas')]);
    check('markup follows the switch', document.getElementById('menu_edit')?.textContent === '编辑',
        document.getElementById('menu_edit')?.textContent);
    check('tooltips follow the switch',
        (document.getElementById('btn_tool_node')?.getAttribute('data-tip') || '').includes('按节点编辑路径'),
        document.getElementById('btn_tool_node')?.getAttribute('data-tip'));

    // Dock tabs are written by JS, not markup: they need the LANGUAGE_CHANGED hook.
    const tabZh = document.querySelector('.dock-tab[data-panel-id="objects"]')?.textContent;
    check('dock tab is relabelled in zh', tabZh === '对象', tabZh);

    // Preference selects copy their option text into a custom trigger, so a switch
    // has to push a fresh option list through that wrapper.
    if (prefs) prefs.syncLabelOptions();
    const themeLabel = prefs?.querySelector('#pref_theme')?.previousElementSibling?.querySelector('.cs-label')?.textContent;
    check('preferences selects are relabelled', themeLabel === '浅色', themeLabel);

    check('document metadata follows the switch',
        document.documentElement.getAttribute('lang') === 'zh-CN'
        && document.title === I18n.t('app.title', ''),
        [document.documentElement.getAttribute('lang'), document.title]);

    const zhLeaks = [];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const v = el.textContent.trim();
        if (keyish.test(v)) zhLeaks.push('text=' + v + ' on #' + (el.id || el.tagName.toLowerCase()));
    });
    check('no bare key appears after switching to zh', zhLeaks.length === 0, zhLeaks);

    // Unknown ids are ignored, and switching back restores English everywhere.
    check('unknown locale id is rejected', I18n.setLang('de') === false && I18n.lang === 'zh', I18n.lang);
    I18n.setLang('en');
    check('switching back restores English',
        I18n.t('menu.file') === 'File'
        && document.getElementById('menu_edit')?.textContent === 'Edit'
        && document.querySelector('.dock-tab[data-panel-id="objects"]')?.textContent === 'Objects'
        && document.documentElement.getAttribute('lang') === 'en',
        [I18n.t('menu.file'), document.querySelector('.dock-tab[data-panel-id="objects"]')?.textContent]);
    if (storedBefore === null) localStorage.removeItem('InkShader_lang');
    else localStorage.setItem('InkShader_lang', storedBefore);

    // --- keys deleted as dead text must not come back ---
    check('deleted key is no longer defined', I18n.t('prop.group_spacing') === 'prop.group_spacing',
        I18n.t('prop.group_spacing'));
    check('renamed key carries the new wording', I18n.t('prop.smart') === 'Live Stroke', I18n.t('prop.smart'));
    check('Weight collision resolved', I18n.t('prop.weight') === 'Width', I18n.t('prop.weight'));

    check('no page errors', out.errors.length === 0, out.errors);
    return JSON.stringify(out);
})()
`;

async function main() {
    let target;
    try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await res.json();
    } catch (e) {
        console.error('Cannot create tab:', e.message);
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
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!window.I18n && !!document.querySelector('help-modal') && !!document.querySelector('main-canvas')?.curve_manager`,
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
        const v = res.result?.result?.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
    ws.close();
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
