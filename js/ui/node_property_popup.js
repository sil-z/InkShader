import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { initResizeHandles, bringToFront } from "./popup_utils.js";

export const NODE_PROPS_DOCKED = 'npp:docked';
export const NODE_PROPS_UNDOCKED = 'npp:undocked';

const POPUP_HTML = `
<div class="property_group_title npp-drag-handle" id="npp_drag_handle">Node Properties</div>
<div class="npp-fields">
    <div class="npp-row">
        <label>Pos</label>
        <div class="npp-input-group">
            <span class="npp-axis">X</span>
            <input type="number" step="0.1" id="npp_x">
            <span class="npp-axis">Y</span>
            <input type="number" step="0.1" id="npp_y">
        </div>
    </div>
    <div class="npp-row">
        <label>In</label>
        <div class="npp-input-group">
            <span class="npp-axis">X</span>
            <input type="number" step="0.1" id="npp_in_x">
            <span class="npp-axis">Y</span>
            <input type="number" step="0.1" id="npp_in_y">
        </div>
    </div>
    <div class="npp-row">
        <label>Out</label>
        <div class="npp-input-group">
            <span class="npp-axis">X</span>
            <input type="number" step="0.1" id="npp_out_x">
            <span class="npp-axis">Y</span>
            <input type="number" step="0.1" id="npp_out_y">
        </div>
    </div>
    <div class="npp-row">
        <label>Angle</label>
        <div class="npp-input-group">
            <span class="npp-axis">In</span>
            <input type="number" step="1" id="npp_in_a">
            <span class="npp-axis">Out</span>
            <input type="number" step="1" id="npp_out_a">
        </div>
    </div>
</div>`;

const REALTIME_IDS = ['npp_x', 'npp_y', 'npp_in_x', 'npp_in_y', 'npp_out_x', 'npp_out_y', 'npp_in_a', 'npp_out_a'];
const POS_KEY = 'npp_pos';
const DOCK_KEY = 'npp_docked';

