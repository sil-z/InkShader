// Hover forensics: move the pointer over textarea / over wrap, screenshot both states,
// and compare whether the scrollbar thumb becomes visible (hover rules apply).
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=scrollprobe-5';

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

    // Move pointer OUT of the panel first (neutral state), screenshot, then over textarea,
    // screenshot, then over wrap, screenshot.
    await mouse('mouseMoved', boxes.report.x - 100, 400);
    await new Promise(r2 => setTimeout(r2, 400));
    const shot = async (label) => {
        const img = await send('Page.captureScreenshot', { format: 'png', clip });
        return { label, dataUrl: 'data:image/png;base64,' + img.result.data };
    };
    const neutral = await shot('neutral');
    await mouse('mouseMoved', boxes.input.x + 40, boxes.input.y + 20);
    await new Promise(r2 => setTimeout(r2, 400));
    const overInput = await shot('overInput');
    await mouse('mouseMoved', boxes.wrap.x + 100, boxes.wrap.y + 100);
    await new Promise(r2 => setTimeout(r2, 400));
    const overWrap = await shot('overWrap');

    const clipX = clip.x, clipY = clip.y;
    const analyze = async (shot) => evaluate(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(shot.dataUrl)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const boxes = ${JSON.stringify(boxes)};
        const OX = ${clipX}, OY = ${clipY};
        const hex = (i) => '#' + [px[i], px[i + 1], px[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
        const strip = (bx, mode, inset) => {
            const x0 = Math.round(bx.x - OX), y0 = Math.round(bx.y - OY);
            const w = Math.round(bx.w), h = Math.round(bx.h);
            const len = mode === 'v' ? h : w;
            const runs = [];
            let prev = null, count = 0;
            for (let i = 0; i < len; i++) {
                const cx = x0 + (mode === 'v' ? w - inset : i);
                const cy = y0 + (mode === 'v' ? i : h - inset);
                if (cx < 0 || cy < 0 || cx >= c.width || cy >= c.height) continue;
                const k = hex((cy * c.width + cx) * 4);
                if (k === prev) { count++; } else { if (prev) runs.push([prev, count]); prev = k; count = 1; }
            }
            if (prev) runs.push([prev, count]);
            return runs.slice(0, 10);
        };
        // count non-background pixels in the v/h strips (thumb visible?)
        const nonBg = (bx, mode, inset) => {
            const x0 = Math.round(bx.x - OX), y0 = Math.round(bx.y - OY);
            const w = Math.round(bx.w), h = Math.round(bx.h);
            const len = mode === 'v' ? h : w;
            let n = 0;
            for (let i = 0; i < len; i++) {
                const cx = x0 + (mode === 'v' ? w - inset : i);
                const cy = y0 + (mode === 'v' ? i : h - inset);
                if (cx < 0 || cy < 0 || cx >= c.width || cy >= c.height) continue;
                const k = hex((cy * c.width + cx) * 4);
                if (k !== '#f8fafc' && k !== '#ffffff' && k !== '#eff2f7') n++;
            }
            return n;
        };
        return JSON.stringify({
            inputV: { runs: strip(boxes.input, 'v', 3), nonBg: nonBg(boxes.input, 'v', 3) },
            inputH: { runs: strip(boxes.input, 'h', 3), nonBg: nonBg(boxes.input, 'h', 3) },
            wrapV: { runs: strip(boxes.wrap, 'v', 3), nonBg: nonBg(boxes.wrap, 'v', 3) },
            wrapH: { runs: strip(boxes.wrap, 'h', 3), nonBg: nonBg(boxes.wrap, 'h', 3) }
        });
    })()`);

    for (const s of [neutral, overInput, overWrap]) {
        const r = await analyze(s);
        console.log('--- ' + s.label + ' ---');
        console.log(r.error || r.value);
    }
    ws.close();
}
main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1); });