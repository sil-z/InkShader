import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";

const POPUP_HTML = `
<div class="pen-tool-popup-header" data-i18n="prop.pen_settings">Pen Tool Settings</div>
<div class="pen-tool-popup-body">
    <div class="pen-tool-row">
        <label data-i18n="prop.weight">Weight</label>
        <input type="number" min="0" step="1" id="pen_popup_stroke">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="prop.closed">Closed</label>
        <input type="checkbox" id="pen_popup_closed">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="prop.smart">Smart</label>
        <input type="checkbox" id="pen_popup_smart_stroke">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="prop.skel">Skeleton</label>
        <input type="checkbox" id="pen_popup_show_skel">
    </div>
    <div class="pen-tool-separator"></div>
    <div class="pen-tool-row">
        <button type="button" id="pen_popup_finish_path" class="pen-tool-finish-btn">Finish Path</button>
    </div>
</div>`;

export class PenToolPopup extends HTMLElement {
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
            if (!id || !id.startsWith('pen_popup_')) return;
            this._dispatchChange(e.target);
        });

        this.addEventListener('input', (e) => {
            if (e.target.id === 'pen_popup_stroke') {
                this._dispatchChange(e.target, false);
            }
        });

        this.addEventListener('click', (e) => {
            if (e.target.id === 'pen_popup_finish_path') {
                this._finishPath();
                this.hide();
            }
        });

        this.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStateChanged(e));

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
            if (e.button !== 0) return;
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
        patch('pen_popup_stroke', t.stroke_width);
        patch('pen_popup_closed', t.closed);
        patch('pen_popup_smart_stroke', t.smart_expand);
        patch('pen_popup_show_skel', t.show_skeleton);
    }

    _dispatchChange(target, recordHistory = true) {
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : target.value.trim();
        const numVal = target.type === 'number' ? target.valueAsNumber : parseFloat(val);
        const propMap = {
            'pen_popup_stroke': 'stroke_width',
            'pen_popup_closed': 'closed',
            'pen_popup_smart_stroke': 'smart_expand',
            'pen_popup_show_skel': 'show_skeleton'
        };
        const prop = propMap[id];
        if (prop) {
            CanvasDispatcher.requestSetPenProperties(
                { [prop]: (target.type === 'checkbox' ? val : numVal) },
                { recordHistory }
            );
        }
    }

    _finishPath() {
        CanvasDispatcher.requestFinishDrawingPath();
    }

    show(clientX, clientY) {
        this._patchValues();
        this.style.left = clientX + 'px';
        this.style.top = clientY + 'px';
        this.classList.add('visible');

        const rect = this.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.style.left = (clientX - rect.width) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            this.style.top = (clientY - rect.height) + 'px';
        }
        this._visible = true;
    }

    hide() {
        this.classList.remove('visible');
        this._visible = false;
    }
}

customElements.define('pen-tool-popup', PenToolPopup);
