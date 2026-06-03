// js/property_panel.js
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";

const TEMPLATE_HTML = `
    <div class="prop_panel_title_wrapper">
        <div class="panel_title" data-i18n="prop.title">Properties</div>
    </div>
    
    <div id="property_container" class="prop_panel_container"></div>
    
    <div id="sequence_container" class="prop_panel_seq_wrapper">
        <div class="property_group_title prop_panel_seq_title" data-i18n="seq.title">Sequence</div>
        <div class="prop_panel_seq_inner">
            <glyph-sequence-editor></glyph-sequence-editor>
        </div>
    </div>
`;

export class PropertyPanel extends HTMLElement {
    constructor() {
        super();
        this.interaction = createEmptyEditorInteractionState();
        this.currentTool = 'DRAW';
        this.globalEventTrackers = [];
        this.lastSignature = "";
        this._drawToolSettings = null;
    }

    addGlobalListener(target, type, listener, options = false) {
        if (target === window) {
            const cleanup = appEventBus.on(type, listener, options);
            this.globalEventTrackers.push(cleanup);
            return;
        }
        target.addEventListener(type, listener, options);
        this.globalEventTrackers.push(() => target.removeEventListener(type, listener, options));
    }

    connectedCallback() {
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

        const realtimeIds = [
            'ref_tx', 'ref_ty', 
            'sel_prop_x', 'sel_prop_y', 'sel_prop_w', 'sel_prop_h',
            'prop_x', 'prop_y', 'prop_in_x', 'prop_in_y', 'prop_out_x', 'prop_out_y', 'prop_in_a', 'prop_out_a',
            'tool_stroke', 'path_stroke'
        ];

        this.container.addEventListener('input', (e) => {
            if (realtimeIds.includes(e.target.id)) {
                this.handlePropertyChange(e);
            }
        });

        // 某些平台/输入法下 number input 的 input 触发频率不稳定，
        // 这里补一层 keyup，保证 W/H 文本变化时画布也能实时预览。
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

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this.handleStoreStateChanged(e));

        this.addGlobalListener(window, CANVAS_EVENTS.LANGUAGE_CHANGED, () => {
            this.lastSignature = ""; 
            this.render();           
        });

