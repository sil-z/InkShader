// js/core/bezier/manager.js — 协调器：组合 CurveStore + TreeStore + SequenceService + SnapshotSerializer
import { CurveStore } from './curve_store.js';
import { TreeStore } from './tree_store.js';
import { SequenceService } from './sequence_service.js';
import { SnapshotSerializer } from './snapshot_serializer.js';
import { BooleanEngine } from '../boolean.js';
import { DOMAIN_EVENTS } from '../../domain/events/domain_events.js';
import { EMPTY_CURVE_MANAGER_HOST_PORT } from '../../domain/ports/curve_manager_host_port.js';
import { SelectionState } from '../../domain/selection/selection_state.js';

/**
 * CurveManager：轻量协调器，组合四个专职子模块，保持原有公共 API 不变。
 *
 * 子模块：
 * - CurveStore   — 几何数据（curves, domMap, 节点/曲线 CRUD）
 * - TreeStore    — 树层级（treeItems, 分组, 变换, 属性）
 * - SequenceService — 序列文本/解析/字符映射/偏移
 * - SnapshotSerializer — JSON I/O
 */
export class CurveManager {
    static _instance = null;
    static _activeResolver = null;

    /** @type {CurveStore} */
    curveStore;
    /** @type {TreeStore} */
    treeStore;
    /** @type {SequenceService} */
    seqService;
    /** @type {SnapshotSerializer} */
    serializer;

    // =========================================================================
    // 选择状态（保持独立）
    // =========================================================================
    selection;

    // =========================================================================
    // 事件 / 宿主端口
    // =========================================================================
    eventEmitter = null;
    messageReporter = null;
    _hostPort = EMPTY_CURVE_MANAGER_HOST_PORT;

    // =========================================================================
    // 剪贴板（跨命令共享）
    // =========================================================================
    clipboard = null;

    // =========================================================================
    // 构造
    // =========================================================================

    constructor() {
        this.curveStore = CurveStore.getInstance();
        this.treeStore = new TreeStore(this.curveStore, (name, detail) => this._emitEvent(name, detail));
        this.seqService = new SequenceService(this.treeStore);
        this.serializer = new SnapshotSerializer(this.curveStore, this.treeStore, this.seqService);
        this.selection = new SelectionState(this);
    }

    // =========================================================================
    // 单例 + 活跃实例
    // =========================================================================

    static setActiveResolver(resolver) {
        CurveManager._activeResolver = typeof resolver === 'function' ? resolver : null;
        CurveStore.setActiveResolver(resolver);
    }

    static resolveActive() {
        return CurveManager._activeResolver?.() ?? CurveManager._instance ?? null;
    }

    static getInstance() {
        if (!CurveManager._instance) {
            CurveManager._instance = new CurveManager();
            CurveManager._instance.initTree();
        }
        return CurveManager._instance;
    }

    // =========================================================================
    // 事件 / 端口
    // =========================================================================

    setEventEmitter(emitter) {
        this.eventEmitter = typeof emitter === 'function' ? emitter : null;
    }

    setHostPort(port) {
        this._hostPort = port && typeof port === 'object' ? port : EMPTY_CURVE_MANAGER_HOST_PORT;
    }

    setMessageReporter(reporter) {
        this.messageReporter = typeof reporter === 'function' ? reporter : null;
    }

    _emitEvent(name, detail = {}) {
        if (!this.eventEmitter) return;
        if (this._hostPort.isRestoring?.()) return;
        this.eventEmitter(name, detail);
    }

    _shouldEmitInteractionEvents() {
        const check = this._hostPort.shouldEmitInteractionEvents;
        return typeof check === 'function' ? check() : true;
    }

    _notifySelectionInvalidated() {
        this._hostPort.onSelectionInvalidated?.();
    }

    _reportMessage(level, message) {
        if (this.messageReporter) {
            this.messageReporter(level, message);
            return;
        }
        if (level === 'error') console.error(message);
        else console.warn(message);
    }

    // =========================================================================
    // 选择代理（委托 SelectionState）
    // =========================================================================

    get selectedTreeIds() { return this.selection.selectedTreeIds; }
    set selectedTreeIds(v) { this.selection.selectedTreeIds = v; }
    get node_selecting() { return this.selection.node_selecting; }
    get node_selecting_ref_by_marker() { return this.selection.node_selecting_ref_by_marker; }
    get selected_curves() { return this.selection.selected_curves; }
    get selected_refs() { return this.selection.selected_refs; }
    get focused_seq_idx() { return this.selection.focused_seq_idx; }
    set focused_seq_idx(v) { this.selection.focused_seq_idx = v; }
    get activeGroupId() { return this.selection.activeGroupId; }
    set activeGroupId(v) { this.selection.activeGroupId = v; }

