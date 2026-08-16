// Live computed-style test: while the pointer hovers the wrap vs the input, read
// getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor in PAGE context.
// If the wrap's computed bg stays transparent while hovered, the wrap scrollbar IS
// broken the same way (needs the data-scrollbar-visible fix); if it turns cbd5e1
// but pixels don't show it, it's a rendering/layering quirk.
const DEBUG_PORT = 9222;
const APP_URL = 'http://localhost:8123/?v=scrollprobe-8';

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
        const body = panel.querySelector('.sample-panel-body');
        const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return JSON.stringify({ input: box(input), wrap: box(wrap), body: box(body) });
    })()`);
    const boxes = JSON.parse(prep.value);

    const live = () => evaluate(`(() => {
        const panel = document.querySelector('sample-text-panel');
        const input = panel.querySelector('#sample_text_input');
        const wrap = panel.querySelector('#sample_canvas_wrap');
        const body = panel.querySelector('.sample-panel-body');
        const read = (el) => {
            const t = getComputedStyle(el, '::-webkit-scrollbar-thumb');
            const s = getComputedStyle(el, '::-webkit-scrollbar');
            return { thumbBg: t.backgroundColor, scrollbarW: s.width, scrollbarH: s.height,
                     attr: el.getAttribute('data-scrollbar-visible') };
        };
        return JSON.stringify({ input: read(input), wrap: read(wrap), body: read(body) });
    })()`);

    // neutral (move mouse far left)
    await mouse('mouseMoved', boxes.input.x - 200, 400);
    await new Promise(r2 => setTimeout(r2, 300));
    console.log('NEUTRAL:', (await live()).error || (await live()).value);
    // hover input
    await mouse('mouseMoved', boxes.input.x + 40, boxes.input.y + 20);
    await new Promise(r2 => setTimeout(r2, 400));
    console.log('OVER-INPUT:', (await live()).error || (await live()).value);
    // hover wrap content
    await mouse('mouseMoved', boxes.wrap.x + 100, boxes.wrap.y + 100);
    await new Promise(r2 => setTimeout(r2, 400));
    console.log('OVER-WRAP:', (await live()).error || (await live()).value);
    // hover wrap scrollbar column itself
    await mouse('mouseMoved', boxes.wrap.x + boxes.wrap.w - 4, boxes.wrap.y + 20);
    await new Promise(r2 => setTimeout(r2, 400));
    console.log('OVER-WRAP-BAR:', (await live()).error || (await live()).value);
    // hover body (the .sample-panel-body container, which has overflow-y:auto + scrollbar rules)
    await mouse('mouseMoved', boxes.input.x + 10, boxes.input.y - 15);
    await new Promise(r2 => setTimeout(r2, 400));
    console.log('OVER-BODY:', (await live()).error || (await live()).value);

    // manual scroll event on wrap — does the data attr get set? (wrap is NOT in SCROLLABLE)
    const scrollTest = await evaluate(`(async () => {
        const panel = document.querySelector('sample-text-panel');
        const wrap = panel.querySelector('#sample_canvas_wrap');
        wrap.scrollTop = 100;
        wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        return JSON.stringify({ wrapAttr: wrap.getAttribute('data-scrollbar-visible'),
                                st: wrap.scrollTop, scrollbarsCustom: null });
    })()`);
    console.log('AFTER-SCROLL-WRAP:', scrollTest.error || scrollTest.value);
    ws.close();
}
main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1); });