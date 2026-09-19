// Delete segment — chain-level assertions.
//
// The command used to be "verified" by comparing a coarse group summary before
// and after, which cannot tell a correct break from a mangled one. This suite
// asserts the break invariant directly, on a real project and through the real
// selection path:
//
//   Opening a closed path must place the gap exactly at the deleted segment.
//   The two nodes of that segment become the ends of the now-open path, every
//   other link stays a real segment, and no node leaves the chain.
//
// Two cases:
//   A. select two adjacent nodes mid-chain  → start=trail, end=lead
//   B. select the wrap pair (last, first)   → start/end unchanged
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';

const SRC = exampleProject();
const TMP = tmpFile('del_seg_chain_probe.json');
copyFileSync(SRC, TMP);
const projectJson = readFileSync(TMP, 'utf-8');
const { port: PORT, srv: SRV } = probePorts();

for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page')) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 800) };
    return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm=()=>true; window.prompt=()=>null; window.alert=()=>{};' });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?v=delsegchain-${Date.now()}` });
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await evalp('!!window.__canvas')) break;
}
await new Promise(r => setTimeout(r, 2000));

const out = await evalp(`(async () => {
    const cv = window.__canvas, cm = cv.curve_manager;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const res = { steps: [], cases: {} };
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await sleep(2500);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    await sleep(400);

    const mod = await import('/js/app/canvas_dispatcher.js');
    const chain = (c) => { const a = []; let n = c.startNode; const seen = new Set(); while (n && !seen.has(n)) { seen.add(n); a.push(n); n = n.nextOnCurve; } return a; };
    const ids = (a) => a.map(n => n.id);
    const linksIntact = (a) => a.every((n, i) => {
        const nx = a[(i + 1) % a.length];
        if (i === a.length - 1) return true;             // last link checked by case logic
        return n.nextOnCurve === nx && nx.lastOnCurve === n;
    });

    // Find a glyph whose active group has a closed curve with >= 4 nodes.
    let pick = null;
    for (const tok of (cm.sequenceTokens || [])) {
        const gid = tok.isChar ? cm.getDefaultGroupForChar(tok.value) : tok.value;
        if (!gid) continue;
        cv.commands.setActiveGroup(gid);
        await sleep(120);
        let curves = [];
        try { curves = cm.getCurvesForGroup(gid) || []; } catch { curves = []; }
        const found = curves.map(cd => cd.curve).find(c => c.closed && chain(c).length >= 4);
        if (found) { pick = { gid, token: tok.value, curveId: found.id }; break; }
    }
    if (!pick) return { error: 'no-closed-curve-with-4-nodes' };
    res.pick = pick;

    const runCase = async (label, pickPair) => {
        cv.commands.setActiveGroup(pick.gid);
        await sleep(200);
        let curve = (cm.getCurvesForGroup(pick.gid) || []).map(cd => cd.curve).find(c => c.id === pick.curveId);
        if (!curve) return { error: 'curve-vanished' };
        const before = chain(curve);
        const gidCurveCountBefore = (cm.getCurvesForGroup(pick.gid) || []).length;
        const selected = pickPair(before);
        res.steps.push({ label, id: curve.id, selected: ids(selected), beforeCount: before.length });

        mod.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: selected.map(n => n.main_node && n.main_node.id) });
        await sleep(500);
        const ret = cv.commands.deleteSegmentBetweenNodes();
        await sleep(500);

        let afterCurves = [];
        try { afterCurves = cm.getCurvesForGroup(pick.gid) || []; } catch { afterCurves = []; }
        const main = afterCurves.map(cd => cd.curve).find(c => c.id === pick.curveId) || null;
        const after = main ? chain(main) : [];
        const lead = selected[0], trail = selected[1];

        return {
            ret: ret === undefined ? 'undefined' : ret,
            closed: main ? !!main.closed : null,
            start: main && main.startNode ? main.startNode.id : null,
            end: main && main.endNode ? main.endNode.id : null,
            expectStart: trail.id, expectEnd: lead.id,
            countBefore: before.length, countAfter: after.length,
            curveCountDelta: afterCurves.length - gidCurveCountBefore,
            goneLink: lead.nextOnCurve === trail,
            leadNextNull: lead.nextOnCurve === null,
            trailLastNull: trail.lastOnCurve === null,
            allNodesPresent: before.every(n => after.includes(n)),
            linksIntact: linksIntact(after),
            afterIds: ids(after),
            beforeIds: ids(before),
        };
    };

    // Case A: two adjacent nodes mid-chain (index 0 and 1 of the chain).
    res.cases.A_midChain = await runCase('A_midChain', (before) => [before[0], before[1]]);

    // Case B: the wrap pair — last node and first node, i.e. the wrap segment.
    // Start/end must stay put: the gap is already where the chain wraps.
    await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
    await sleep(2500);
    cv.commands.setActiveGroup(pick.gid);
    await sleep(300);
    let c2 = (cm.getCurvesForGroup(pick.gid) || []).map(cd => cd.curve).find(c => c.id === pick.curveId);
    if (c2) {
        const b = chain(c2);
        const gidCountBefore = (cm.getCurvesForGroup(pick.gid) || []).length;
        const wrapLead = b[b.length - 1], wrapTrail = b[0];
        const startIdBefore = c2.startNode.id, endIdBefore = c2.endNode.id;
        mod.CanvasDispatcher.requestChangeNodeSelection('replace', { markerIds: [wrapLead.main_node.id, wrapTrail.main_node.id] });
        await sleep(500);
        const ret = cv.commands.deleteSegmentBetweenNodes();
        await sleep(500);
        const afterCurves = cm.getCurvesForGroup(pick.gid) || [];
        const main = afterCurves.map(cd => cd.curve).find(c => c.id === pick.curveId) || null;
        const a = main ? chain(main) : [];
        res.cases.B_wrapPair = {
            ret: ret === undefined ? 'undefined' : ret,
            closed: main ? !!main.closed : null,
            start: main && main.startNode ? main.startNode.id : null,
            end: main && main.endNode ? main.endNode.id : null,
            expectStart: startIdBefore, expectEnd: endIdBefore,
            countBefore: b.length, countAfter: a.length,
            curveCountDelta: afterCurves.length - gidCountBefore,
            wrapGone: wrapLead.nextOnCurve === null,
            allNodesPresent: b.every(n => a.includes(n)),
            linksIntact: linksIntact(a),
        };
    } else {
        res.cases.B_wrapPair = { error: 'curve-vanished-before-case-B' };
    }
    return res;
})()`);

