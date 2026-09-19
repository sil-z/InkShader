import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { appEventBus } from "../app/event_bus.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { initResizeHandles, bringToFront } from "./popup_utils.js";
import { createCustomSelect } from "./custom_select.js";

/** Translation shorthand: table first, English literal as the fallback. */
const t = (key, fallback) => (window.I18n ? window.I18n.t(key, fallback) : fallback);

/** @returns {import('../core/bezier/kerning_manager.js').KerningManager|null} */
function getKerningManager() {
    const c = document.querySelector('main-canvas');
    return c?.curve_manager?.kerningManager ?? null;
}
import {
    installEnterBlurHandler,
    isValidNumber,
    isValidTreeName,
    numberFromInput,
    restoreRememberedInputValue,
    rememberInputValue,
    trimmedInputValue
} from "./input_validation.js";

/** Compute LSB/RSB for a group from its curves + advance (read-only, no stored fields) */
function getGroupLsbRsb(groupId) {
    const extents = EditorModel.getGroupCurveExtents(groupId);
    if (!extents) return { lsb: 0, rsb: 0 };
    const advance = EditorModel.getGroupAdvance(groupId) ?? 1000;
    return { lsb: Math.round(extents.minX), rsb: Math.round(advance - extents.maxX) };
}

export const GRP_DOCKED = 'grp:docked';

