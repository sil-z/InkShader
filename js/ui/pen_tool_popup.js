import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import {
    installEnterBlurHandler,
    isValidNumber,
    numberFromInput,
    restoreRememberedInputValue,
    rememberInputValue
} from "./input_validation.js";

const POPUP_HTML = `
<div class="property_group_title" data-i18n="prop.pen_settings">Pen Tool Settings</div>
<div class="npp-fields">
    <div class="npp-row">
        <label data-i18n="prop.weight">Weight</label>
        <input type="number" min="0" step="1" id="pen_popup_stroke">
    </div>
    <div class="npp-row">
        <label data-i18n="prop.closed">Closed</label>
        <input type="checkbox" id="pen_popup_closed">
    </div>
    <div class="npp-row">
        <label data-i18n="prop.smart">Smart</label>
        <input type="checkbox" id="pen_popup_smart_stroke">
    </div>
    <div class="npp-row">
        <label data-i18n="prop.skel">Skeleton</label>
        <input type="checkbox" id="pen_popup_show_skel">
    </div>
</div>`;

export class PenToolPopup extends HTMLElement {
    constructor() {
        super();
        this._globalCleanups = [];
        this._drawToolSettings = null;
        this._visible = false;
        this._focusedInput = null;
        this._strokeSnapshot = null;
    }

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
        installEnterBlurHandler(this);

        this.addEventListener('focusin', (e) => {
            if (e.target.tagName !== 'INPUT') return;
            this._focusedInput = e.target;
            rememberInputValue(this, e.target);
            if (e.target.id === 'pen_popup_stroke') {
                this._strokeSnapshot = this._drawToolSettings?.stroke_width ?? numberFromInput(e.target);
            }
        });

        this.addEventListener('focusout', (e) => {
            if (e.target.tagName !== 'INPUT') return;
            this._focusedInput = null;
            if (e.target.id === 'pen_popup_stroke' && !isValidNumber(numberFromInput(e.target), { min: 0 })) {
                this._restoreStrokeInput(e.target);
            }
        });

        this.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('pen_popup_')) return;
            this._dispatchChange(e.target);
        });

        this.addEventListener('input', (e) => {
            if (e.target.id === 'pen_popup_stroke') {
                if (!isValidNumber(numberFromInput(e.target), { min: 0 })) return;
                this._dispatchChange(e.target, false);
            }
        });

        this.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStateChanged(e));

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
            if (!this.contains(e.target)) {
                this.hide();
            }
        }, true);
    }

    disconnectedCallback() {
        this._globalCleanups.forEach(fn => fn());
        this._globalCleanups = [];
    }

    _handleStateChanged(e) {
        const nextState = e?.detail?.afterState;
        // Only accept drawToolSettings from actions that actually update them.
        // Other actions (SET_SEQUENCE_EDITOR_STATE, CHANGE_OBJECT_SELECTION, etc.)
        // carry stale boot defaults that would overwrite canvas-persisted values.
        if (nextState?.drawToolSettings) {
            const actionType = e.detail?.action?.type;
            if (actionType === 'SET_DRAW_TOOL_SETTINGS' || actionType === 'SEED_FROM_RUNTIME' || actionType === '__INIT__') {
                this._drawToolSettings = nextState.drawToolSettings;
            }
        }
        if (this._visible) {
            this._patchValues();
        }
    }

    _patchValues() {
        if (!this._drawToolSettings) return;
        const t = this._drawToolSettings;
        const patch = (id, val) => {
            const el = this.querySelector(`#${id}`);
            if (!el) return;
            if (el.type === 'checkbox') {
                el.checked = val;
            } else {
                if (el === this._focusedInput) return;
                el.value = val != null ? String(val) : '';
            }
        };
        patch('pen_popup_stroke', t.stroke_width);
        patch('pen_popup_closed', t.closed);
        patch('pen_popup_smart_stroke', t.smart_expand);
        patch('pen_popup_show_skel', t.show_skeleton);
    }

    _dispatchChange(target, recordHistory = true) {
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : target.value.trim();
        const numVal = numberFromInput(target);
        const propMap = {
            'pen_popup_stroke': 'stroke_width',
            'pen_popup_closed': 'closed',
            'pen_popup_smart_stroke': 'smart_expand',
            'pen_popup_show_skel': 'show_skeleton'
        };
        const prop = propMap[id];
        if (prop) {
            if (prop === 'stroke_width' && !isValidNumber(numVal, { min: 0 })) {
                this._restoreStrokeInput(target);
                return;
            }
            // Immediately update local copy so _patchValues (called via _handleStateChanged)
            // reads the fresh value before the state event round-trips.
            if (this._drawToolSettings) {
                this._drawToolSettings[prop] = target.type === 'checkbox' ? val : numVal;
            }
            CanvasDispatcher.requestSetPenProperties(
                { [prop]: (target.type === 'checkbox' ? val : numVal) },
                { recordHistory }
            );
        }
    }

    _restoreStrokeInput(target) {
        const fallback = this._strokeSnapshot != null ? String(this._strokeSnapshot) : '';
        restoreRememberedInputValue(this, target, fallback);
        if (Number.isFinite(Number(this._strokeSnapshot)) && Number(this._strokeSnapshot) >= 0) {
            CanvasDispatcher.requestSetPenProperties(
                { stroke_width: Number(this._strokeSnapshot) },
                { recordHistory: false }
            );
        }
    }

    show(anchorEl) {
        // Always prefer canvas.drawToolSettings as source of truth (persisted value).
        if (window.__canvas?.drawToolSettings) {
            this._drawToolSettings = { ...window.__canvas.drawToolSettings };
        }
        this._patchValues();
        this.classList.add('visible');

        requestAnimationFrame(() => {
            const rect = anchorEl.getBoundingClientRect();
            let left = rect.right + 2;
            let top = rect.top;
            const popupRect = this.getBoundingClientRect();

            if (left + popupRect.width > window.innerWidth - 4) {
                left = rect.left - popupRect.width - 2;
            }
            if (top + popupRect.height > window.innerHeight - 4) {
                top = window.innerHeight - popupRect.height - 4;
            }
            if (top < 4) top = 4;

            this.style.left = left + 'px';
            this.style.top = top + 'px';
        });
        this._visible = true;
    }

    hide() {
        this.classList.remove('visible');
        this._visible = false;
    }
}

customElements.define('pen-tool-popup', PenToolPopup);
