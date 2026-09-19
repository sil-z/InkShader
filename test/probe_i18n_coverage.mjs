// i18n coverage diagnostic (pure Node CDP, no npm deps):
//  switches the UI to Chinese, reloads so every panel is built in Chinese, then walks
//  every user-visible text node and tooltip attribute and reports anything that still
//  contains Latin letters. Run it after editing the zh table to find strings that were
//  never routed through t().
//
//  Not a pass/fail suite: the output is a review list (shortcut tokens, axis labels
//  and glyph names legitimately read the same in both locales), so it prints and exits
//  without deciding the run's status. Requires the shared probe environment:
//      node test/run_probes.mjs --only i18n_coverage
import { writeFileSync } from 'node:fs';
import { probePorts, tmpFile } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
/** Where the full review list lands (run_probes only echoes a tail of stdout). */
const OUT_FILE = process.env.PROBE_I18N_OUT || tmpFile('i18n_coverage.json');
const APP_URL = `http://localhost:${SRV}/?v=i18ncov-1`;

const PROBE = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const I18n = window.I18n;
    if (!I18n) return JSON.stringify({ error: 'no I18n' });
    if (I18n.lang !== 'zh') { I18n.setLang('zh'); return '__RELOAD__'; }

    const skip = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE']);
    const latin = /[A-Za-z]/;
    // Strip the parts that legitimately read the same in both locales — parenthesised
    // shortcut hints, unit and format names, OpenType weight/width class names, and
    // the language picker's own labels. A Latin letter left after that means the
    // string never went through t().
    const NEUTRAL = /\([^)]*\)|Ctrl|Shift|Alt|Del|Backspace|Space|Esc|OTF|TTF|UFO|SVG|JSON|UPM|Unicode|ExtraLight|SemiBold|Regular|Bold|Black|Thin|Light|Medium|Condensed|Expanded|English|Ultra/g;
    const neutralOnly = (s) => !latin.test(String(s).replace(NEUTRAL, ''));
    const found = [];
    const where = (el) => {
        const parts = [];
        let n = el;
        while (n && n !== document.body) {
            parts.push(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\\s+/)[0] : ''));
            n = n.parentElement;
        }
        return parts.slice().reverse().join('>');
    };
    const push = (kind, text, el) => {
        const t = String(text).trim();
        if (!t || !latin.test(t) || neutralOnly(t)) return;
        found.push(kind + '  ' + JSON.stringify(t) + '   @ ' + where(el));
    };

    document.querySelectorAll('body *').forEach(el => {
        if (skip.has(el.tagName)) return;
        if (!el.children.length) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
            if (own.trim()) push('text', own, el);
        }
        ['data-tip', 'title', 'placeholder', 'aria-label'].forEach(a => {
            const v = el.getAttribute && el.getAttribute(a);
            if (v) push(a, v, el);
        });
    });

    // Attribute values and option labels of every <option>, including hidden panels.
    document.querySelectorAll('option').forEach(o => push('option', o.textContent, o));

    I18n.setLang('en');
    found.sort();
    return JSON.stringify({ total: found.length, items: found }, null, 1);
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
console.log(`i18n coverage: ${items.length} string(s) still contain Latin letters`);
console.log(`full list: ${OUT_FILE}`);
items.slice(0, 40).forEach(line => console.log('  ' + line));
ws.close();
