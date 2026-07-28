// js/ui/kern_popup.js — Kerning pair editor popup (Web Component)
//
// Displays a table of kerning pairs with add/remove capability.
// Left/right glyph selectors populated from root-level groups.
// Values in UPM units.

import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline popup HTML (matched to the same CSS classes as property popups)
const POPUP_HTML = `
<div class="pen-tool-popup-body kern-popup-body">
  <div class="kern-popup-header">
    <span data-i18n="kern.title">Kerning Pairs</span>
  </div>
  <div class="kern-popup-add-row">
    <select class="kern-left-select" data-i18n-placeholder="kern.left_glyph" title="Left glyph">
      <option value="">-- Left --</option>
    </select>
    <select class="kern-right-select" data-i18n-placeholder="kern.right_glyph" title="Right glyph">
      <option value="">-- Right --</option>
    </select>
    <input type="number" class="kern-value-input" value="0" step="5" placeholder="0" title="Kerning value (UPM)">
    <button class="kern-add-btn" data-i18n="kern.add">Add</button>
  </div>
  <div class="kern-popup-list">
    <div class="kern-list-empty" data-i18n="kern.no_pairs">No kerning pairs defined.</div>
  </div>
</div>`;

export class KernPopup extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
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

        // Click-away: close when clicking outside (like font_popup.js)
        this._awayHandler = (e) => {
            if (!this._visible) return;
            if (e.target.closest('.top .item')) return;
            if (!this.contains(e.target)) this.hide();
        };
        document.addEventListener('mousedown', this._awayHandler, true);

        // Listen for state changes to refresh the list
        const offState = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, () => {
            if (this._visible) this._scheduleRender();
        });
        this._cleanup = () => {
            offState();
            document.removeEventListener('mousedown', this._awayHandler, true);
            this._awayHandler = null;
        };
    }

    disconnectedCallback() {
        if (this._cleanup) this._cleanup();
    }

    _populateGlyphSelects() {
        const names = this._getGlyphNames();
        const leftSel = this.querySelector('.kern-left-select');
        const rightSel = this.querySelector('.kern-right-select');
        if (!leftSel || !rightSel) return;

        // Preserve selected values if any
        const leftVal = leftSel.value;
        const rightVal = rightSel.value;

        leftSel.innerHTML = '<option value="">-- Left --</option>';
        rightSel.innerHTML = '<option value="">-- Right --</option>';

        for (const name of names) {
            leftSel.appendChild(this._optionEl(name));
            rightSel.appendChild(this._optionEl(name));
        }

        if (leftVal) leftSel.value = leftVal;
        if (rightVal) rightSel.value = rightVal;
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

        const km = this._getKerningManager();
        if (!km) return;

        km.setPair(left, right, value);
        this._markDirty();
        this._scheduleRender();
    }

    _removePair(left, right) {
        const km = this._getKerningManager();
        if (!km) return;
        km.removePair(left, right);
        this._markDirty();
        this._scheduleRender();
    }

    _markDirty() {
        const c = this._resolveCanvas();
        if (c) {
            // Recalculate sequence offsets to reflect kerning changes
            c.curve_manager?.calculateSequenceOffsets?.();
            // Invalidate stable scene cache so dividers re-draw at new positions
            c.renderer?.invalidateStableSceneCache?.();
            c.is_dirty = true;
            c.notifyPropertiesUpdate?.();
        }
    }

    _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            // Re-populate selects (in case glyph names changed)
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
                const km = this._getKerningManager();
                if (km) {
                    km.setPair(left, right, numVal);
                    this._markDirty();
                }
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

        const pairs = km ? km.getAllPairs() : [];
        const emptyEl = this.querySelector('.kern-list-empty');

        if (pairs.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            // Remove any pair rows
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

        // Track which keys are still present
        const seenKeys = new Set();

        for (const { left, right, value } of pairs) {
            const key = left + '|' + right;
            seenKeys.add(key);

            let row = existingRows.get(key);
            if (row) {
                // Update value (only if not currently editing)
                const valSpan = row.querySelector('.kern-pair-value');
                if (valSpan && !valSpan._editing) {
                    valSpan.textContent = String(value);
                }
            } else {
                // Create new row
                row = document.createElement('div');
                row.className = 'kern-pair-row';
                row.dataset.left = left;
                row.dataset.right = right;

                row.innerHTML = `
                    <span class="kern-pair-left">${esc(left)}</span>
                    <span class="kern-pair-arrow">&rarr;</span>
                    <span class="kern-pair-right">${esc(right)}</span>
                    <span class="kern-pair-value">${value}</span>
                    <button class="kern-pair-remove" title="Remove pair">&times;</button>
                `;

                row.querySelector('.kern-pair-remove').addEventListener('click', () => {
                    this._removePair(left, right);
                });

                listEl.appendChild(row);
            }
        }

        // Remove rows for pairs that no longer exist
        for (const [key, row] of existingRows) {
            if (!seenKeys.has(key)) {
                row.remove();
            }
        }
    }

    show(anchorEl) {
        this.classList.add('visible');
        this._visible = true;

        // Full refresh
        this._populateGlyphSelects();
        this._renderPairs();

        requestAnimationFrame(() => {
            const btnRect = anchorEl.getBoundingClientRect();
            let left = btnRect.left;
            let top = btnRect.bottom + 2;
            const popupRect = this.getBoundingClientRect();

            if (left + popupRect.width > window.innerWidth - 4) {
                left = window.innerWidth - popupRect.width - 4;
            }
            if (top + popupRect.height > window.innerHeight - 4) {
                top = btnRect.top - popupRect.height - 2;
            }

            this.style.left = left + 'px';
            this.style.top = top + 'px';
        });
    }

    hide() {
        this.classList.remove('visible');
        this._visible = false;
    }
}

customElements.define('kern-popup', KernPopup);
