// Diagnostic: which font does the platform actually use for the page's font stacks?
//
// The stylesheet only names generic families (enforced by test/check_fonts.mjs), so the
// face the user sees is chosen by the browser: `ui-monospace` and `monospace` both resolve
// through the platform's own font settings, and the *document language* can change which
// face they pick (the Han-script default is not the Latin one). This probe asks Chromium
// directly (`CSS.getPlatformFontsForNode`) and prints the answer, so a "the font changed"
// report can be settled by measurement rather than by reading the CSS.
//
// Measured on Windows 10 (125%): `lang="en"` -> Consolas, `lang="zh-CN"` -> NSimSun,
// for both `monospace` and `ui-monospace`, and for both Latin and Han text. The stack's
// contents make no difference; only the generic keyword and the document language do.
// This is why the interface's monospace face changed when i18n started writing `lang`.
//
//  Not a pass/fail suite. Requires the probe environment:
//      node test/run_probes.mjs --only platform_fonts
// The full report lands in PROBE_FONTS_OUT (the runner only echoes a tail of stdout).
import { writeFileSync } from 'node:fs';
import { probePorts, tmpFile } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const APP_URL = `http://localhost:${SRV}/?v=platformfonts-3`;

/** Injected probes: a stable id, the stack to declare, the text to measure. */
const CONTROLS = [
    ['#__f_ui_mono_latin', '14px ui-monospace, monospace', 'InkShader 0123'],
    ['#__f_mono_latin', '14px monospace', 'InkShader 0123'],
    ['#__f_ui_mono_cjk', '14px ui-monospace, monospace', '汉字测试 0123'],
    ['#__f_mono_cjk', '14px monospace', '汉字测试 0123'],
    ['#__f_sans_latin', '14px system-ui, sans-serif', 'InkShader 0123'],
    ['#__f_sans_cjk', '14px system-ui, sans-serif', '汉字测试 0123'],
    ['#__f_old_stack', '14px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace', 'InkShader 0123'],
    ['#__f_named_consolas', '14px Consolas', 'InkShader 0123'],
];

/** Real UI text, measured as it is rendered (light DOM only; panels live in shadow roots). */
const REAL = [
    ['body', 'body'],
    ['mouse position readout', '#mouse_pos'],
];

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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('CSS.enable');
    await send('Page.navigate', { url: APP_URL });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!window.__dock && !!document.querySelector('main-canvas')?.curve_manager`,
            returnByValue: true,
        });
        if (r.result?.result?.value === true) break;
        await new Promise(r2 => setTimeout(r2, 500));
    }
    await new Promise(r2 => setTimeout(r2, 1200));

    const inject = (controls) => send('Runtime.evaluate', {
        expression: `(() => {
            document.querySelectorAll('[id^="__f_"]').forEach(el => el.remove());
            for (const [id, family, text] of ${JSON.stringify(controls)}) {
                const el = document.createElement('span');
                el.id = id.replace(/^#/, '');
                el.textContent = text;
                el.style.cssText = 'position:fixed;left:-9999px;top:0;font:' + family;
                document.body.appendChild(el);
            }
        })()`,
        returnByValue: true,
    });

    const documentNode = await send('DOM.getDocument', { depth: -1, pierce: true });
    const rootId = documentNode.result.root.nodeId;

    const measure = async (rows) => {
        const out = [];
        for (const [label, selector] of rows) {
            const found = await send('DOM.querySelector', { nodeId: rootId, selector });
            const nodeId = found.result?.nodeId;
            if (!nodeId) { out.push(`${label}: element not found (${selector})`); continue; }
            const fonts = await send('CSS.getPlatformFontsForNode', { nodeId });
            const list = (fonts.result?.fonts || []).map(f => `${f.familyName}${f.isCustomFont ? ' (webfont)' : ''}`);
            out.push(`${label}: ${list.join('  +  ') || '(no glyphs measured)'}`);
        }
        return out;
    };

    const report = [];
    for (const docLang of ['en', 'zh-CN']) {
        await send('Runtime.evaluate', {
            expression: `document.documentElement.lang = ${JSON.stringify(docLang)}`,
            returnByValue: true,
        });
        await inject(CONTROLS);
        await new Promise(r2 => setTimeout(r2, 200));
        report.push(`--- document language: ${docLang} ---`);
        report.push(...await measure(CONTROLS.map(([sel, family, text]) => [text.includes('汉') ? `${sel.slice(4)} (CJK text)` : sel.slice(4), sel])));
        report.push(...await measure(REAL));
    }

    const text = 'resolved platform fonts\n' + report.map(l => (l.startsWith('---') ? l : '  ' + l)).join('\n') + '\n';
    writeFileSync(process.env.PROBE_FONTS_OUT || tmpFile('platform_fonts.txt'), text, 'utf8');
    console.log(text);
    ws.close();
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
