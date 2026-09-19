// Advance-divider drag regression suite.
//
// Dragging the divider between two glyphs must do exactly one of two things,
// depending on which glyph is active, and both must look identical to the user
// (the divider follows the mouse):
//
//   LEFT active  ("RSB"): the left glyph's advance grows by d; no coordinate is
//                         edited — the right side is displaced by layout only;
//                         the view stays put (the ruler does not move).
//   RIGHT active ("LSB"): the right glyph's nodes shift by -d and its advance
//                         shrinks by d, so its ink and everything after it stay
//                         put on screen; the view pans by +dx so the divider
//                         still follows the mouse (ruler + left side move right).
//
// Every case asserts the same four things: the divider tracks the mouse, the
// active side bearing is the only property that changed, no unrelated
// coordinate moved, and the edit is undoable. Cases run twice — once on the
// first-time listener registration and once after a dock-move reconnect —
// because the two registration paths used to carry divergent copies.
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync, writeFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('divider_probe.json');
copyFileSync(SRC, TMP);                              // never write the user's file
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();
const APP = process.env.APP_URL || `http://127.0.0.1:${SRV}/index.html?v=divider-${Date.now()}`;

const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
for (const t of tabs.slice(0, -1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
const tab = tabs[tabs.length - 1];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map(); const dialogs = []; const consoleErrors = [];
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(m.params && m.params.message);
        ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 240));
    }
});
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    const ex = r.result?.exceptionDetails;
    if (ex) return { __exc: (ex.exception?.description || ex.text || '').slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null;' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await new Promise(r => setTimeout(r, 7000));

// ---------------------------------------------------------------- in-page toolkit
const toolkit = `(() => {
    const cv = () => window.__canvas;
    const cm = () => window.__canvas.curve_manager;
    const gidOf = (i) => {
        const t = (cm().sequenceTokens || [])[i];
        if (!t) return null;
        return t.isChar ? cm().getDefaultGroupForChar(t.value) : t.value;
    };
    const walk = (curve, fn) => {
        let n = curve && curve.startNode; const seen = new Set(); let guard = 0;
        while (n && !seen.has(n) && guard++ < 20000) { seen.add(n); fn(n); n = n.nextOnCurve; }
    };
    const nodeXs = (gid) => {
        const xs = [];
        let curves = [];
        try { curves = cm().getCurvesForGroup(gid) || []; } catch (e) { curves = []; }
        for (const cd of curves) walk(cd.curve, (n) => xs.push(+n.x.toFixed(6)));
        return xs.sort((a, b) => a - b);
    };
    window.__pb = {
        gidOf,
        state() {
            const c = cv(), m = cm();
            const off = c.utils.getLogicalOffset();
            const toks = m.sequenceTokens || [];
            const store = c.commandHostPort?.getStoreState?.() || {};
            const items = toks.map((t, i) => {
                const gid = gidOf(i);
                const g = m.treeItems.get(gid);
                const adv = g && g.advance !== undefined ? g.advance : null;
                const xs = nodeXs(gid);
                const so = m.getSeqOffset(i);
                return {
                    token: t.isChar ? t.value : t.name,
                    gid,
                    advance: adv,
                    seqOffset: +so.toFixed(6),
                    nodeXs: xs,
                    inkLeftScreen: +(((xs.length ? xs[0] : 0) + so) * c.scale + off.x).toFixed(6),
                    divLeftScreen: +(so * c.scale + off.x).toFixed(6),
                    divRightScreen: +(((so + (adv || 0)) * c.scale) + off.x).toFixed(6)
                };
            });
            return {
                scale: +c.scale.toFixed(9),
                offX: +off.x.toFixed(6),
                activeGroupId: store.activeGroupId ?? m.activeGroupId ?? null,
                tool: store.currentTool ?? null,
                items
            };
        },
        /** Read each curve's cached bounds, then a forced recomputation. A drag that
         *  forgot to invalidate shows up as cached != fresh. */
        boundsFresh(gid) {
            const out = [];
            for (const cd of (cm().getCurvesForGroup(gid) || [])) {
                const curve = cd.curve;
                if (!curve) continue;
                const cached = curve.getBounds();
                const cachedMinX = cached ? +cached.minX.toFixed(6) : null;
                const cachedMaxX = cached ? +cached.maxX.toFixed(6) : null;
                curve._invalidateBounds?.();
                const fresh = curve.getBounds();
                out.push({
                    cachedMinX, cachedMaxX,
                    freshMinX: fresh ? +fresh.minX.toFixed(6) : null,
                    freshMaxX: fresh ? +fresh.maxX.toFixed(6) : null
                });
            }
            return out;
        },
        points(which) {
            const c = cv(), m = cm();
            const off = c.utils.getLogicalOffset();
            const rect = c.canvasObj.getBoundingClientRect();
            const u = c.viewportService.getCanvasUserSpaceSize();
            const toClient = (ux, uy) => ({
                x: rect.left + ux * (rect.width / u.width),
                y: rect.top + uy * (rect.height / u.height)
            });
            const last = (m.sequenceTokens || []).length - 1;
            const it = window.__pb.state().items;
            const asc = c.fontSettings?.ascender ?? 800;
            const desc = c.fontSettings?.descender ?? -200;
            const sheet = (asc - desc) * c.scale;
            let ux, expect;
            if (which === 'leftmost') { ux = it[0].divLeftScreen; expect = it[0].gid + '-0-l'; }
            else if (which === 'between') { ux = it[1].divLeftScreen; expect = it[1].gid + '-1-l'; }
            else { ux = it[last].divRightScreen; expect = it[last].gid + '-' + last + '-r'; }
            // A curve under the cursor wins over the divider, so pick a point on the
            // divider that has no ink on it (the originals' ink can sit anywhere).
            const probe = (y) => ({
                y,
                curve: !!c.utils.hitTestCurve(ux, y),
                node: !!c.utils.hitTestNode(ux, y)
            });
            const cands = [0.12, 0.3, 0.5, 0.7, 0.88].map(f => probe(off.y + sheet * f));
            const clean = cands.find(p => !p.curve && !p.node) || cands[0];
            const hit = c.utils.hitTestDividerLines(ux, clean.y);
            return {
                client: toClient(ux, clean.y), ux, y: clean.y, expect, curveFree: !clean.curve && !clean.node,
                hit: hit ? (hit.groupId + '-' + hit.seqIndex + (hit.isLeftEdge ? '-l' : '-r')) : null
            };
        },
        prepare(activeIdx) {
            const c = cv(), m = cm();
            if (activeIdx !== null) {
                const gid = gidOf(activeIdx);
                c.commands.setActiveGroup(gid);
            }
            const it = window.__pb.state().items;
            const u = c.viewportService.getCanvasUserSpaceSize();
            const maxX = it[it.length - 1].seqOffset + it[it.length - 1].advance;
            c.scale = Math.min(1, (u.width * 0.7) / Math.max(1, maxX));
            c.offset.x = u.width / 2 - (maxX / 2) * c.scale - c.ruler_size;
            c.offset.y = u.height / 2 - ((c.fontSettings?.ascender ?? 800) * c.scale) / 2 - c.ruler_size;
            c.is_dirty = true;
            const st = window.__pb.state();
            return { activeGroupId: st.activeGroupId, wantActive: activeIdx === null ? null : gidOf(activeIdx), tokens: st.items.length };
        },
        reconnect() {
            // Exactly what MainCanvas.connectedCallback(gen>1) does after a dock move.
            const c = cv();
            (c.globalEventTrackers || []).forEach((f) => { try { f(); } catch (e) {} });
            c.globalEventTrackers = [];
            c.canvasInputController.bind();
        },
        undo() {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
        },
        setTool(digit) {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit' + digit, bubbles: true, cancelable: true }));
        }
    };
    return true;
})()`;
await evalp(toolkit);

const STATE = 'window.__pb.state()';

const drag = async (which, dx, steps = 4) => {
    const pts = await evalp(`window.__pb.points(${JSON.stringify(which)})`);
    if (!pts || pts.__exc) return { error: 'points', pts };
    const { client } = pts;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: client.x, y: client.y, button: 'left', clickCount: 1 });
    const during = [];
    for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: client.x + (dx * i) / steps, y: client.y, button: 'left', buttons: 1
        });
        await new Promise(r => setTimeout(r, 120));
        during.push(await evalp(STATE));
    }
    await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: client.x + dx, y: client.y, button: 'left', clickCount: 1
    });
    await new Promise(r => setTimeout(r, 400));
    return { pts, during, after: await evalp(STATE) };
};

