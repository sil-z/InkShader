// Supersampling comparison: render the SAME sample text two ways on equal-size
// logical canvases —
//   OLD path: drawSampleTextPreview directly at 1x (what the panel did pre-fix)
//   NEW path: draw at 4x into an offscreen canvas, then high-quality downscale
// Metric: distinct intermediate alpha bins (anti-aliasing richness) — jagged
// edges quantize coverage to ~1-2 alpha levels; smooth edges spread it out.
// Also saves PNGs for visual confirmation.
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
    await send('Page.navigate', { url: 'http://localhost:8123/?v=ss-1' });
    await new Promise(r => setTimeout(r, 3500));

    const probe = `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const cv = document.querySelector('main-canvas');
        window.confirm = () => true;
        localStorage.removeItem('inkshader_sample_panel_state');
        const resp = await fetch('/test/InkShader_project_2026-08-02T16-27-25.json');
        await cv.projectManager.loadFromFile(await resp.text());
        await sleep(800);
        if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;
        await sleep(300);
        const EM = await import('./js/app/editor_read_facade.js');
        const state = EM.getSampleTextPanelState();
        // Fixture has real outlines for A-E only; auto-created groups are empty
        // (the earlier fox text rendered NO ink — its letters don't exist).
        const TEXT = 'ABCDE';
        const SS = 4;
        const ow = 281, oh = 68;
        const m = EM.measureSampleTextPreview(TEXT, { kerning: false, width: ow, fontSize: 48 });

        const metrics = (ctx, W, H) => {
            const d = ctx.getImageData(0, 0, W, H).data;
            const bins = new Set();
            let ink = 0;
            for (let i = 3; i < d.length; i += 4) {
                const a = d[i];
                if (a > 0) { ink++; if (a < 255) bins.add(a); }
            }
            return { ink, midAlphaBins: bins.size };
        };

        const opts = {
            kerning: false, guides: false,
            fontSize: 48
        };

        // OLD: direct 1x render
        const oldC = document.createElement('canvas');
        oldC.width = ow; oldC.height = oh;
        const octx = oldC.getContext('2d');
        EM.drawSampleTextPreview(octx, TEXT, { ...opts, width: ow, height: oh });

        // NEW: 4x offscreen + high-quality downscale
        const newC = document.createElement('canvas');
        newC.width = ow; newC.height = oh;
        const nctx = newC.getContext('2d');
        const ssC = document.createElement('canvas');
        ssC.width = ow * SS; ssC.height = oh * SS;
        const sctx = ssC.getContext('2d');
        sctx.setTransform(SS, 0, 0, SS, 0, 0);
        EM.drawSampleTextPreview(sctx, TEXT, { ...opts, width: ow, height: oh });
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = 'high';
        nctx.drawImage(ssC, 0, 0, ow, oh);

        const rOld = metrics(octx, ow, oh);
        const rNew = metrics(nctx, ow, oh);

        // Edge staircase metric: count "jump" transitions along ink boundaries.
        // A jagged diagonal alternates 1px steps (many boundary jumps); a smooth
        // edge changes less abruptly per row. Count per-row ink-column boundary
        // jumps > 1 px on the LEFT edge of the first ink column.
        const staircase = (ctx, W, H) => {
            const d = ctx.getImageData(0, 0, W, H).data;
            let jumps = 0, rows = 0, prevLeft = -1;
            for (let y = 0; y < H; y++) {
                let left = -1;
                for (let x = 0; x < W; x++) {
                    if (d[(y * W + x) * 4 + 3] > 128) { left = x; break; }
                }
                if (left >= 0) {
                    if (prevLeft >= 0 && Math.abs(left - prevLeft) > 1) jumps++;
                    prevLeft = left;
                    rows++;
                } else { prevLeft = -1; }
            }
            return { jumps, rows };
        };
        const sOld = staircase(octx, ow, oh);
        const sNew = staircase(nctx, ow, oh);

        // ASCII render of the 'A' left diagonal (crop, 8-aligned grid): lets us SEE
        // the staircase (hard steps) vs the smoothed ramp directly.
        const ascii = (ctx, x0, y0, w, h) => {
            const d = ctx.getImageData(x0, y0, w, h).data;
            const chars = ' .:*#';
            let out = '';
            for (let y = 0; y < h; y++) {
                let line = '';
                for (let x = 0; x < w; x++) {
                    const a = d[(y * w + x) * 4 + 3];
                    line += chars[Math.min(4, Math.floor(a / 64))];
                }
                out += line + '\\n';
            }
            return out;
        };
        const crop = { x: 30, y: 10, w: 24, h: 30 };
        const asciiOld = ascii(octx, crop.x, crop.y, crop.w, crop.h);
        const asciiNew = ascii(nctx, crop.x, crop.y, crop.w, crop.h);

        const pngOld = 'data:image/png;base64,' + oldC.toDataURL('image/png').split(',')[1];
        const pngNew = 'data:image/png;base64,' + newC.toDataURL('image/png').split(',')[1];
        return JSON.stringify({
            measured: m ? { rows: m.rows, h: m.contentHeight, w: m.maxRowWidthPx } : null,
            old: { ...rOld, ...sOld },
            new: { ...rNew, ...sNew },
            asciiOld, asciiNew,
            pngOld, pngNew
        });
    })()`;

    const r = await send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
        console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
        ws.close();
        return;
    }
    const v = JSON.parse(r.result.result.value);
    const { pngOld, pngNew, ...rest } = v;
    console.log('SS:', JSON.stringify(rest));
    fs.writeFileSync('C:/Users/z/Desktop/InkShader/InkShader/test/ss_old.png', Buffer.from(pngOld, 'base64'));
    fs.writeFileSync('C:/Users/z/Desktop/InkShader/InkShader/test/ss_new.png', Buffer.from(pngNew, 'base64'));
    ws.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });