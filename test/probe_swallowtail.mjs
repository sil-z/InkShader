// Swallowtail check for a live-stroke band, part 2 — distance ground truth.
//
// band = { p : dist(p, skeleton) <= stroke_width/2 }. This probe builds that
// region directly (dense polyline + per-pixel distance), renders the cache's own
// region the same way, and diffs them. Pixels the cache leaves unfilled but the
// distance says are inside the band are spurious notches — exactly the
// "swallowtail at a bend" the user reports. Canvas `stroke()` is deliberately
// NOT used as the oracle: it fills its own self-intersecting outline with the
// same winding rule and reproduces the same notch.
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { exampleProject, TMP_DIR } from './probe_env.mjs';

const WebSocket = (await import('ws')).default;
const PORT = Number(process.env.PROBE_PORT || 9222);
const SRV = Number(process.env.PROBE_SRV || 8123);
const APP = `http://127.0.0.1:${SRV}/index.html?v=swtl2-${Date.now()}`;
const jsonText = readFileSync(exampleProject('bug_test.json'), 'utf8');

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
if (!tabs.length) { console.log('no page target'); process.exit(1); }
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.alert=()=>{};` });
await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${SRV}`, storageTypes: 'all' }).catch(() => { });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

const out = await evalp(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cv = window.__canvas;
    const cm = cv.curve_manager;
    await cm.loadFromJSON(${JSON.stringify(jsonText)});
    await sleep(1200);

    const sampleSeg = (s, n, out) => {
        for (let i = 1; i <= n; i++) {
            const t = i / n, u = 1 - t;
            const a = u*u*u, b = 3*u*u*t, c2 = 3*u*t*t, d = t*t*t;
            out.push([a*s.p0.x + b*s.p1.x + c2*s.p2.x + d*s.p3.x, a*s.p0.y + b*s.p1.y + c2*s.p2.y + d*s.p3.y]);
        }
    };

    const rows = [];
    for (const c of cm.curveStore.curves) {
        if (!c.startNode || !(c.smart_stroke && c.stroke_width > 0)) continue;
        const hw = c.stroke_width / 2;
        const segs = c.getSkeletonBezierSegments() || [];
        if (!segs.length) continue;

        c.invalidateBooleanCache(); c._booleanEmptyHash = null;
        c.updateBooleanCache();
        const cache = Array.isArray(c.cached_boolean_geometry) ? c.cached_boolean_geometry : [];
        if (!cache.length) { rows.push({ id: c.id, err: 'cache empty' }); continue; }

        const poly = [[segs[0].p0.x, segs[0].p0.y]];
        for (const s of segs) sampleSeg(s, 60, poly);

        // canvas frame
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const acc = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
        for (const [x, y] of poly) acc(x, y);
        const pad = hw * 3; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const scale = 900 / Math.max(maxX - minX, maxY - minY);
        const w = Math.max(8, Math.ceil((maxX - minX) * scale)), h = Math.max(8, Math.ceil((maxY - minY) * scale));

        // distance mask (exact band definition)
        const trueMask = new Uint8Array(w * h);
        let trueFilled = 0;
        for (let py = 0; py < h; py++) {
            const wy = py / scale + minY;
            for (let px = 0; px < w; px++) {
                const wx = px / scale + minX;
                let best = Infinity;
                for (let i = 0; i + 1 < poly.length; i++) {
                    const ax = poly[i][0], ay = poly[i][1], bx = poly[i+1][0], by = poly[i+1][1];
                    const dx = bx - ax, dy = by - ay;
                    const len2 = dx*dx + dy*dy || 1e-9;
                    let t = ((wx - ax)*dx + (wy - ay)*dy) / len2;
                    t = t < 0 ? 0 : t > 1 ? 1 : t;
                    const qx = ax + t*dx, qy = ay + t*dy;
                    const d2 = (wx - qx)*(wx - qx) + (wy - qy)*(wy - qy);
                    if (d2 < best) best = d2;
                }
                let inside = best <= hw * hw;
                if (!inside && c.closed && segs.length >= 2) {
                    // A closed path's region is band ∪ interior (nonzero winding of
                    // the skeleton ring). Without this, every closed path looks like
                    // a huge cache over-fill.
                    let wn = 0;
                    for (let i = 0; i + 1 < poly.length; i++) {
                        const ax = poly[i][0], ay = poly[i][1], bx = poly[i+1][0], by = poly[i+1][1];
                        if (ay <= wy && by > wy) { if ((bx-ax)*(wy-ay) - (wx-ax)*(by-ay) > 0) wn++; }
                        else if (ay > wy && by <= wy) { if ((bx-ax)*(wy-ay) - (wx-ax)*(by-ay) < 0) wn--; }
                    }
                    inside = wn !== 0;
                }
                if (inside) { trueMask[py*w + px] = 1; trueFilled++; }
            }
        }

        // cache mask
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.canvas.width = w; ctx.canvas.height = h;
        ctx.setTransform(scale, 0, 0, scale, -minX*scale, -minY*scale);
        ctx.fillStyle = '#000';
        const cp = new Path2D();
        for (const sub of cache) {
            const sg = sub.segments; if (!sg || sg.length < 2) continue;
            cp.moveTo(sg[0].x, sg[0].y);
            for (let i = 0; i < sg.length; i++) {
                const a2 = sg[i], b2 = sg[(i+1)%sg.length];
                cp.bezierCurveTo(a2.x + (a2.outX||0), a2.y + (a2.outY||0), b2.x + (b2.inX||0), b2.y + (b2.inY||0), b2.x, b2.y);
            }
            cp.closePath();
        }
        ctx.fill(cp, 'nonzero');
        const d = ctx.getImageData(0, 0, w, h).data;
        const cacheMask = new Uint8Array(w * h);
        let cacheFilled = 0;
        for (let i = 0, p = 0; i < d.length; i += 4, p++) { cacheMask[p] = d[i+3] > 127 ? 1 : 0; if (cacheMask[p]) cacheFilled++; }

        // The gesture fallback for an OPEN path: the raw self-intersecting
        // keyhole band, filled with the same nonzero rule. If the fold lobe is
        // wound opposite, this is where a swallowtail notch appears.
        let fallbackMask = null, fallbackFilled = 0;
        if (!c.closed) {
            const rec = [new Path2D()];
            const cur = () => rec[rec.length - 1];
            const recorder = {
                moveTo(x, y) { cur().moveTo(x, y); },
                lineTo(x, y) { cur().lineTo(x, y); },
                bezierCurveTo(a, b, d, e, f, g) { cur().bezierCurveTo(a, b, d, e, f, g); },
                closePath() { cur().closePath(); }
            };
            const outline = c.computeExpandedStrokeOutline(hw);
            if (outline) {
                try {
                    const { emitExpandedStrokeOutline } = await import('/js/core/bezier/path_emitter.js');
                    emitExpandedStrokeOutline(recorder, outline, (x, y) => ({ x, y }), {
                        roundCap: c._expandRoundCap === true, curve: c._expandRoundCap === true ? c : null, halfWidth: c._expandRoundCap === true ? hw : 0
                    });
                    const fctx = document.createElement('canvas').getContext('2d');
                    fctx.canvas.width = w; fctx.canvas.height = h;
                    fctx.setTransform(scale, 0, 0, scale, -minX*scale, -minY*scale);
                    fctx.fillStyle = '#000';
                    fctx.fill(rec[0], 'nonzero');
                    const fd = fctx.getImageData(0, 0, w, h).data;
                    fallbackMask = new Uint8Array(w * h);
                    for (let i = 0, p = 0; i < fd.length; i += 4, p++) { fallbackMask[p] = fd[i+3] > 127 ? 1 : 0; if (fallbackMask[p]) fallbackFilled++; }
                } catch (_) { fallbackMask = null; }
            }
        }
        const diffMasks = (mask, label) => {
            const miss = new Uint8Array(w * h);
            let missPx = 0, extraPx = 0;
            for (let p = 0; p < w*h; p++) { if (trueMask[p] && !mask[p]) { miss[p] = 1; missPx++; } else if (!trueMask[p] && mask[p]) extraPx++; }
            let clusters = 0, largest = 0;
            for (let p = 0; p < w*h; p++) {
                if (!miss[p]) continue;
                clusters++; let size = 0; const st = [p]; miss[p] = 0;
                while (st.length) {
                    const a = st.pop(); size++;
                    const x = a % w, y = (a - x) / w;
                    const nb = [x>0?a-1:-1, x<w-1?a+1:-1, y>0?a-w:-1, y<h-1?a+w:-1];
                    for (const q of nb) if (q >= 0 && miss[q]) { miss[q] = 0; st.push(q); }
                }
                if (size > largest) largest = size;
            }
            return { misses: missPx, extras: extraPx, clusters, largest };
        };
        const cacheDiff = diffMasks(cacheMask);
        const fbDiff = fallbackMask ? diffMasks(fallbackMask) : null;
        // diff: pixels inside the band that the cache leaves empty = notches
        const miss = new Uint8Array(w * h);
        let missPx = 0, extraPx = 0;
        for (let p = 0; p < w*h; p++) { if (trueMask[p] && !cacheMask[p]) { miss[p] = 1; missPx++; } else if (!trueMask[p] && cacheMask[p]) extraPx++; }
        // cluster the notches and report the largest ones' span (a bend notch is local)
        let clusters = 0, largest = 0;
        for (let p = 0; p < w*h; p++) {
            if (!miss[p]) continue;
            clusters++; let size = 0; const st = [p]; miss[p] = 0;
            let cminx=Infinity,cminy=Infinity,cmaxx=-Infinity,cmaxy=-Infinity;
            while (st.length) {
                const a = st.pop(); size++;
                const x = a % w, y = (a - x) / w;
                if (x<cminx)cminx=x; if(x>cmaxx)cmaxx=x; if(y<cminy)cminy=y; if(y>cmaxy)cmaxy=y;
                const nb = [x>0?a-1:-1, x<w-1?a+1:-1, y>0?a-w:-1, y<h-1?a+w:-1];
                for (const q of nb) if (q >= 0 && miss[q]) { miss[q] = 0; st.push(q); }
            }
            if (size > largest) largest = size;
        }
        rows.push({ id: c.id, closed: !!c.closed, hw, raster: { w, h }, trueFilled, cacheFilled,
            missPx, extraPx, missPctOfBand: trueFilled ? Math.round(missPx / trueFilled * 1000) / 10 : 0,
            notches: clusters, largestNotchPx: largest,
            cacheDiff, fallbackFilled, fallbackDiff: fbDiff });
    }
    return rows;
})()`);

if (out && out.__exc) { console.log('threw: ' + out.__exc); process.exit(1); }
const rows = out || [];
const checks = [{ name: 'measured smart stroke curves', ok: rows.length > 0 }];
for (const r of rows) {
    if (r.err) { checks.push({ name: `${r.id}: ${r.err}`, ok: false }); continue; }
    // Boundary rounding makes misses ≈ extras spread over many 1px clusters. A
    // swallowtail is the opposite signature: a CONCENTRATED missing blob with no
    // compensating over-fill.
    const areaTol = Math.max(120, r.trueFilled * 0.02);
    const notchTol = Math.max(60, r.trueFilled * 0.005);
    checks.push({
        name: `${r.id}: cache region == distance band (miss ${r.cacheDiff.misses} extra ${r.cacheDiff.extras} of ${r.trueFilled})`,
        ok: Math.abs(r.cacheDiff.misses - r.cacheDiff.extras) <= areaTol
    });
    checks.push({
        name: `${r.id}: no swallowtail notch (largest missing cluster ${r.cacheDiff.largest}px, tol ${Math.round(notchTol)})`,
        ok: r.cacheDiff.largest <= notchTol
    });
    if (r.fallbackDiff) {
        checks.push({
            name: `${r.id}: gesture fallback region == distance band (miss ${r.fallbackDiff.misses} extra ${r.fallbackDiff.extras})`,
            ok: Math.abs(r.fallbackDiff.misses - r.fallbackDiff.extras) <= areaTol
        });
        checks.push({
            name: `${r.id}: gesture fallback has no swallowtail notch (largest ${r.fallbackDiff.largest}px)`,
            ok: r.fallbackDiff.largest <= notchTol
        });
    }
}
try { writeFileSync(path.join(TMP_DIR, 'swallowtail.json'), JSON.stringify({ rows, checks }, null, 2)); } catch { /* diag */ }
for (const r of rows) {
    if (r.err) { console.log('=== ' + r.id + ' ERR ' + r.err); continue; }
    console.log('=== ' + r.id + ' closed=' + r.closed + ' hw=' + r.hw + ' truth=' + r.trueFilled + 'px');
    console.log('    cache   : filled=' + r.cacheFilled + '  missing=' + r.cacheDiff.misses + 'px  extra=' + r.cacheDiff.extras + 'px  clusters=' + r.cacheDiff.clusters + ' largest=' + r.cacheDiff.largest);
    if (r.fallbackDiff) console.log('    fallback: filled=' + r.fallbackFilled + '  missing=' + r.fallbackDiff.misses + 'px  extra=' + r.fallbackDiff.extras + 'px  clusters=' + r.fallbackDiff.clusters + ' largest=' + r.fallbackDiff.largest);
}
console.log(JSON.stringify({ tag: 'swallowtail', checks }, null, 2));
ws.close();
process.exit(checks.some(c => !c.ok) ? 1 : 0);