// ---------------------------------------------------------------- checks
const checks = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const chk = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const shifted = (before, after, d, tol = 0.05) =>
    before.length === after.length && before.every((x, i) => near(after[i], x + d, tol));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * mode: 'left' | 'right' | 'last'  — which side bearing the drag must change.
 * divider: 'leftmost' | 'between' | 'rightmost'
 */
const runCase = async ({ label, divider, activeIdx, mode, dx = 40, reconnected = false, undo = false, reverseDrag = false }) => {
    const prep = await evalp(`(async () => {
        const cv = window.__canvas;
        await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
        await new Promise(r => setTimeout(r, 2500));
        return window.__pb.prepare(${activeIdx});
    })()`);
    if (!prep || prep.__exc) { chk(`${label}: setup`, false, JSON.stringify(prep)); return; }
    chk(`${label}: active glyph is the expected one`, prep.activeGroupId === prep.wantActive,
        `active=${prep.activeGroupId} want=${prep.wantActive}`);
    if (reconnected) await evalp('(window.__pb.reconnect(), true)');
    await evalp(`(window.__pb.setTool('2'), true)`);          // NODE tool: divider drag enabled
    await new Promise(r => setTimeout(r, 300));

    const before = await evalp(STATE);
    const pts = await evalp(`window.__pb.points(${JSON.stringify(divider)})`);
    if (!pts || pts.__exc) { chk(`${label}: divider hit-test`, false, JSON.stringify(pts)); return; }
    chk(`${label}: divider is hit at its rendered position`, pts.hit === pts.expect, `hit=${pts.hit} expect=${pts.expect}`);
    chk(`${label}: drag point has no ink (so the divider owns the mousedown)`, pts.curveFree === true, `curveFree=${pts.curveFree}`);

    const res = await drag(divider, dx);
    const after = res.after;
    if (!after || after.__exc) { chk(`${label}: state after drag`, false, JSON.stringify(after)); return; }

    const dragIdx = divider === 'rightmost' ? before.items.length - 1 : (divider === 'between' ? 1 : 0);
    const divBefore = divider === 'rightmost' ? before.items[dragIdx].divRightScreen : before.items[dragIdx].divLeftScreen;
    const divAfter = divider === 'rightmost' ? after.items[dragIdx].divRightScreen : after.items[dragIdx].divLeftScreen;
    // Model expectations follow the divider's own displacement: the drag anchors on the
    // divider's rendered x, so a sub-pixel error in the synthetic click lands there too.
    const dxEff = divAfter - divBefore;
    const d = dxEff / before.scale;
    chk(`${label}: divider follows the mouse`, near(dxEff, dx, 2), `${divBefore} -> ${divAfter} (dx=${dx})`);

    // Subject = the glyph whose side bearing this drag must edit. For the leftmost
    // divider there is no left glyph, so index 0 plays the "right" role instead.
    const lastIdx = before.items.length - 1;
    const subIdx = mode === 'last' ? lastIdx
        : mode === 'left' ? (divider === 'rightmost' ? lastIdx : dragIdx - 1)
        : (divider === 'leftmost' ? 0 : dragIdx);
    const otherIdx = divider === 'between' ? (subIdx === 0 ? 1 : 0) : null;
    const sub = { b: before.items[subIdx], a: after.items[subIdx] };
    const oth = otherIdx === null ? null : { b: before.items[otherIdx], a: after.items[otherIdx] };
    const subHasInk = sub.b.nodeXs.length > 0;

    if (mode === 'left') {
        chk(`${label}: subject advance += d`, near(sub.a.advance, sub.b.advance + d, 0.05),
            `${sub.b.advance} -> ${sub.a.advance} (d=${d.toFixed(3)})`);
        chk(`${label}: no node coordinate edited`, shifted(sub.b.nodeXs, sub.a.nodeXs, 0, 1e-6),
            `by=${JSON.stringify(sub.b.nodeXs.slice(0, 2))} -> ${JSON.stringify(sub.a.nodeXs.slice(0, 2))}`);
        chk(`${label}: view (ruler) did not move`, near(after.offX, before.offX, 1e-6), `${before.offX} -> ${after.offX}`);
        chk(`${label}: subject stays put on screen`, near(sub.a.inkLeftScreen, sub.b.inkLeftScreen, 1.5),
            `${sub.b.inkLeftScreen} -> ${sub.a.inkLeftScreen}`);
        if (oth) {
            chk(`${label}: other glyph untouched (model)`,
                oth.a.advance === oth.b.advance && shifted(oth.b.nodeXs, oth.a.nodeXs, 0, 1e-6),
                `advance ${oth.b.advance} -> ${oth.a.advance}`);
            chk(`${label}: other glyph displaced by layout alone (+dxEff)`,
                near(oth.a.inkLeftScreen, oth.b.inkLeftScreen + dxEff, 1.5),
                `${oth.b.inkLeftScreen} -> ${oth.a.inkLeftScreen} (dxEff=${dxEff.toFixed(2)})`);
        }
    } else if (mode === 'right') {
        chk(`${label}: subject outline shifts by -d`, shifted(sub.b.nodeXs, sub.a.nodeXs, -d),
            `d=${d.toFixed(3)} ${JSON.stringify(sub.b.nodeXs.slice(0, 3))} -> ${JSON.stringify(sub.a.nodeXs.slice(0, 3))}`);
        chk(`${label}: subject advance -= d`, near(sub.a.advance, sub.b.advance - d, 0.05),
            `${sub.b.advance} -> ${sub.a.advance}`);
        chk(`${label}: view pans by +dxEff so the divider still follows`, near(after.offX, before.offX + dxEff, 0.05),
            `${before.offX} -> ${after.offX} (dxEff=${dxEff.toFixed(2)})`);
        if (subHasInk) {
            chk(`${label}: subject outline stays put on screen`,
                near(sub.a.inkLeftScreen, sub.b.inkLeftScreen, 1.5), `${sub.b.inkLeftScreen} -> ${sub.a.inkLeftScreen}`);
        }
        if (oth) {
            chk(`${label}: other glyph untouched (model)`,
                oth.a.advance === oth.b.advance && shifted(oth.b.nodeXs, oth.a.nodeXs, 0, 1e-6),
                `advance ${oth.b.advance} -> ${oth.a.advance}`);
            chk(`${label}: other glyph moves with the ruler (+dxEff)`,
                near(oth.a.inkLeftScreen, oth.b.inkLeftScreen + dxEff, 1.5),
                `${oth.b.inkLeftScreen} -> ${oth.a.inkLeftScreen} (dxEff=${dxEff.toFixed(2)})`);
        }
        if (subHasInk) {
            const fresh = await evalp(`window.__pb.boundsFresh(${JSON.stringify(sub.b.gid)})`);
            chk(`${label}: geometry caches invalidated (bounds match a fresh read)`,
                !!fresh && !fresh.__exc && fresh.every(f => Math.abs(f.cachedMinX - f.freshMinX) < 1e-6 && Math.abs(f.cachedMaxX - f.freshMaxX) < 1e-6),
                JSON.stringify(fresh));
        }
        if (divider === 'leftmost') {
            const next = { b: before.items[1], a: after.items[1] };
            // Its model offset does drop by d (the subject's advance shrank); the view
            // pan cancels it, so what must not change is its place on screen.
            chk(`${label}: everything right of the divider stays put on screen`,
                near(next.a.inkLeftScreen, next.b.inkLeftScreen, 1.5),
                `origin ${next.b.inkLeftScreen} -> ${next.a.inkLeftScreen}, seqOffset ${next.b.seqOffset} -> ${next.a.seqOffset}`);
        }
    } else {
        chk(`${label}: last advance += d`, near(sub.a.advance, sub.b.advance + d, 0.05),
            `${sub.b.advance} -> ${sub.a.advance} (d=${d.toFixed(3)})`);
        chk(`${label}: no node coordinate edited`, shifted(sub.b.nodeXs, sub.a.nodeXs, 0, 1e-6));
        chk(`${label}: view (ruler) did not move`, near(after.offX, before.offX, 1e-6), `${before.offX} -> ${after.offX}`);
        chk(`${label}: subject stays put on screen`, near(sub.a.inkLeftScreen, sub.b.inkLeftScreen, 1.5),
            `${sub.b.inkLeftScreen} -> ${sub.a.inkLeftScreen}`);
    }

    const lastFrame = res.during && res.during[res.during.length - 1];
    if (lastFrame && !lastFrame.__exc) {
        chk(`${label}: released state keeps the dragged value`,
            same(lastFrame.items.map(i => [i.advance, i.seqOffset]), after.items.map(i => [i.advance, i.seqOffset])),
            `during=${JSON.stringify(lastFrame.items.map(i => i.advance))} after=${JSON.stringify(after.items.map(i => i.advance))}`);
    }

    if (reverseDrag) {
        // A second drag in the opposite direction must start from the committed
        // state (no leaked origin snapshot, no leaked offset) and land back where
        // it started, because the gesture anchors on the divider itself.
        // Each drag anchors on the divider's rendered x, so a round trip can miss by
        // up to a pixel; anything larger means state leaked between the two gestures.
        const back = await drag(divider, -dx);
        const reverted = back.after;
        const tol = 1.5 / before.scale;
        const roundTrip = !!reverted && !reverted.__exc && reverted.items.every((it, i) =>
            Math.abs(it.advance - before.items[i].advance) <= tol &&
            it.nodeXs.every((x, k) => Math.abs(x - before.items[i].nodeXs[k]) <= tol));
        chk(`${label}: reverse drag returns to the starting document`, roundTrip,
            `advances ${JSON.stringify(reverted && reverted.items && reverted.items.map(i => i.advance))} vs ${JSON.stringify(before.items.map(i => i.advance))}`);
    }

    if (undo) {
        const times = reverseDrag ? 2 : 1;
        for (let i = 0; i < times; i++) {
            await evalp('(window.__pb.undo(), true)');
            await new Promise(r => setTimeout(r, 900));
        }
        const un = await evalp(STATE);
        const tol = 1.5 / before.scale;
        const restored = !!un && !un.__exc && un.items.every((it, i) =>
            Math.abs(it.advance - before.items[i].advance) <= tol &&
            it.nodeXs.every((x, k) => Math.abs(x - before.items[i].nodeXs[k]) <= tol));
        chk(`${label}: undo restores advances and coordinates`, restored,
            `before=${JSON.stringify(before.items.map(i => i.advance))} afterUndo=${JSON.stringify(un && un.items && un.items.map(i => i.advance))}`);
    }
    return { before, after, points: pts };
};

