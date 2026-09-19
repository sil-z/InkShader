// js/ui/kern_popup.js — Kerning pair editor popup (Web Component)
//
// Displays a table of kerning pairs with add/remove capability.
// Left/right glyph selectors populated from root-level groups.
// Values in UPM units.

import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { createCustomSelect } from "./custom_select.js";

/** Translation shorthand: table first, English literal as the fallback. */
const t = (key, fallback) => (window.I18n ? window.I18n.t(key, fallback) : fallback);

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline popup HTML (matched to the same CSS classes as property popups)
const POPUP_HTML = `
<div class="prop_panel_title_wrapper"><span class="panel_title" data-i18n="panel.kerning">Kerning</span></div>
<div class="pen-tool-popup-body kern-popup-body">
  <div class="kern-popup-add-row">
    <select class="kern-left-select" data-i18n-placeholder="kern.left_glyph" data-i18n-tip="kern.left_glyph" title="Left glyph">
      <option value="" data-i18n="kern.pick_left">${t('kern.pick_left', '-- Left --')}</option>
    </select>
    <select class="kern-right-select" data-i18n-placeholder="kern.right_glyph" data-i18n-tip="kern.right_glyph" title="Right glyph">
      <option value="" data-i18n="kern.pick_right">${t('kern.pick_right', '-- Right --')}</option>
    </select>
    <input type="number" class="kern-value-input" value="0" step="5" placeholder="0" data-i18n-tip="kern.value_tip" title="Kerning value (UPM)">
    <button class="kern-add-btn" data-i18n="kern.add">Add</button>
  </div>
  <div class="kern-popup-list">
    <div class="kern-list-empty" data-i18n="kern.no_pairs">No kerning pairs defined.</div>
  </div>
</div>`;

export class KernPopup extends HTMLElement {
    constructor() {
        super();
        this._canvas = null;
        this._glyphNames = [];
        this._pairs = [];
        this._renderPending = false;
    }

    setCanvas(c) {
        this._canvas = c;
    }

    _resolveCanvas() {
        if (this._canvas) return this._canvas;
        this._canvas = document.querySelector('main-canvas');
        return this._canvas;
    }

    /** @returns {import('../core/bezier/kerning_manager.js').KerningManager|null} */
    _getKerningManager() {
        const c = this._resolveCanvas();
        return c?.curve_manager?.kerningManager ?? null;
    }