    addNodeSelection(markers) { return this.selection.addNodeSelection(markers); }
    removeNodeSelection(markers) { return this.selection.removeNodeSelection(markers); }
    clearNodeSelection() { return this.selection.clearNodeSelection(); }
    setNodeSelectionRefContext(marker, refId) { return this.selection.setNodeSelectionRefContext(marker, refId); }
    getNodeSelectionRefId(marker) { return this.selection.getNodeSelectionRefId(marker); }
    removeNodeSelectionRefContext(markers) { return this.selection.removeNodeSelectionRefContext(markers); }
    replaceNodeSelection(markers, refContext) { return this.selection.replaceNodeSelection(markers, refContext); }
    changeNodeSelection(strategy, markers, refContext) { return this.selection.changeNodeSelection(strategy, markers, refContext); }
    addObjectSelection(curves, refs) { return this.selection.addObjectSelection(curves, refs); }
    removeObjectSelection(curves, refs) { return this.selection.removeObjectSelection(curves, refs); }
    clearObjectSelection() { return this.selection.clearObjectSelection(); }
    replaceObjectSelection(curves, refs) { return this.selection.replaceObjectSelection(curves, refs); }
    updateActiveGroup(groupId) { return this.selection.updateActiveGroup(groupId); }
    changeObjectSelection(strategy, payload) { return this.selection.changeObjectSelection(strategy, payload); }
    setTreeSelection(idsArray) { return this.selection.setTreeSelection(idsArray); }
    syncTreeSelectionFromCanvas() { return this.selection.syncTreeSelectionFromCanvas(); }
    clearAllSelection() { return this.selection.clearAllSelection(); }
    validateSelection() { return this.selection.validateSelection(); }

    // =========================================================================
    // CurveStore 委托 — 节点操作
    // =========================================================================

    find_curve_by_dom(m) { return this.curveStore.find_curve_by_dom(m); }
    find_node_by_curve(m) { return this.curveStore.find_node_by_curve(m); }
    find_node_by_dom(m) { return this.curveStore.find_node_by_dom(m); }

    adjustControlNode(marker, x, y) {
        const ok = this.curveStore.adjustControlNode(marker, x, y);
        if (ok) {
            const node = this.curveStore.find_node_by_curve(marker);
            const curve = node?.curve;
            if (curve?.groupId) this.invalidateGroupCache(curve.groupId);
            else this.notifyModelUpdate();
        }
        return ok;
    }

    moveSingleNode(marker, x, y, c1, c2) {
        const ok = this.curveStore.moveSingleNode(marker, x, y, c1, c2);
        if (ok) {
            const node = this.curveStore.find_node_by_curve(marker);
            const curve = node?.curve;
            if (curve?.groupId) this.invalidateGroupCache(curve.groupId);
            else this.notifyModelUpdate();
        }
        return ok;
    }

    moveSelectedNodes(updates) {
        const { changed, affectedGroups } = this.curveStore.moveSelectedNodes(updates);
        for (let gid of affectedGroups) this.invalidateGroupCache(gid);
        if (changed && affectedGroups.size === 0) this.notifyModelUpdate();
        return changed;
    }

    changeSmoothModeOnSingleNode(marker, mode, force = false) {
        const ok = this.curveStore.changeSmoothModeOnSingleNode(marker, mode, force);
        if (ok) {
            const node = this.curveStore.find_node_by_curve(marker);
            const curve = node?.curve;
            if (curve?.groupId) this.invalidateGroupCache(curve.groupId);
            else this.notifyModelUpdate();
        }
        return ok;
    }

    deleteSingleNode(marker) {
        const result = this.curveStore.deleteSingleNode(marker);
        if (!result) return false;

        this.removeNodeSelection([marker]);

        if (result.isEmpty) {
            this.remove_curve(result.curve.id);
        } else {
            this.invalidateGroupCache(result.curve.groupId);
        }
        return true;
    }

    updateNodeProperty(marker, propId, numVal) {
        const result = this.curveStore.updateNodeProperty(marker, propId, numVal);
        if (!result) return false;
        if (result.curve?.groupId) this.invalidateGroupCache(result.curve.groupId);
        else this.notifyModelUpdate();
        return true;
    }

