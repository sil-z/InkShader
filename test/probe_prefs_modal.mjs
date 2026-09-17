// Preferences modal probe (pure Node CDP, no npm deps):
//  - the popup opens from the top menu and renders its rows
//  - English-only invariant: the locale table is English and the language
//    selector is gone (previously it switched the whole UI to Chinese)
//  - theme / accent selects and the canvas colour pickers are wired
//  - opening and closing raise no console errors
// The only probe covering the preferences modal at all.
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
import { probePorts } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const APP_URL = `http://localhost:${SRV}/?v=prefs-1`;

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => {
        out.checks.push({ name, ok, detail });
        if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail));
    };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const btn = document.querySelector('.top .item[data-i18n="menu.prefs"]');
    check('preferences menu item exists', !!btn);
    if (!btn) return JSON.stringify(out);
    btn.click();
    await sleep(400);

    const pp = document.querySelector('preferences-popup');
    check('preferences popup mounted', !!pp);
    check('preferences popup visible', !!(pp && pp._visible), pp && pp._visible);

    check('language selector removed', !document.querySelector('#pref_lang'));
    check('theme select present', !!document.querySelector('#pref_theme'));
    check('accent select present', !!document.querySelector('#pref_accent_hue'));
    const colorRows = document.querySelectorAll('#pref_colors .pen-tool-row').length;
    check('canvas colour pickers built (>= 2)', colorRows >= 2, colorRows);

    const I18n = window.I18n;
    check('i18n table resolves English', !!I18n && I18n.t('menu.file') === 'File',
        I18n && I18n.t('menu.file'));
    check('i18n language fixed to en', !!I18n && I18n.lang === 'en', I18n && I18n.lang);

    pp.hide();
    await sleep(200);
    check('popup hides again', !pp._visible, pp._visible);
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
            expression: `!!document.querySelector('preferences-popup') && !!document.querySelector('main-canvas')?.curve_manager`,
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