    _getGlyphNames() {
        const c = this._resolveCanvas();
        if (!c?.curve_manager?.treeItems) return [];
        const names = [];
        for (const [id, item] of c.curve_manager.treeItems.entries()) {
            if (item.type === 'group' && !item.isRef && item.parentId === null) {
                names.push(item.name);
            }
        }
        return names.sort();
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;
        this.innerHTML = POPUP_HTML;

        this.addEventListener('mousedown', (e) => e.stopPropagation());

        // Convert native <select> to custom styled dropdowns
        this.querySelectorAll('select').forEach(sel => createCustomSelect(sel));

        // Populate glyph selectors
        this._populateGlyphSelects();

        // Add button handler
        const addBtn = this.querySelector('.kern-add-btn');
        addBtn?.addEventListener('click', () => this._addPair());

        // Enter key on value input also adds
        const valInput = this.querySelector('.kern-value-input');
        valInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._addPair();
        });

        // Event delegation: dblclick on value span starts inline edit
        const listEl = this.querySelector('.kern-popup-list');
        listEl?.addEventListener('dblclick', (e) => {
            const valSpan = e.target.closest('.kern-pair-value');
            if (!valSpan) return;
            const row = valSpan.closest('.kern-pair-row');
            if (!row) return;
            this._startEditValue(valSpan, row.dataset.left, row.dataset.right);
        });

        // Listen for state changes to refresh the list. Registered once and
        // never torn down: the dock detaches/reattaches the element on layout
        // rebuilds (hide/show/float), and connectedCallback early-returns after
        // the first connect, so a per-connection cleanup would kill the refresh.
        appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, () => {
            if (this.dataset.panelHidden) return;
            this._scheduleRender();
        });

        // Initial render (previously done in show() on every open).
        this._populateGlyphSelects();
        this._renderPairs();
    }

    _populateGlyphSelects() {
        const names = this._getGlyphNames();
        const leftSel = this.querySelector('.kern-left-select');
        const rightSel = this.querySelector('.kern-right-select');
        if (!leftSel || !rightSel) return;

        // Preserve selected values if any
        const leftVal = leftSel.value;
        const rightVal = rightSel.value;

        // data-i18n on the rebuilt option keeps it re-translatable: the custom
        // dropdown mirrors this element's text, and translateDOM can only rewrite
        // elements that declare a key.
        leftSel.innerHTML = '<option value="" data-i18n="kern.pick_left">' + esc(t('kern.pick_left', '-- Left --')) + '</option>';
        rightSel.innerHTML = '<option value="" data-i18n="kern.pick_right">' + esc(t('kern.pick_right', '-- Right --')) + '</option>';

        for (const name of names) {
            leftSel.appendChild(this._optionEl(name));
            rightSel.appendChild(this._optionEl(name));
        }

        const newLeftVal = leftVal || '';
        const newRightVal = rightVal || '';
        leftSel.value = newLeftVal;
        rightSel.value = newRightVal;

        // Update custom select wrappers if they exist
        const leftWrapper = leftSel.previousElementSibling;
        const rightWrapper = rightSel.previousElementSibling;
        if (leftWrapper?._csUpdateOptions) {
            const leftOpts = [{ value: '', label: t('kern.pick_left', '-- Left --') }, ...names.map(n => ({ value: n, label: n }))];
            leftWrapper._csUpdateOptions(leftOpts, newLeftVal);
        }
        if (rightWrapper?._csUpdateOptions) {
            const rightOpts = [{ value: '', label: t('kern.pick_right', '-- Right --') }, ...names.map(n => ({ value: n, label: n }))];
            rightWrapper._csUpdateOptions(rightOpts, newRightVal);
        }
    }

    _optionEl(value) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        return opt;
    }

    _addPair() {
        const leftSel = this.querySelector('.kern-left-select');
        const rightSel = this.querySelector('.kern-right-select');
        const valInput = this.querySelector('.kern-value-input');
        if (!leftSel || !rightSel || !valInput) return;

        const left = leftSel.value;
        const right = rightSel.value;
        const value = parseInt(valInput.value, 10);

        if (!left || !right) return;
        if (isNaN(value)) return;

        // Route through the command/history pipeline (undo/redo + autosave).
        CanvasDispatcher.requestSetKerningPairs([{ left, right, value }], { recordHistory: true });
        this._scheduleRender();
    }

    _removeEntry(left, right) {
        CanvasDispatcher.requestSetKerningPairs([{ left, right, remove: true }], { recordHistory: true });
        this._scheduleRender();
    }

    _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            this._populateGlyphSelects();
            this._renderPairs();
        });
    }

    // ── Inline editing ──

    /** Start inline editing on a value span. */
    _startEditValue(valSpan, left, right) {
        if (valSpan._editing) return;
        const original = valSpan.textContent;
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'kern-pair-edit-input';
        input.value = original;
        input.step = '5';

        // Replace span content with input
        valSpan.textContent = '';
        valSpan.appendChild(input);
        valSpan._editing = true;

        input.focus();
        input.select();

        const finish = (save) => {
            if (!valSpan._editing) return;
            valSpan._editing = false;
            const newValue = save ? input.value : original;
            // Clean up input
            if (input.parentNode === valSpan) {
                valSpan.removeChild(input);
            }
            // Apply if changed
            const numVal = parseInt(newValue, 10);
            if (save && !isNaN(numVal) && numVal !== parseInt(original, 10)) {
                CanvasDispatcher.requestSetKerningPairs([{ left, right, value: numVal }], { recordHistory: true });
                valSpan.textContent = String(numVal);
            } else {
                valSpan.textContent = original;
            }
        };

        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            e.stopPropagation();
        });
    }

    _renderPairs() {
        const km = this._getKerningManager();
        const listEl = this.querySelector('.kern-popup-list');
        if (!listEl) return;

        // Only show exact glyph-to-glyph pairs
        const entries = [];
        if (km) {
            for (const { left, right, value } of km.getAllPairs()) {
                entries.push({ left, right, value });
            }
        }

        const emptyEl = this.querySelector('.kern-list-empty');

        if (entries.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            listEl.querySelectorAll('.kern-pair-row').forEach(el => el.remove());
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        // Build a map of existing rows for efficient update
        const existingRows = new Map();
        listEl.querySelectorAll('.kern-pair-row').forEach(el => {
            const key = el.dataset.left + '|' + el.dataset.right;
            existingRows.set(key, el);
        });

        const seenKeys = new Set();

        for (const { left, right, value } of entries) {
            const key = left + '|' + right;
            seenKeys.add(key);

            let row = existingRows.get(key);
            if (row) {
                const valSpan = row.querySelector('.kern-pair-value');
                if (valSpan && !valSpan._editing) {
                    valSpan.textContent = String(value);
                }
            } else {
                row = document.createElement('div');
                row.className = 'kern-pair-row';
                row.dataset.left = left;
                row.dataset.right = right;

                row.innerHTML = `
                    <span class="kern-pair-left">${esc(left)}</span>
                    <span class="kern-pair-arrow">&rarr;</span>
                    <span class="kern-pair-right">${esc(right)}</span>
                    <span class="kern-pair-value">${value}</span>
                    <button class="kern-pair-remove" data-i18n-tip="kern.remove_tip" title="Remove">&times;</button>
                `;

                row.querySelector('.kern-pair-remove').addEventListener('click', () => {
                    this._removeEntry(left, right);
                });

                listEl.appendChild(row);
            }
        }

        // Remove rows that no longer exist
        for (const [key, row] of existingRows) {
            if (!seenKeys.has(key)) {
                row.remove();
            }
        }
    }

    }

customElements.define('kern-popup', KernPopup);
