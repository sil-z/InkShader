// 仅 Windows Firefox：通过 data-scrollbar-visible 属性控制滚动条显示/隐藏
const SCROLLABLE = '.placeholder, .tree_panel, .sequence-add-menu, .pref_modal_body, .pref_content_area, .logger-output';

function isFirefoxWindows() {
    return navigator.userAgent.toLowerCase().includes('firefox')
        && navigator.userAgent.toLowerCase().includes('windows');
}

export function initScrollbarVisibility() {
    if (!isFirefoxWindows()) return;

    // 为 Firefox 设置初始滚动条样式（不在 CSS 中写，避免 Chrome 新版也应用 scrollbar-color）
    document.querySelectorAll(SCROLLABLE).forEach(el => {
        el.style.setProperty('scrollbar-width', 'thin');
        el.style.setProperty('scrollbar-color', 'transparent transparent');
    });
    // 观察动态添加的元素
    const mo = new MutationObserver((records) => {
        for (const rec of records) {
            for (const node of rec.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.matches?.(SCROLLABLE)) {
                        node.style.setProperty('scrollbar-width', 'thin');
                        node.style.setProperty('scrollbar-color', 'transparent transparent');
                    }
                    node.querySelectorAll?.(SCROLLABLE).forEach(el => {
                        el.style.setProperty('scrollbar-width', 'thin');
                        el.style.setProperty('scrollbar-color', 'transparent transparent');
                    });
                }
            }
        }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

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
