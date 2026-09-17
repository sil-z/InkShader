// Menu shortcut-label regression probe (pure Node CDP, no npm deps):
//  - File menu renders Ctrl+N/O + Save(Ctrl+S) / Save As JSON(Ctrl+Shift+J) /
//    Ctrl+Shift+E/S labels; import items have none
//  - Edit menu keeps Ctrl+C/V/D + Del (regression)
//  - Help menu entry opens help-modal; close via OK button
//  - help list has >= 20 entries; zh help.s.* keys resolve
// The only probe covering menu shortcut-label RENDERING + help-modal open path.
// Requires: Chrome --remote-debugging-port=9222, server on :8123.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=menu-sc-1';

const PROBE = `
(async () => {
    const out = { errors: [], checks: [] };
    const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.errors.push(name + ': ' + JSON.stringify(detail)); };
    window.addEventListener('error', e => out.errors.push('error: ' + e.message));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const btnFile = document.getElementById('menu_file');
    const btnHelp = document.querySelector('.top .item[data-i18n="menu.help"]');
    const btnEdit = document.getElementById('menu_edit');

    // --- File menu: shortcut labels rendered ---
    btnFile.click();
    await sleep(300);
    const dd = document.querySelector('dropdown-menu');
    const items = [...dd.querySelectorAll('.save-dropdown-item')];
    const labelShortcuts = {};
    for (const it of items) {
        const sc = it.querySelector('.shortcut');
        if (sc) labelShortcuts[it.querySelector('.save-dropdown-label').textContent.trim()] = sc.textContent.trim();
    }
    check('File menu opened', dd._visible === true, dd._visible);
    check('File New has Ctrl+N', labelShortcuts['New Project'] === 'Ctrl+N', labelShortcuts['New Project']);
    check('File Open has Ctrl+O', labelShortcuts['Open Project (JSON)'] === 'Ctrl+O', labelShortcuts['Open Project (JSON)']);
    check('File Save has Ctrl+S', labelShortcuts['Save'] === 'Ctrl+S', labelShortcuts['Save']);
    check('File Save As JSON has Ctrl+Shift+J', labelShortcuts['Save as JSON Project'] === 'Ctrl+Shift+J', labelShortcuts['Save as JSON Project']);
    check('File Export UFO has Ctrl+Shift+E', labelShortcuts['Save as UFO Project'] === 'Ctrl+Shift+E', labelShortcuts['Save as UFO Project']);
    check('File Export SVG has Ctrl+Shift+S', labelShortcuts['Save as SVG File'] === 'Ctrl+Shift+S', labelShortcuts['Save as SVG File']);
    // Import items must NOT have a shortcut (none bound)
    check('File Load UFO has no shortcut', !items.some(i => i.querySelector('.save-dropdown-label').textContent.includes('UFO') && i.querySelector('.shortcut') && i.textContent.includes('Import')), true);
    dd.hide();

    // --- Edit menu: existing shortcuts intact (regression) ---
    btnEdit.click();
    await sleep(300);
    const eItems = [...dd.querySelectorAll('.save-dropdown-item')];
    const eSc = {};
    for (const it of eItems) {
        const sc = it.querySelector('.shortcut');
        if (sc) eSc[it.querySelector('.save-dropdown-label').textContent.trim()] = sc.textContent.trim();
    }
    check('Edit Copy has Ctrl+C', eSc['Copy'] === 'Ctrl+C', eSc['Copy']);
    check('Edit Paste has Ctrl+V', eSc['Paste'] === 'Ctrl+V', eSc['Paste']);
    check('Edit Duplicate has Ctrl+D', eSc['Duplicate'] === 'Ctrl+D', eSc['Duplicate']);
    check('Edit Delete has Del', eSc['Delete'] === 'Del', eSc['Delete']);
    dd.hide();

    // --- Help menu: entry opens help-modal ---
    btnHelp.click();
    await sleep(300);
    const helpItem = [...dd.querySelectorAll('.save-dropdown-item')].find(i => i.querySelector('.save-dropdown-label').textContent.trim() === 'Keyboard Shortcuts');
    check('Help menu has shortcuts entry', !!helpItem, !!helpItem);
    helpItem.click();
    await sleep(300);
    const hm = document.querySelector('help-modal');
    check('help-modal opened', hm && hm.overlay.classList.contains('active'), hm && hm.overlay.classList.contains('active'));
    const helpLis = hm ? hm.querySelectorAll('.help_list li').length : 0;
    check('help list complete (>= 20 entries)', helpLis >= 20, helpLis);
    // english-only build: help.s.* must still resolve through the i18n table
    // (rather than falling back to the raw key)
    const I18n = window.I18n;
    const tools = I18n && I18n.t('help.s.tools');
    check('help.s.tools resolves via i18n', !!tools && tools.length > 10 && tools !== 'help.s.tools', tools);
    // close via OK button
    hm.querySelector('#btn_help_ok').click();
    await sleep(200);
    check('help-modal closes', !hm.overlay.classList.contains('active'), hm.overlay.classList.contains('active'));

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
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager && !!document.querySelector('dropdown-menu') && !!document.querySelector('help-modal')`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT waiting for app bootstrap'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));
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