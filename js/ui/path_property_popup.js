import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import * as EditorModel from "../app/editor_read_facade.js";

export const PATH_PROPS_DOCKED = 'ppp:docked';
export const PATH_PROPS_UNDOCKED = 'ppp:undocked';

const POPUP_HTML = `
<div class="property_group_title npp-drag-handle" id="ppp_drag_handle" data-i18n="prop.path_props">Path Properties</div>
<div class="npp-fields ppp-fields">
    <div class="ppp-row ppp-path-field">
        <label data-i18n="prop.weight">Weight</label>
        <input type="number" min="0" step="1" id="ppp_stroke">
    </div>
    <div class="ppp-row ppp-path-field">
        <label data-i18n="prop.closed">Closed</label>
        <input type="checkbox" id="ppp_closed">
    </div>
    <div class="ppp-row ppp-path-field">
        <label data-i18n="prop.smart">Smart</label>
        <input type="checkbox" id="ppp_smart_stroke">
    </div>
    <div class="ppp-row ppp-path-field">
        <label data-i18n="prop.skel">Skeleton</label>
        <input type="checkbox" id="ppp_show_skel">
    </div>
    <div class="ppp-row ppp-single-path">
        <label data-i18n="prop.name">Name</label>
        <input type="text" id="ppp_name">
    </div>
    <div class="ppp-row ppp-single-path">
        <label data-i18n="prop.path_direction">Path Direction</label>
        <div class="prop_direction_controls">
            <button type="button" id="ppp_reverse_dir_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
            <span id="ppp_direction" class="prop_direction_label">—</span>
        </div>
    </div>
    <div class="ppp-row ppp-single-path">
        <label data-i18n="prop.smart_expand_direction">Smart Expand Direction</label>
        <div class="prop_direction_controls">
            <button type="button" id="ppp_smart_winding_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
            <span id="ppp_smart_winding" class="prop_direction_label">—</span>
        </div>
    </div>
</div>`;

const POS_KEY = 'ppp_pos';
const DOCK_KEY = 'ppp_docked';

export class PathPropertyPopup extends HTMLElement {
    constructor() {
        super();
        this._selectedCurveIds = [];
        this._selectedTreeIds = [];
        this._globalCleanups = [];
        this._dragging = false;
        this._dragSX = 0;
        this._dragSY = 0;
        this._dragSL = 0;
        this._dragST = 0;
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
                this._commitChange(e.target);
            }
        });

        this.container.addEventListener('input', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('ppp_')) return;
            if (e.target.type === 'checkbox') return;
            if (id === 'ppp_stroke') {
                this._dispatchChange(e.target, false);
            }
        });

        this.container.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('ppp_')) return;
            this._dispatchChange(e.target, true);
        });

        this.container.addEventListener('click', (e) => {
            const reverseBtn = e.target.closest('#ppp_reverse_dir_toggle');
            if (reverseBtn) {
                this._handleReverseDirection();
                return;
            }
            const windingBtn = e.target.closest('#ppp_smart_winding_toggle');
            if (windingBtn) {
                this._handleSmartWindingToggle();
            }
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this._handleStoreStateChanged(e));
        this.addGlobalListener(appEventBus, PATH_PROPS_UNDOCKED, (e) => this._onUndocked(e));

        this._restoreDockedState();
        this._initDrag();
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

        const selIds = nextState.selectedTreeIds || [];
        const curves = [];
        selIds.forEach(id => {
            const it = EditorModel.getTreeItem(id);
            if (it && it.type === 'curve') {
                const curve = EditorModel.getCurveById(it.curveId);
                if (curve) curves.push(curve);
            }
        });

        if (curves.length === 0) {
            if (this._docked) {
                appEventBus.emit(PATH_PROPS_DOCKED, { curveIds: [], treeIds: [] });
            }
            this._hide();
            return;
        }

        this._selectedCurveIds = selIds.filter(id => {
            const it = EditorModel.getTreeItem(id);
            return it && it.type === 'curve';
        });
        this._selectedTreeIds = [...selIds];

        const singlePathEls = this.container.querySelectorAll('.ppp-single-path');
        const pathFieldEls = this.container.querySelectorAll('.ppp-path-field');
        if (curves.length === 1) {
            singlePathEls.forEach(el => el.style.display = '');
            pathFieldEls.forEach(el => el.style.display = '');
        } else {
            singlePathEls.forEach(el => el.style.display = 'none');
            pathFieldEls.forEach(el => el.style.display = '');
        }

        if (this._docked) {
            this._hide();
            appEventBus.emit(PATH_PROPS_DOCKED, { curveIds: this._selectedCurveIds, treeIds: this._selectedTreeIds });
            return;
        }

        if (!this._focusedInput) this._patchValues(curves);
        this._show();
    }

    _patchValues(curves) {
        const patch = (id, val, disable = false) => {
            const el = this.container.querySelector(`#${id}`);
            if (!el) return;
            if (el === this._focusedInput) return;
            if (el.type === 'checkbox') {
                el.checked = val;
            } else {
                el.value = val != null ? String(val) : '';
            }
            if (disable !== undefined) el.disabled = !!disable;
        };

        if (!curves || curves.length === 0) return;

        const curve = curves[0];
        patch('ppp_stroke', curve.stroke_width);

        const getTreeItem = () => {
            if (this._selectedTreeIds.length > 0) return EditorModel.getTreeItem(this._selectedTreeIds[0]);
            return null;
        };

        if (curves.length === 1) {
            patch('ppp_closed', curve.closed);
            patch('ppp_smart_stroke', curve.smart_stroke);
            patch('ppp_show_skel', curve.show_skeleton);

            const item = getTreeItem();
            patch('ppp_name', item?.name ?? '');

            const winding = curve.skeletonWinding ?? 'open';
            const dirText = winding === 'cw' ? 'Clockwise' : winding === 'ccw' ? 'Counter-clockwise' : 'Open';
            const dirEl = this.container.querySelector('#ppp_direction');
            if (dirEl) dirEl.textContent = dirText;
            const revBtn = this.container.querySelector('#ppp_reverse_dir_toggle');
            if (revBtn) {
                const canReverse = (curve.skeletonVertexCount ?? 0) >= 2;
                revBtn.disabled = !canReverse;
                revBtn.setAttribute('aria-pressed', winding === 'cw' ? 'true' : 'false');
            }

            const smartWinding = curve.smart_stroke_clockwise !== false ? 'cw' : 'ccw';
            const smartDirEl = this.container.querySelector('#ppp_smart_winding');
            if (smartDirEl) smartDirEl.textContent = smartWinding === 'cw' ? 'Clockwise' : 'Counter-clockwise';
            const smartBtn = this.container.querySelector('#ppp_smart_winding_toggle');
            if (smartBtn) {
                const enableSmartWinding = curve.smart_stroke === true;
                smartBtn.disabled = !enableSmartWinding;
                smartBtn.setAttribute('aria-pressed', smartWinding === 'cw' ? 'true' : 'false');
            }
        }
    }

    _dispatchChange(target, recordHistory) {
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : target.value.trim();
        const numVal = target.type === 'number' ? target.valueAsNumber : parseFloat(val);
        const selIds = [...this._selectedTreeIds];

        if (id === 'ppp_stroke') {
            const updates = [];
            selIds.forEach(sid => {
                const item = EditorModel.getTreeItem(sid);
                if (item && item.type === 'curve') {
                    updates.push({ id: sid, props: { stroke_width: numVal } });
                }
            });
            if (updates.length > 0) {
                CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory });
            }
            return;
        }

        if (['ppp_closed', 'ppp_smart_stroke', 'ppp_show_skel'].includes(id)) {
            const propMap = {
                'ppp_closed': 'closed',
                'ppp_smart_stroke': 'smart_stroke',
                'ppp_show_skel': 'show_skeleton'
            };
            const prop = propMap[id];
            const updates = [];
            selIds.forEach(sid => {
                const item = EditorModel.getTreeItem(sid);
                if (item && item.type === 'curve') {
                    updates.push({ id: sid, props: { [prop]: val } });
                }
            });
            if (updates.length > 0) {
                CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory });
            }
            return;
        }

        if (id === 'ppp_name') {
            const selId = selIds[0];
            const item = EditorModel.getTreeItem(selId);
            if (item && item.name !== val) {
                const reqDetail = CanvasDispatcher.requestRenameTreeItem(selId, val);
                if (!reqDetail.result) {
                    target.value = item.name;
                }
            }
        }
    }

    _commitChange(target) {
        this._dispatchChange(target, true);
    }

    _handleReverseDirection() {
        const selIds = [...this._selectedTreeIds];
        if (selIds.length !== 1) return;
        const item = EditorModel.getTreeItem(selIds[0]);
        if (!item || item.type !== 'curve') return;
        CanvasDispatcher.requestSetSingleObjectProperties(
            [{ id: item.id, props: { reverse_direction: true } }],
            { recordHistory: true }
        );
    }

    _handleSmartWindingToggle() {
        const selIds = [...this._selectedTreeIds];
        if (selIds.length !== 1) return;
        const item = EditorModel.getTreeItem(selIds[0]);
        if (!item || item.type !== 'curve') return;
        CanvasDispatcher.requestSetSingleObjectProperties(
            [{ id: item.id, props: { toggle_smart_winding: true } }],
            { recordHistory: true }
        );
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
            appEventBus.emit(PATH_PROPS_DOCKED, { curveIds: this._selectedCurveIds, treeIds: this._selectedTreeIds });
        }
    }

    _restoreDockedState() {
        try {
            const v = localStorage.getItem(DOCK_KEY);
            if (v === '1') this._docked = true;
        } catch (_) {}
    }

    _onUndocked(e) {
        this._docked = false;
        if (e?.detail) {
            const vw = window.innerWidth, vh = window.innerHeight;
            const pw = this.offsetWidth || 240, ph = this.offsetHeight || 260;
            let nl = e.detail.x - pw / 2;
            let nt = e.detail.y - ph / 2;
            nl = Math.max(0, Math.min(nl, vw - pw));
            nt = Math.max(0, Math.min(nt, vh - ph));
            this.style.left = nl + 'px';
            this.style.top = nt + 'px';
            this._savePosition();
        }
        const curves = this._selectedCurveIds.map(id => {
            const item = EditorModel.getTreeItem(id);
            if (item && item.type === 'curve') return EditorModel.getCurveById(item.curveId);
            return null;
        }).filter(Boolean);
        if (!this._focusedInput) this._patchValues(curves);
        this._show();
    }

    _restorePosition() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const pw = this.offsetWidth || 240, ph = this.offsetHeight || 260;
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

    _initDrag() {
        this.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.tagName === 'INPUT') return;
            if (e.target.type === 'checkbox') return;
            if (e.target.closest('.prop_toggle_btn')) return;
            e.preventDefault();
            this._dragging = true;
            this._dragSX = e.clientX;
            this._dragSY = e.clientY;
            this._dragSL = parseFloat(this.style.left) || 0;
            this._dragST = parseFloat(this.style.top) || 0;

            const isTitle = e.target.id === 'ppp_drag_handle';
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
                    propPanel.classList.toggle('ppp-drop-target', over);
                }
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._dragging = false;

                if (isTitle && propPanel) {
                    propPanel.classList.remove('ppp-drop-target');
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

customElements.define('path-property-popup', PathPropertyPopup);