// ---------------------------------------------------------------- run
const results = {};
results.betweenLeft = await runCase({ label: 'between/left-active', divider: 'between', activeIdx: 0, mode: 'left', undo: true, reverseDrag: true });
results.betweenRight = await runCase({ label: 'between/right-active', divider: 'between', activeIdx: 1, mode: 'right', undo: true, reverseDrag: true });
results.betweenNone = await runCase({ label: 'between/no-active', divider: 'between', activeIdx: null, mode: 'left' });
results.leftmost = await runCase({ label: 'leftmost/no-active', divider: 'leftmost', activeIdx: null, mode: 'right', undo: true });
results.leftmostActive = await runCase({ label: 'leftmost/first-active', divider: 'leftmost', activeIdx: 0, mode: 'right' });
results.rightmost = await runCase({ label: 'rightmost/last-active', divider: 'rightmost', activeIdx: 1, mode: 'last' });
results.betweenLeftReconnect = await runCase({ label: 'between/left-active after reconnect', divider: 'between', activeIdx: 0, mode: 'left', reconnected: true });
results.betweenRightReconnect = await runCase({ label: 'between/right-active after reconnect', divider: 'between', activeIdx: 1, mode: 'right', reconnected: true });
results.leftmostReconnect = await runCase({ label: 'leftmost/no-active after reconnect', divider: 'leftmost', activeIdx: null, mode: 'right', reconnected: true });

const failed = checks.filter(c => !c.ok);
writeFileSync(tmpFile('divider_probe_checks.json'), JSON.stringify({ checks, results, dialogs, consoleErrors }, null, 2));
console.log(JSON.stringify({ tag: 'divider-drag', checks: checks.length, failed: failed.length, dialogs, consoleErrors: consoleErrors.slice(-5) }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '   [' + c.detail + ']' : ''}`);
console.log('\n--- raw ---');
console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(failed.length ? 1 : 0);