const checks = [];
if (out?.error || out?.__exc) {
    checks.push({ name: 'probe-run', ok: false, detail: String(out.error || out.__exc).slice(0, 400) });
} else {
    for (const name of ['A_midChain', 'B_wrapPair']) {
        const c = out.cases?.[name];
        if (!c || c.error) {
            checks.push({ name: `${name}:ran`, ok: false, detail: String(c?.error || 'missing') });
            continue;
        }
        checks.push({ name: `${name}:returned-true`, ok: c.ret === true, detail: `ret=${c.ret}` });
        checks.push({ name: `${name}:opened`, ok: c.closed === false, detail: `closed=${c.closed}` });
        checks.push({ name: `${name}:no-orphan-curve`, ok: c.curveCountDelta === 0, detail: `delta=${c.curveCountDelta}` });
        checks.push({ name: `${name}:nodes-preserved`, ok: c.allNodesPresent && c.countBefore === c.countAfter, detail: `before=${c.countBefore} after=${c.countAfter} allPresent=${c.allNodesPresent}` });
        checks.push({ name: `${name}:links-intact`, ok: c.linksIntact === true, detail: `linksIntact=${c.linksIntact}` });
        checks.push({ name: `${name}:gap-is-the-deleted-segment`, ok: c.start === c.expectStart && c.end === c.expectEnd, detail: `start=${c.start}/${c.expectStart} end=${c.end}/${c.expectEnd}` });
    }
    const a = out.cases?.A_midChain;
    if (a && !a.error) {
        checks.push({ name: 'A_midChain:deleted-link-is-gone', ok: a.goneLink === false, detail: `lead.next===trail: ${a.goneLink}` });
        checks.push({ name: 'A_midChain:ends-nulled', ok: a.leadNextNull === true && a.trailLastNull === true, detail: `leadNext=null:${a.leadNextNull} trailLast=null:${a.trailLastNull}` });
    }
    const b = out.cases?.B_wrapPair;
    if (b && !b.error) {
        checks.push({ name: 'B_wrapPair:wrap-link-is-gone', ok: b.wrapGone === true, detail: `wrapGone=${b.wrapGone}` });
    }
}

const failed = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`);
console.log(JSON.stringify({ checks, passed: checks.length - failed, total: checks.length, failedCount: failed, steps: out?.steps ?? null, pick: out?.pick ?? null }, null, 2));

ws.close();
process.exit(failed === 0 && checks.length > 0 ? 0 : 1);
