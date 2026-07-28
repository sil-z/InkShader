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
    <span data-i18n="kern.title">Kerning</span>
  </div>
  <div class="kern-tab-bar">
    <button class="kern-tab active" data-tab="pairs">Pairs</button>
    <button class="kern-tab" data-tab="classes">Classes</button>
  </div>
  <!-- Pairs tab -->
  <div class="kern-tab-content" data-panel="pairs">
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
  </div>
  <!-- Classes tab -->
  <div class="kern-tab-content" data-panel="classes" style="display:none">
    <div class="kern-class-controls">
      <select class="kern-class-side-select" title="Side">
        <option value="left">Left classes</option>
        <option value="right">Right classes</option>
      </select>
      <input type="text" class="kern-class-name-input" placeholder="Class name" title="New class name">
      <button class="kern-class-add-btn">Add Class</button>
    </div>
    <div class="kern-class-layout">
      <div class="kern-class-list">
        <div class="kern-class-list-empty">No classes defined.</div>
      </div>
      <div class="kern-class-detail" style="display:none">
        <div class="kern-class-detail-header">
          <span class="kern-class-detail-name"></span>
          <button class="kern-class-delete-btn" title="Delete class">&times;</button>
        </div>
        <div class="kern-class-members"></div>
      </div>
    </div>
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
        this._activeTab = 'pairs';
        this._selectedClassSide = 'left';
        this._selectedClassName = null;
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

        // Tab switching
        this.querySelectorAll('.kern-tab').forEach(tab => {
            tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
        });

        // Populate glyph selectors
        this._populateGlyphSelects();

        // Pairs tab: add button handler
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
            this._startEditValue(valSpan, row.dataset.left, row.dataset.right, row.dataset.type || 'pair');
        });

        // Classes tab handlers
        this.querySelector('.kern-class-add-btn')?.addEventListener('click', () => this._addClass());
        this.querySelector('.kern-class-name-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._addClass();
        });
        this.querySelector('.kern-class-delete-btn')?.addEventListener('click', () => this._deleteSelectedClass());

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

    // ── Tab switching ──

    _switchTab(tab) {
        this._activeTab = tab;
        this.querySelectorAll('.kern-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        this.querySelectorAll('.kern-tab-content').forEach(p => {
            p.style.display = p.dataset.panel === tab ? '' : 'none';
        });
        if (tab === 'classes') this._renderClasses();
    }

    _populateGlyphSelects() {
        const names = this._getGlyphNames();
        const km = this._getKerningManager();
        const leftSel = this.querySelector('.kern-left-select');
        const rightSel = this.querySelector('.kern-right-select');
        if (!leftSel || !rightSel) return;

        // Preserve selected values if any
        const leftVal = leftSel.value;
        const rightVal = rightSel.value;

        leftSel.innerHTML = '<option value="">-- Left --</option>';
        rightSel.innerHTML = '<option value="">-- Right --</option>';

        // Glyphs
        for (const name of names) {
            leftSel.appendChild(this._optionEl(name));
            rightSel.appendChild(this._optionEl(name));
        }

        // Classes (prefixed with [ ] to distinguish from glyphs)
        if (km) {
            for (const cn of km.getAllClasses('left')) {
                leftSel.appendChild(this._optionEl('[' + cn + ']'));
            }
            for (const cn of km.getAllClasses('right')) {
                rightSel.appendChild(this._optionEl('[' + cn + ']'));
            }
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

    /** Check if a select value is a class reference (e.g. "[UC]") and return the class name, or null. */
    _resolveKernRef(val) {
        if (val && val.startsWith('[') && val.endsWith(']')) return val.slice(1, -1);
        return null;
    }

    _addPair() {
        const leftSel = this.querySelector('.kern-left-select');
        const rightSel = this.querySelector('.kern-right-select');
        const valInput = this.querySelector('.kern-value-input');
        if (!leftSel || !rightSel || !valInput) return;

        const leftRaw = leftSel.value;
        const rightRaw = rightSel.value;
        const value = parseInt(valInput.value, 10);

        if (!leftRaw || !rightRaw) return;
        if (isNaN(value)) return;

        const km = this._getKerningManager();
        if (!km) return;

        const leftClass = this._resolveKernRef(leftRaw);
        const rightClass = this._resolveKernRef(rightRaw);

        if (leftClass && rightClass) {
            km.setClassValue(leftClass, rightClass, value);
        } else if (leftClass) {
            // Left is class, right is glyph — mixed pair
            km.setMixedPair('leftClass', leftClass, rightRaw, value);
        } else if (rightClass) {
            // Left is glyph, right is class — mixed pair
            km.setMixedPair('rightClass', rightClass, leftRaw, value);
        } else {
            km.setPair(leftRaw, rightRaw, value);
        }
        this._markDirty();
        this._scheduleRender();
    }

    _removeEntry(leftRaw, rightRaw, type) {
        const km = this._getKerningManager();
        if (!km) return;
        if (type === 'class') {
            km.removeClassValue(leftRaw, rightRaw);
        } else if (type === 'mixed-left') {
            km.removeMixedPair('leftClass', leftRaw, rightRaw);
        } else if (type === 'mixed-right') {
            km.removeMixedPair('rightClass', leftRaw, rightRaw);
        } else {
            km.removePair(leftRaw, rightRaw);
        }
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
            this._populateGlyphSelects();
            this._renderPairs();
            if (this._activeTab === 'classes') this._renderClasses();
        });
    }

    // ── Classes tab ──

    _addClass() {
        const km = this._getKerningManager();
        if (!km) return;
        const nameInput = this.querySelector('.kern-class-name-input');
        const sideSelect = this.querySelector('.kern-class-side-select');
        const name = nameInput?.value?.trim();
        const side = sideSelect?.value || 'left';
        if (!name) return;
        km.createClass(side, name);
        this._selectedClassSide = side;
        this._selectedClassName = name;
        nameInput.value = '';
        this._markDirty();
        this._renderClasses();
    }

    _deleteSelectedClass() {
        const km = this._getKerningManager();
        if (!km || !this._selectedClassName) return;
        km.removeClass(this._selectedClassSide, this._selectedClassName);
        this._selectedClassName = null;
        this._markDirty();
        this._renderClasses();
    }

    _renderClasses() {
        const km = this._getKerningManager();
        const listEl = this.querySelector('.kern-class-list');
        const detailEl = this.querySelector('.kern-class-detail');
        if (!listEl || !km) return;

        const side = this._selectedClassSide;
        const classes = km.getAllClassesWithMembers(side);

        // Update side selector
        const sideSelect = this.querySelector('.kern-class-side-select');
        if (sideSelect) sideSelect.value = side;

        // Render class list
        listEl.innerHTML = '';
        if (classes.length === 0) {
            listEl.innerHTML = '<div class="kern-class-list-empty">No classes defined.</div>';
            if (detailEl) detailEl.style.display = 'none';
            return;
        }

        for (const { name, members } of classes) {
            const item = document.createElement('div');
            item.className = 'kern-class-item' + (name === this._selectedClassName ? ' active' : '');
            item.innerHTML = `<span class="kern-class-item-name">${esc(name)}</span><span class="kern-class-item-count">${members.length}</span>`;
            item.addEventListener('click', () => {
                this._selectedClassName = name;
                this._renderClasses();
            });
            listEl.appendChild(item);
        }

        // Auto-select first if none selected
        if (!this._selectedClassName || !classes.find(c => c.name === this._selectedClassName)) {
            if (classes.length > 0) {
                this._selectedClassName = classes[0].name;
            }
        }

        if (!this._selectedClassName) {
            if (detailEl) detailEl.style.display = 'none';
            return;
        }

        if (detailEl) detailEl.style.display = '';

        // Skip re-rendering members if the same class is already shown and input is focused
        // (prevents focus loss when STATE_CHANGED triggers _scheduleRender)
        const membersEl = this.querySelector('.kern-class-members');
        const activeInput = document.activeElement;
        const inputFocused = activeInput && membersEl && membersEl.contains(activeInput);
        if (inputFocused && membersEl.querySelector('.kern-ac-input')) {
            return; // User is typing — don't rebuild DOM
        }

        this._renderClassMembers();
    }

    _renderClassMembers() {
        const km = this._getKerningManager();
        const membersEl = this.querySelector('.kern-class-members');
        const nameEl = this.querySelector('.kern-class-detail-name');
        if (!km || !membersEl || !this._selectedClassName) return;

        if (nameEl) nameEl.textContent = this._selectedClassName;

        const side = this._selectedClassSide;
        const members = new Set(km.getClassMembers(side, this._selectedClassName));
        const allGlyphs = this._getGlyphNames();

        // Build inner HTML: chips container + input with autocomplete
        membersEl.innerHTML = `
            <div class="kern-chips"></div>
            <div class="kern-ac-wrap">
                <input type="text" class="kern-ac-input" placeholder="Add glyph..." title="Type glyph name to add">
                <div class="kern-ac-suggest" style="display:none"></div>
            </div>`;

        const chipsEl = membersEl.querySelector('.kern-chips');
        const inputEl = membersEl.querySelector('.kern-ac-input');
        const suggestEl = membersEl.querySelector('.kern-ac-suggest');

        // ── Render existing members as chips ──
        const renderChips = () => {
            chipsEl.innerHTML = '';
            const currentMembers = km.getClassMembers(side, this._selectedClassName);
            for (const g of currentMembers) {
                const chip = document.createElement('span');
                chip.className = 'kern-chip';
                chip.innerHTML = `<span class="kern-chip-name">${esc(g)}</span><button class="kern-chip-x" title="Remove">&times;</button>`;
                chip.querySelector('.kern-chip-x').addEventListener('click', () => {
                    const updated = km.getClassMembers(side, this._selectedClassName).filter(m => m !== g);
                    km.setClass(side, this._selectedClassName, updated);
                    this._markDirty();
                    renderChips();
                    this._renderClasses(); // Update count
                });
                chipsEl.appendChild(chip);
            }
        };
        renderChips();

        // ── Autocomplete logic ──
        const currentMembers = () => new Set(km.getClassMembers(side, this._selectedClassName));

        const showSuggestions = (query) => {
            const cur = currentMembers();
            const q = query.toLowerCase();
            const matches = allGlyphs.filter(g => !cur.has(g) && g.toLowerCase().includes(q));
            if (matches.length === 0 || q === '') {
                suggestEl.style.display = 'none';
                return;
            }
            suggestEl.innerHTML = '';
            for (const g of matches.slice(0, 20)) { // Cap at 20 suggestions
                const item = document.createElement('div');
                item.className = 'kern-ac-item';
                item.textContent = g;
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // Prevent blur
                    addMember(g);
                });
                suggestEl.appendChild(item);
            }
            suggestEl.style.display = '';
        };

        const addMember = (glyphName) => {
            if (!glyphName) return;
            const cur = currentMembers();
            if (cur.has(glyphName)) return;
            cur.add(glyphName);
            km.setClass(side, this._selectedClassName, [...cur]);
            inputEl.value = '';
            suggestEl.style.display = 'none';
            this._markDirty();
            renderChips();
            this._renderClasses(); // Update count
        };

        inputEl.addEventListener('input', () => {
            showSuggestions(inputEl.value.trim());
        });

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = inputEl.value.trim();
                if (val) addMember(val);
            } else if (e.key === 'Escape') {
                inputEl.value = '';
                suggestEl.style.display = 'none';
            }
        });

        inputEl.addEventListener('blur', () => {
            // Delay hide so mousedown on suggestion fires first
            setTimeout(() => { suggestEl.style.display = 'none'; }, 150);
        });

        inputEl.addEventListener('focus', () => {
            if (inputEl.value.trim()) showSuggestions(inputEl.value.trim());
        });
    }

    // ── Inline editing ──

    /** Start inline editing on a value span. */
    _startEditValue(valSpan, left, right, type) {
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
                    if (type === 'class') {
                        km.setClassValue(left, right, numVal);
                    } else if (type === 'mixed-left') {
                        km.setMixedPair('leftClass', left, right, numVal);
                    } else if (type === 'mixed-right') {
                        km.setMixedPair('rightClass', right, left, numVal);
                    } else {
                        km.setPair(left, right, numVal);
                    }
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

        // Merge exact pairs + class-to-class + mixed class-glyph values into one unified list
        const entries = [];
        if (km) {
            for (const { left, right, value } of km.getAllPairs()) {
                entries.push({ left, right, value, type: 'pair' });
            }
            for (const { leftClass, rightClass, value } of km.getAllClassValues()) {
                entries.push({ left: leftClass, right: rightClass, value, type: 'class' });
            }
            for (const { type: mixType, className, glyphName, value } of km.getAllMixedPairs()) {
                if (mixType === 'leftClass') {
                    entries.push({ left: className, right: glyphName, value, type: 'mixed-left' });
                } else {
                    entries.push({ left: glyphName, right: className, value, type: 'mixed-right' });
                }
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
            const key = el.dataset.left + '|' + el.dataset.right + '|' + el.dataset.type;
            existingRows.set(key, el);
        });

        const seenKeys = new Set();

        for (const { left, right, value, type } of entries) {
            const key = left + '|' + right + '|' + type;
            seenKeys.add(key);

            const leftLabel = (type === 'class' || type === 'mixed-left') ? '[' + left + ']' : left;
            const rightLabel = (type === 'class' || type === 'mixed-right') ? '[' + right + ']' : right;

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
                row.dataset.type = type;

                row.innerHTML = `
                    <span class="kern-pair-left">${esc(leftLabel)}</span>
                    <span class="kern-pair-arrow">&rarr;</span>
                    <span class="kern-pair-right">${esc(rightLabel)}</span>
                    <span class="kern-pair-value">${value}</span>
                    <button class="kern-pair-remove" title="Remove">&times;</button>
                `;

                row.querySelector('.kern-pair-remove').addEventListener('click', () => {
                    this._removeEntry(left, right, type);
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

    show(anchorEl) {
        this.classList.add('visible');
        this._visible = true;

        // Full refresh
        this._populateGlyphSelects();
        this._renderPairs();
        if (this._activeTab === 'classes') this._renderClasses();

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