        EditorModel.whenEditorStoreReady((st) => {
            this.interaction.applyEventDetail({ afterState: st });
            this._drawToolSettings = st.drawToolSettings ?? null;
            if (typeof st.currentTool === "string") this.currentTool = st.currentTool;
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
        const markerId = this.interaction.selectedNodeMarkerIds[0];
        return markerId ? EditorModel.resolveNodeMarker(markerId) : null;
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
        let isToolSettings = (this.currentTool === 'DRAW');

        let bounds = (this.currentTool === 'SELECT') ? this.getSelectionBounds() : null;
        let hasBounds = bounds !== null;
        let nodeCount = (this.currentTool === 'NODE') ? this.interaction.nodeSelectionCount : 0;

        if (selectedIds.length === 1 && nodeCount === 0) {
            item = EditorModel.getTreeItem(selectedIds[0]);
            if (item) {
                if (item.type === 'group' && item.isRef) hasRef = true;
                else if (item.type === 'group' && !item.isRef) hasGroup = true;
            }
        }

        let sig = `${isToolSettings}_${hasRef}_${hasGroup}_${hasPath}_${selectedCurves.length}_${hasBounds}_${nodeCount}`;

        if (this.lastSignature !== sig) {
            this.buildDOM(isToolSettings, hasRef, hasGroup, hasPath, selectedCurves.length, hasBounds, nodeCount);
            this.lastSignature = sig;
        }

        this.patchValues(item, selectedCurves, bounds, nodeCount, isToolSettings);
    }

    /* 将原本巨长的 DOM 构建逻辑安全拆分 */
    buildDOM(isToolSettings, hasRef, hasGroup, hasPath, pathCount, hasBounds, nodeCount) {
        let blocks = [];
        const t = (k, defaultStr) => window.I18n ? window.I18n.t(k) : defaultStr;

        if (nodeCount > 0) blocks.push(this._buildNodeProps(nodeCount, t));
        if (hasBounds) blocks.push(this._buildBoundsProps(t));
        if (hasPath) blocks.push(this._buildPathProps(pathCount, t));
        if (isToolSettings) blocks.push(this._buildPenProps(t));
        if (hasRef) blocks.push(this._buildRefProps(t));
        else if (hasGroup && !hasPath) blocks.push(this._buildGroupProps(t));

        if (blocks.length === 0) {
            this.container.replaceChildren();
            this.container.classList.add("is_empty");
            return;
        }

        this.container.classList.remove("is_empty");
        const frag = document.createDocumentFragment();
        const dividerProto = document.createElement("div");
        dividerProto.className = "prop_divider";

        blocks.forEach((html, index) => {
            if (index > 0) frag.appendChild(dividerProto.cloneNode(false));
            const holder = document.createElement("div");
            holder.innerHTML = html;
            while (holder.firstChild) frag.appendChild(holder.firstChild);
        });
        frag.appendChild(dividerProto.cloneNode(false));
        this.container.replaceChildren(frag);
    }

    _buildNodeProps(nodeCount, t) {
        if (nodeCount === 1) {
            return `
                <div class="property_group">
                    <div class="property_group_title">${t('prop.node_pos', 'Node Position')}</div>
                    <div class="property_single_row">
                        <label>${t('prop.pos', 'Pos')}</label>
                        <div class="prop_inputs"><input type="number" step="0.1" id="prop_x" placeholder="X"><input type="number" step="0.1" id="prop_y" placeholder="Y"></div>
                    </div>
                </div>
                <div class="property_group">
                    <div class="property_group_title">${t('prop.handles', 'Handles & Angles')}</div>
                    <div class="property_single_row">
                        <label>${t('prop.in', 'In')}</label>
                        <div class="prop_inputs"><input type="number" step="0.1" id="prop_in_x" placeholder="X"><input type="number" step="0.1" id="prop_in_y" placeholder="Y"></div>
                    </div>
                    <div class="property_single_row">
                        <label>${t('prop.out', 'Out')}</label>
                        <div class="prop_inputs"><input type="number" step="0.1" id="prop_out_x" placeholder="X"><input type="number" step="0.1" id="prop_out_y" placeholder="Y"></div>
                    </div>
                    <div class="property_single_row">
                        <label>${t('prop.angle', 'Angle')}</label>
                        <div class="prop_inputs"><input type="number" step="1" id="prop_in_a" placeholder="In°"><input type="number" step="1" id="prop_out_a" placeholder="Out°"></div>
                    </div>
                </div>`;
        } else {
            return `
                <div class="property_group">
                    <div class="property_group_title">${t('prop.node_props', 'Node Properties')}</div>
                    <div class="prop_node_count">${nodeCount} ${t('prop.nodes_selected', 'nodes selected')}</div>
                </div>`;
        }
    }

    _buildBoundsProps(t) {
        return `
            <div class="property_group">
                <div class="property_group_title">${t('prop.bbox', 'Bounding Box')}</div>
                <div class="property_single_row">
                    <label>X, Y</label>
                    <div class="prop_inputs"><input type="number" step="0.1" id="sel_prop_x" placeholder="X"><input type="number" step="0.1" id="sel_prop_y" placeholder="Y"></div>
                </div>
                <div class="property_single_row">
                    <label>W, H</label>
                    <div class="prop_inputs"><input type="number" step="0.1" id="sel_prop_w" placeholder="W"><input type="number" step="0.1" id="sel_prop_h" placeholder="H"></div>
                </div>
            </div>`;
    }

    _buildPathProps(pathCount, t) {
        let pathHtml = `
            <div class="property_group">
                <div class="property_group_title">${pathCount === 1 ? t('prop.path_props', 'Path Properties') : t('prop.multiple_paths', 'Multiple Paths')}</div>
                <div class="property_single_row"><label>${t('prop.weight', 'Weight')}</label><input type="number" min="0" step="1" id="path_stroke"></div>
                <div class="property_single_row"><label>${t('prop.closed', 'Closed')}</label><input type="checkbox" id="path_closed"></div>
                <div class="property_single_row"><label>${t('prop.smart', 'Smart')}</label><input type="checkbox" id="path_smart_stroke"></div>
                <div class="property_single_row"><label>${t('prop.skel', 'Skeleton')}</label><input type="checkbox" id="path_show_skel"></div>
            </div>`;
        if (pathCount === 1) {
            pathHtml += `
                <div class="property_group">
                    <div class="property_group_title">${t('prop.path_details', 'Path Details')}</div>
                    <div class="property_single_row"><label>${t('prop.name', 'Name')}</label><input type="text" id="c_name"></div>
                    <div class="property_single_row">
                        <label>${t('prop.path_direction', 'Path Direction')}</label>
                        <div class="prop_direction_controls">
                            <button type="button" id="path_reverse_dir_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
                            <span id="path_direction" class="prop_direction_label">—</span>
                        </div>
                    </div>
                    <div class="property_single_row">
                        <label>${t('prop.smart_expand_direction', 'Smart Expand Direction')}</label>
                        <div class="prop_direction_controls">
                            <button type="button" id="path_smart_winding_toggle" class="prop_toggle_btn" aria-pressed="false"></button>
                            <span id="path_smart_winding" class="prop_direction_label">—</span>
                        </div>
                    </div>
                </div>`;
        }
        return pathHtml;
    }

    _buildPenProps(t) {
        return `
            <div class="property_group">
                <div class="property_group_title">${t('prop.pen_settings', 'Pen Tool Settings')}</div>
                <div class="property_single_row"><label>${t('prop.weight', 'Weight')}</label><input type="number" min="0" step="1" id="tool_stroke"></div>
                <div class="property_single_row"><label>${t('prop.closed', 'Closed')}</label><input type="checkbox" id="tool_closed"></div>
                <div class="property_single_row"><label>${t('prop.smart', 'Smart')}</label><input type="checkbox" id="tool_smart_stroke"></div>
                <div class="property_single_row"><label>${t('prop.skel', 'Skeleton')}</label><input type="checkbox" id="tool_show_skel"></div>
            </div>`;
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

    patchValues(item, selectedCurves, bounds, nodeCount, isToolSettings) {
        const t = (k, defaultStr) => window.I18n ? window.I18n.t(k) : defaultStr;
        const patch = (id, val, disable = false) => {
            let el = this.container.querySelector('#' + id);
            if (!el) return;
            if (disable !== undefined) el.disabled = disable;
            if (document.activeElement === el) return; 

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

        if (isToolSettings && this._drawToolSettings) {
            const tool = this._drawToolSettings;
            patch('tool_stroke', tool.stroke_width);
            patch('tool_closed', tool.closed);
            patch('tool_smart_stroke', tool.smart_expand);
            patch('tool_show_skel', tool.show_skeleton);
        }

        if (selectedCurves.length > 0) {
            patch('path_stroke', this.getCommonValue(selectedCurves, 'stroke_width'));
            patch('path_closed', this.getCommonValue(selectedCurves, 'closed'));
            patch('path_smart_stroke', this.getCommonValue(selectedCurves, 'smart_stroke'));
            patch('path_show_skel', this.getCommonValue(selectedCurves, 'show_skeleton'));
            if (selectedCurves.length === 1 && item) {
                patch('c_name', item.name);
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

        if (nodeCount === 1) {
            let marker = this._resolvePrimaryNodeMarker();
            const markerId = typeof marker === 'object' ? marker?.id : marker;
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

        if (id.startsWith('tool_')) {
            const propMap = { 'tool_stroke': 'stroke_width', 'tool_closed': 'closed', 'tool_smart_stroke': 'smart_expand', 'tool_show_skel': 'show_skeleton' };
            const prop = propMap[id];
            if (prop) {
                CanvasDispatcher.requestSetPenProperties(
                    { [prop]: (target.type === 'checkbox' ? val : numVal) },
                    { recordHistory: e.type === 'change' }
                );
            }
            return;
        }

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
            let marker = this._resolvePrimaryNodeMarker();
            CanvasDispatcher.requestUpdateNodeProperty(marker, id, numVal, { recordHistory: e.type === 'change' });
            return;
        }
    }
}

customElements.define("property-panel", PropertyPanel);