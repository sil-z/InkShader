const TEMPLATE_HTML = `
    <div id="painting_area" class="painting_area">
        <button id="lock_guideline_button" class="lock_guideline_button">
            <img id="lock_guideline_icon" class="lock_guideline_icon" data-src="assets/icons/lock.svg" alt="Guideline Locked" >
            <img id="lock_guideline_icon_unlocked" class="lock_guideline_icon_unlocked" data-src="assets/icons/unlock.svg" alt="Guideline Unlocked">
        </button>
        <div id="ruler_horizontal" class="ruler_horizontal"></div>
        <div id="ruler_vertical" class="ruler_vertical"></div>
        <div id="main_canvas_large" class="main_canvas_large">
            <div id="main_canvas" class="main_canvas"></div>
        </div>
    </div>
`;
export function setupCanvasView(canvas) {
    if (canvas.painting_area) return; // Already set up (e.g., after dock-initiated reconnect)
    const template = canvas.env.createDOMElement("template");
    template.innerHTML = TEMPLATE_HTML;
    canvas.appendChild(template.content.cloneNode(true));
    canvas.lock_guideline_button = canvas.querySelector("#lock_guideline_button");
    canvas.lock_guideline_icon = canvas.querySelector("#lock_guideline_icon");
    canvas.lock_guideline_icon_unlocked = canvas.querySelector("#lock_guideline_icon_unlocked");
    canvas.painting_area = canvas.querySelector("#painting_area");
    canvas.ruler_horizontal = canvas.querySelector("#ruler_horizontal");
    canvas.ruler_vertical = canvas.querySelector("#ruler_vertical");
    canvas._rulerIndicatorH = canvas.env.createDOMElement("div");
    canvas._rulerIndicatorH.className = "ruler-indicator-h";
    canvas.painting_area.appendChild(canvas._rulerIndicatorH);
    canvas._rulerIndicatorV = canvas.env.createDOMElement("div");
    canvas._rulerIndicatorV.className = "ruler-indicator-v";
    canvas.painting_area.appendChild(canvas._rulerIndicatorV);
    canvas.main_canvas = canvas.querySelector("#main_canvas");
    canvas.main_canvas_large = canvas.querySelector("#main_canvas_large");
    canvas.canvasObj = canvas.env.createDOMElement("canvas");
    canvas.canvasObj.className = "core_canvas";
    canvas.canvasObj.oncontextmenu = () => false;
    canvas.main_canvas_large.appendChild(canvas.canvasObj);
    canvas.ctx = canvas.env.getCanvasContext(canvas.canvasObj, "2d");
    canvas.resizeCanvas();
    canvas.refreshViewportConfig();
    const viewport = canvas.viewportConfig || {};
    const viewportWidth = Number.isFinite(viewport.viewportWidth) ? viewport.viewportWidth : 0;
    const viewportHeight = Number.isFinite(viewport.viewportHeight) ? viewport.viewportHeight : 0;
    canvas.offset.x = (viewportWidth - canvas.ruler_size - canvas.canvas_size_width * canvas.scale) / 2;
    canvas.offset.y = (viewportHeight - canvas.ruler_size - canvas.canvas_size_height * canvas.scale) / 2;
}
export function setupCanvasResizeBehavior(canvas) {
    const onViewportChange = () => {
        canvas.resizeCanvas();
        canvas.is_dirty = true;
    };
    canvas.addGlobalListener("window", "resize", onViewportChange);
    canvas.resizeObserver = new ResizeObserver(onViewportChange);
    if (canvas.main_canvas_large) canvas.resizeObserver.observe(canvas.main_canvas_large);
    if (canvas.canvasObj) canvas.resizeObserver.observe(canvas.canvasObj);
    // Chrome 页面缩放（Ctrl +/-）主要触发 visualViewport，而非 layout resize
    if (typeof window !== "undefined" && window.visualViewport) {
        const vv = window.visualViewport;
        vv.addEventListener("resize", onViewportChange);
        vv.addEventListener("scroll", onViewportChange);
        canvas.globalEventTrackers.push(() => {
            vv.removeEventListener("resize", onViewportChange);
            vv.removeEventListener("scroll", onViewportChange);
        });
    }
}
