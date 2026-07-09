// js/core/bezier/manager.js — Coordinator: compositing CurveStore + TreeStore + SequenceService + SnapshotSerializer
import { CurveStore } from './curve_store.js';
import { TreeStore } from './tree_store.js';
import { SequenceService } from './sequence_service.js';
import { SnapshotSerializer } from './snapshot_serializer.js';
import { BooleanEngine } from '../boolean.js';
import { DOMAIN_EVENTS } from '../../domain/events/domain_events.js';
import { EMPTY_CURVE_MANAGER_HOST_PORT } from '../../domain/ports/curve_manager_host_port.js';
import { SelectionState } from '../../domain/selection/selection_state.js';

/**
 * CurveManager: lightweight coordinator, compositing four dedicated sub-modules, preserving existing public API.
 *
 * Sub-modules:
 * - CurveStore   — geometry data (curves, domMap, node/curve CRUD)
 * - TreeStore    — tree hierarchy (treeItems, groups, transforms, properties)
 * - SequenceService — sequence text/parsing/character mapping/offsets
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
    // Selection state (kept independent)
    // =========================================================================
    selection;

    // =========================================================================
    // Events / host port
    // =========================================================================
    eventEmitter = null;
    messageReporter = null;
    _hostPort = EMPTY_CURVE_MANAGER_HOST_PORT;

    // =========================================================================
    // Clipboard (shared across commands)
    // =========================================================================
    clipboard = null;

    // =========================================================================
    // Construction
    // =========================================================================

    constructor() {
        this.curveStore = CurveStore.getInstance();
        this.treeStore = new TreeStore(this.curveStore, (name, detail) => this._emitEvent(name, detail));
        this.seqService = new SequenceService(this.treeStore);
        this.serializer = new SnapshotSerializer(this.curveStore, this.treeStore, this.seqService);
        this.selection = new SelectionState(this);
    }

    // =========================================================================
    // Singleton + active instance
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
    // Events / port
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
    // Selection delegation (delegates to SelectionState)
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
    // CurveStore delegation — node operations
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

    deleteControlNode(marker) {
        const controlNode = this.curveStore.find_node_by_curve(marker);
        const curve = controlNode?.curve;
        const ok = this.curveStore.deleteControlNode(marker);
        if (ok) {
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
    // CurveStore delegation — curve CRUD
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
    // TreeStore delegation — tree operations
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
    // TreeStore delegation — object operations
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
    // TreeStore delegation — transform preview
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
    // TreeStore delegation — bounds editing
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
    // TreeStore delegation — references / clones
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
    // Boolean operations
    // =========================================================================

    _executeBooleanOp(targetCurves, parentGroupId, engineMethod) {
        if (!targetCurves || targetCurves.length === 0) return false;
        try {
            const cmProxy = {
                curves: this.curveStore.curves,
                domMap: this.curveStore.domMap,
                treeItems: this.treeStore.treeItems,
                create_temp_curve: () => {
                    // ensureUniqueName only checks treeItems, not curves, so it
                    // returns the same name for multiple curves created inside a
                    // single boolean op.  Use a unique timestamp-based ID instead.
                    const uid = "Bool_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
                    return this.curveStore.createCurve(uid);
                },
                add_node_by_curve: (...a) => this.curveStore.add_node_by_curve(...a),
                find_node_by_curve: (...a) => this.curveStore.find_node_by_curve(...a),
                commit_curve: (...a) => this.curveStore.commit_curve(...a),
                remove_curve: (...a) => this.curveStore.remove_curve(...a),
                ensureUniqueName: (...a) => this.treeStore.ensureUniqueName(...a),
            };
            const boolEngine = new BooleanEngine(cmProxy);
            const newCurves = boolEngine[engineMethod](targetCurves, parentGroupId);
            if (!newCurves || newCurves.length === 0) return false;

            // Clean up old curves: remove DOM markers, delete tree items,
            // and clear selection (curves already removed from store by proxy)
            for (let c of targetCurves) {
                this.curveStore.unregisterCurveDomMarkers(c);
                this.treeStore.deleteTreeItem(c.id, false);
                this.selected_curves.delete(c);
            }

            // Register new curves in the tree and set groupId
            for (let nc of newCurves) {
                nc.groupId = parentGroupId;
                this.treeStore.treeItems.set(nc.id, {
                    id: nc.id, type: 'curve', curveId: nc.id,
                    name: nc.id, parentId: parentGroupId
                });
                const parent = this.treeStore.treeItems.get(parentGroupId);
                if (parent && parent.type === 'group' && !parent.isRef) {
                    if (!parent.children) parent.children = [];
                    parent.children.push(nc.id);
                    parent.is_modified = true;
                }
                this.selected_curves.add(nc);
            }

            this.treeStore.invalidateGroupCache(parentGroupId);
            this.notifyTreeUpdate();
            return true;
        } catch (err) {
            console.error("Boolean Operation Failed:", err);
            return false;
        }
    }

    executeBooleanUnion(targetCurves, parentGroupId) {
        return this._executeBooleanOp(targetCurves, parentGroupId, 'executeUnion');
    }

    executeBooleanIntersection(targetCurves, parentGroupId) {
        return this._executeBooleanOp(targetCurves, parentGroupId, 'executeIntersection');
    }

    executeBooleanDifference(targetCurves, parentGroupId) {
        return this._executeBooleanOp(targetCurves, parentGroupId, 'executeDifference');
    }

    executeBooleanExclusion(targetCurves, parentGroupId) {
        return this._executeBooleanOp(targetCurves, parentGroupId, 'executeExclusion');
    }

    // =========================================================================
    // TreeStore delegation — images
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
    // SequenceService delegation
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
    // Notifications
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
    // SnapshotSerializer delegation
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
    // applyTreeChildOrder delegation
    // =========================================================================

    applyTreeChildOrder(g, o) { this.treeStore.applyTreeChildOrder(g, o); }
}
