// Diagnostic: which font does the platform actually use for each declared stack?
//
// The stylesheet only names generic families (see test/check_fonts.mjs), so what the user
// sees is decided by the browser's own font settings. This probe asks Chromium for that
// answer (`CSS.getPlatformFontsForNode`) for representative elements, and compares each
// stack against a control element using the bare generic keyword. Run it when a font looks
// different from what the CSS text suggests.
//
//  Not a pass/fail suite: the output is a report. Requires the probe environment:
//      node test/run_probes.mjs --only platform_fonts
import { writeFileSync } from 'node:fs';
import { probePorts, tmpFile } from './probe_env.mjs';

const { port: DEBUG_PORT, srv: SRV } = probePorts();
const APP_URL = `http://localhost:${SRV}/?v=platformfonts-1`;

/** Elements whose stack we want resolved. */
const TARGETS = [
    { name: 'body (ui text)', selector: 'body' },
    { name: 'mouse position readout', selector: '#mouse_pos' },
    { name: 'bare monospace control', selector: '#__font_control_mono' },
    { name: 'bare sans-serif control', selector: '#__font_control_sans' },
    { name: 'old error-dialog stack', selector: '#__font_control_old_mono' },
    { name: 'named Consolas control', selector: '#__font_control_consolas' },
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

    // Two controls with the bare generic keywords, so the report can say whether the
    // project's stacks land on the same face the platform uses for the keyword alone.
    await send('Runtime.evaluate', {
        expression: `
            (() => {
                const mk = (id, family) => {
                    const d = document.createElement('span');
                    d.id = id;
                    d.textContent = 'InkShader 0123';
                    d.style.cssText = 'position:fixed;left:-9999px;top:0;font:' + family;
                    document.body.appendChild(d);
                };
                mk('__font_control_mono', '14px monospace');
                mk('__font_control_sans', '14px sans-serif');
                // The stack the error dialog used to declare, kept as a control so a
                // "did this change the font?" question can be answered by measurement.
                mk('__font_control_old_mono', '14px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace');
                mk('__font_control_consolas', '14px Consolas');
            })()`,
        returnByValue: true,
    });

    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const rootId = doc.result.root.nodeId;

    const report = [];
    for (const t of TARGETS) {
        const found = await send('DOM.querySelector', { nodeId: rootId, selector: t.selector });
        const nodeId = found.result?.nodeId;
        if (!nodeId) { report.push(`${t.name}: no element matched ${t.selector}`); continue; }
        const fonts = await send('CSS.getPlatformFontsForNode', { nodeId });
        const list = (fonts.result?.fonts || []).map(f => `${f.familyName}${f.isCustomFont ? ' (webfont)' : ''}`);
        const declared = await send('Runtime.evaluate', {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(t.selector)});
                return el ? getComputedStyle(el).fontFamily : null; })()`,
            returnByValue: true,
        });
        report.push(`${t.name}: ${list.join(' + ') || '(no glyphs measured)'}\n      declared: ${declared.result?.result?.value}`);
    }

    const text = 'resolved platform fonts:\n' + report.map(l => '  ' + l).join('\n');
    // The runner only echoes a tail of a diagnostic's stdout, so keep the full report
    // in a file the caller can read.
    writeFileSync(process.env.PROBE_FONTS_OUT || tmpFile('platform_fonts.txt'), text, 'utf8');
    console.log(text);
    ws.close();
}
main().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1); });
