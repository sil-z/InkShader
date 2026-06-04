// 仅 Windows Firefox：动态注入 thin + 透明滚动条，mouseover 显示/离开立即隐藏
const SCROLLABLE = [
    '.placeholder', '.tree_panel', '.sequence-add-menu',
    '.pref_modal_body', '.pref_content_area', '.logger-output'
].join(', ');

function isFirefoxWindows() {
    return navigator.userAgent.toLowerCase().includes('firefox')
        && navigator.userAgent.toLowerCase().includes('windows');
}

function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
        ${SCROLLABLE} {
            scrollbar-width: thin !important;
            scrollbar-color: transparent transparent !important;
        }
        ${SCROLLABLE}[data-scrollbar-visible] {
            scrollbar-color: var(--ui-border-light) transparent !important;
        }
    `;
    document.head.appendChild(style);
}

export function initScrollbarVisibility() {
    if (!isFirefoxWindows()) return;

    injectStyles();

    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest(SCROLLABLE);
        if (!el) return;
        el.setAttribute('data-scrollbar-visible', '');
    }, true);

    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest(SCROLLABLE);
        if (!el) return;
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.removeAttribute('data-scrollbar-visible');
    }, true);

    document.addEventListener('scroll', (e) => {
        const el = e.target.closest(SCROLLABLE);
        if (!el) return;
        el.setAttribute('data-scrollbar-visible', '');
    }, true);
}
