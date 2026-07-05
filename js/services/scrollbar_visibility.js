// Windows Firefox only: control scrollbar visibility via data-scrollbar-visible attribute
const SCROLLABLE = '.placeholder, .tree_panel, .sequence-add-menu, .pref_modal_body, .pref_content_area, .logger-output, .pen-tool-popup-body';

function isFirefoxWindows() {
    return navigator.userAgent.toLowerCase().includes('firefox')
        && navigator.userAgent.toLowerCase().includes('windows');
}

export function initScrollbarVisibility() {
    if (!isFirefoxWindows()) return;

    // Set initial scrollbar styles for Firefox (not in CSS, to avoid Chrome new version also applying scrollbar-color)
    document.querySelectorAll(SCROLLABLE).forEach(el => {
        el.style.setProperty('scrollbar-width', 'thin');
        el.style.setProperty('scrollbar-color', 'transparent transparent');
    });
    // Observe dynamically added elements
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