    // =========================================================================
    // CurveStore 委托 — 曲线 CRUD
    // =========================================================================

    get curves() { return this.curveStore.curves; }
    get domMap() { return this.curveStore.domMap; }

    get_curves() { return this.curveStore.get_curves(); }

    create_temp_curve() {
        let newId = this.treeStore.ensureUniqueName("Path");
        return this.curveStore.createCurve(newId);
    }

    add_node_by_curve(...args) { return this.curveStore.add_node_by_curve(...args); }

    commit_curve(curve, targetGroupId = null) {
        const parentId = targetGroupId || this.ensureActiveGroup();
        if (!parentId) return;
        curve.groupId = parentId;
        this.curveStore.commit_curve(curve);
        this.treeStore.treeItems.set(curve.id, {
            id: curve.id, type: 'curve', curveId: curve.id, name: curve.id, parentId: parentId
        });
        const parent = this.treeStore.treeItems.get(parentId);
        if (parent && parent.type === 'group' && !parent.isRef) {
            if (!parent.children) parent.children = [];
            parent.children.push(curve.id);
            parent.is_modified = true;
        }
        this.notifyTreeUpdate();
    }

    remove_curve(id) {
        if (this.curveStore.remove_curve(id)) {
            this.treeStore.deleteTreeItem(id, false);
            this.notifyTreeUpdate();
            return true;
        }
        return false;
    }

    rollbackLastPathNode(curve) { return this.curveStore.rollbackLastPathNode(curve); }

    startAddingPath(targetGroupId = null, pathProps = null) {
        const parentId = targetGroupId || this.ensureActiveGroup();
        if (!parentId) return null;

        let curve = this.create_temp_curve();
        curve.groupId = parentId;
        if (pathProps) {
            if (pathProps.stroke_width !== undefined) curve.stroke_width = pathProps.stroke_width;
            if (pathProps.closed !== undefined) curve.closed = pathProps.closed;
            if (pathProps.smart_stroke !== undefined) curve.smart_stroke = pathProps.smart_stroke;
            if (pathProps.show_skeleton !== undefined) curve.show_skeleton = pathProps.show_skeleton;
        }
        return curve;
    }

    addPath(curve, targetGroupId = null) {
        if (!curve || !curve.startNode) return false;
        this.commit_curve(curve, targetGroupId);
        return true;
    }

    finishAddingPath(curve, targetGroupId = null) {
        return this.addPath(curve, targetGroupId);
    }

    // =========================================================================
    // TreeStore 委托 — 树操作
    // =========================================================================

    get treeItems() { return this.treeStore.treeItems; }
    get rootChildren() { return this.treeStore.rootChildren; }
    get groupFlatCache() { return this.treeStore.groupFlatCache; }
    set groupFlatCache(v) { this.treeStore.groupFlatCache = v; }
    get boundsEditSession() { return this.treeStore.boundsEditSession; }
    set boundsEditSession(v) { this.treeStore.boundsEditSession = v; }

    initTree() {
        this.treeStore.initTree();
        this.seqService.defaultGlyphs.clear();
        this.clearAllSelection();
    }

    getGroupByName(name) { return this.treeStore.getGroupByName(name); }
    ensureUniqueName(base, ignore) { return this.treeStore.ensureUniqueName(base, ignore); }
    isDescendant(p, t, v) { return this.treeStore.isDescendant(p, t, v); }
    getRootGroupId(g) { return this.treeStore.getRootGroupId(g); }

    renameItem(oldId, newName) {
        const item = this.treeItems.get(oldId);
        if (!item) return false;

        if (item.type === 'group' && item.parentId === null && !item.isRef) {
            let oldRef = `\\${oldId}\\`;
            let newRef = `\\${newName}\\`;
            if (this.seqService.sequenceText.includes(oldRef)) {
                this.seqService.sequenceText = this.seqService.sequenceText.split(oldRef).join(newRef);
            }
        }

        if (!this.treeStore.renameItem(oldId, newName)) return false;

        for (let [char, gid] of this.seqService.defaultGlyphs.entries()) {
            if (gid === oldId) this.seqService.defaultGlyphs.set(char, newName);
        }

        if (this.selectedTreeIds.has(oldId)) {
            this.selectedTreeIds.delete(oldId);
            this.selectedTreeIds.add(newName);
        }
        if (this.activeGroupId === oldId) this.activeGroupId = newName;

        this.updateSequenceParsing();
        this.seqService.rebuildDefaultGlyphs();
        this.notifyTreeUpdate();
        return true;
    }

