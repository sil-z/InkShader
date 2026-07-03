import { initializeLayoutShell } from "../ui/layout_shell.js";
import { ensureRuntimeHost } from "./canvas_host_wiring.js";
import { initScrollbarVisibility } from "../services/scrollbar_visibility.js";

/**
 * Uses the top menu bar's natural width as the page minimum width.
 * When the browser is narrower than the menu bar, stops compressing all components and shows a horizontal scrollbar instead.
 */
function constrainPageMinWidth() {
    const topBar = document.querySelector('.top');
    if (!topBar) return;
    // scrollWidth covers the full width of overflow children, unaffected by viewport compression
    const menuWidth = topBar.scrollWidth;
    const viewportWidth = window.innerWidth;
    if (menuWidth > 0) {
        if (menuWidth > viewportWidth) {
            document.documentElement.style.minWidth = menuWidth + 'px';
            document.documentElement.style.overflowX = 'auto';
        } else {
            document.documentElement.style.minWidth = '';
            document.documentElement.style.overflowX = '';
        }
    }
}

// Debounce: delay execution during high-frequency resize to avoid frequent reflow
let _resizeTimer = null;
function debouncedConstrain() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(constrainPageMinWidth, 80);
}

window.addEventListener("DOMContentLoaded", () => {
    ensureRuntimeHost();
    initializeLayoutShell();
    initScrollbarVisibility();
    constrainPageMinWidth();
});
window.addEventListener("resize", debouncedConstrain);
