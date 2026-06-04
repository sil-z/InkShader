// Firefox: 悬停显示/隐藏细滚动条（scrollbar-color 切换，不动 scrollbar-width 避免布局偏移）
const SCROLLABLE = [
    '.placeholder', '.tree_panel', '.sequence-add-menu',
    '.pref_modal_body', '.pref_content_area', '.logger-output'
].join(', ');

function isFirefox() {
    return navigator.userAgent.toLowerCase().includes('firefox');
}

export function initScrollbarVisibility() {
    if (!isFirefox()) return;

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