    deleteTreeItem(id, cascade = true) { this.treeStore.deleteTreeItem(id, cascade); }

    getCurvesForGroup(g) { return this.treeStore.getCurvesForGroup(g); }
    invalidateGroupCache(t) {
        this.treeStore.invalidateGroupCache(t);
        this.notifyModelUpdate();
    }

    // =========================================================================
    // TreeStore 委托 — 对象操作
    // =========================================================================

    deleteSingleObject(objectId) {
        const result = this.treeStore.deleteSingleObject(objectId);
        if (!result) return false;

        if (result.curveIdsToDelete.size > 0) {
            const invalidMarkers = [];
            for (const marker of this.node_selecting) {
                const curve = this.find_curve_by_dom(marker);
                if (curve && result.curveIdsToDelete.has(curve.id)) invalidMarkers.push(marker);
            }
            if (invalidMarkers.length > 0) this.removeNodeSelection(invalidMarkers);
        }

        for (const curve of Array.from(this.selected_curves)) {
            if (curve && result.curveIdsToDelete.has(curve.id)) this.selected_curves.delete(curve);
        }
        for (const ref of Array.from(this.selected_refs)) {
            if (ref && ref.id && result.treeIdsToDelete.has(ref.id)) this.selected_refs.delete(ref);
        }
        for (const treeId of result.treeIdsToDelete) {
            this.selectedTreeIds.delete(treeId);
        }

        if (this.activeGroupId && result.treeIdsToDelete.has(this.activeGroupId)) {
            const item = this.treeStore.treeItems.get(objectId);
            const fallbackParentId = item?.parentId && !result.treeIdsToDelete.has(item.parentId) ? item.parentId : null;
            this.activeGroupId = fallbackParentId;
        }

        return true;
    }

    changeSingleObjectGroup(o, t, m) { return this.treeStore.changeSingleObjectGroup(o, t, m); }
    setSingleObjectProperties(id, props) { return this.treeStore.setSingleObjectProperties(id, props); }
    toggleSingleObjectLock(id, l) { return this.treeStore.toggleSingleObjectLock(id, l); }
    toggleSingleObjectDisplay(id, v) { return this.treeStore.toggleSingleObjectDisplay(id, v); }

    // =========================================================================
    // TreeStore 委托 — 变换预览
    // =========================================================================

    applyTransformPreview(payload) {
        return this.treeStore.applyTransformPreview(payload, {
            sequenceTokens: this.seqService.sequenceTokens,
            activeSequenceIndices: this.seqService.activeSequenceIndices,
            getSeqOffset: (i) => this.seqService.getSeqOffset(i),
            getDefaultGroupForChar: (c) => this.seqService.getDefaultGroupForChar(c),
        });
    }

    translateTransformPreview(dx, dy, snaps, snapRefs) {
        return this.treeStore.translateTransformPreview(dx, dy, snaps, snapRefs);
    }

    // =========================================================================
    // TreeStore 委托 — 边界编辑
    // =========================================================================

    changeSelectedObjectsBounds(prop, val, bounds, geometryBounds, options) {
        return this.treeStore.changeSelectedObjectsBounds(prop, val, bounds, geometryBounds, options, {
            selectedCurves: this.selected_curves,
            selectedRefs: this.selected_refs,
            activeSequenceIndices: this.seqService.activeSequenceIndices,
            getSeqIdxForGroupId: (groupId) => {
                let seqTokens = this.seqService.sequenceTokens || [];
                let activeIndices = this.seqService.activeSequenceIndices || new Set();
                let focused = this.focused_seq_idx;

                if (focused !== undefined && focused !== -1 && focused < seqTokens.length) {
                    let t = seqTokens[focused];
                    let gid = t.isChar ? this.seqService.getDefaultGroupForChar(t.value) : t.value;
                    if (groupId === gid && activeIndices.has(focused)) return focused;
                }
                for (let i = 0; i < seqTokens.length; i++) {
                    let t = seqTokens[i];
                    let gid = t.isChar ? this.seqService.getDefaultGroupForChar(t.value) : t.value;
                    if (groupId === gid && activeIndices.has(i)) return i;
                }
                for (let i = 0; i < seqTokens.length; i++) {
                    let t = seqTokens[i];
                    let gid = t.isChar ? this.seqService.getDefaultGroupForChar(t.value) : t.value;
                    if (groupId === gid) return i;
                }
                return -1;
            },
            getSeqOffset: (i) => this.seqService.getSeqOffset(i),
        });
    }

