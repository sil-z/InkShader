import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { initResizeHandles, bringToFront } from "./popup_utils.js";
import {
    installEnterBlurHandler,
    isValidNumber,
    isValidTreeName,
    numberFromInput,
    restoreRememberedInputValue,
    rememberInputValue,
    trimmedInputValue
} from "./input_validation.js";

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
            <div class="prop_direction_text_toggle" role="button" tabindex="0" id="ppp_reverse_dir_wrapper">
                <input type="text" readonly class="prop_direction_input" id="ppp_direction_text" value="">
                <button type="button" id="ppp_reverse_dir_toggle" class="prop_toggle_btn" aria-pressed="false" disabled></button>
            </div>
    </div>
    <div class="ppp-row ppp-single-path">
        <label data-i18n="prop.smart_expand_direction">Smart Expand Direction</label>
            <div class="prop_direction_text_toggle" role="button" tabindex="0" id="ppp_smart_winding_wrapper">
                <input type="text" readonly class="prop_direction_input" id="ppp_smart_winding_text" value="">
                <button type="button" id="ppp_smart_winding_toggle" class="prop_toggle_btn" aria-pressed="false" disabled></button>
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
        this._togglingDirection = false;
        this._strokeSnapshot = null;
        this._skipCommitTarget = null;
        this._hadCurves = false;
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

        installEnterBlurHandler(this.container);

        this.container.addEventListener('focusin', (e) => {
            if (e.target.tagName === 'INPUT') {
                this._focusedInput = e.target;
                rememberInputValue(this, e.target);
                if (e.target.id === 'ppp_stroke') this._captureStrokeSnapshot();
            }
        });
        this.container.addEventListener('focusout', (e) => {
            if (e.target.tagName === 'INPUT') {
                this._focusedInput = null;
                if (this._skipCommitTarget === e.target) {
                    this._skipCommitTarget = null;
                    return;
                }
                if (this._isValidFinalInput(e.target)) {
                    this._commitChange(e.target);
                } else {
                    this._restoreInput(e.target);
                }
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
            const dirTextToggle = e.target.closest('.prop_direction_text_toggle');
            if (dirTextToggle) {
                const toggleBtn = dirTextToggle.querySelector('.prop_toggle_btn');
                if (toggleBtn && !toggleBtn.disabled) {
                    const id = toggleBtn.id;
                    if (id === 'ppp_reverse_dir_toggle') {
                        this._handleReverseDirection();
                    } else if (id === 'ppp_smart_winding_toggle') {
                        this._handleSmartWindingToggle();
                    }
                }
                return;
            }
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
        this._initResize();
        this.addEventListener('mousedown', () => bringToFront(this));
    }

    disconnectedCallback() {
        this._globalCleanups.forEach(fn => fn());
        this._globalCleanups = [];
    }

    _handleStoreStateChanged(e) {
        const nextState = e?.detail?.afterState;
        const actionType = e?.detail?.action?.type;
        if (!nextState || typeof nextState !== 'object') {
            this._hadCurves = false;
            this._hide();
            return;
        }

        // CHANGE_NODE_SELECTION never changes curve selection — skip
        // iteration of 1500+ tree IDs when no curves were previously selected.
        if (actionType === 'CHANGE_NODE_SELECTION' && !this._hadCurves) return;

        const selIds = nextState.selectedTreeIds || [];
        const curves = [];
        selIds.forEach(id => {
            const it = EditorModel.getTreeItem(id);
            if (it && it.type === 'curve') {
                const curve = EditorModel.getCurveById(it.curveId);
                if (curve) {
                    curves.push(curve);
                }
            }
        });

        if (curves.length === 0) {
            this._hadCurves = false;
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

        // Always call _patchValues even when docked, so the guard flag
        // (_togglingDirection) works the same way regardless of dock state.
        // The popup is the single authority for direction toggle logic.
        if (!this._focusedInput) this._patchValues(curves);

        if (this._docked) {
            this._hide();
            // Compute direction state to sync to the property panel.
            // Single path: read from our DOM (picks up optimistic toggle flips).
            // Multi-path: compute common winding from the actual curve data
            // (no optimistic DOM flips for multi-path).
            const curve = curves.length > 0 ? curves[0] : null;
            let winding = null;
            let smartWinding = null;
            if (curves.length === 1) {
                const revBtn = this.container.querySelector('#ppp_reverse_dir_toggle');
                winding = revBtn ? revBtn.getAttribute('aria-pressed') === 'true' ? 'cw' : 'ccw' : null;
                const smartBtn = this.container.querySelector('#ppp_smart_winding_toggle');
                smartWinding = smartBtn ? smartBtn.getAttribute('aria-pressed') === 'true' ? 'cw' : 'ccw' : null;
            } else if (curves.length > 1) {
                const firstW = curves[0].skeletonWinding;
                if (firstW === 'cw' || firstW === 'ccw') {
                    if (curves.every(c => c.skeletonWinding === firstW)) winding = firstW;
                }
                const firstSW = curves[0].smart_stroke_clockwise !== false ? 'cw' : 'ccw';
                if (curves.every(c => (c.smart_stroke_clockwise !== false ? 'cw' : 'ccw') === firstSW)) {
                    smartWinding = firstSW;
                }
            }
            appEventBus.emit(PATH_PROPS_DOCKED, {
                curveIds: this._selectedCurveIds,
                treeIds: this._selectedTreeIds,
                curves: curves,
                winding: winding,
                smartWinding: smartWinding
            });
            return;
        }

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

            // When a direction toggle is in progress, skip overwriting the
            // direction UI to avoid reverting the optimistic flip. The toggle
            // handler already set correct values via _manualDirWinding.
            if (!this._togglingDirection) {
                this._patchDirection(curve);
            }

            const smartWinding = curve.smart_stroke_clockwise !== false ? 'cw' : 'ccw';
            const smartDirEl = this.container.querySelector('#ppp_smart_winding_text');
            if (smartDirEl) smartDirEl.value = smartWinding === 'cw' ? 'Clockwise' : 'Counter-clockwise';
            const smartBtn = this.container.querySelector('#ppp_smart_winding_toggle');
            if (smartBtn) {
                const enableSmartWinding = curve.smart_stroke === true;
                smartBtn.disabled = !enableSmartWinding;
                smartBtn.setAttribute('aria-pressed', smartWinding === 'cw' ? 'true' : 'false');
            }
            const smartWrapper = this.container.querySelector('#ppp_smart_winding_wrapper');
            if (smartWrapper) {
                smartWrapper.title = 'Toggle smart expand direction';
            }
        }
    }

    _patchDirection(curve) {
        const dirEl = this.container.querySelector('#ppp_direction_text');
        const revBtn = this.container.querySelector('#ppp_reverse_dir_toggle');
        if (revBtn) {
            revBtn.disabled = false;
            // If the curve changed, clear stale dataset from previous curve
            if (this._lastDirCurveId !== curve.id) {
                this._lastDirCurveId = curve.id;
                delete revBtn.dataset.winding;
            }
            // Restore manual winding from JS store (survives DOM recreation)
            if (this._manualDirWinding && this._manualDirWinding[curve.id]) {
                revBtn.dataset.winding = this._manualDirWinding[curve.id];
            }
        }
        // Use data-winding if set (manually toggled, figure-8 workaround);
        // fall back to skeletonWinding from the curve model.
        const winding = (revBtn && revBtn.dataset && revBtn.dataset.winding) || (curve.skeletonWinding != null ? curve.skeletonWinding : 'open');
        if (dirEl) {
            dirEl.value = winding === 'cw' ? 'Clockwise' : winding === 'ccw' ? 'Counter-clockwise' : 'Open';
        }
        if (revBtn) {
            revBtn.setAttribute('aria-pressed', winding === 'cw' ? 'true' : 'false');
        }
        const revWrapper = this.container.querySelector('#ppp_reverse_dir_wrapper');
        if (revWrapper) {
            revWrapper.title = 'Toggle path direction';
        }
    }

    _dispatchChange(target, recordHistory) {
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : trimmedInputValue(target);
        const numVal = numberFromInput(target);
        const selIds = [...this._selectedTreeIds];

        if (id === 'ppp_stroke') {
            if (!isValidNumber(numVal, { min: 0 })) {
                if (recordHistory) this._restoreInput(target);
                return;
            }
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
            if (!isValidTreeName(val)) {
                this._restoreInput(target);
                return;
            }
            if (item && item.name !== val) {
                const reqDetail = CanvasDispatcher.requestRenameTreeItem(selId, val);
                if (!reqDetail.result) {
                    this._restoreInput(target);
                }
            }
        }
    }

    _commitChange(target) {
        this._dispatchChange(target, true);
    }

    _isValidFinalInput(target) {
        if (target.id === 'ppp_stroke') return isValidNumber(numberFromInput(target), { min: 0 });
        if (target.id === 'ppp_name') return isValidTreeName(trimmedInputValue(target));
        return true;
    }

    _captureStrokeSnapshot() {
        this._strokeSnapshot = [...this._selectedTreeIds].map((sid) => {
            const item = EditorModel.getTreeItem(sid);
            const curve = item?.type === 'curve' ? EditorModel.getCurveById(item.curveId) : null;
            return curve ? { id: sid, value: curve.stroke_width } : null;
        }).filter(Boolean);
    }

    _restoreInput(target) {
        restoreRememberedInputValue(this, target);
        this._skipCommitTarget = target;
        if (target.id === 'ppp_stroke' && Array.isArray(this._strokeSnapshot)) {
            const updates = this._strokeSnapshot.map(({ id, value }) => ({ id, props: { stroke_width: value } }));
            if (updates.length > 0) {
                CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory: false });
            }
        }
        this._patchValues(this._selectedTreeIds.map((id) => {
            const item = EditorModel.getTreeItem(id);
            return item?.type === 'curve' ? EditorModel.getCurveById(item.curveId) : null;
        }).filter(Boolean));
    }

    _handleReverseDirection() {
        const selIds = [...this._selectedTreeIds];

        // Collect all selected curve items with their Curve objects
        const items = [];
        selIds.forEach(sid => {
            const item = EditorModel.getTreeItem(sid);
            if (item && item.type === 'curve') {
                const curve = EditorModel.getCurveById(item.curveId);
                if (curve) items.push({ item, curve });
            }
        });
        if (items.length === 0) return;

        if (items.length === 1) {
            // Single path: optimistic UI flip for the popup so any synchronous
            // re-render picks up the correct winding from _manualDirWinding
            // instead of the stale skeletonWinding.
            const { item, curve } = items[0];
            const dirEl = this.container.querySelector('#ppp_direction_text');
            const revBtn = this.container.querySelector('#ppp_reverse_dir_toggle');
            if (revBtn && dirEl) {
                const isCw = revBtn.getAttribute('aria-pressed') === 'true';
                const newWinding = isCw ? 'ccw' : 'cw';
                revBtn.setAttribute('aria-pressed', newWinding === 'cw' ? 'true' : 'false');
                revBtn.dataset.winding = newWinding;
                dirEl.value = newWinding === 'cw' ? 'Clockwise' : 'Counter-clockwise';
                if (!this._manualDirWinding) this._manualDirWinding = {};
                this._manualDirWinding[item.id] = newWinding;
            }
            this._togglingDirection = true;
            try {
                CanvasDispatcher.requestSetSingleObjectProperties(
                    [{ id: item.id, props: { reverse_direction: true } }],
                    { recordHistory: true }
                );
            } finally {
                this._togglingDirection = false;
            }
            return;
        }

        // Multi-path: check if windings differ across selected curves
        const windings = items.map(({ curve }) =>
            curve.skeletonWinding != null ? curve.skeletonWinding : 'open'
        );
        const allSame = windings.every(w => w === windings[0]);

        if (!allSame) {
            // Mixed winding: only reverse CW curves so all become CCW in one click
            const updates = items
                .filter(({ curve }) => (curve.skeletonWinding != null ? curve.skeletonWinding : 'open') === 'cw')
                .map(({ item }) => ({ id: item.id, props: { reverse_direction: true } }));
            if (updates.length > 0) {
                CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory: true });
            }
            return;
        }

        // All same winding: toggle all
        CanvasDispatcher.requestSetSingleObjectProperties(
            items.map(({ item }) => ({ id: item.id, props: { reverse_direction: true } })),
            { recordHistory: true }
        );
    }

    /**
     * Called by the property panel when the user clicks a direction toggle
     * button in docked state. Delegates to this popup's proven handlers so the
     * same guard-flag logic applies regardless of dock state.
     */
    handleDockedDirectionToggle(buttonId) {
        if (buttonId.endsWith('reverse_dir_toggle')) {
            this._handleReverseDirection();
        } else if (buttonId.endsWith('smart_winding_toggle')) {
            this._handleSmartWindingToggle();
        }
    }

    _handleSmartWindingToggle() {
        const selIds = [...this._selectedTreeIds];
        const updates = [];
        selIds.forEach(sid => {
            const item = EditorModel.getTreeItem(sid);
            if (item && item.type === 'curve') {
                const curve = EditorModel.getCurveById(item.curveId);
                if (curve && curve.smart_stroke === true) {
                    updates.push({ id: item.id, props: { toggle_smart_winding: true } });
                }
            }
        });
        if (updates.length === 0) return;
        CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory: true });
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
        } else {
            appEventBus.emit(PATH_PROPS_UNDOCKED);
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
            appEventBus.emit(PATH_PROPS_DOCKED);
        }
    }

    _onUndocked(e) {
        this._setDocked(false);
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

    _initResize() {
        initResizeHandles(this, { minW: 320, minH: 200 });
    }

    _initDrag() {
        this.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.tagName === 'INPUT') return;
            if (e.target.type === 'checkbox') return;
            if (e.target.closest('.prop_toggle_btn')) return;
            if (e.target.closest('.prop_direction_text_toggle')) return;
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
