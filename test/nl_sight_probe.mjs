// Capture the sample panel canvas for several newline texts, then dump:
// (a) guide-line pixel rows per horizontal line (scan the orange color),
// (b) a PNG screenshot of the panel area for visual confirmation.
const DEBUG_PORT = 9222;
import fs from 'node:fs';

async function cdp() {
    const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => {
        const i = ++id; pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    return { ws, send };
}

(async () => {
    const { ws, send } = await cdp();
    await send('Network.clearBrowserCache');
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://localhost:8123/?v=sight-1' });
    await new Promise(r => setTimeout(r, 3500));

    const probe = `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const cv = document.querySelector('main-canvas');
        window.confirm = () => true;
        localStorage.removeItem('inkshader_sample_panel_state');
        const panel = document.querySelector('sample-text-panel');
        const input = panel.querySelector('#sample_text_input');
        const canvas = panel.querySelector('#sample_canvas');
        const ctx = canvas.getContext('2d');
        const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
        await cv.projectManager.loadFromFile(await resp.text());
        await sleep(800);
        if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;
        await sleep(300);
        if (!panel.querySelector('#sample_guides').checked) panel.querySelector('#sample_guides').click();
        const fsInp = panel.querySelector('#sample_font_size');
        fsInp.value = '48'; fsInp.dispatchEvent(new Event('change', { bubbles: true }));
        const wrap = panel.querySelector('#sample_canvas_wrap');
        await sleep(400);
        const scanGuides = () => {
            const W = canvas.width, H = canvas.height;
            const d = ctx.getImageData(0, 0, W, H).data;
            const lines = [];
            for (let y = 0; y < H; y++) {
                let cnt = 0;
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    if (d[i] > 200 && d[i + 1] < 180 && d[i + 2] < 120 && d[i + 3] > 0) cnt++;
                }
                if (cnt > 2) lines.push({ y, px: cnt });
            }
            return lines;
        };
        const type = async (text) => { input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(500); };

        const result = {};
        for (const t of ['AB', 'AB\\nCD', 'AB\\nCD\\n', 'AB\\n\\nCD', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'The quick brown fox\\nJumps over\\nThe lazy dog']) {
            await type(t);
            const lines = scanGuides();
            // group into clusters (gap > 3)
            const clusters = [];
            let cur = null;
            for (const l of lines) {
                if (cur && l.y - cur.end <= 3) cur.end = l.y, cur.rows.push(l.y);
                else { cur = { start: l.y, end: l.y, rows: [l.y] }; clusters.push(cur); }
            }
            // detail: measured layout info + canvas size
            const em = await import('./js/app/editor_read_facade.js');
            const wrapW = wrap.clientWidth;
            const m1 = em.measureSampleTextPreview(t, { kerning: undefined, width: wrapW, fontSize: 48 });
            const cw = m1 && m1.maxRowWidthPx > 0 ? Math.max(wrapW, Math.ceil(m1.maxRowWidthPx)) : wrapW;
            const m2 = cw !== wrapW ? em.measureSampleTextPreview(t, { kerning: undefined, width: cw, fontSize: 48 }) : m1;
            result[t.replace(/\\n/g, '\\\\n')] = {
                canvasH: canvas.height, canvasW: canvas.width, wrapW,
                m1: m1 && { rows: m1.rows, maxRowWidthPx: Math.round(m1.maxRowWidthPx), contentH: Math.round(m1.contentHeight) },
                m2: m2 && { rows: m2.rows, contentH: Math.round(m2.contentHeight) },
                clusters: clusters.map(c => ({ start: c.start, rows: c.rows }))
            };
        }
        window.__sight = result;
        return JSON.stringify(result);
    })()`;

    const r = await send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    console.log('SCAN:', r.result?.result?.value);

    // Screenshot the whole page
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
    await new Promise(r2 => setTimeout(r2, 400));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
        fs.writeFileSync('C:\\Users\\z\\Desktop\\InkShader\\InkShader\\test\\nl_sight.png', Buffer.from(shot.result.data, 'base64'));
        console.log('screenshot saved');
    }
    ws.close();
})();