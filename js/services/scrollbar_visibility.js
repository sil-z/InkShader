// Windows Firefox only: control scrollbar visibility via data-scrollbar-visible attribute
// Chrome: use scrollbar-color CSS property (supported in Chrome 121+) for reliable show/hide
const SCROLLABLE = '.placeholder, .tree_panel, .sequence-add-menu, .pref_modal_body, .pref_content_area, .logger-scroll, .pen-tool-popup-body';

function isFirefoxWindows() {
    return navigator.userAgent.toLowerCase().includes('firefox')
        && navigator.userAgent.toLowerCase().includes('windows');
}

export function initScrollbarVisibility() {
    // Whether we need inline scrollbar-color initialization (Firefox: yes; Chrome: no, via CSS)
    const isFF = isFirefoxWindows();

    if (isFF) {
        document.querySelectorAll(SCROLLABLE).forEach(el => {
            el.style.setProperty('scrollbar-width', 'thin');
            el.style.setProperty('scrollbar-color', 'transparent transparent');
        });
    }
    // Observe dynamically added elements
    const mo = new MutationObserver((records) => {
        for (const rec of records) {
            for (const node of rec.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.matches?.(SCROLLABLE)) {
                        if (isFF) {
                            node.style.setProperty('scrollbar-width', 'thin');
                            node.style.setProperty('scrollbar-color', 'transparent transparent');
                        }
                    }
                    node.querySelectorAll?.(SCROLLABLE).forEach(el => {
                        if (isFF) {
                            el.style.setProperty('scrollbar-width', 'thin');
                            el.style.setProperty('scrollbar-color', 'transparent transparent');
                        }
                    });
                }
            }
        }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

    document.addEventListener('mouseover', (e) => {
        const el = e.target?.closest?.(SCROLLABLE);
        if (!el) return;
        el.setAttribute('data-scrollbar-visible', '');
        if (isFF) el.style.setProperty('scrollbar-color', 'var(--ui-border-light) transparent');
    }, true);

    document.addEventListener('mouseout', (e) => {
        const el = e.target?.closest?.(SCROLLABLE);
        if (!el) return;
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.removeAttribute('data-scrollbar-visible');
        if (isFF) el.style.setProperty('scrollbar-color', 'transparent transparent');
    }, true);

    document.addEventListener('scroll', (e) => {
        const el = e.target?.closest?.(SCROLLABLE);
        if (!el) return;
        el.setAttribute('data-scrollbar-visible', '');
        if (isFF) el.style.setProperty('scrollbar-color', 'var(--ui-border-light) transparent');
    }, true);
}