const POPUP_HTML = `
<div class="property_group_title npp-drag-handle" id="grp_drag_handle" data-i18n="prop.glyph_settings">Glyph Settings</div>
<div class="npp-fields" id="grp_standard_fields">
    <div class="npp-row"><label data-i18n="prop.name">Name</label><input type="text" id="grp_name"></div>
    <div class="npp-row"><label data-i18n="prop.char">Char</label><input type="text" id="grp_char"></div>
    <div class="npp-row"><label data-i18n="prop.advance">Advance Width</label><input type="number" id="grp_advance"></div>
    <div class="npp-row"><label data-i18n="prop.lsb">LSB</label><input type="number" id="grp_lsb"></div>
    <div class="npp-row"><label data-i18n="prop.rsb">RSB</label><input type="number" id="grp_rsb"></div>
    <div class="npp-row"><label data-i18n="prop.kern_left">Left Kern</label><select id="grp_kern_left"><option value="">${t('common.none', '(none)')}</option></select></div>
    <div class="npp-row"><label data-i18n="prop.kern_right">Right Kern</label><select id="grp_kern_right"><option value="">${t('common.none', '(none)')}</option></select></div>
</div>
<div class="npp-fields" id="grp_ref_fields" style="display:none">
    <div class="npp-row"><label data-i18n="prop.name">Name</label><input type="text" id="grp_ref_name" readonly></div>
    <div class="npp-row"><label data-i18n="prop.position">Position</label><div class="npp-input-group"><span class="npp-axis">X</span><input type="number" step="0.1" id="grp_ref_pos_x"><span class="npp-axis">Y</span><input type="number" step="0.1" id="grp_ref_pos_y"></div></div>
    <div class="npp-row"><label data-i18n="prop.scale">Scale</label><div class="npp-input-group"><span class="npp-axis">X</span><input type="number" step="0.001" id="grp_ref_scale_x"><span class="npp-axis">Y</span><input type="number" step="0.001" id="grp_ref_scale_y"></div></div>
    <div class="npp-row"><label data-i18n="prop.rotation">Rotation</label><div class="npp-input-group"><span class="npp-axis">°</span><input type="number" step="0.1" id="grp_ref_rotation"></div></div>
    <div class="npp-row"><label data-i18n="prop.shear">Shear</label><div class="npp-input-group"><span class="npp-axis">V</span><input type="number" step="0.001" id="grp_ref_shear"></div></div>
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
        this._inputSnapshot = null;
        this._skipCommitTarget = null;
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

        // Convert native <select> to custom styled dropdowns
        this.querySelectorAll('select').forEach(sel => createCustomSelect(sel));

        this.container.addEventListener('focusin', (e) => {
            if (e.target.tagName === 'INPUT') {
                this._focusedInput = e.target;
                rememberInputValue(this, e.target);
                this._captureInputSnapshot(e.target);
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
            if (!id || !id.startsWith('grp_')) return;
            if (id === 'grp_advance' && isValidNumber(numberFromInput(e.target), { min: 0 })) {
                this._dispatchChange(e.target, false);
            }
            if ((id === 'grp_lsb' || id === 'grp_rsb') && isValidNumber(numberFromInput(e.target), { min: 0 })) {
                this._dispatchChange(e.target, false);
            }
        });

        this.container.addEventListener('change', (e) => {
            const id = e.target.id;
            if (!id || !id.startsWith('grp_')) return;
            if (id === 'grp_kern_left' || id === 'grp_kern_right') {
                this._handleKernClassChange(e.target);
                return;
            }
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
            if (this._extractedRefId) return;
            this._hide();
            return;
        }

        this.interaction.applyEventDetail(e?.detail);

        if (this._extractedRefId) {
            // Pinned to a ref extraction. activeGroupId points to the ref's
            // parent group, not the ref itself — so look at selectedTreeIds
            // to find the actually selected ref item.
            const selIds = this.interaction.selectedTreeIds || [];
            const selRef = selIds.find(id => {
                const it = EditorModel.getTreeItem(id);
                return it?.type === 'group' && it.isRef;
            });
            if (selRef) {
                // Follow selection to the current ref item
                this._extractedRefId = selRef;
                this._groupId = selRef;
            } else {
                // No ref selected — stay pinned to the original item
                this._groupId = this._extractedRefId;
            }

            const item = EditorModel.getTreeItem(this._groupId);
            if (!item || item.type !== 'group' || !item.isRef) {
                this._extractedRefId = null;
                this._hide();
                return;
            }

            const stdFields = this.container.querySelector('#grp_standard_fields');
            const refFields = this.container.querySelector('#grp_ref_fields');
            const titleEl = this.container.querySelector('#grp_drag_handle');
            if (stdFields) stdFields.style.display = 'none';
            if (refFields) refFields.style.display = '';
            if (titleEl) titleEl.textContent = t('prop.ref_properties', 'Reference Properties');
            // Ensure all ref rows visible
            const rows = refFields?.querySelectorAll('.npp-row');
            if (rows) for (let i = 0; i < rows.length; i++) rows[i].style.display = '';

            if (this._docked) {
                this._hide();
                appEventBus.emit(GRP_DOCKED, { groupId: this._groupId });
                return;
            }

            if (!this._focusedInput) this._patchValues();
            this._show();
            return;
        }

        // Normal flow (not pinned to ref) — follow activeGroupId
        const activeGroupId = nextState.activeGroupId || this.interaction.activeGroupId;
        if (!activeGroupId) {
            this._hide();
            return;
        }

        const item = EditorModel.getTreeItem(activeGroupId);
        if (!item || item.type !== 'group') {
            this._hide();
            return;
        }

        this._groupId = activeGroupId;

        // Show appropriate field section based on item type
        const stdFields = this.container.querySelector('#grp_standard_fields');
        const refFields = this.container.querySelector('#grp_ref_fields');
        const titleEl = this.container.querySelector('#grp_drag_handle');
        if (stdFields && refFields) {
            if (item.isRef) {
                stdFields.style.display = 'none';
                refFields.style.display = '';
                if (titleEl) titleEl.textContent = t('prop.ref_properties', 'Reference Properties');
                // Ensure all ref rows visible
                const rows = refFields.querySelectorAll('.npp-row');
                for (let i = 0; i < rows.length; i++) rows[i].style.display = '';
            } else {
                stdFields.style.display = '';
                refFields.style.display = 'none';
                if (titleEl) titleEl.textContent = t('prop.glyph_settings', 'Glyph Settings');
            }
        }

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
        this._populateKernClassSelects();
        const patch = (id, val) => {
            const el = this.container.querySelector(`#${id}`);
            if (!el) return;
            if (el === this._focusedInput) return;
            el.value = val != null ? String(val) : '';
        };
        patch('grp_name', item.name);
        patch('grp_char', item.charCode || '');
        // Live read (treeItems) — the tree snapshot may lag in-place advances (e.g. UPM rescale),
        // matching the live-read pattern of getGroupLsbRsb below.
        patch('grp_advance', EditorModel.getGroupAdvance(this._groupId) ?? 1000);
        const grpLr = getGroupLsbRsb(this._groupId);
        patch('grp_lsb', grpLr.lsb);
        patch('grp_rsb', grpLr.rsb);
        if (item.isRef) {
            patch('grp_ref_name', item.name);
            const t = item.transform;
            // Decompose matrix into Position, Scale, Rotation, Shear
            // M = T(tx,ty) * R(theta) * [sx, shear; 0, sy]
            const a = t?.a ?? 1, b = t?.b ?? 0, c = t?.c ?? 0, d = t?.d ?? 1;
            const scaleX = Math.sqrt(a * a + b * b) || 1;
            const det = a * d - b * c;
            const scaleY = scaleX > 1e-10 ? det / scaleX : 1;
            const shear = scaleX > 1e-10 ? (a * c + b * d) / scaleX : 0;
            const rot = Math.atan2(b, a) * 180 / Math.PI || 0;
            patch('grp_ref_pos_x', t && Number.isFinite(t.e) ? t.e : 0);
            patch('grp_ref_pos_y', t && Number.isFinite(t.f) ? t.f : 0);
            patch('grp_ref_scale_x', scaleX);
            patch('grp_ref_scale_y', scaleY);
            patch('grp_ref_rotation', rot);
            patch('grp_ref_shear', shear);
        }
    }

    _dispatchChange(target, recordHistory) {
        if (!this._groupId) return;
        const id = target.id;
        const val = target.type === 'checkbox' ? target.checked : trimmedInputValue(target);

        if (id === 'grp_name') {
            const item = EditorModel.getTreeItem(this._groupId);
            if (!isValidTreeName(val)) {
                this._restoreInput(target);
                return;
            }
            if (item && item.name !== val) {
                const reqDetail = CanvasDispatcher.requestRenameTreeItem(this._groupId, val);
                if (!reqDetail.result) this._restoreInput(target);
            }
            return;
        }

        if (id === 'grp_char') {
            const item = EditorModel.getTreeItem(this._groupId);
            if (item) {
                const newVal = val === "" ? null : val;
                if (item.charCode !== newVal) {
                    const reqDetail = CanvasDispatcher.requestSetGroupCharCode(this._groupId, newVal, { recordHistory: true });
                    if (!reqDetail.result?.success && reqDetail.result?.error) this._restoreInput(target);
                }
            }
            return;
        }

        if (id === 'grp_advance') {
            const numVal = numberFromInput(target);
            if (isValidNumber(numVal, { min: 0 })) {
                CanvasDispatcher.requestSetGroupAdvance(this._groupId, numVal, { recordHistory });
            } else if (recordHistory) {
                this._restoreInput(target);
            }
            return;
        }

        if (id === 'grp_lsb' || id === 'grp_rsb') {
            const numVal = numberFromInput(target);
            if (isValidNumber(numVal, { min: 0 })) {
                const item = EditorModel.getTreeItem(this._groupId);
                const advance = item && item.advance !== undefined ? item.advance : 1000;
                const grpLr = getGroupLsbRsb(this._groupId);
                const currentVal = id === 'grp_lsb' ? grpLr.lsb : grpLr.rsb;
                const newAdv = Math.max(0, advance + (numVal - currentVal));
                CanvasDispatcher.requestSetGroupAdvance(this._groupId, newAdv, { recordHistory });
            } else if (recordHistory) {
                this._restoreInput(target);
            }
            return;
        }

        // Ref transform fields — map popup IDs to model prop names
        const refFieldMap = { 'grp_ref_pos_x': 'ref_pos_x', 'grp_ref_pos_y': 'ref_pos_y',
            'grp_ref_scale_x': 'ref_scale_x', 'grp_ref_scale_y': 'ref_scale_y',
            'grp_ref_rotation': 'ref_rotation', 'grp_ref_shear': 'ref_shear' };
        const propName = refFieldMap[id];
        if (propName) {
            const numVal = numberFromInput(target);
            if (Number.isFinite(numVal)) {
                CanvasDispatcher.requestSetSingleObjectProperties(
                    [{ id: this._groupId, props: { [propName]: numVal } }],
                    { recordHistory }
                );
            } else if (recordHistory) {
                this._restoreInput(target);
            }
            return;
        }
    }

    _commitChange(target) {
        this._dispatchChange(target, true);
    }

    _captureInputSnapshot(target) {
        const item = this._groupId ? EditorModel.getTreeItem(this._groupId) : null;
        const t = item?.isRef && item.transform ? item.transform : null;
        // Decompose ref matrix for snapshot
        let refDecomp = null;
        if (t) {
            const a = t.a ?? 1, b = t.b ?? 0, c = t.c ?? 0, d = t.d ?? 1;
            const sx = Math.sqrt(a * a + b * b) || 1;
            refDecomp = {
                posX: t.e ?? 0, posY: t.f ?? 0,
                scaleX: sx,
                scaleY: sx > 1e-10 ? (a * d - b * c) / sx : 1,
                shear: sx > 1e-10 ? (a * c + b * d) / sx : 0,
                rotation: Math.atan2(b, a) * 180 / Math.PI || 0
            };
        }
        this._inputSnapshot = {
            id: target.id,
            value: target.id === 'grp_name' ? item?.name ?? target.value
                : target.id === 'grp_char' ? item?.charCode ?? ''
                    : target.id === 'grp_advance' ? item?.advance ?? numberFromInput(target)
                        : (target.id === 'grp_lsb' || target.id === 'grp_rsb') ? (item?.advance ?? 1000)
                            : target.id === 'grp_ref_pos_x' ? (refDecomp?.posX ?? 0)
                            : target.id === 'grp_ref_pos_y' ? (refDecomp?.posY ?? 0)
                                : target.id === 'grp_ref_scale_x' ? (refDecomp?.scaleX ?? 1)
                                    : target.id === 'grp_ref_scale_y' ? (refDecomp?.scaleY ?? 1)
                                        : target.id === 'grp_ref_rotation' ? (refDecomp?.rotation ?? 0)
                                        : target.id === 'grp_ref_shear' ? (refDecomp?.shear ?? 0)
                                            : target.value
        };
    }

    _isValidFinalInput(target) {
        if (target.id === 'grp_name') return isValidTreeName(trimmedInputValue(target));
        if (target.id === 'grp_advance') return isValidNumber(numberFromInput(target), { min: 0 });
        if (target.id === 'grp_lsb' || target.id === 'grp_rsb') return isValidNumber(numberFromInput(target), { min: 0 });
        return true;
    }

    _restoreInput(target) {
        const fallback = this._inputSnapshot?.id === target.id ? String(this._inputSnapshot.value ?? '') : '';
        restoreRememberedInputValue(this, target, fallback);
        this._skipCommitTarget = target;
        if (['grp_advance', 'grp_lsb', 'grp_rsb'].includes(target.id) && this._groupId && Number.isFinite(Number(this._inputSnapshot?.value))) {
            CanvasDispatcher.requestSetGroupAdvance(this._groupId, Number(this._inputSnapshot.value), { recordHistory: false });
        }
        this._patchValues();
    }

    _handleKernClassChange(target) {
        if (!this._groupId) return;
        const item = EditorModel.getTreeItem(this._groupId);
        if (!item || item.isRef) return;
        const km = getKerningManager();
        if (!km) return;
        const side = target.id === 'grp_kern_left' ? 'left' : 'right';
        const className = target.value || null;
        km.assignGlyphToClass(item.name, side, className);
        // Recalculate sequence offsets
        const c = document.querySelector('main-canvas');
        if (c) {
            c.curve_manager?.calculateSequenceOffsets?.();
            c.renderer?.invalidateStableSceneCache?.();
            c.is_dirty = true;
        }
    }

    _populateKernClassSelects() {
        const km = getKerningManager();
        const item = this._groupId ? EditorModel.getTreeItem(this._groupId) : null;
        const leftSel = this.container.querySelector('#grp_kern_left');
        const rightSel = this.container.querySelector('#grp_kern_right');
        if (!leftSel || !rightSel) return;

        const leftVal = leftSel.value;
        const rightVal = rightSel.value;

        const noneLabel = t('common.none', '(none)').replace(/</g, '&lt;');
        leftSel.innerHTML = '<option value="">' + noneLabel + '</option>';
        rightSel.innerHTML = '<option value="">' + noneLabel + '</option>';

        const leftClasses = [];
        const rightClasses = [];
        if (km) {
            for (const cn of km.getAllClasses('left')) {
                const opt = document.createElement('option');
                opt.value = cn;
                opt.textContent = cn;
                leftSel.appendChild(opt);
                leftClasses.push({ value: cn, label: cn });
            }
            for (const cn of km.getAllClasses('right')) {
                const opt = document.createElement('option');
                opt.value = cn;
                opt.textContent = cn;
                rightSel.appendChild(opt);
                rightClasses.push({ value: cn, label: cn });
            }
        }

        // Restore or set current glyph's class
        let finalLeftVal = leftVal || '';
        let finalRightVal = rightVal || '';
        if (item && km) {
            const leftClass = km.getGlyphClass(item.name, 'left');
            const rightClass = km.getGlyphClass(item.name, 'right');
            if (leftClass) finalLeftVal = leftClass;
            if (rightClass) finalRightVal = rightClass;
        }
        leftSel.value = finalLeftVal;
        rightSel.value = finalRightVal;

        // Update custom select wrappers if they exist
        const leftWrapper = leftSel.previousElementSibling;
        const rightWrapper = rightSel.previousElementSibling;
        if (leftWrapper?._csUpdateOptions) {
            leftWrapper._csUpdateOptions([{ value: '', label: t('common.none', '(none)') }, ...leftClasses], finalLeftVal);
        }
        if (rightWrapper?._csUpdateOptions) {
            rightWrapper._csUpdateOptions([{ value: '', label: t('common.none', '(none)') }, ...rightClasses], finalRightVal);
        }
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
        let docked = true;
        try {
            const v = localStorage.getItem(DOCK_KEY);
            if (v === '0') docked = false;
        } catch (_) {
            // localStorage unavailable — stay with default (docked)
        }
        this._docked = docked;
        if (docked) {
            appEventBus.emit(GRP_DOCKED, { groupId: this._groupId });
        }
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