export class NodePropertyPopup extends HTMLElement {
    constructor() {
        super();
        this.interaction = createEmptyEditorInteractionState();
        this._anchorNodeId = null;
        this._globalCleanups = [];
        this._dragging = false;
        this._dragSX = 0;
        this._dragSY = 0;
        this._dragSL = 0;
        this._dragST = 0;
        this._focusedInput = null;
        this._docked = false;
        this._positionReady = false;
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
                this._patchValues(this._anchorNodeId);
            }
        });

        this.container.addEventListener('input', (e) => {
            if (!REALTIME_IDS.includes(e.target.id)) return;
            const numVal = e.target.valueAsNumber;
            if (isNaN(numVal)) return;
            const marker = this._resolveMarker(this._anchorNodeId);
            if (!marker) return;
            const propMap = {
                'npp_x': 'prop_x', 'npp_y': 'prop_y',
                'npp_in_x': 'prop_in_x', 'npp_in_y': 'prop_in_y',
                'npp_out_x': 'prop_out_x', 'npp_out_y': 'prop_out_y',
                'npp_in_a': 'prop_in_a', 'npp_out_a': 'prop_out_a'
            };
            const propId = propMap[e.target.id];
            if (propId) CanvasDispatcher.requestUpdateNodeProperty(marker, propId, numVal, { recordHistory: false });
        });

        this.container.addEventListener('change', (e) => {
            if (!REALTIME_IDS.includes(e.target.id)) return;
            const numVal = e.target.valueAsNumber;
            if (isNaN(numVal)) return;
            const marker = this._resolveMarker(this._anchorNodeId);
            if (!marker) return;
            const propMap = {
                'npp_x': 'prop_x', 'npp_y': 'prop_y',
                'npp_in_x': 'prop_in_x', 'npp_in_y': 'prop_in_y',
                'npp_out_x': 'prop_out_x', 'npp_out_y': 'prop_out_y',
                'npp_in_a': 'prop_in_a', 'npp_out_a': 'prop_out_a'
            };
            const propId = propMap[e.target.id];
            if (propId) CanvasDispatcher.requestUpdateNodeProperty(marker, propId, numVal, { recordHistory: true });
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStoreStateChanged(e));
        this.addGlobalListener(appEventBus, NODE_PROPS_UNDOCKED, (e) => this._onUndocked(e));

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

        const anchorId = nextState.draggingNodeId ||
            (Array.isArray(nextState.selectedNodeIds) && nextState.selectedNodeIds.length > 0
                ? nextState.selectedNodeIds[nextState.selectedNodeIds.length - 1]
                : null);

        if (!anchorId) {
            if (this._docked) {
                this._hide();
                appEventBus.emit(NODE_PROPS_DOCKED, { anchorId: null });
                return;
            }
            this._hide();
            return;
        }

        this._anchorNodeId = anchorId;

        if (this._docked) {
            this._hide();
            appEventBus.emit(NODE_PROPS_DOCKED, { anchorId: this._anchorNodeId });
            return;
        }

        if (!this._focusedInput) {
            this._patchValues(anchorId);
        }
        this._show();
    }

    _resolveMarker(anchorId) {
        if (!anchorId) return null;
        return EditorModel.resolveNodeMarker(anchorId);
    }

    _patchValues(anchorId) {
        if (!anchorId) return;
        const node = EditorModel.getNodeReadByMarkerId(anchorId);
        if (!node) return;

        const patch = (id, val, disable = false) => {
            const el = this.container.querySelector(`#${id}`);
            if (!el) return;
            if (el === this._focusedInput) return;
            if (disable) {
                el.disabled = true;
                el.value = '';
            } else {
                el.disabled = false;
                el.value = val;
            }
        };

        patch('npp_x', node.x.toFixed(1));
        patch('npp_y', node.y.toFixed(1));

        const hasC1 = !!node.control1;
        patch('npp_in_x', hasC1 ? node.control1.x.toFixed(1) : '', !hasC1);
        patch('npp_in_y', hasC1 ? node.control1.y.toFixed(1) : '', !hasC1);
        patch('npp_in_a', hasC1
            ? (Math.atan2(node.control1.y - node.y, node.control1.x - node.x) * 180 / Math.PI).toFixed(1)
            : '', !hasC1);

        const hasC2 = !!node.control2;
        patch('npp_out_x', hasC2 ? node.control2.x.toFixed(1) : '', !hasC2);
        patch('npp_out_y', hasC2 ? node.control2.y.toFixed(1) : '', !hasC2);
        patch('npp_out_a', hasC2
            ? (Math.atan2(node.control2.y - node.y, node.control2.x - node.x) * 180 / Math.PI).toFixed(1)
            : '', !hasC2);
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
            appEventBus.emit(NODE_PROPS_DOCKED, { anchorId: this._anchorNodeId });
        }
    }

    _restoreDockedState() {
        let docked = true;
        try {
            const v = localStorage.getItem(DOCK_KEY);
            if (v === '0') docked = false;
        } catch (_) {
            // localStorage unavailable — stay with default (docked)
        }
        this._docked = docked;
        if (docked) {
            appEventBus.emit(NODE_PROPS_DOCKED, { anchorId: this._anchorNodeId });
        }
    }

    _onUndocked(e) {
        this._setDocked(false);
        if (e?.detail) {
            const vw = window.innerWidth, vh = window.innerHeight;
            const pw = this.offsetWidth || 220, ph = this.offsetHeight || 120;
            let nl = e.detail.x - pw / 2;
            let nt = e.detail.y - ph / 2;
            nl = Math.max(0, Math.min(nl, vw - pw));
            nt = Math.max(0, Math.min(nt, vh - ph));
            this.style.left = nl + 'px';
            this.style.top = nt + 'px';
            this._savePosition();
        }
        if (this._anchorNodeId) {
            if (!this._focusedInput) this._patchValues(this._anchorNodeId);
            this._show();
        }
    }

    _restorePosition() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const pw = this.offsetWidth || 240, ph = this.offsetHeight || 140;
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
        this.style.top = '16px';
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

            const isTitle = e.target.id === 'npp_drag_handle';
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
                    propPanel.classList.toggle('npp-drop-target', over);
                }
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._dragging = false;

                if (isTitle && propPanel) {
                    propPanel.classList.remove('npp-drop-target');
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

customElements.define('node-property-popup', NodePropertyPopup);
