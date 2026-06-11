// js/property_panel.js
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { NODE_PROPS_DOCKED, NODE_PROPS_UNDOCKED } from "./node_property_popup.js";
import { PATH_PROPS_DOCKED, PATH_PROPS_UNDOCKED } from "./path_property_popup.js";
import { BBOX_DOCKED, BBOX_UNDOCKED } from "./bounding_box_popup.js";

const TEMPLATE_HTML = `
    <div class="prop_panel_title_wrapper">
        <div class="panel_title" data-i18n="prop.title">Properties</div>
    </div>
    
    <div id="property_container" class="prop_panel_container"></div>
`;

export class PropertyPanel extends HTMLElement {
    constructor() {
        super();
        this.interaction = createEmptyEditorInteractionState();
        this.currentTool = 'DRAW';
        this.globalEventTrackers = [];
        this.lastSignature = "";
        this._drawToolSettings = null;
        this._nodePropsDocked = false;
        this._pathPropsDocked = false;
        this._bboxDocked = false;
        this._focusedInput = null;
        this._sectionOrder = [];
        this._loadSectionOrder();
        this._dragState = null;
    }

    addGlobalListener(target, type, listener, options = false) {
        if (target === window || target === appEventBus) {
            const cleanup = target === appEventBus
                ? target.on(type, listener, options)
                : appEventBus.on(type, listener, options);
            this.globalEventTrackers.push(cleanup);
            return;
        }
        target.addEventListener(type, listener, options);
        this.globalEventTrackers.push(() => target.removeEventListener(type, listener, options));
    }

    connectedCallback() {
        if (!this._domReady) {
            this._domReady = true;
            const temp = document.createElement("template");
            temp.innerHTML = TEMPLATE_HTML;
            this.appendChild(temp.content.cloneNode(true));

            this.container = this.querySelector('#property_container');

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
                if (e.target.tagName === 'INPUT') this._focusedInput = null;
            });

            const realtimeIds = [
                'ref_tx', 'ref_ty',
                'sel_prop_x', 'sel_prop_y', 'sel_prop_w', 'sel_prop_h',
                'prop_x', 'prop_y', 'prop_in_x', 'prop_in_y', 'prop_out_x', 'prop_out_y', 'prop_in_a', 'prop_out_a',
                'path_stroke'
            ];

            this.container.addEventListener('input', (e) => {
                if (realtimeIds.includes(e.target.id)) {
                    this.handlePropertyChange(e);
                }
            });

            this.container.addEventListener('keyup', (e) => {
                if (e.target && (e.target.id === 'sel_prop_w' || e.target.id === 'sel_prop_h')) {
                    this.handlePropertyChange({ type: 'input', target: e.target });
                }
            });

            this.container.addEventListener('change', (e) => {
                this.handlePropertyChange(e);
            });

            this.container.addEventListener('click', (e) => {
                const reverseBtn = e.target.closest('#path_reverse_dir_toggle');
                if (reverseBtn) {
                    this.handlePathReverseDirection();
                    return;
                }
                const windingBtn = e.target.closest('#path_smart_winding_toggle');
                if (windingBtn) {
                    this.handleSmartStrokeWindingToggle();
                }
            });

