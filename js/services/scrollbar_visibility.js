// 仅 Windows Firefox：通过 data-scrollbar-visible 属性控制滚动条显示/隐藏
// （样式规则已迁移至 style.css 的 scrollbar 区块）
const SCROLLABLE = [
    '.placeholder', '.tree_panel', '.sequence-add-menu',
    '.pref_modal_body', '.pref_content_area', '.logger-output'
].join(', ');

function isFirefoxWindows() {
    return navigator.userAgent.toLowerCase().includes('firefox')
        && navigator.userAgent.toLowerCase().includes('windows');
}

export function initScrollbarVisibility() {
    if (!isFirefoxWindows()) return;

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
