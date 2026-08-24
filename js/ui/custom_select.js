// js/ui/custom_select.js
// Reusable custom dropdown select that replaces native <select> elements.
// Matches the page's rounded-corner design with theme variables.
//
// The options panel is appended to document.body with position:fixed
// so it visually extends beyond any overflow container without
// modifying ancestor overflow properties.

/**
 * Replace a native <select> with a custom styled dropdown.
 * Fires the same 'change' events so existing code works transparently.
 *
 * @param {HTMLSelectElement} selectEl - The native select to replace
 * @param {object} [opts]
 * @param {number} [opts.minWidth] - Minimum width in px (defaults to select's offsetWidth)
 * @returns {HTMLElement} The wrapper element (inserted in place of the select)
 */
export function createCustomSelect(selectEl, opts = {}) {
    if (!selectEl || selectEl.tagName !== 'SELECT') return null;

    // Collect options from the original <select>
    const options = [...selectEl.querySelectorAll('option')].map(opt => ({
        value: opt.value,
        label: opt.textContent.trim(),
        selected: opt.selected,
    }));

    const currentValue = selectEl.value;

    // Build wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'cs-wrapper';
    wrapper.dataset.value = currentValue;

    // Match original element's CSS classes for sizing context
    if (selectEl.classList.contains('font-popup-input')) {
        wrapper.classList.add('font-popup-input');
    }

    // Trigger button
    const trigger = document.createElement('div');
    trigger.className = 'cs-trigger';
    trigger.tabIndex = 0;

    const selectedLabel = options.find(o => o.value === currentValue)?.label || '';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'cs-label';
    labelSpan.textContent = selectedLabel;

    const chevron = document.createElement('span');
    chevron.className = 'cs-chevron';
    chevron.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 4.5L6 8L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);

    // Options panel — created once, moved between body and wrapper
    const panel = document.createElement('div');
    panel.className = 'cs-panel';

    options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'cs-option' + (opt.value === currentValue ? ' selected' : '');
        item.dataset.value = opt.value;
        item.textContent = opt.label;
        panel.appendChild(item);
    });

    wrapper.appendChild(trigger);
    // Panel is NOT appended to wrapper — it lives in document.body when open

    // Replace the native select in the DOM
    selectEl.style.display = 'none';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    // Move panel to body so it's never clipped
    document.body.appendChild(panel);

    // --- Event handling ---
    let open = false;

    function positionPanel() {
        const rect = trigger.getBoundingClientRect();
        const gap = 2; // px between trigger and dropdown
        let top = rect.bottom + gap;
        let left = rect.left;
        let width = rect.width;

        panel.style.width = width + 'px';
        panel.style.left = left + 'px';

        // If dropdown would go below viewport, open upward
        const estimatedHeight = Math.min(panel.scrollHeight || 200, 200);
        if (top + estimatedHeight > window.innerHeight - 4) {
            top = rect.top - gap - estimatedHeight;
        }
        // Clamp to viewport
        if (top < 4) top = 4;

        panel.style.top = top + 'px';
    }

    function close() {
        if (!open) return;
        open = false;
        wrapper.classList.remove('open');
        panel.style.display = 'none';
        document.removeEventListener('mousedown', onDocClick, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll, true);
    }

    function openPanel() {
        if (open) { close(); return; }
        open = true;
        wrapper.classList.add('open');
        panel.style.display = 'block';
        positionPanel();

        // Scroll selected into view within the panel
        const sel = panel.querySelector('.cs-option.selected');
        if (sel) {
            const panelRect = panel.getBoundingClientRect();
            const selRect = sel.getBoundingClientRect();
            if (selRect.top < panelRect.top || selRect.bottom > panelRect.bottom) {
                sel.scrollIntoView({ block: 'nearest' });
            }
        }

        document.addEventListener('mousedown', onDocClick, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll, true);
    }

    function onDocClick(e) {
        if (!wrapper.contains(e.target) && !panel.contains(e.target)) close();
    }

    function onScroll() { close(); }

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        open ? close() : openPanel();
    });

    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open ? close() : openPanel();
        } else if (e.key === 'Escape') {
            close();
        }
    });

    // Stop mousedown from reaching parent popup's own close-on-outside-click
    // handlers. The panel lives in document.body (position:fixed) so parent
    // popups would see a click here as 'outside' and close themselves.
    // Must be capture phase because parent popups register their close handler
    // on document in capture phase too (e.g. preferences_modal).
    panel.addEventListener('mousedown', (e) => e.stopPropagation(), true);

    panel.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = e.target.closest('.cs-option');
        if (!item) return;

        const value = item.dataset.value;
        if (value === wrapper.dataset.value) { close(); return; }

        // Update selection
        panel.querySelectorAll('.cs-option').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        wrapper.dataset.value = value;
        labelSpan.textContent = item.textContent;

        // Sync back to native select and fire change
        selectEl.value = value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));

        close();
    });

    // Expose helper to update options programmatically
    wrapper._csUpdateOptions = function (newOptions, newValue) {
        panel.innerHTML = '';
        newOptions.forEach(opt => {
            const item = document.createElement('div');
            item.className = 'cs-option' + (opt.value === newValue ? ' selected' : '');
            item.dataset.value = opt.value;
            item.textContent = opt.label;
            panel.appendChild(item);
        });
        wrapper.dataset.value = newValue;
        labelSpan.textContent = newOptions.find(o => o.value === newValue)?.label || '';
        selectEl.value = newValue;
    };

    // Expose helper to set value programmatically
    wrapper._csSetValue = function (value) {
        const opt = panel.querySelector(`.cs-option[data-value="${CSS.escape(value)}"]`);
        if (!opt) return;
        panel.querySelectorAll('.cs-option').forEach(el => el.classList.remove('selected'));
        opt.classList.add('selected');
        wrapper.dataset.value = value;
        labelSpan.textContent = opt.textContent;
        selectEl.value = value;
    };

    return wrapper;
}

/**
 * Convenience: convert all <select> elements inside a container to custom selects.
 * @param {HTMLElement} container
 * @param {string} [selector='select'] - CSS selector for selects to convert
 */
export function convertSelects(container, selector = 'select') {
    const selects = container.querySelectorAll(selector);
    selects.forEach(sel => createCustomSelect(sel));
}