    // =========================================================================
    // TreeStore 委托 — 引用 / 克隆
    // =========================================================================

    pasteGroupRef(src, tgt, tx) {
        const id = this.treeStore.pasteGroupRef(src, tgt, tx);
        if (id) {
            this.invalidateGroupCache(tgt);
            this.updateSequenceParsing();
            this.notifyTreeUpdate();
        }
        return id;
    }

    cloneCurveToGroup(curve, targetGroupId = null) {
        if (!curve || !curve.startNode) return null;

        let newCurve = this.create_temp_curve();
        let current = curve.startNode;
        let lastNodeMarker = null;

        while (current) {
            const mainMarker = { id: `m_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}` };
            this.add_node_by_curve(
                mainMarker, "vertex", current.x, current.y,
                null, lastNodeMarker, newCurve, String(mainMarker.id)
            );

            const newNode = this.find_node_by_curve(mainMarker);
            if (!newNode) return null;
            newNode.smooth = current.smooth;

            if (current.control_mode !== 0 || current.control1 || current.control2) {
                this.changeSmoothModeOnSingleNode(mainMarker, current.control_mode, true);
            }

            if (current.control1 && newNode.control1) {
                newNode.control1.x = current.control1.x;
                newNode.control1.y = current.control1.y;
            }
            if (current.control2 && newNode.control2) {
                newNode.control2.x = current.control2.x;
                newNode.control2.y = current.control2.y;
            }

            lastNodeMarker = mainMarker;
            current = current.nextOnCurve;
        }

        if (lastNodeMarker) {
            newCurve.endNode = this.find_node_by_curve(lastNodeMarker);
        }
        newCurve.closed = curve.closed;
        newCurve.stroke_width = curve.stroke_width;
        newCurve.smart_stroke = curve.smart_stroke;
        newCurve.smart_stroke_clockwise = curve.smart_stroke_clockwise !== false;
        newCurve.show_skeleton = curve.show_skeleton;
        newCurve.visible = curve.visible !== false;
        newCurve.locked = curve.locked === true;

        this.addPath(newCurve, targetGroupId);
        return newCurve;
    }

    duplicateGroupDeep(groupId, targetParentId) {
        const result = this.treeStore.duplicateGroupDeep(groupId, targetParentId, (curve, parentId) => {
            return this.cloneCurveToGroup(curve, parentId);
        });
        if (!result) return null;

        let sequenceChanged = false;
        if (!targetParentId) {
            const escapeName = `\\${result.id}\\`;
            let newActive = new Set();
            newActive.add(0);
            for (let idx of this.seqService.activeSequenceIndices) newActive.add(idx + 1);
            this.seqService.sequenceText = escapeName + this.seqService.sequenceText;
            this.seqService.activeSequenceIndices = newActive;
            sequenceChanged = true;
        }

        this.notifyTreeUpdate();
        return { id: result.id, sequenceChanged, activeIndices: Array.from(this.seqService.activeSequenceIndices) };
    }

    unlinkReferenceDeep(refId) {
        return this.treeStore.unlinkReferenceDeep(refId, (curve, parentId) => {
            return this.cloneCurveToGroup(curve, parentId);
        });
    }

    // =========================================================================
    // 布尔运算
    // =========================================================================

    executeBooleanUnion(targetCurves, parentGroupId) {
        if (!targetCurves || targetCurves.length === 0) return false;
        try {
            const cmProxy = {
                curves: this.curveStore.curves,
                domMap: this.curveStore.domMap,
                treeItems: this.treeStore.treeItems,
                create_temp_curve: (prefix) => this.create_temp_curve(),
                add_node_by_curve: (...a) => this.curveStore.add_node_by_curve(...a),
                find_node_by_curve: (...a) => this.curveStore.find_node_by_curve(...a),
                commit_curve: (...a) => this.curveStore.commit_curve(...a),
                remove_curve: (...a) => this.curveStore.remove_curve(...a),
                ensureUniqueName: (...a) => this.treeStore.ensureUniqueName(...a),
            };
            const boolEngine = new BooleanEngine(cmProxy);
            const newCurves = boolEngine.executeUnion(targetCurves, parentGroupId);
            if (!newCurves || newCurves.length === 0) return false;

            targetCurves.forEach(c => {
                this.selected_curves.delete(c);
                let treeItem = Array.from(this.treeItems.values()).find(item => item.curveId === c.id);
                if (treeItem) this.selectedTreeIds.delete(treeItem.id);
            });

            for (let nc of newCurves) this.selected_curves.add(nc);
            this.syncTreeSelectionFromCanvas();
            return true;
        } catch (err) {
            console.error("Boolean Operation Failed:", err);
            return false;
        }
    }

