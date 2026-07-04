import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";

const POPUP_HTML = `
<div class="property_group_title">Ellipse Tool Settings</div>
<div class="npp-fields">
    <div class="npp-row">
        <label data-i18n="prop.weight">Weight</label>
        <input type="number" min="0" step="1" id="ellipse_popup_stroke">
    </div>
    <div class="npp-row">
        <label data-i18n="prop.closed">Closed</label>
        <input type="checkbox" id="ellipse_popup_closed" checked disabled>
    </div>
    <div class="npp-row">
        <label data-i18n="prop.smart">Smart</label>
        <input type="checkbox" id="ellipse_popup_smart_stroke">
    </div>
    <div class="npp-row">
        <label data-i18n="prop.skel">Skeleton</label>
        <input type="checkbox" id="ellipse_popup_show_skel">
    </div>
    <div class="pen-tool-actions">
        <button type="button" id="ellipse_popup_cancel" class="btn-cancel">Cancel</button>
        <button type="button" id="ellipse_popup_ok" class="btn-ok">OK</button>
    </div>
</div>`;

export class EllipseToolPopup extends HTMLElement {
    constructor() {
        super();
        this._globalCleanups = [];
        this._drawToolSettings = null;
        this._visible = false;
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

        this.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('ellipse_popup_')) return;
            this._dispatchChange(e.target);
        });

        this.addEventListener('input', (e) => {
            if (e.target.id === 'ellipse_popup_stroke') {
                this._dispatchChange(e.target, false);
            }
        });

        this.addEventListener('click', (e) => {
            if (e.target.id === 'ellipse_popup_ok') {
                this.hide();
            } else if (e.target.id === 'ellipse_popup_cancel') {
                this.hide();
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
        if (nextState?.drawToolSettings) {
            this._drawToolSettings = nextState.drawToolSettings;
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
                el.value = val != null ? String(val) : '';
            }
        };
        patch('ellipse_popup_stroke', t.stroke_width);
        patch('ellipse_popup_smart_stroke', t.smart_expand);
        patch('ellipse_popup_show_skel', t.show_skeleton);
    }

    _dispatchChange(target, recordHistory = true) {
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : target.value.trim();
        const numVal = target.type === 'number' ? target.valueAsNumber : parseFloat(val);
        const propMap = {
            'ellipse_popup_stroke': 'stroke_width',
            'ellipse_popup_smart_stroke': 'smart_expand',
            'ellipse_popup_show_skel': 'show_skeleton'
        };
        const prop = propMap[id];
        if (prop) {
            CanvasDispatcher.requestSetPenProperties(
                { [prop]: (target.type === 'checkbox' ? val : numVal) },
                { recordHistory }
            );
        }
    }

    show(anchorEl) {
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

customElements.define('ellipse-tool-popup', EllipseToolPopup);
