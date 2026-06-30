import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { initResizeHandles, bringToFront } from "./popup_utils.js";

export const BBOX_DOCKED = 'bbox:docked';
export const BBOX_UNDOCKED = 'bbox:undocked';

const POPUP_HTML = `
<div class="property_group_title npp-drag-handle" id="bbox_drag_handle" data-i18n="prop.bbox">Bounding Box</div>
<div class="npp-fields">
    <div class="npp-row">
        <label>Pos</label>
        <div class="npp-input-group">
            <span class="npp-axis">X</span>
            <input type="number" step="0.1" id="bbox_x">
            <span class="npp-axis">Y</span>
            <input type="number" step="0.1" id="bbox_y">
        </div>
    </div>
    <div class="npp-row">
        <label>Size</label>
        <div class="npp-input-group">
            <span class="npp-axis">W</span>
            <input type="number" step="0.1" id="bbox_w">
            <span class="npp-axis">H</span>
            <input type="number" step="0.1" id="bbox_h">
        </div>
    </div>
</div>`;

const POS_KEY = 'bbox_pos';
const DOCK_KEY = 'bbox_docked';

export class BoundingBoxPopup extends HTMLElement {
    constructor() {
        super();
        this._selectedTreeIds = [];
        this._bounds = null;
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
            if (!id || !id.startsWith('bbox_')) return;
            this._dispatchChange(e.target, false);
        });

        this.container.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('bbox_')) return;
            this._dispatchChange(e.target, true);
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStoreStateChanged(e));
        this.addGlobalListener(appEventBus, BBOX_UNDOCKED, (e) => this._onUndocked(e));

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

        if (nextState.currentTool !== 'SELECT') {
            this._hide();
            return;
        }

        const selIds = nextState.selectedTreeIds || [];
        if (selIds.length === 0) {
            this._hide();
            return;
        }

        this._selectedTreeIds = [...selIds];
        this._bounds = EditorModel.getSelectionBounds('transform');

        if (this._docked) {
            this._hide();
            appEventBus.emit(BBOX_DOCKED, { treeIds: this._selectedTreeIds });
            return;
        }

        if (!this._focusedInput) this._patchValues();
        this._show();
    }

    _patchValues() {
        if (!this._bounds) return;
        const patch = (id, val) => {
            const el = this.container.querySelector(`#${id}`);
            if (!el) return;
            if (el === this._focusedInput) return;
            el.value = val != null ? String(val) : '';
        };
        patch('bbox_x', this._bounds.minX.toFixed(1));
        patch('bbox_y', this._bounds.minY.toFixed(1));
        patch('bbox_w', (this._bounds.maxX - this._bounds.minX).toFixed(1));
        patch('bbox_h', (this._bounds.maxY - this._bounds.minY).toFixed(1));
    }

    _dispatchChange(target, recordHistory) {
        const id = target.id;
        const numVal = target.valueAsNumber;
        if (isNaN(numVal)) return;
        const propMap = { 'bbox_x': 'x', 'bbox_y': 'y', 'bbox_w': 'w', 'bbox_h': 'h' };
        const prop = propMap[id];
        if (!prop) return;
        const isSizeProp = (prop === 'w' || prop === 'h');
        const isValidSize = !isSizeProp || numVal >= 0;
        if (!isValidSize) {
            if (recordHistory) this._patchValues();
            return;
        }
        CanvasDispatcher.requestChangeSelectedObjectsBounds(prop, numVal, {
            recordHistory,
            useBoundsSession: isSizeProp,
            commitBoundsSession: isSizeProp && recordHistory
        });
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
            appEventBus.emit(BBOX_DOCKED, { treeIds: this._selectedTreeIds });
        }
    }

    _restoreDockedState() {
        try {
            const v = localStorage.getItem(DOCK_KEY);
            if (v === '1') {
                this._docked = true;
                appEventBus.emit(BBOX_DOCKED);
            }
        } catch (_) {}
    }

    _onUndocked(e) {
        this._setDocked(false);
        if (e?.detail) {
            const vw = window.innerWidth, vh = window.innerHeight;
            const pw = this.offsetWidth || 220, ph = this.offsetHeight || 80;
            let nl = e.detail.x - pw / 2;
            let nt = e.detail.y - ph / 2;
            nl = Math.max(0, Math.min(nl, vw - pw));
            nt = Math.max(0, Math.min(nt, vh - ph));
            this.style.left = nl + 'px';
            this.style.top = nt + 'px';
            this._savePosition();
        }
        if (!this._focusedInput) this._patchValues();
        this._show();
    }

    _restorePosition() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const pw = this.offsetWidth || 220, ph = this.offsetHeight || 80;
        try {
            const saved = JSON.parse(localStorage.getItem(POS_KEY));
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                let nl = Math.max(0, Math.min(saved.left, vw - pw));
                let nt = Math.max(0, Math.min(saved.top, vh - ph));
                this.style.left = nl + 'px';
                this.style.top = nt + 'px';
                return;
            }
        } catch (_) {}
        this.style.left = Math.max(0, vw - pw - 16) + 'px';
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
        initResizeHandles(this, { minW: 320, minH: 120 });
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

            const isTitle = e.target.id === 'bbox_drag_handle';
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
                    propPanel.classList.toggle('bbox-drop-target', over);
                }
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._dragging = false;

                if (isTitle && propPanel) {
                    propPanel.classList.remove('bbox-drop-target');
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

customElements.define('bounding-box-popup', BoundingBoxPopup);