    // =========================================================================
    // TreeStore 委托 — 图片
    // =========================================================================

    importImageToCurrentGroup(img, name) {
        const id = this.treeStore.importImageToCurrentGroup(img, name, this.activeGroupId);
        if (id) this.notifyTreeUpdate();
        return id;
    }

    restoreSessionImages(imgs) {
        if (this.treeStore.restoreSessionImages(imgs)) {
            this.notifyTreeUpdate();
            return true;
        }
        return false;
    }

    // =========================================================================
    // SequenceService 委托
    // =========================================================================

    get sequenceText() { return this.seqService.sequenceText; }
    set sequenceText(v) { this.seqService.sequenceText = v; }
    get sequenceTokens() { return this.seqService.sequenceTokens; }
    get activeSequenceIndices() { return this.seqService.activeSequenceIndices; }
    set activeSequenceIndices(v) { this.seqService.activeSequenceIndices = v; }
    get defaultGlyphs() { return this.seqService.defaultGlyphs; }
    get sequenceOffsets() { return this.seqService.sequenceOffsets; }

    parseSequence(text) { return this.seqService.parseSequence(text); }
    rebuildDefaultGlyphs() { this.seqService.rebuildDefaultGlyphs(); }
    getDefaultGroupForChar(c) { return this.seqService.getDefaultGroupForChar(c); }
    getAGLName(c) { return this.seqService.getAGLName(c); }
    getSeqOffset(i) { return this.seqService.getSeqOffset(i); }
    calculateSequenceOffsets() { this.seqService.calculateSequenceOffsets(); }

    setSequence(text) {
        this.seqService.setSequence(text);
        this.updateSequenceParsing();
    }

    setSequenceState(opts) {
        if (this.seqService.setSequenceState(opts)) {
            this.updateSequenceParsing();
            return true;
        }
        return false;
    }

    setActiveIndices(s) {
        this.seqService.setActiveIndices(s);
        this.updateSequenceParsing();
    }

    updateSequenceParsing() {
        this.seqService.updateSequenceParsing();
        this.seqService.syncTreeWithSequence(
            () => this.validateSelection(),
            () => this.syncTreeSelectionFromCanvas(),
            () => this._notifySelectionInvalidated(),
            () => this.notifyTreeUpdate()
        );
    }

    ensureActiveGroup() {
        const id = this.seqService.ensureActiveGroup(this.activeGroupId);
        if (id) this.activeGroupId = id;
        return id;
    }

    // =========================================================================
    // 通知
    // =========================================================================

    notifyTreeUpdate() {
        this.treeStore.groupFlatCache.clear();
        this.seqService.calculateSequenceOffsets();
        this._emitEvent(DOMAIN_EVENTS.TREE_UPDATED);
    }

    notifyModelUpdate() {
        this._emitEvent(DOMAIN_EVENTS.MODEL_UPDATED);
    }

    // =========================================================================
    // SnapshotSerializer 委托
    // =========================================================================

    async loadFromJSON(jsonStr) {
        await this.serializer.loadFromJSON(jsonStr, (l, m) => this._reportMessage(l, m));
    }

    async loadFromSnapshotObject(data) {
        await this.serializer.loadFromSnapshotObject(data, (l, m) => this._reportMessage(l, m));
    }

    replacePathFromSnapshotData(g, p, d) {
        return this.serializer.replacePathFromSnapshotData(g, p, d);
    }

    _reconstructGroup(gid, gData, parentId, charCode = null) {
        return this.serializer._reconstructGroup(gid, gData, parentId, charCode);
    }

    exportJSON(state) {
        return this.serializer.exportJSON(state);
    }

    // =========================================================================
    // applyTreeChildOrder 委托
    // =========================================================================

    applyTreeChildOrder(g, o) { this.treeStore.applyTreeChildOrder(g, o); }
}
