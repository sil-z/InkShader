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

/**
 * 工具栏按钮：body 级 tooltip（避免被 overflow:auto 裁剪）
 * 在每个 .tool_button 上监听 mouseenter/mouseleave，创建/移除 body 下的提示元素
 */
function initToolbarTooltips() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;
    let tooltipEl = null;
    let currentBtn = null;

    function show(btn) {
        const tip = btn.getAttribute('data-tip');
        if (!tip) return;
        hide();
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'toolbar-tooltip';
        tooltipEl.textContent = tip;
        document.body.appendChild(tooltipEl);
        const r = btn.getBoundingClientRect();
        tooltipEl.style.left = (r.right + 4) + 'px';
        tooltipEl.style.top = r.top + 'px';
        currentBtn = btn;
    }

    function hide() {
        if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
        currentBtn = null;
    }

    toolbar.addEventListener('mouseover', e => {
        const btn = e.target.closest('.tool_button');
        if (btn) { if (btn !== currentBtn) show(btn); }
        else { hide(); }
    });

    toolbar.addEventListener('scroll', () => {
        if (currentBtn && tooltipEl) {
            const r = currentBtn.getBoundingClientRect();
            tooltipEl.style.left = (r.right + 8) + 'px';
            tooltipEl.style.top = r.top + 'px';
        }
    });

    toolbar.addEventListener('mouseleave', hide);
}

window.addEventListener("DOMContentLoaded", () => {
    ensureRuntimeHost();
    initializeLayoutShell();
    initScrollbarVisibility();
    constrainPageMinWidth();
    initToolbarTooltips();
});
window.addEventListener("resize", debouncedConstrain);
