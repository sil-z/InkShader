// One-off verification: font panel popup-body scrollbar must behave exactly
// like the shared panel group (.dock-content): transparent by default,
// --ui-border-light thumb on hover/data-scrollbar-visible, --ui-text-muted on
// thumb hover. (CSS-only change; no app code touched in this session.)
import { spawn } from 'node:child_process';

const HTTP = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdp(wsUrl, id, method, params = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
        ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id === id) { ws.close(); resolve(m.result); }
        };
        ws.onerror = (e) => reject(new Error('ws error'));
        setTimeout(() => reject(new Error('timeout cdp ' + method)), 15000);
    });
}

async function main() {
    // steal the existing headless tab? no - open a fresh page
    const res = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
    const wsUrl = res.webSocketDebuggerUrl;
    const id = res.id;
    await cdp(wsUrl, 1, 'Page.enable');
    await cdp(wsUrl, 2, 'Runtime.enable');
    await cdp(wsUrl, 3, 'Network.enable');
    // clear browser cache so the new stylesheet is fetched fresh
    await fetch(`http://127.0.0.1:9222/json/version`).catch(() => {});
    const { Network } = await import('node:inspector/promises').catch(() => ({}));
    // Network.clearBrowserCache via raw CDP
    await cdp(wsUrl, 4, 'Network.clearBrowserCache');
    await cdp(wsUrl, 5, 'Page.navigate', { url: HTTP + '/?v=fontscroll-1' });
    await sleep(3500);

    async function evalJs(expression) {
        const r = await cdp(wsUrl, Math.floor(Math.random() * 1e6), 'Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true
        });
        if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result?.value;
    }

    // show font panel (Session 27: hidden by default at fresh boot)
    const shown = await evalJs(`(() => {
        const d = window.__dock;
        if (!d) return { err: 'no __dock' };
        if (d.isPanelHidden('font')) d.showPanel('font');
        return { ok: true, hidden: Array.from(d._hiddenPanels) };
    })()`);
    console.log('show font:', JSON.stringify(shown));
    await sleep(400);

    const out = await evalJs(`(() => {
        const body = document.querySelector('font-popup .pen-tool-popup-body');
        const dockContent = document.querySelector('.dock-content');
        if (!body) return { err: 'no pen-tool-popup-body' };
        // ensure it actually overflows (long content) so a thumb exists
        const thumbStyle = (el, pseudo) => getComputedStyle(el, pseudo);
        const cs = (el) => ({
            w: thumbStyle(el, '::-webkit-scrollbar').width,
            thumb: thumbStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
            thumbHover: thumbStyle(el, '::-webkit-scrollbar-thumb:hover').backgroundColor,
            track: thumbStyle(el, '::-webkit-scrollbar-track').backgroundColor,
            borderR: thumbStyle(el, '::-webkit-scrollbar-thumb').borderRadius,
        });
        const base = { font: cs(body), dock: dockContent ? cs(dockContent) : null };
        // hover path: mouseover is what scrollbar_visibility.js listens for
        body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
        const hoveredFont = cs(body);
        // data attribute path (what the global listener sets on scroll)
        body.removeAttribute('data-scrollbar-visible');
        body.setAttribute('data-scrollbar-visible', '');
        const attrFont = cs(body);
        body.removeAttribute('data-scrollbar-visible');
        // cleanup font panel (restore hidden state) so we don't pollute
        const d = window.__dock;
        if (!d.isPanelHidden('font')) d.hidePanel('font');
        return { base, hoveredFont, attrFont, overflow: body.scrollHeight > body.clientHeight };
    })()`);
    console.log('result:', JSON.stringify(out, null, 1));

    await fetch(`http://127.0.0.1:9222/json/close/${id}`).catch(() => {});
}

main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e); process.exit(1); });