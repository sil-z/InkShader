// 节点编辑 + 节点拖动的渲染同步测试（用户主诉：路径渲染不更新、和选框不同步）。
const WebSocket = (await import('ws')).default;
import { readFileSync, copyFileSync } from 'fs';
import { exampleProject, probePorts, tmpFile } from './probe_env.mjs';
const { port: PORT, srv: SRV } = probePorts();
const APP = `http://127.0.0.1:${SRV}/index.html?v=nodesync-${Date.now()}`;
const TMP = tmpFile('roundhand_probe.json');
copyFileSync(exampleProject(), TMP);
const projectJson = readFileSync(TMP, 'utf-8');

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const tabs = (await res.json()).filter(t => t.type === 'page');
const tab = tabs[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, ms = 20000) => new Promise((resolve, reject) => {
    const id = ++msgId; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, ms);
});
const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
    if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 900) };
    return r.result?.result?.value;
};
await send('Page.enable', {});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.confirm=()=>true; window.prompt=()=>null;` });
// Navigate to the app: this probe used to rely on a manually opened tab, which made
// it hang forever when the runner supplied a blank one.
await send('Page.navigate', { url: APP });
await new Promise((r) => setTimeout(r, 3500));

const out = await evalp(`(async()=>{
  const cv = window.__canvas;
  const cm = cv.curve_manager;
  await cv.projectManager.loadFromFile(${JSON.stringify(projectJson)}, { filePath: ${JSON.stringify(TMP)} });
  await new Promise(r=>setTimeout(r,2500));
  cv.commands.setTreeSelection(['Path']);
  await new Promise(r=>setTimeout(r,900));
  const curve = cm.curveById.get('Path');
  const ctx = cv.canvasObj.getContext('2d');
  const W = cv.canvasObj.width, H = cv.canvasObj.height;
  const ink = () => { const d = ctx.getImageData(0,0,W,H).data; let c=0; for(let i=3;i<d.length;i+=4) if(d[i]>10) c++; return c; };
  const results = {};
  // 节点 marker 通过 manager 的 marker API
  let nodeId = null;
  try {
    // find_node_by_curve 用 marker；先拿 marker 列表
    const domMap = cm.domMap || cm._domMap || null;
    const iter = domMap ? [...domMap.keys()].slice(0, 5) : null;
    results._domMapSize = domMap ? domMap.size : 'none';
    results._domMapSample = iter;
    nodeId = iter && iter.length ? iter[0] : null;
  } catch(e) { results._domErr = String(e).slice(0,200); }

  // 直接用 marker 结构 {curve, node} 调 updateNodeProperty（面板同款）
  if (nodeId) {
    const marker = cm.domMap.get(nodeId);
    const before = { x: marker.x, px: ink() };
    const ok = cm.updateNodeProperty(nodeId, 'prop_x', marker.x + 50);
    await new Promise(r=>setTimeout(r,700));
    const after = { x: marker.x, px: ink(), ok };
    results.nodePropEdit = { before, after, moved: before.x !== after.x, pxChanged: before.px !== after.px };
  } else {
    results.nodePropEdit = 'no node id';
  }
  return results;
})()`);
console.log('NODE-SYNC:', JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
