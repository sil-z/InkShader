import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { initResizeHandles, bringToFront } from "./popup_utils.js";

export const GRP_DOCKED = 'grp:docked';

const POPUP_HTML = `
<div class="property_group_title npp-drag-handle" id="grp_drag_handle" data-i18n="prop.group_settings">Group Settings</div>
<div class="npp-fields">
    <div class="npp-row"><label>Name</label><input type="text" id="grp_name"></div>
    <div class="npp-row"><label>Char</label><input type="text" id="grp_char"></div>
    <div class="npp-row"><label>Advance</label><input type="number" id="grp_advance"></div>
</div>`;

const POS_KEY = 'grp_pos';
const DOCK_KEY = 'grp_docked';

export class GroupSettingsPopup extends HTMLElement {
    constructor() {
        super();
        this.interaction = createEmptyEditorInteractionState();
        this._groupId = null;
        this._globalCleanups = [];
        this._dragging = false;
        this._dragSX = 0;
        this._dragSY = 0;
        this._dragSL = 0;
        this._dragST = 0;
        this._docked = false;
        this._positionReady = false;
        this._focusedInput = null;
    }

    get docked() { return this._docked; }

    addGlobalListener(target, type, listener, options = false) {
        if (target === window || target === appEventBus) {
            const cleanup = target === appEventBus
                ? target.on(type, listener, options)
                : appEventBus.on(type, listener, options);
            this._globalCleanups.push(cleanup);
            return;
        }
        target.addEventListener(type, listener, options);
        this._globalCleanups.push(() => target.removeEventListener(type, listener, options));
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;

        this.innerHTML = POPUP_HTML;
        this.container = this;

        this.container.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
                e.preventDefault();
                e.target.blur();
            }
        });

        this.container.addEventListener('focusin', (e) => {
            if (e.target.tagName === 'INPUT') this._focusedInput = e.target;
        });
        this.container.addEventListener('focusout', (e) => {
            if (e.target.tagName === 'INPUT') {
                this._focusedInput = null;
                this._commitChange(e.target);
            }
        });

        this.container.addEventListener('input', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('grp_')) return;
            this._dispatchChange(e.target, false);
        });

        this.container.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('grp_')) return;
            this._dispatchChange(e.target, true);
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStoreStateChanged(e));

        this._restoreDockedState();
        this._initDrag();
        this._initResize();
        this.addEventListener('mousedown', () => bringToFront(this));
    }

    disconnectedCallback() {
        this._globalCleanups.forEach(fn => fn());
        this._globalCleanups = [];
    }

    _handleStoreStateChanged(e) {
        const nextState = e?.detail?.afterState;
        if (!nextState || typeof nextState !== 'object') {
            this._hide();
            return;
        }

        // Get active group from state
        const activeGroupId = nextState.activeGroupId || this.interaction.activeGroupId;
        if (!activeGroupId) {
            this._hide();
            return;
        }

        const item = EditorModel.getTreeItem(activeGroupId);
        if (!item || item.type !== 'group' || item.isRef) {
            this._hide();
            return;
        }

        this._groupId = activeGroupId;
        this.interaction.applyEventDetail(e?.detail);

        if (this._docked) {
            this._hide();
            appEventBus.emit(GRP_DOCKED, { groupId: this._groupId });
            return;
        }

        if (!this._focusedInput) this._patchValues();
        this._show();
    }

    _patchValues() {
        if (!this._groupId) return;
        const item = EditorModel.getTreeItem(this._groupId);
        if (!item) return;
        const patch = (id, val) => {
            const el = this.container.querySelector(`#${id}`);
            if (!el) return;
            if (el === this._focusedInput) return;
            el.value = val != null ? String(val) : '';
        };
        patch('grp_name', item.name);
        patch('grp_char', item.charCode || '');
        patch('grp_advance', item.advance !== undefined ? item.advance : 1000);
    }

    _dispatchChange(target, recordHistory) {
        if (!this._groupId) return;
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : target.value.trim();

        if (id === 'grp_name') {
            const item = EditorModel.getTreeItem(this._groupId);
            if (item && item.name !== val) {
                CanvasDispatcher.requestRenameTreeItem(this._groupId, val);
            }
            return;
        }

        if (id === 'grp_char') {
            const item = EditorModel.getTreeItem(this._groupId);
            if (item) {
                const newVal = val === "" ? null : val;
                if (item.charCode !== newVal) {
                    CanvasDispatcher.requestSetGroupCharCode(this._groupId, newVal, { recordHistory: true });
                }
            }
            return;
        }

        if (id === 'grp_advance') {
            const numVal = target.valueAsNumber;
            if (!isNaN(numVal)) {
                CanvasDispatcher.requestSetGroupAdvance(this._groupId, numVal, { recordHistory });
            }
            return;
        }
    }

    _commitChange(target) {
        this._dispatchChange(target, true);
    }

    _show() {
        this.classList.add('visible');
        if (!this._positionReady) {
            this._positionReady = true;
            requestAnimationFrame(() => this._restorePosition());
        }
    }

    _hide() {
        this.classList.remove('visible');
    }

    _setDocked(docked) {
        this._docked = docked;
        try { localStorage.setItem(DOCK_KEY, docked ? '1' : '0'); } catch (_) {}
        if (docked) {
            this._hide();
            appEventBus.emit(GRP_DOCKED, { groupId: this._groupId });
        }
    }

    _restoreDockedState() {
        try {
            const v = localStorage.getItem(DOCK_KEY);
            if (v === '1') {
                this._docked = true;
            }
        } catch (_) {}
    }

    _restorePosition() {
        const vw = window.innerWidth, vh = window.innerHeight;
        try {
            const saved = JSON.parse(localStorage.getItem(POS_KEY));
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                this.style.left = Math.max(0, Math.min(saved.left, vw - 220)) + 'px';
                this.style.top = Math.max(0, Math.min(saved.top, vh - 100)) + 'px';
                return;
            }
        } catch (_) {}
        this.style.left = Math.max(0, vw - 236) + 'px';
        this.style.top = '50px';
    }

    _savePosition() {
        try {
            localStorage.setItem(POS_KEY, JSON.stringify({
                left: parseFloat(this.style.left) || 0,
                top: parseFloat(this.style.top) || 0
            }));
        } catch (_) {}
    }

    _initResize() {
        initResizeHandles(this, { minW: 320, minH: 140 });
    }

    _initDrag() {
        this.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.tagName === 'INPUT') return;
            e.preventDefault();
            this._dragging = true;
            this._dragSX = e.clientX;
            this._dragSY = e.clientY;
            this._dragSL = parseFloat(this.style.left) || 0;
            this._dragST = parseFloat(this.style.top) || 0;

            const isTitle = e.target.id === 'grp_drag_handle';
            const propPanel = document.querySelector('property-panel');

            const onMove = (ev) => {
                if (!this._dragging) return;
                const vw = window.innerWidth, vh = window.innerHeight;
                const pw = this.offsetWidth, ph = this.offsetHeight;
                let nl = this._dragSL + ev.clientX - this._dragSX;
                let nt = this._dragST + ev.clientY - this._dragSY;
                nl = Math.max(0, Math.min(nl, vw - pw));
                nt = Math.max(0, Math.min(nt, vh - ph));
                this.style.left = nl + 'px';
                this.style.top = nt + 'px';

                if (isTitle && propPanel) {
                    const r = propPanel.getBoundingClientRect();
                    const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
                    propPanel.classList.toggle('grp-drop-target', over);
                }
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._dragging = false;

                if (isTitle && propPanel) {
                    propPanel.classList.remove('grp-drop-target');
                    const r = propPanel.getBoundingClientRect();
                    const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
                    if (over) {
                        this._setDocked(true);
                        return;
                    }
                }
                this._savePosition();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
}

customElements.define('group-settings-popup', GroupSettingsPopup);
