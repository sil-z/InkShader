// Diagnostic: switch the language WITHOUT reloading and list every user-visible string
// that is still in English. `probe_i18n_coverage.mjs` reloads after the switch, so it only
// proves that a fresh boot is fully translated; this one measures which components fail to
// follow a live switch (they build their text through t() at render time and never re-render).
//
//  Not a pass/fail suite: the output is a review list. Requires the probe environment:
//      node test/run_probes.mjs --only i18n_live_switch
import { writeFileSync } from 'node:fs';
import { probePorts, tmpFile } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const OUT_FILE = process.env.PROBE_I18N_LIVE_OUT || tmpFile('i18n_live_switch.json');
const APP_URL = `http://localhost:${SRV}/?v=i18nlive-1`;

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const I18n = window.I18n;
    if (!I18n) return JSON.stringify({ error: 'no I18n' });
    if (I18n.lang !== 'en') { I18n.setLang('en'); return '__RELOAD__'; }

    const latin = /[A-Za-z]/;
    const NEUTRAL = /\\([^)]*\\)|Ctrl|Shift|Alt|Del|Backspace|Space|Esc|OTF|TTF|UFO|SVG|JSON|UPM|Unicode|ExtraLight|SemiBold|Regular|Bold|Black|Thin|Light|Medium|Condensed|Expanded|English|Ultra/g;
    const skip = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE']);

    // Shadow DOM is where every panel lives, so walk it explicitly.
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        roots[i].querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
    }
    const scan = () => {
        const found = [];
        const where = (el) => {
            const parts = [];
            let n = el;
            while (n && n !== document.body) {
                parts.push(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\\s+/)[0] : ''));
                n = n.parentElement || n.host || null;
            }
            return parts.slice().reverse().join('>');
        };
        const push = (kind, text, el) => {
            const t = String(text).trim();
            if (!t || !latin.test(t)) return;
            if (!latin.test(t.replace(NEUTRAL, ''))) return;
            found.push(kind + '  ' + JSON.stringify(t) + '   @ ' + where(el));
        };
        roots.forEach(root => {
            root.querySelectorAll('*').forEach(el => {
                if (skip.has(el.tagName)) return;
                if (!el.children.length) {
                    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
                    if (own.trim()) push('text', own, el);
                }
                ['data-tip', 'title', 'placeholder', 'aria-label'].forEach(a => {
                    const v = el.getAttribute && el.getAttribute(a);
                    if (v) push(a, v, el);
                });
                if (el.tagName === 'OPTION') push('option', el.textContent, el);
            });
        });
        return found;
    };

    // Open the panels that build their rows lazily, so the scan sees real content.
    document.querySelectorAll('object-tree, glyphs-panel, font-popup, kern-popup, glyph-popup, properties-panel')
        .forEach(el => { try { el.render?.(); } catch (_) { /* optional hook */ } });
    await sleep(300);
    const before = scan().length;

    I18n.setLang('zh');
    await sleep(600);
    const after = scan();
    after.sort();
    // Probes share one origin, so leaving the stored locale switched would make the
    // next probe boot in Chinese and fail its English expectations.
    I18n.setLang('en');
    return JSON.stringify({ before, total: after.length, items: after }, null, 1);
})()
`;

const res = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
const target = await res.json();
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
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL });
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', {
        expression: `!!window.I18n && !!document.querySelector('main-canvas')?.curve_manager`,
        returnByValue: true,
    });
    if (r.result?.result?.value === true) break;
    await new Promise(r => setTimeout(r, 500));
}
await new Promise(r => setTimeout(r, 800));
const evaluate = () => send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
let out = await evaluate();
let raw = out.result?.result?.value ?? JSON.stringify(out.result?.exceptionDetails);
if (raw === '"__RELOAD__"' || raw === '__RELOAD__') {
    await send('Page.reload');
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
        const r = await send('Runtime.evaluate', {
            expression: `!!window.I18n && !!document.querySelector('main-canvas')?.curve_manager`,
            returnByValue: true,
        });
        if (r.result?.result?.value === true) break;
        await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 1200));
    out = await evaluate();
    raw = out.result?.result?.value ?? JSON.stringify(out.result?.exceptionDetails);
}
writeFileSync(OUT_FILE, raw, 'utf8');
let parsed = null;
try { parsed = JSON.parse(raw); } catch { /* keep the raw dump only */ }
const items = parsed?.items || [];
console.log(`live switch: ${items.length} string(s) did not follow the switch (${parsed?.before ?? '?'} before)`);
console.log(`full list: ${OUT_FILE}`);
items.slice(0, 25).forEach(line => console.log('  ' + line));
ws.close();