            EditorModel.whenEditorStoreReady((st) => {
                this.interaction.applyEventDetail({ afterState: st });
                this._drawToolSettings = st.drawToolSettings ?? null;
                if (typeof st.currentTool === "string") this.currentTool = st.currentTool;
                this.render();
            });
        }
        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this.handleStoreStateChanged(e));
        this.addGlobalListener(window, CANVAS_EVENTS.LANGUAGE_CHANGED, () => {
            this.lastSignature = "";
            this.render();
        });
        this.addGlobalListener(appEventBus, NODE_PROPS_DOCKED, (e) => {
            const was = this._nodePropsDocked;
            this._nodePropsDocked = true;
            this._nodePropsAnchorId = e?.detail?.anchorId || null;
            if (!was) this.lastSignature = "";
            this.render();
        });
        this.addGlobalListener(appEventBus, PATH_PROPS_DOCKED, (e) => {
            const was = this._pathPropsDocked;
            this._pathPropsDocked = true;
            if (!was) this.lastSignature = "";
            this.render();
        });
        this.addGlobalListener(appEventBus, BBOX_DOCKED, (e) => {
            const was = this._bboxDocked;
            this._bboxDocked = true;
            if (!was) this.lastSignature = "";
            this.render();
        });
    }

    disconnectedCallback() {
        this.globalEventTrackers.forEach((cleanup) => cleanup());
        this.globalEventTrackers = [];
    }

    handleStoreStateChanged(e) {
        const nextState = e?.detail?.afterState;
        if (!nextState || typeof nextState !== "object") {
            const st = EditorModel.getEditorStoreState();
            if (st) this.interaction.applyEventDetail({ afterState: st });
            this.render();
            return;
        }
        this.interaction.applyEventDetail(e?.detail);
        if (typeof nextState.currentTool === "string") {
            this.currentTool = nextState.currentTool;
        }
        if (nextState.drawToolSettings) {
            this._drawToolSettings = nextState.drawToolSettings;
        }
        this.render();
    }

    _loadSectionOrder() {
        try {
            const saved = localStorage.getItem('prop_section_order');
            if (saved) {
                this._sectionOrder = JSON.parse(saved);
                if (!Array.isArray(this._sectionOrder)) this._sectionOrder = [];
            }
        } catch (e) {
            this._sectionOrder = [];
        }
    }

    _saveSectionOrder() {
        try {
            localStorage.setItem('prop_section_order', JSON.stringify(this._sectionOrder));
        } catch (e) {}
    }

    _resolveSelectedCurves() {
        const ids = this.interaction.selectedCurveIds;
        if (!ids?.length) return [];
        return EditorModel.getCurvesByIds(ids);
    }

    _resolveSelectedRefs() {
        return this.interaction.selectedRefIds
            .map((id) => EditorModel.getTreeItem(id))
            .filter((item) => item && item.isRef);
    }

    _resolvePrimaryNodeMarker() {
        const ids = this.interaction.selectedNodeMarkerIds;
        const markerId = ids.length > 0 ? ids[ids.length - 1] : null;
        return markerId ? EditorModel.resolveNodeMarker(markerId) : null;
    }
    _resolveNodeMarkerById(anchorId) {
        return anchorId ? EditorModel.resolveNodeMarker(anchorId) : null;
    }

    decomposeMatrix(m) {
        if (!m || typeof m !== "object") return { tx: 0, ty: 0 };
        return { tx: m.e ?? 0, ty: m.f ?? 0 };
    }

    getSeqIdxForGroupId(groupId) {
        return EditorModel.getSeqIdxForGroup(groupId, this.interaction.focusedSeqIdx);
    }

    getSelectionBounds(mode = "transform") {
        return EditorModel.getSelectionBounds(mode);
    }

    getCommonValue(items, prop) {
        if (items.length === 0) return null;
        let first = items[0][prop];
        for (let i = 1; i < items.length; i++) {
            if (items[i][prop] !== first) return 'mixed';
        }
        return first;
    }

    render() {
        if (!this.container) return;
        if (!EditorModel.getTreeItemsMap()) return;

        let selectedIds = [...this.interaction.selectedTreeIds];
        let selectedCurves = [];
        let item = null;
        let hasRef = false, hasGroup = false, hasPath = false;

        selectedIds.forEach(id => {
            let it = EditorModel.getTreeItem(id);
            if (it && it.type === 'curve') {
                let curve = EditorModel.getCurveById(it.curveId);
                if (curve) selectedCurves.push(curve);
            }
        });

        hasPath = selectedCurves.length > 0;

        let bounds = (this.currentTool === 'SELECT' && selectedIds.length > 0) ? this.getSelectionBounds() : null;
        let hasBounds = bounds !== null;
        let nodeCount = this.interaction.nodeSelectionCount || 0;

        if (selectedIds.length === 1 && nodeCount === 0) {
            item = EditorModel.getTreeItem(selectedIds[0]);
            if (item) {
                if (item.type === 'group' && item.isRef) hasRef = true;
                else if (item.type === 'group' && !item.isRef) hasGroup = true;
            }
        }

        let sig = `${hasRef}_${hasGroup}_${hasPath}_${selectedCurves.length}_${hasBounds}_${nodeCount}_${this._nodePropsDocked}_${this._pathPropsDocked}_${this._bboxDocked}`;

        if (this.lastSignature !== sig) {
            if (this._focusedInput) {
                this.patchValues(item, selectedCurves, bounds, nodeCount, selectedIds);
                return;
            }
            this.buildDOM(hasRef, hasGroup, hasPath, selectedCurves.length, hasBounds, nodeCount);
            this.lastSignature = sig;
        }

        this.patchValues(item, selectedCurves, bounds, nodeCount, selectedIds);
    }

    buildDOM(hasRef, hasGroup, hasPath, pathCount, hasBounds, nodeCount) {
        const t = (k, defaultStr) => window.I18n ? window.I18n.t(k) : defaultStr;

        const sections = {};
        if (nodeCount > 0 || this._nodePropsDocked) {
            const html = this._buildNodeProps(nodeCount, t);
            if (html) sections.npp = html;
        }
        if (hasBounds && this._bboxDocked) sections.bbox = this._buildBoundsProps(t);
        if (hasPath) {
            const html = this._buildPathProps(pathCount, t);
            if (html) sections.ppp = html;
        }

        const sectionKeys = Object.keys(sections);
        if (sectionKeys.length === 0 && !hasRef && !(hasGroup && !hasPath)) {
            this.container.replaceChildren();
            this.container.classList.add("is_empty");
            return;
        }

        this._ensureSectionOrder(sectionKeys);

        const frag = document.createDocumentFragment();
        this._sectionOrder.forEach(key => {
            if (sections[key]) {
                const holder = document.createElement('div');
                holder.innerHTML = sections[key];
                while (holder.firstChild) frag.appendChild(holder.firstChild);
            }
        });

        if (hasRef) {
            const html = this._buildRefProps(t);
            const holder = document.createElement('div');
            holder.innerHTML = html;
            while (holder.firstChild) frag.appendChild(holder.firstChild);
        } else if (hasGroup && !hasPath) {
            const html = this._buildGroupProps(t);
            const holder = document.createElement('div');
            holder.innerHTML = html;
            while (holder.firstChild) frag.appendChild(holder.firstChild);
        }

        this.container.classList.remove("is_empty");
        const st = this.container.scrollTop;
        this.container.replaceChildren(frag);
        this.container.scrollTop = st;

        this._initSectionReorder();
    }

    _ensureSectionOrder(availableKeys) {
        const allKeys = ['npp', 'bbox', 'ppp'];
        const existing = this._sectionOrder.filter(k => allKeys.includes(k));
        allKeys.forEach(k => {
            if (!existing.includes(k)) existing.push(k);
        });
        this._sectionOrder = existing;
        this._saveSectionOrder();
    }

    _initSectionReorder() {
        const handles = this.container.querySelectorAll('.npp-section-handle');
        if (handles.length < 1) return;

        handles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                if (this._dragState) return;

                const section = handle.closest('.npp-section');
                if (!section) return;

                const sectionId = section.dataset.section;
                let popup = null;
                let extracted = false;
                this._dragState = { section, handle, startX: e.clientX, startY: e.clientY };

                const onMove = (ev) => {
                    if (!this._dragState) return;
                    const dx = ev.clientX - this._dragState.startX;
                    const dy = ev.clientY - this._dragState.startY;
                    const dist = Math.abs(dx) + Math.abs(dy);

                    if (!extracted && dist >= 3) {
                        extracted = true;
                        section.classList.add('is-dragging');
                        popup = this._getPopupForSection(sectionId);
                        if (!popup) {
                            section.classList.remove('is-dragging');
                            this._dragState = null;
                            return;
                        }
                        this._extractSectionImpl(sectionId, popup, ev.clientX, ev.clientY);
                        // Override position to follow cursor after render
                        const pw = popup.offsetWidth || 220, ph = popup.offsetHeight || 100;
                        popup.style.left = Math.max(0, Math.min(ev.clientX - pw / 2, window.innerWidth - pw)) + 'px';
                        popup.style.top = Math.max(0, Math.min(ev.clientY - 10, window.innerHeight - ph)) + 'px';
                        return;
                    }

                    if (extracted && popup) {
                        const vw = window.innerWidth, vh = window.innerHeight;
                        const pw = popup.offsetWidth || 220, ph = popup.offsetHeight || 100;
                        let nl = Math.max(0, Math.min(ev.clientX - pw / 2, vw - pw));
                        let nt = Math.max(0, Math.min(ev.clientY - 10, vh - ph));
                        popup.style.left = nl + 'px';
                        popup.style.top = nt + 'px';
                        const r = this.getBoundingClientRect();
                        const over = ev.clientX >= r.left && ev.clientX <= r.right &&
                                    ev.clientY >= r.top && ev.clientY <= r.bottom;
                        this.classList.toggle('npp-drop-target', over);
                    }
                };

                const onUp = (ev) => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    this.classList.remove('npp-drop-target');
                    this._clearReorderPreview();
                    if (this._dragState?.section) {
                        this._dragState.section.classList.remove('is-dragging');
                    }

                    if (extracted && popup) {
                        const r = this.getBoundingClientRect();
                        const over = ev.clientX >= r.left && ev.clientX <= r.right &&
                                    ev.clientY >= r.top && ev.clientY <= r.bottom;
                        if (over) {
                            popup._setDocked(true);
                        } else if (typeof popup._savePosition === 'function') {
                            popup._savePosition();
                        }
                    }
                    this._dragState = null;
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    _getPopupForSection(sectionId) {
        if (sectionId === 'npp') return document.querySelector('node-property-popup');
        if (sectionId === 'bbox') return document.querySelector('bounding-box-popup');
        if (sectionId === 'ppp') return document.querySelector('path-property-popup');
        return null;
    }

    _extractSectionImpl(sectionId, popup, startX, startY) {
        const self = this;

        if (sectionId === 'npp') {
            this._nodePropsDocked = false;
            this._nodePropsAnchorId = null;
            this.lastSignature = '';
            this.render();

            const anchorId = popup._anchorNodeId;
            popup._docked = false;
            popup._anchorNodeId = anchorId;
            popup.classList.add('visible');
            popup._patchValues(anchorId);
        } else if (sectionId === 'bbox') {
            this._bboxDocked = false;
            this.lastSignature = '';
            this.render();

            popup._docked = false;
            popup._selectedTreeIds = [...this.interaction.selectedTreeIds];
            popup._bounds = this.getSelectionBounds();
            popup.classList.add('visible');
            popup._patchValues();
        } else if (sectionId === 'ppp') {
            this._pathPropsDocked = false;
            this.lastSignature = '';
            this.render();

            popup._docked = false;
            const selIds = [...this.interaction.selectedTreeIds];
            const curves = [];
            selIds.forEach(id => {
                const it = EditorModel.getTreeItem(id);
                if (it && it.type === 'curve') {
                    const curve = EditorModel.getCurveById(it.curveId);
                    if (curve) curves.push(curve);
                }
            });
            popup._selectedCurveIds = selIds.filter(id => {
                const it = EditorModel.getTreeItem(id);
                return it && it.type === 'curve';
            });
            popup._selectedTreeIds = [...selIds];
            popup.classList.add('visible');
            popup._patchValues(curves);
        }

        popup.style.left = startX + 'px';
        popup.style.top = startY + 'px';

        const sx = startX, sy = startY;
        const sl = startX, st = startY;
        const dropClass = sectionId === 'npp' ? 'npp-drop-target'
                        : sectionId === 'bbox' ? 'bbox-drop-target'
                        : 'ppp-drop-target';

        const onMove = (ev) => {
            const vw = window.innerWidth, vh = window.innerHeight;
            const pw = popup.offsetWidth, ph = popup.offsetHeight;
            let nl = sl + ev.clientX - sx;
            let nt = st + ev.clientY - sy;
            nl = Math.max(0, Math.min(nl, vw - pw));
            nt = Math.max(0, Math.min(nt, vh - ph));
            popup.style.left = nl + 'px';
            popup.style.top = nt + 'px';

            const r = this.getBoundingClientRect();
            const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
            this.classList.toggle(dropClass, over);
        };

        const onUp = (ev) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            this.classList.remove(dropClass);

            const r = this.getBoundingClientRect();
            const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
            if (over) {
                popup.classList.remove('visible');
                this._setSectionDocked(sectionId, true, popup);
            } else {
                popup._savePosition();
            }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    _setSectionDocked(sectionId, docked, popup) {
        if (sectionId === 'npp') {
            popup._docked = true;
            this._nodePropsDocked = true;
        } else if (sectionId === 'bbox') {
            popup._docked = true;
            this._bboxDocked = true;
        } else if (sectionId === 'ppp') {
            popup._docked = true;
            this._pathPropsDocked = true;
        }
        this.lastSignature = '';
        this.render();
    }

    _updateReorderPreview(mouseY) {
        this._clearReorderPreview();

        const sections = [...this.container.querySelectorAll('.npp-section')];
        const dragged = this._dragState.section;
        const siblings = sections.filter(s => s !== dragged);

        let insertIdx = siblings.length;
        for (let i = 0; i < siblings.length; i++) {
            const rect = siblings[i].getBoundingClientRect();
            if (mouseY < rect.top + rect.height / 2) {
                insertIdx = i;
                break;
            }
        }

        const preview = document.createElement('div');
        preview.className = 'npp-section-preview';
        this._dragState._insertIdx = insertIdx;

        if (insertIdx >= siblings.length) {
            const last = siblings[siblings.length - 1] || dragged;
            last.parentNode.insertBefore(preview, last.nextSibling);
        } else {
            siblings[insertIdx].parentNode.insertBefore(preview, siblings[insertIdx]);
        }
    }

    _clearReorderPreview() {
        const existing = this.container.querySelector('.npp-section-preview');
        if (existing) existing.remove();
    }

    _commitReorder(mouseY) {
        const sections = [...this.container.querySelectorAll('.npp-section')];
        const dragged = this._dragState.section;
        const siblings = sections.filter(s => s !== dragged);

        let insertIdx = siblings.length;
        for (let i = 0; i < siblings.length; i++) {
            const rect = siblings[i].getBoundingClientRect();
            if (mouseY < rect.top + rect.height / 2) {
                insertIdx = i;
                break;
            }
        }

        if (insertIdx >= siblings.length) {
            const last = siblings[siblings.length - 1] || dragged;
            last.parentNode.insertBefore(dragged, last.nextSibling);
        } else {
            siblings[insertIdx].parentNode.insertBefore(dragged, siblings[insertIdx]);
        }

        const newOrder = [...this.container.querySelectorAll('.npp-section')].map(
            el => el.dataset.section
        );
        this._sectionOrder = newOrder;
        this._saveSectionOrder();
    }

    _buildNodeProps(nodeCount, t) {
        if (nodeCount > 0 && this._nodePropsDocked) {
            const countHtml = nodeCount > 1 ? `<div class="prop_node_count">${nodeCount} ${t('prop.nodes_selected', 'nodes selected')}</div>` : '';
            return `
                <div class="npp-section" data-section="npp">
                    <div class="npp-section-handle" data-section="npp">${t('prop.node_props', 'Node Properties')}</div>
                    ${countHtml}
                    <div class="npp-docked-fields">
                        <div class="npp-row"><label>Pos</label><span class="npp-axis">X</span><input type="number" step="0.1" id="prop_x"><span class="npp-axis">Y</span><input type="number" step="0.1" id="prop_y"></div>
                        <div class="npp-row"><label>In</label><span class="npp-axis">X</span><input type="number" step="0.1" id="prop_in_x"><span class="npp-axis">Y</span><input type="number" step="0.1" id="prop_in_y"></div>
                        <div class="npp-row"><label>Out</label><span class="npp-axis">X</span><input type="number" step="0.1" id="prop_out_x"><span class="npp-axis">Y</span><input type="number" step="0.1" id="prop_out_y"></div>
                        <div class="npp-row"><label>Angle</label><span class="npp-axis">In</span><input type="number" step="1" id="prop_in_a"><span class="npp-axis">Out</span><input type="number" step="1" id="prop_out_a"></div>
                    </div>
                </div>`;
        }
        return '';
    }

    _buildBoundsProps(t) {
        return `
            <div class="npp-section" data-section="bbox">
                <div class="npp-section-handle" data-section="bbox">${t('prop.bbox', 'Bounding Box')}</div>
                <div class="npp-docked-fields">
                    <div class="npp-row"><label>Pos</label><span class="npp-axis">X</span><input type="number" step="0.1" id="sel_prop_x"><span class="npp-axis">Y</span><input type="number" step="0.1" id="sel_prop_y"></div>
                    <div class="npp-row"><label>Size</label><span class="npp-axis">W</span><input type="number" step="0.1" id="sel_prop_w"><span class="npp-axis">H</span><input type="number" step="0.1" id="sel_prop_h"></div>
                </div>
            </div>`;
    }

    _buildPathProps(pathCount, t) {
        if (pathCount > 0 && this._pathPropsDocked) {
            return `
                <div class="npp-section" data-section="ppp">
                    <div class="npp-section-handle" data-section="ppp">${t('prop.path_props', 'Path Properties')}</div>
                    <div class="npp-docked-fields">
                        <div class="ppp-row ppp-path-field"><label>${t('prop.weight', 'Weight')}</label><input type="number" min="0" step="1" id="path_stroke"></div>
                        <div class="ppp-row ppp-path-field"><label>${t('prop.closed', 'Closed')}</label><input type="checkbox" id="path_closed"></div>
                        <div class="ppp-row ppp-path-field"><label>${t('prop.smart', 'Smart')}</label><input type="checkbox" id="path_smart_stroke"></div>
                        <div class="ppp-row ppp-path-field"><label>${t('prop.skel', 'Skeleton')}</label><input type="checkbox" id="path_show_skel"></div>
                        ${pathCount === 1 ? `
                        <div class="ppp-row ppp-single-path"><label>${t('prop.name', 'Name')}</label><input type="text" id="c_name"></div>
                        <div class="ppp-row ppp-single-path">
                            <label>${t('prop.path_direction', 'Path Direction')}</label>
                            <div class="prop_direction_controls">
                                <button type="button" id="path_reverse_dir_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
                                <span id="path_direction" class="prop_direction_label">—</span>
                            </div>
                        </div>
                        <div class="ppp-row ppp-single-path">
                            <label>${t('prop.smart_expand_direction', 'Smart Expand Direction')}</label>
                            <div class="prop_direction_controls">
                                <button type="button" id="path_smart_winding_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
                                <span id="path_smart_winding" class="prop_direction_label">—</span>
                            </div>
                        </div>` : ''}
                    </div>
                </div>`;
        } else if (pathCount > 1) {
            return `
                <div class="property_group">
                    <div class="property_group_title">${t('prop.multiple_paths', 'Multiple Paths')}</div>
                    <div class="npp-docked-fields">
                        <div class="ppp-row"><label>${t('prop.weight', 'Weight')}</label><input type="number" min="0" step="1" id="path_stroke"></div>
                        <div class="ppp-row"><label>${t('prop.closed', 'Closed')}</label><input type="checkbox" id="path_closed"></div>
                        <div class="ppp-row"><label>${t('prop.smart', 'Smart')}</label><input type="checkbox" id="path_smart_stroke"></div>
                        <div class="ppp-row"><label>${t('prop.skel', 'Skeleton')}</label><input type="checkbox" id="path_show_skel"></div>
                    </div>
                </div>`;
        }
        return '';
    }

    _buildRefProps(t) {
        return `
            <div class="property_group">
                <div class="property_group_title">${t('prop.trans_ref', 'Transform (Ref)')}</div>
                <div class="property_single_row">
                    <label>${t('prop.trans', 'Trans')}</label>
                    <div class="prop_inputs"><input type="number" id="ref_tx" placeholder="X"><input type="number" id="ref_ty" placeholder="Y"></div>
                </div>
            </div>
            <div class="property_group">
                <div class="property_group_title">${t('prop.ref_details', 'Reference Details')}</div>
                <div class="property_single_row"><label>${t('prop.name', 'Name')}</label><input type="text" id="ref_name"></div>
            </div>`;
    }

    _buildGroupProps(t) {
        return `
            <div class="property_group">
                <div class="property_group_title">${t('prop.group_spacing', 'Group Spacing')}</div>
                <div class="property_single_row"><label>${t('prop.advance', 'Advance')}</label><input type="number" id="g_advance"></div>
            </div>
            <div class="property_group">
                <div class="property_group_title">${t('prop.group_details', 'Group Details')}</div>
                <div class="property_single_row"><label>${t('prop.name', 'Name')}</label><input type="text" id="g_name"></div>
                <div class="property_single_row"><label>${t('prop.char', 'Char')}</label><input type="text" id="g_char" placeholder="Ligatures allowed"></div>
            </div>`;
    }

    patchValues(item, selectedCurves, bounds, nodeCount, selectedIds) {
        const t = (k, defaultStr) => window.I18n ? window.I18n.t(k) : defaultStr;
        const patch = (id, val, disable = false) => {
            let el = this.container.querySelector('#' + id);
            if (!el) return;
            if (disable !== undefined) el.disabled = disable;
            if (el === this._focusedInput) return; 

            if (el.type === 'checkbox') {
                if (val === 'mixed') {
                    el.indeterminate = true;
                    el.checked = false;
                } else {
                    el.indeterminate = false;
                    el.checked = val;
                }
            } else {
                if (val === 'mixed') {
                    el.value = '';
                    el.placeholder = t('prop.mixed', 'Mixed');
                } else {
                    let sVal = String(val);
                    if (el.value !== sVal) el.value = sVal;
                    el.placeholder = '';
                }
            }
        };

        if (selectedCurves.length > 0) {
            patch('path_stroke', this.getCommonValue(selectedCurves, 'stroke_width'));
            patch('path_closed', this.getCommonValue(selectedCurves, 'closed'));
            patch('path_smart_stroke', this.getCommonValue(selectedCurves, 'smart_stroke'));
            patch('path_show_skel', this.getCommonValue(selectedCurves, 'show_skeleton'));
            if (selectedCurves.length === 1 && (item || selectedIds.length > 0)) {
                if (!item) item = EditorModel.getTreeItem(selectedIds[0]);
                patch('c_name', item?.name ?? '');
                const curve = selectedCurves[0];
                const winding = curve.skeletonWinding ?? 'open';
                const dirText = winding === 'cw' ? t('prop.dir_cw', 'Clockwise')
                    : winding === 'ccw' ? t('prop.dir_ccw', 'Counter-clockwise')
                    : t('prop.dir_open', 'Open');
                const dirEl = this.container.querySelector('#path_direction');
                if (dirEl) dirEl.textContent = dirText;
                const revBtn = this.container.querySelector('#path_reverse_dir_toggle');
                if (revBtn) {
                    const canReverse = (curve.skeletonVertexCount ?? 0) >= 2;
                    revBtn.disabled = !canReverse;
                    revBtn.setAttribute('aria-pressed', winding === 'cw' ? 'true' : 'false');
                    revBtn.title = t('prop.toggle_path_direction', 'Toggle path direction');
                }

                const smartWinding = curve.smart_stroke_clockwise !== false ? 'cw' : 'ccw';
                let smartDirEl = this.container.querySelector('#path_smart_winding');
                if (smartDirEl) smartDirEl.textContent = smartWinding === 'cw' ? t('prop.dir_cw', 'Clockwise') : t('prop.dir_ccw', 'Counter-clockwise');
                let smartBtn = this.container.querySelector('#path_smart_winding_toggle');
                if (smartBtn) {
                    const enableSmartWinding = curve.smart_stroke === true;
                    smartBtn.disabled = !enableSmartWinding;
                    smartBtn.setAttribute('aria-pressed', smartWinding === 'cw' ? 'true' : 'false');
                    smartBtn.title = t('prop.toggle_smart_expand_direction', 'Toggle smart expand direction');
                }
            }
        }

        if (item && nodeCount === 0) {
            if (item.type === 'group' && item.isRef) {
                const transform = EditorModel.getRefTransform(item);
                if (transform) {
                    const decomp = this.decomposeMatrix(transform);
                    patch('ref_name', item.name);
                    patch('ref_tx', decomp.tx.toFixed(1));
                    patch('ref_ty', decomp.ty.toFixed(1));
                }
            } else if (item.type === 'group' && !item.isRef && selectedCurves.length === 0) {
                patch('g_name', item.name);
                patch('g_char', item.charCode || '');
                patch('g_advance', item.advance !== undefined ? item.advance : 1000);
            }
        }

        if (bounds) {
            patch('sel_prop_x', bounds.minX.toFixed(1));
            patch('sel_prop_y', bounds.minY.toFixed(1));
            patch('sel_prop_w', (bounds.maxX - bounds.minX).toFixed(1));
            patch('sel_prop_h', (bounds.maxY - bounds.minY).toFixed(1));
        }

        if (nodeCount === 1 || (nodeCount > 1 && this._nodePropsDocked)) {
            let markerId;
            if (nodeCount === 1) {
                let marker = this._resolvePrimaryNodeMarker();
                markerId = typeof marker === 'object' ? marker?.id : marker;
            } else if (this._nodePropsAnchorId) {
                markerId = this._nodePropsAnchorId;
            }
            const node = EditorModel.getNodeReadByMarkerId(markerId);
            if (node) {
                patch('prop_x', node.x.toFixed(1));
                patch('prop_y', node.y.toFixed(1));

                let hasC1 = !!node.control1;
                patch('prop_in_x', hasC1 ? node.control1.x.toFixed(1) : '', !hasC1);
                patch('prop_in_y', hasC1 ? node.control1.y.toFixed(1) : '', !hasC1);
                patch('prop_in_a', hasC1 ? (Math.atan2(node.control1.y - node.y, node.control1.x - node.x) * 180 / Math.PI).toFixed(1) : '', !hasC1);

                let hasC2 = !!node.control2;
                patch('prop_out_x', hasC2 ? node.control2.x.toFixed(1) : '', !hasC2);
                patch('prop_out_y', hasC2 ? node.control2.y.toFixed(1) : '', !hasC2);
                patch('prop_out_a', hasC2 ? (Math.atan2(node.control2.y - node.y, node.control2.x - node.x) * 180 / Math.PI).toFixed(1) : '', !hasC2);
            }
        }
    }

    handlePathReverseDirection() {
        let selectedIds = [...this.interaction.selectedTreeIds];
        if (selectedIds.length !== 1) return;
        let item = EditorModel.getTreeItem(selectedIds[0]);
        if (!item || item.type !== 'curve') return;
        CanvasDispatcher.requestSetSingleObjectProperties(
            [{ id: item.id, props: { reverse_direction: true } }],
            { recordHistory: true }
        );
    }

    handleSmartStrokeWindingToggle() {
        let selectedIds = [...this.interaction.selectedTreeIds];
        if (selectedIds.length !== 1) return;
        let item = EditorModel.getTreeItem(selectedIds[0]);
        if (!item || item.type !== 'curve') return;
        CanvasDispatcher.requestSetSingleObjectProperties(
            [{ id: item.id, props: { toggle_smart_winding: true } }],
            { recordHistory: true }
        );
    }

    handlePropertyChange(e) {
        const target = e.target;
        const id = target.id;
        if (!id) return;

        let val = target.type === 'checkbox' ? target.checked : target.value.trim();
        let numVal = target.type === 'number' ? target.valueAsNumber : parseFloat(val);
        let selectedIds = [...this.interaction.selectedTreeIds];

        if (id.startsWith('path_')) {
            const propMap = { 'path_stroke': 'stroke_width', 'path_closed': 'closed', 'path_smart_stroke': 'smart_stroke', 'path_show_skel': 'show_skeleton' };
            const prop = propMap[id];
            const updates = [];
            selectedIds.forEach(sid => {
                let item = EditorModel.getTreeItem(sid);
                if (item && item.type === 'curve') {
                    updates.push({
                        id: sid,
                        props: { [prop]: (target.type === 'checkbox' ? val : numVal) }
                    });
                }
            });
            if (updates.length > 0) {
                CanvasDispatcher.requestSetSingleObjectProperties(updates, { recordHistory: e.type === 'change' });
            }
            return;
        }

        if (['ref_name', 'g_name', 'c_name'].includes(id)) {
            let selId = selectedIds[0];
            let item = EditorModel.getTreeItem(selId);
            if (item.name === val) return;

            const reqDetail = CanvasDispatcher.requestRenameTreeItem(selId, val);
            if (!reqDetail.result) {
                target.value = item.name;
            }
            return;
        }

        if (id === 'g_char') {
            let selId = selectedIds[0];
            let item = EditorModel.getTreeItem(selId);
            if (item) {
                let newVal = val === "" ? null : val;
                if (item.charCode === newVal) return;
                const reqDetail = CanvasDispatcher.requestSetGroupCharCode(selId, newVal, { recordHistory: true });
                if (!reqDetail.result?.success) {
                    if (reqDetail.result?.error) alert(reqDetail.result.error);
                    target.value = item.charCode || '';
                }
            }
            return;
        }

        if (['ref_tx', 'ref_ty'].includes(id)) {
            let selId = selectedIds[0];
            let item = EditorModel.getTreeItem(selId);
            if (item && item.isRef) {
                let tx = parseFloat(this.container.querySelector('#ref_tx').value) || 0;
                let ty = parseFloat(this.container.querySelector('#ref_ty').value) || 0;
                CanvasDispatcher.requestSetSingleObjectProperties(
                    [{ id: selId, props: { ref_tx: tx, ref_ty: ty } }],
                    { recordHistory: e.type === 'change' }
                );
            }
            return;
        }

        if (id === 'g_advance' && !isNaN(numVal)) {
            let selId = selectedIds[0];
            let item = EditorModel.getTreeItem(selId);
            if (item) {
                CanvasDispatcher.requestSetGroupAdvance(selId, numVal, { recordHistory: e.type === 'change' });
            }
            return;
        }

        if (['sel_prop_x', 'sel_prop_y', 'sel_prop_w', 'sel_prop_h'].includes(id)) {
            const prop = id.split('_')[2];
            const isValidNumber = !isNaN(numVal);
            const isSizeProp = (prop === 'w' || prop === 'h');
            const isValidSize = !isSizeProp || numVal >= 0;

            if (isValidNumber && isValidSize) {
                CanvasDispatcher.requestChangeSelectedObjectsBounds(prop, numVal, {
                    recordHistory: e.type === 'change',
                    useBoundsSession: isSizeProp,
                    commitBoundsSession: isSizeProp && e.type === 'change'
                });
            } else if (e.type === 'change') {
                // 失焦/回车时若输入非法，回填当前真实值，避免空值滞留
                this.render();
            }
            return;
        }

        if (['prop_x', 'prop_y', 'prop_in_x', 'prop_in_y', 'prop_in_a', 'prop_out_x', 'prop_out_y', 'prop_out_a'].includes(id)) {
            if (isNaN(numVal)) return;
            let marker;
            if (this._nodePropsDocked && this._nodePropsAnchorId) {
                marker = this._nodePropsAnchorId;
            } else {
                marker = this._resolvePrimaryNodeMarker();
            }
            CanvasDispatcher.requestUpdateNodeProperty(marker, id, numVal, { recordHistory: e.type === 'change' });
            return;
        }
    }
}

customElements.define("property-panel", PropertyPanel);