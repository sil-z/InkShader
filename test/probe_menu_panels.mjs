// Top-bar menus whose contents are built in JS, not markup:
//  - Layout lists the seven available panels. Console is withdrawn from the menu for
//    now: the panel and its dock tab still work, but there is no toggle that reveals
//    it, so a stray Console entry is a regression.
//  - Help is a single link out to the project page, opened in the system browser.
//    Any in-app item reappearing here (shortcuts modal, About) fails the probe.
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
import { probePorts } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const APP_URL = `http://localhost:${SRV}/?v=menupanels-1`;
const PROJECT_URL = 'https://github.com/sil-z/InkShader';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => {
        out.checks.push({ name, ok, detail });
        if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail));
    };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const dd = document.querySelector('dropdown-menu');
    const labels = () => [...dd.querySelectorAll('.save-dropdown-label')].map(e => e.textContent);
    const itemFor = (text) => [...dd.querySelectorAll('.save-dropdown-item')]
        .find(d => (d.querySelector('.save-dropdown-label')?.textContent || '').includes(text));
    const closeMenus = () => document.body.click();

    // ── Layout menu ──
    document.getElementById('menu_layout').click();
    await sleep(120);
    const layoutLabels = labels();
    const has = (s) => layoutLabels.some(l => l.includes(s));
    check('layout menu lists the seven panels',
        ['Canvas', 'Objects', 'Properties', 'Sample', 'Font', 'Kerning', 'Glyphs'].every(has),
        layoutLabels);
    check('layout menu has no Console toggle', !has('Console'), layoutLabels);

    // The toggle still works: kerning starts hidden, so its first click shows it.
    const dock = window.__dock;
    const wasHidden = dock.isPanelHidden('kerning');
    itemFor('Kerning').click();
    await sleep(250);
    check('a layout toggle still hides/shows its panel',
        dock.isPanelHidden('kerning') !== wasHidden,
        { wasHidden, nowHidden: dock.isPanelHidden('kerning') });
    if (!wasHidden) { // put it back the way the layout started
        document.getElementById('menu_layout').click();
        await sleep(120);
        itemFor('Kerning').click();
        await sleep(250);
    }
    closeMenus();
    await sleep(120);

    // ── Help menu ──
    const opened = [];
    const realOpen = window.open;
    window.open = (...args) => { opened.push(args); return null; };
    try {
        document.querySelector('[data-i18n="menu.help"]').click();
        await sleep(120);
        const helpLabels = labels();
        check('help menu has exactly one item', helpLabels.length === 1, helpLabels);
        check('that item is Documentation', /Documentation/.test(helpLabels[0] || ''), helpLabels);

        itemFor('Documentation').click();
        await sleep(200);
        check('documentation opens the project page externally',
            opened.length === 1 && opened[0][0] === ${JSON.stringify(PROJECT_URL)},
            opened);
    } finally {
        window.open = realOpen;
    }

    // The same single item must follow a language switch.
    const before = window.I18n.lang;
    window.I18n.setLang('zh');
    await sleep(150);
    closeMenus();
    await sleep(120);
    document.querySelector('[data-i18n="menu.help"]').click();
    await sleep(120);
    const zhLabels = labels();
    check('help item is translated', zhLabels.length === 1 && /文档/.test(zhLabels[0] || ''), zhLabels);
    window.I18n.setLang(before);
    closeMenus();

    return JSON.stringify(out);
})()
`;

async function main() {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
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
            expression: `!!window.I18n && !!window.__dock && !!document.querySelector('main-canvas')?.curve_manager`,
            returnByValue: true,
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1200));
    const evaluated = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    const parsed = JSON.parse(evaluated.result?.result?.value || '{"checks":[]}');
    const failed = parsed.checks.filter(c => !c.ok).length;
    for (const c of parsed.checks) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${JSON.stringify(c.detail)}`);
    }
    console.log(JSON.stringify({
        passed: parsed.checks.length - failed,
        total: parsed.checks.length,
        pageErrors: parsed.errors,
    }, null, 2));
    ws.close();
    process.exit(failed === 0 && parsed.checks.length > 0 ? 0 : 1);
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
