// Shared utilities for property popup windows (resize handles, z-index management)

let _popupZCounter = 2000;

/**
 * Bring a popup element to the front by incrementing its z-index.
 * Mirrors DockLayout._bringToFront().
 * @param {HTMLElement} el
 */
export function bringToFront(el) {
    _popupZCounter++;
    el.style.zIndex = _popupZCounter;
}

/**
 * Initialize 8 directional resize handles on a popup element, mimicking the
 * dock-float-window resize behavior.
 * @param {HTMLElement} popupEl  The popup custom element
 * @param {object}      [opts]
 * @param {number}      [opts.minW=280]  Minimum width constraint
 * @param {number}      [opts.minH=120]  Minimum height constraint
 */
export function initResizeHandles(popupEl, opts = {}) {
    const minW = opts.minW || 320;
    const minH = opts.minH || 120;
    const edges = ["n","s","e","w","ne","nw","se","sw"];

    edges.forEach(edge => {
        const h = document.createElement("div");
        h.className = "dock-float-resize handle-" + edge;
        h.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            bringToFront(popupEl);

            const sx = e.clientX, sy = e.clientY;
            const sr = popupEl.getBoundingClientRect();

            // The popup uses content-box sizing (default).  getBoundingClientRect
            // returns border-box values, so style.width/height must subtract the
            // borders to keep the same total rendered size — otherwise every
            // resize leaks border pixels into the content area, bumping the
            // popup larger by the border each time the width changes.
            const cs = getComputedStyle(popupEl);
            const bw = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
            const bh = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
            const affectsHeight = edge.includes("s") || edge.includes("n");

            const onMove = (ev) => {
                const dx = ev.clientX - sx, dy = ev.clientY - sy;
                let l = sr.left, t = sr.top, w = sr.width, h = sr.height;

                if (edge.includes("e")) w = sr.width + dx;
                if (edge.includes("w")) { w = sr.width - dx; l = sr.left + dx; }
                if (edge.includes("s")) h = sr.height + dy;
                if (edge.includes("n")) { h = sr.height - dy; t = sr.top + dy; }

                // Clamp to minimum
                if (w < minW) {
                    if (edge.includes("w")) l = sr.left + sr.width - minW;
                    w = minW;
                }
                if (h < minH) {
                    if (edge.includes("n")) t = sr.top + sr.height - minH;
                    h = minH;
                }

                // Keep within viewport
                if (t < 0) { h = Math.max(minH, h + t); t = 0; }
                if (l < -(w - 60)) { l = -(w - 60); w = Math.max(minW, w); }

                popupEl.style.left = l + "px";
                popupEl.style.top = t + "px";
                popupEl.style.width = (w - bw) + "px";
                // Only write height when the resize actually involves a vertical
                // edge — width-only (e/w) should never override the natural
                // content-driven height, which stays constant regardless of width.
                if (affectsHeight) {
                    popupEl.style.height = (h - bh) + "px";
                }
            };

            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                if (typeof popupEl._savePosition === "function") {
                    popupEl._savePosition();
                }
            };

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        popupEl.appendChild(h);
    });
}
