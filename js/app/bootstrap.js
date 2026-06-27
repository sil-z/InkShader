import { initializeLayoutShell } from "../ui/layout_shell.js";
import { ensureRuntimeHost } from "./canvas_host_wiring.js";
import { initScrollbarVisibility } from "../services/scrollbar_visibility.js";

/**
 * 以顶部菜单栏的自然宽度作为页面最小宽度。
 * 当浏览器宽度小于菜单栏时，停止压缩所有组件，改为显示水平滚动条。
 */
function constrainPageMinWidth() {
    const topBar = document.querySelector('.top');
    if (!topBar) return;
    // scrollWidth 包含溢出子元素的完整宽度，不受视口压缩影响
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

// 防抖：resize 高频触发时延迟执行，避免频繁 reflow
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
