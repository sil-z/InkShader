// Decisive experiment: (1) does the default ::-webkit-resizer gray square sit at the
// textarea corner? (2) does the WRAP thumb show on hover anywhere along its strip?
// (3) what do the scrollbars look like WITHOUT the custom rules (system default)?
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=scrollprobe-6';

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
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails, null, 2) };
        return { value: r.result?.result?.value };
    };
    const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0 });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP_URL });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', {
            expression: `!!document.querySelector('main-canvas') && !!document.querySelector('main-canvas').curve_manager`,
            returnByValue: true
        });
        if (r.result?.result?.value === true) { ready = true; break; }
        await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!ready) { console.log('TIMEOUT'); process.exit(1); }
    await new Promise(r2 => setTimeout(r2, 1500));

    const prep = await evaluate(`(async () => {
        localStorage.removeItem('inkshader_sample_panel_state');
        const panel = document.querySelector('sample-text-panel');
        const input = panel.querySelector('#sample_text_input');
        input.setAttribute('wrap', 'off');
        input.value = 'A'.repeat(400) + '\\n' + Array.from({length: 20}, (_, i) => 'line ' + i).join('\\n');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        const wrap = panel.querySelector('#sample_canvas_wrap');
        const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        const report = document.querySelector('.dock-leaf[data-panel-id="sample"]');
        return JSON.stringify({ input: box(input), wrap: box(wrap), report: report ? box(report) : null });
    })()`);
    const boxes = JSON.parse(prep.value);
    const clip = {
        x: Math.floor(boxes.report.x) - 4,
        y: Math.floor(boxes.report.y) - 4,
        width: Math.ceil(boxes.report.w) + 8,
        height: Math.ceil(boxes.report.h) + 8,
        scale: 1
    };

    const shot = async () => {
        const img = await send('Page.captureScreenshot', { format: 'png', clip });
        return 'data:image/png;base64,' + img.result.data;
    };

    // ── State A: hover over textarea (custom styles active) ──
    await mouse('mouseMoved', boxes.input.x + 40, boxes.input.y + 20);
    await new Promise(r2 => setTimeout(r2, 400));
    const a = await shot();

    // ── State B: inject hide of ::-webkit-resizer, re-hover, reshot ──
    const hidden = await evaluate(`(() => {
        const s = document.createElement('style');
        s.id = 'probe-resizer-hide';
        s.textContent = '.sample-text-input::-webkit-resizer { display: none !important; }';
        document.head.appendChild(s);
        return 'injected';
    })()`);
    await mouse('mouseMoved', boxes.input.x + 30, boxes.input.y + 20);
    await new Promise(r2 => setTimeout(r2, 400));
    const b = await shot();

    // ── State C: remove ALL custom scrollbar CSS (system default for textarea) ──
    const removed = await evaluate(`(() => {
        document.getElementById('probe-resizer-hide')?.remove();
        const s = document.createElement('style');
        s.id = 'probe-nocustom';
        s.textContent = '.sample-text-input::-webkit-scrollbar, .sample-text-input::-webkit-scrollbar-thumb, .sample-text-input::-webkit-scrollbar-track, .sample-text-input::-webkit-scrollbar-corner, .sample-text-input::-webkit-resizer { all: unset; }';
        document.head.appendChild(s);
        return 'injected';
    })()`);
    await mouse('mouseMoved', boxes.input.x + 30, boxes.input.y + 20);
    await new Promise(r2 => setTimeout(r2, 500));
    const c = await shot();

    const clipX = clip.x, clipY = clip.y;
    const analyze = async (dataUrl) => evaluate(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const boxes = ${JSON.stringify(boxes)};
        const OX = ${clipX}, OY = ${clipY};
        const hex = (i) => '#' + [px[i], px[i + 1], px[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
        // 24x24 corner block colors
        const corner = (bx) => {
            const x0 = Math.round(bx.x - OX) + Math.round(bx.w) - 24;
            const y0 = Math.round(bx.y - OY) + Math.round(bx.h) - 24;
            const colors = new Map();
            for (let y = y0; y < y0 + 24; y++) for (let x = x0; x < x0 + 24; x++) {
                if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
                const k = hex((y * c.width + x) * 4);
                colors.set(k, (colors.get(k) || 0) + 1);
            }
            return [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        };
        // full V-strip scan (non-bg counts per 10px band) to see where the thumb is
        const vBands = (bx, inset) => {
            const x0 = Math.round(bx.x - OX), y0 = Math.round(bx.y - OY);
            const w = Math.round(bx.w), h = Math.round(bx.h);
            const bands = [];
            for (let band = 0; band < Math.ceil(h / 10); band++) {
                let n = 0;
                for (let i = band * 10; i < Math.min((band + 1) * 10, h); i++) {
                    const cx = x0 + w - inset, cy = y0 + i;
                    if (cx < 0 || cy < 0 || cx >= c.width || cy >= c.height) continue;
                    const k = hex((cy * c.width + cx) * 4);
                    if (k !== '#f8fafc' && k !== '#ffffff' && k !== '#eff2f7' && k !== '#ecf0f5') n++;
                }
                bands.push(n);
            }
            return bands;
        };
        const hBands = (bx, inset) => {
            const x0 = Math.round(bx.x - OX), y0 = Math.round(bx.y - OY);
            const w = Math.round(bx.w), h = Math.round(bx.h);
            const bands = [];
            for (let band = 0; band < Math.ceil(w / 10); band++) {
                let n = 0;
                for (let i = band * 10; i < Math.min((band + 1) * 10, w); i++) {
                    const cx = x0 + i, cy = y0 + h - inset;
                    if (cx < 0 || cy < 0 || cx >= c.width || cy >= c.height) continue;
                    const k = hex((cy * c.width + cx) * 4);
                    if (k !== '#f8fafc' && k !== '#ffffff' && k !== '#eff2f7' && k !== '#ecf0f5') n++;
                }
                bands.push(n);
            }
            return bands;
        };
        return JSON.stringify({
            inputCorner: corner(boxes.input),
            wrapCorner: corner(boxes.wrap),
            inputV: vBands(boxes.input, 3),
            inputH: hBands(boxes.input, 3),
            wrapV: vBands(boxes.wrap, 3),
            wrapH: hBands(boxes.wrap, 3)
        });
    })()`);

    console.log('--- A: hover textarea (current custom styles) ---');
    console.log((await analyze(a)).error || (await analyze(a)).value);
    console.log('--- B: + ::-webkit-resizer display:none ---');
    console.log((await analyze(b)).error || (await analyze(b)).value);
    console.log('--- C: textarea custom scrollbar CSS all:unset (system default) ---');
    console.log((await analyze(c)).error || (await analyze(c)).value);
    ws.close();
}
main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1); });