// js/core/bezier/manager.js
import { Curve } from './curve.js';
import { CurveNode } from './node.js';
import { generateMarker } from './utils.js';
import { TransformEngine } from '../transform_engine.js';
import { BooleanEngine } from '../boolean.js';
import { DOMAIN_EVENTS } from '../../domain/events/domain_events.js';
import { EMPTY_CURVE_MANAGER_HOST_PORT } from '../../domain/ports/curve_manager_host_port.js';
import { SelectionState } from '../../domain/selection/selection_state.js';
import { getSequenceDisplayChar } from '../../domain/sequence/sequence_display.js';
import { parseSequenceTokens } from '../../domain/sequence/sequence_tokenizer.js';
export class CurveManager {
    static _instance = null;
    /** 由 presentation/bootstrap 注入，core 不访问 document */
    static _activeResolver = null;
    curves = [];
    domMap = new Map();

    treeItems = new Map();
    rootChildren = [];
    clipboard = null;

    constructor() {
        this.selection = new SelectionState(this);
    }

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

    sequenceText = "";
    sequenceTokens = [];
    activeSequenceIndices = new Set();
    defaultGlyphs = new Map(); 

    sequenceOffsets = []; 
    groupFlatCache = new Map();
    boundsEditSession = null;
    eventEmitter = null;
    messageReporter = null;
    /** @type {import('../../domain/ports/curve_manager_host_port.js').CurveManagerHostPort} */
    _hostPort = EMPTY_CURVE_MANAGER_HOST_PORT;

    find_curve_by_dom(main_node) {
        const curve = this.domMap.get(main_node)?.curve ?? null;
        if (!curve) return null;
        return this.curves.includes(curve) ? curve : null;
    } 
    find_node_by_curve(main_node) { return this.domMap.get(main_node) ?? null; }
    find_node_by_dom(main_node) {
        const manager = CurveManager.resolveActive() ?? this;
        return this.domMap.get(main_node) ?? manager.domMap.get(main_node) ?? null;
    }

    /** 从 manager / curve domMap 移除路径上所有 marker（替换或删除曲线前调用） */
    unregisterCurveDomMarkers(curve) {
        if (!curve) return;
        let current = curve.startNode;
        while (current) {
            if (current.main_node) {
                curve.domMap.delete(current.main_node);
                this.domMap.delete(current.main_node);
            }
            if (current.control1?.main_node) {
                curve.domMap.delete(current.control1.main_node);
                this.domMap.delete(current.control1.main_node);
            }
            if (current.control2?.main_node) {
                curve.domMap.delete(current.control2.main_node);
                this.domMap.delete(current.control2.main_node);
            }
            current = current.nextOnCurve;
        }
    }

    _registerNodeDomMarkers(curve, node) {
        if (!curve || !node) return;
        if (node.main_node) {
            curve.domMap.set(node.main_node, node);
            this.domMap.set(node.main_node, node);
        }
        if (node.control1?.main_node) {
            curve.domMap.set(node.control1.main_node, node.control1);
            this.domMap.set(node.control1.main_node, node.control1);
        }
        if (node.control2?.main_node) {
            curve.domMap.set(node.control2.main_node, node.control2);
            this.domMap.set(node.control2.main_node, node.control2);
        }
    }

    static setActiveResolver(resolver) {
        CurveManager._activeResolver = typeof resolver === "function" ? resolver : null;
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

    setEventEmitter(emitter) {
        this.eventEmitter = typeof emitter === 'function' ? emitter : null;
    }

    /** 注入宿主端口（恢复态、Store 投影、选区对账）；由 app/curve_manager_host_adapter 提供 */
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

    /** Store → CM 投影时不向 UI 反向发射选区事件 */
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
    // 交互选区（委托 SelectionState）
    // =========================================================================

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

    /**
     * Action: 改变单个控制点的坐标
     * 作用: 纯粹更新坐标，供高频拖拽或最终确认调用
     */
    adjustControlNode(marker, x, y) {
        let controlNode = this.find_node_by_curve(marker);
        if (!controlNode) return false;

        controlNode.x = x;
        controlNode.y = y;

        if (controlNode.nextOnCurve && typeof controlNode.nextOnCurve.set_both_control === 'function') {
            let mainNode = controlNode.nextOnCurve;
            mainNode.set_both_control(marker, mainNode.control_mode);
        }

        let curve = controlNode.curve;
        if (curve && curve.groupId) {
            this.invalidateGroupCache(curve.groupId);
        } else {
            this.notifyModelUpdate();
        }
        return true;
    }

    /**
     * Action: 移动单个主节点
     * 控制点随主节点平移，保持相对偏移；供高频拖拽或最终确认调用
     */
    moveSingleNode(marker, x, y, control1 = null, control2 = null) {
        let node = this.find_node_by_curve(marker);
        if (!node || node.type === null) return false;

        let dx = x - node.x;
        let dy = y - node.y;
        node.x = x;
        node.y = y;

        if (control1 && node.control1) {
            node.control1.x = control1.x;
            node.control1.y = control1.y;
        } else if (node.control1) {
            node.control1.x += dx;
            node.control1.y += dy;
        }

        if (control2 && node.control2) {
            node.control2.x = control2.x;
            node.control2.y = control2.y;
        } else if (node.control2) {
            node.control2.x += dx;
            node.control2.y += dy;
        }

        let curve = node.curve;
        if (curve && curve.groupId) {
            this.invalidateGroupCache(curve.groupId);
        } else {
            this.notifyModelUpdate();
        }
        return true;
    }

    /**
     * Action: 批量移动主节点
     * @param {Array} updates - TransformEngine.calculateNodesTranslation 的输出
     */
    moveSelectedNodes(updates) {
        if (!updates || updates.length === 0) return false;

        let changed = false;
        let affectedGroups = new Set();

        for (const update of updates) {
            let node = this.find_node_by_curve(update.marker);
            if (!node || node.type === null) continue;

            let dx = update.x - node.x;
            let dy = update.y - node.y;
            node.x = update.x;
            node.y = update.y;

            if (update.control1 && node.control1) {
                node.control1.x = update.control1.x;
                node.control1.y = update.control1.y;
            } else if (node.control1) {
                node.control1.x += dx;
                node.control1.y += dy;
            }

            if (update.control2 && node.control2) {
                node.control2.x = update.control2.x;
                node.control2.y = update.control2.y;
            } else if (node.control2) {
                node.control2.x += dx;
                node.control2.y += dy;
            }

            changed = true;
            if (node.curve && node.curve.groupId) affectedGroups.add(node.curve.groupId);
        }

        for (let gid of affectedGroups) this.invalidateGroupCache(gid);
        if (changed && affectedGroups.size === 0) this.notifyModelUpdate();
        return changed;
    }

    /**
     * Action: 修改单个节点的平滑状态
     */
    changeSmoothModeOnSingleNode(marker, mode, forceCreateHandles = false) {
        let node = this.find_node_by_curve(marker);
        if (!node || node.type === null) return false;
        if (node.control_mode === mode && !forceCreateHandles) return false;

        node.applyMode(mode, this);
        if (forceCreateHandles) {
            if (!node.control1) {
                let c1M = generateMarker("circle");
                let c1Node = new CurveNode(c1M, null, node.x, node.y, node, null, String(c1M.id));
                c1Node.curve = node.curve;
                node.control1 = c1Node;
                this.domMap.set(c1M, c1Node);
                if (node.curve) node.curve.domMap.set(c1M, c1Node);
            }
            if (!node.control2) {
                let c2M = generateMarker("circle");
                let c2Node = new CurveNode(c2M, null, node.x, node.y, node, null, String(c2M.id));
                c2Node.curve = node.curve;
                node.control2 = c2Node;
                this.domMap.set(c2M, c2Node);
                if (node.curve) node.curve.domMap.set(c2M, c2Node);
            }
        }
        node.control_mode = mode;

        let curve = node.curve;
        if (curve && curve.groupId) {
            this.invalidateGroupCache(curve.groupId);
        } else {
            this.notifyModelUpdate();
        }
        return true;
    }

    /**
     * Action: 删除单个节点
     * 作用: 整合Symmetric降级逻辑，调用底层曲线拟合，并安全清理数据映射
     */
    deleteSingleNode(marker) {
        let node = this.find_node_by_curve(marker);
        if (!node || !node.curve) return false;

        let curve = node.curve;
        let prevNode = node.lastOnCurve;
        let nextNode = node.nextOnCurve;

        // 1. 【逻辑整合】：处理相邻节点的降级 (Symmetric -> Smooth)
        // 保证接下来曲线拟合函数在调整靠近侧控制点时，不会因为对称模式而被动破坏另一侧的曲线
        if (prevNode && prevNode.control_mode === 2) {
            prevNode.control_mode = 1;
        }
        if (nextNode && nextNode.control_mode === 2) {
            nextNode.control_mode = 1;
        }

        // 2. 【核心修复】：重新调用原本包含曲线智能拟合逻辑的 remove_node_by_dom
        // 这将自动处理 -1/+1 为 Smooth/Corner 时的把手调整，并完成链表的拼接
        curve.remove_node_by_dom(marker);

        // 3. Manager 层的全局数据映射彻底清理
        this.domMap.delete(marker);
        if (node.control1) this.domMap.delete(node.control1.main_node);
        if (node.control2) this.domMap.delete(node.control2.main_node);

        // 4. 从当前选中集中安全移除
        this.removeNodeSelection([marker]);

        // 5. 校验曲线死活与刷新缓存
        if (!curve.startNode) {
            this.remove_curve(curve.id);
        } else {
            this.invalidateGroupCache(curve.groupId);
        }

        return true;
    }

    /**
     * Action: 删除单个对象（curve/group/ref/image）
     * 作用: 仅执行数据层删除与选择清理，不写历史
     */
    deleteSingleObject(objectId) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        const treeIdsToDelete = new Set();
        const curveIdsToDelete = new Set();

        const collect = (id) => {
            const target = this.treeItems.get(id);
            if (!target) return;
            if (treeIdsToDelete.has(id)) return;
            treeIdsToDelete.add(id);

            if (target.type === 'curve') {
                curveIdsToDelete.add(target.curveId || target.id);
                return;
            }
            if (target.type === 'group' && !target.isRef) {
                for (const childId of (target.children || [])) {
                    collect(childId);
                }
            }
        };
        collect(objectId);

        if (curveIdsToDelete.size > 0) {
            const invalidMarkers = [];
            for (const marker of this.node_selecting) {
                const curve = this.find_curve_by_dom(marker);
                if (curve && curveIdsToDelete.has(curve.id)) invalidMarkers.push(marker);
            }
            if (invalidMarkers.length > 0) this.removeNodeSelection(invalidMarkers);
        }

        for (const curve of Array.from(this.selected_curves)) {
            if (curve && curveIdsToDelete.has(curve.id)) this.selected_curves.delete(curve);
        }
        for (const ref of Array.from(this.selected_refs)) {
            if (ref && ref.id && treeIdsToDelete.has(ref.id)) this.selected_refs.delete(ref);
        }
        for (const treeId of treeIdsToDelete) {
            this.selectedTreeIds.delete(treeId);
        }

        if (this.activeGroupId && treeIdsToDelete.has(this.activeGroupId)) {
            const fallbackParentId = item.parentId && !treeIdsToDelete.has(item.parentId) ? item.parentId : null;
            this.activeGroupId = fallbackParentId;
        }

        this.deleteTreeItem(objectId, true);
        return true;
    }

    /**
     * Action: 更改单个对象归属或层级位置
     * @param {string} objectId 拖拽对象 id
     * @param {string} targetId 目标对象 id
     * @param {'inside'|'before'|'after'} mode 放置模式
     */
    changeSingleObjectGroup(objectId, targetId, mode = 'inside') {
        const moving = this.treeItems.get(objectId);
        const target = this.treeItems.get(targetId);
        if (!moving || !target) return false;
        if (objectId === targetId) return false;

        if (!['inside', 'before', 'after'].includes(mode)) return false;

        // 分组拖入分组内部：创建引用（保持原分组不动）
        if (mode === 'inside' && moving.type === 'group' && !moving.isRef) {
            if (target.type !== 'group' || target.isRef) return false;
            if (this.isDescendant(objectId, targetId)) return false;
            this.pasteGroupRef(objectId, targetId);
            return true;
        }

        let newParentId = null;
        if (mode === 'inside') {
            if (target.type !== 'group' || target.isRef) return false;
            newParentId = targetId;
        } else {
            newParentId = target.parentId || null;
        }

        if (newParentId !== null && this.isDescendant(objectId, newParentId)) return false;

        if (moving.parentId === newParentId && (mode === 'inside' || moving.id === targetId)) return false;

        // 从旧父节点（或根）移除
        const oldParentId = moving.parentId || null;
        if (oldParentId) {
            const oldParent = this.treeItems.get(oldParentId);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(cid => cid !== objectId);
                oldParent.is_modified = true;
            }
        } else {
            this.rootChildren = this.rootChildren.filter(cid => cid !== objectId);
        }

        // 插入新位置
        if (mode === 'inside') {
            if (!target.children) target.children = [];
            target.children.push(objectId);
            target.is_modified = true;
        } else {
            const siblings = newParentId ? (this.treeItems.get(newParentId)?.children || []) : this.rootChildren;
            const targetIndex = siblings.indexOf(targetId);
            if (targetIndex === -1) siblings.push(objectId);
            else if (mode === 'before') siblings.splice(targetIndex, 0, objectId);
            else siblings.splice(targetIndex + 1, 0, objectId);
        }

        moving.parentId = newParentId;

        if (moving.type === 'curve') {
            const curve = this.curves.find(c => c.id === moving.curveId);
            if (curve) curve.groupId = newParentId;
        }

        return true;
    }

    /**
     * Action: 修改单个对象属性（路径/引用等）
     * 作用: 纯数据变更，不写历史
     */
    setSingleObjectProperties(objectId, props = {}) {
        const item = this.treeItems.get(objectId);
        if (!item || !props || typeof props !== 'object') return false;

        let changed = false;

        if (item.type === 'curve') {
            const curve = this.curves.find(c => c.id === item.curveId);
            if (!curve) return false;

            const directProps = ['stroke_width', 'closed', 'smart_stroke', 'show_skeleton', 'smart_stroke_clockwise', 'visible', 'locked'];
            for (const key of directProps) {
                if (Object.prototype.hasOwnProperty.call(props, key) && curve[key] !== props[key]) {
                    curve[key] = props[key];
                    changed = true;
                }
            }

            if (props.reverse_direction === true) {
                if (curve.getSkeletonVertices().length >= 2 && curve.reverseSkeletonDirection()) {
                    changed = true;
                }
            }

            if (props.toggle_smart_winding === true && curve.smart_stroke === true) {
                curve.smart_stroke_clockwise = !(curve.smart_stroke_clockwise !== false);
                changed = true;
            }

            if (changed) {
                curve.cached_boolean_geometry = null;
                curve._lastHash = null;
                if (curve.groupId) this.invalidateGroupCache(curve.groupId);
                else this.notifyModelUpdate();
            }
            return changed;
        }

        if (item.type === 'group' && item.isRef) {
            const hasTx = Object.prototype.hasOwnProperty.call(props, 'ref_tx');
            const hasTy = Object.prototype.hasOwnProperty.call(props, 'ref_ty');
            if (!hasTx && !hasTy) return false;

            const oldTx = item.transform?.e || 0;
            const oldTy = item.transform?.f || 0;
            const newTx = hasTx ? Number(props.ref_tx) : oldTx;
            const newTy = hasTy ? Number(props.ref_ty) : oldTy;
            if (Number.isFinite(newTx) && Number.isFinite(newTy) && (newTx !== oldTx || newTy !== oldTy)) {
                item.transform = new DOMMatrix().translate(newTx, newTy);
                changed = true;
            }

            if (changed) {
                this.invalidateGroupCache(item.id);
            }
            return changed;
        }

        return false;
    }

    /**
     * Action: 锁定/解锁单个对象
     */
    toggleSingleObjectLock(objectId, locked = undefined) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        if (item.type === 'curve') {
            const curve = this.curves.find(c => c.id === item.curveId);
            if (!curve) return false;
            const current = curve.locked === true;
            const target = typeof locked === 'boolean' ? locked : !current;
            if (current === target) return false;
            curve.locked = target;
            item.locked = target;
            if (curve.groupId) this.invalidateGroupCache(curve.groupId);
            else this.notifyModelUpdate();
            return true;
        }

        const current = item.locked === true;
        const target = typeof locked === 'boolean' ? locked : !current;
        if (current === target) return false;
        item.locked = target;
        this.invalidateGroupCache(item.id);
        return true;
    }

    /**
     * Action: 显示/隐藏单个对象
     */
    toggleSingleObjectDisplay(objectId, visible = undefined) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        if (item.type === 'curve') {
            const curve = this.curves.find(c => c.id === item.curveId);
            if (!curve) return false;
            const current = curve.visible !== false;
            const target = typeof visible === 'boolean' ? visible : !current;
            if (current === target) return false;
            curve.visible = target;
            item.visible = target;
            if (curve.groupId) this.invalidateGroupCache(curve.groupId);
            else this.notifyModelUpdate();
            return true;
        }

        const current = item.visible !== false;
        const target = typeof visible === 'boolean' ? visible : !current;
        if (current === target) return false;
        item.visible = target;
        this.invalidateGroupCache(item.id);
        return true;
    }

    /**
     * Action: 基于 transform 快照应用一次变换预览
     * 作用: 高频变换预览，不写历史
     */
    applyTransformPreview(payload = {}) {
        const action = payload.action;
        const snapshots = payload.snapshots || [];
        const snapshotRefs = payload.snapshotRefs || [];
        const dx = Number(payload.dx || 0);
        const dy = Number(payload.dy || 0);
        const pivot = payload.pivot || null;
        const params = payload.params || null;

        let changed = false;

        if (action === 'drag') {
            for (const snap of snapshotRefs) {
                if (!snap || !snap.ref || !snap.startMatrix) continue;
                snap.ref.transform = new DOMMatrix().translate(dx, dy).multiply(snap.startMatrix);
                if (snap.ref.id) this.invalidateGroupCache(snap.ref.id);
                changed = true;
            }

            for (const snap of snapshots) {
                if (!snap || !snap.node) continue;
                const offX = snap.refTx || 0;
                const offY = snap.refTy || 0;

                snap.node.x = snap.main.x + dx - offX;
                snap.node.y = snap.main.y + dy - offY;

                if (snap.node.control1 && snap.c1) {
                    snap.node.control1.x = snap.c1.x + dx - offX;
                    snap.node.control1.y = snap.c1.y + dy - offY;
                }
                if (snap.node.control2 && snap.c2) {
                    snap.node.control2.x = snap.c2.x + dx - offX;
                    snap.node.control2.y = snap.c2.y + dy - offY;
                }
                changed = true;
            }
            return changed;
        }

        if (!pivot || !params) return false;

        for (const snap of snapshotRefs) {
            if (!snap || !snap.ref || !snap.startMatrix) continue;
            if (snap.ref.type !== 'image') continue;
            const seqOff = Number(snap.seqOff || 0);

            let m = new DOMMatrix();
            if (action === 'rot') m = m.translate(pivot.x, pivot.y).rotate(params.angleDeg).translate(-pivot.x, -pivot.y);
            else m = m.translate(pivot.x, pivot.y).scale(params.sx, params.sy).translate(-pivot.x, -pivot.y);

            const globalStart = new DOMMatrix().translate(seqOff, 0).multiply(snap.startMatrix);
            const globalEnd = m.multiply(globalStart);
            snap.ref.transform = new DOMMatrix().translate(-seqOff, 0).multiply(globalEnd);
            changed = true;
        }

        for (const snap of snapshots) {
            if (!snap || !snap.node) continue;
            const nm = TransformEngine.applyTransformationToPoint(snap.main, snap, action, pivot, params);
            snap.node.x = nm.x;
            snap.node.y = nm.y;

            if (snap.node.control1 && snap.c1) {
                const nc = TransformEngine.applyTransformationToPoint(snap.c1, snap, action, pivot, params);
                snap.node.control1.x = nc.x;
                snap.node.control1.y = nc.y;
            }
            if (snap.node.control2 && snap.c2) {
                const nc = TransformEngine.applyTransformationToPoint(snap.c2, snap, action, pivot, params);
                snap.node.control2.x = nc.x;
                snap.node.control2.y = nc.y;
            }
            changed = true;
        }

        return changed;
    }

    /**
     * Action: 在预览态下给当前变换结果追加平移修正
     * 用于手柄缩放后做视觉边界回钉，不写历史。
     */
    translateTransformPreview(dx = 0, dy = 0, snapshots = [], snapshotRefs = []) {
        if ((dx === 0 && dy === 0) || (!snapshots?.length && !snapshotRefs?.length)) return false;
        let changed = false;

        for (const snap of snapshots) {
            if (!snap || !snap.node) continue;
            snap.node.x += dx;
            snap.node.y += dy;
            if (snap.node.control1) {
                snap.node.control1.x += dx;
                snap.node.control1.y += dy;
            }
            if (snap.node.control2) {
                snap.node.control2.x += dx;
                snap.node.control2.y += dy;
            }
            changed = true;
        }

        for (const snap of snapshotRefs) {
            if (!snap || !snap.ref) continue;
            const base = snap.ref.transform ? new DOMMatrix(snap.ref.transform) : new DOMMatrix();
            snap.ref.transform = new DOMMatrix().translate(dx, dy).multiply(base);
            changed = true;
        }

        return changed;
    }

    /**
     * Action: 按选区边界框修改选中对象位置/尺寸
     * prop: x | y | w | h
     */
    _getBoundsSelectionSignature() {
        const curveIds = Array.from(this.selected_curves)
            .filter(c => c && c.id)
            .map(c => c.id)
            .sort()
            .join('|');
        const refIds = Array.from(this.selected_refs)
            .filter(r => r && r.id)
            .map(r => r.id)
            .sort()
            .join('|');
        return `c:${curveIds};r:${refIds}`;
    }

    _createBoundsEditSnapshot() {
        const nodeSnapshots = [];
        for (const curve of this.selected_curves) {
            if (!curve || curve.visible === false || curve.locked === true) continue;
            let current = curve.startNode;
            while (current) {
                nodeSnapshots.push({
                    node: current,
                    x: current.x,
                    y: current.y,
                    c1x: current.control1 ? current.control1.x : null,
                    c1y: current.control1 ? current.control1.y : null,
                    c2x: current.control2 ? current.control2.x : null,
                    c2y: current.control2 ? current.control2.y : null
                });
                current = current.nextOnCurve;
            }
        }

        const refSnapshots = [];
        for (const ref of this.selected_refs) {
            if (!ref || ref.visible === false || ref.locked === true) continue;
            refSnapshots.push({
                ref,
                matrix: ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix()
            });
        }

        return { nodeSnapshots, refSnapshots };
    }

    _restoreBoundsEditSnapshot(session) {
        if (!session || !session.snapshot) return;
        for (const snap of session.snapshot.nodeSnapshots) {
            if (!snap || !snap.node) continue;
            snap.node.x = snap.x;
            snap.node.y = snap.y;
            if (snap.node.control1) {
                snap.node.control1.x = snap.c1x;
                snap.node.control1.y = snap.c1y;
            }
            if (snap.node.control2) {
                snap.node.control2.x = snap.c2x;
                snap.node.control2.y = snap.c2y;
            }
        }
        for (const snap of session.snapshot.refSnapshots) {
            if (!snap || !snap.ref) continue;
            snap.ref.transform = new DOMMatrix(snap.matrix);
        }
    }

    _clearBoundsEditSession() {
        this.boundsEditSession = null;
    }

    changeSelectedObjectsBounds(prop, val, bounds = null, geometryBounds = null, options = {}) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) return false;
        if (!bounds) return false;

        const useSession = options.useBoundsSession === true;
        const selectionSignature = this._getBoundsSelectionSignature();
        if (useSession) {
            if (!this.boundsEditSession || this.boundsEditSession.signature !== selectionSignature) {
                this.boundsEditSession = {
                    signature: selectionSignature,
                    bounds: { ...bounds },
                    geometryBounds: geometryBounds ? { ...geometryBounds } : null,
                    snapshot: this._createBoundsEditSnapshot()
                };
            }
            this._restoreBoundsEditSnapshot(this.boundsEditSession);
            bounds = this.boundsEditSession.bounds;
            geometryBounds = this.boundsEditSession.geometryBounds;
        } else {
            this._clearBoundsEditSession();
        }

        const oldW = bounds.maxX - bounds.minX;
        const oldH = bounds.maxY - bounds.minY;
        const geomMinX = geometryBounds ? geometryBounds.minX : bounds.minX;
        const geomMinY = geometryBounds ? geometryBounds.minY : bounds.minY;
        const geomW = geometryBounds ? (geometryBounds.maxX - geometryBounds.minX) : oldW;
        const geomH = geometryBounds ? (geometryBounds.maxY - geometryBounds.minY) : oldH;

        const dx = prop === 'x' ? numericVal - bounds.minX : 0;
        const dy = prop === 'y' ? numericVal - bounds.minY : 0;
        let sx = 1;
        let sy = 1;
        let scaleOriginX = bounds.minX;
        let scaleOriginY = bounds.minY;

        if (prop === 'w') {
            const paddingW = Math.max(0, oldW - geomW);
            const targetGeomW = Math.max(0, numericVal - paddingW);
            sx = geomW !== 0 ? targetGeomW / geomW : 1;
            scaleOriginX = geomMinX;
        } else if (prop === 'h') {
            const paddingH = Math.max(0, oldH - geomH);
            const targetGeomH = Math.max(0, numericVal - paddingH);
            sy = geomH !== 0 ? targetGeomH / geomH : 1;
            scaleOriginY = geomMinY;
        }

        let changed = false;
        const affectedGroups = new Set();
        const affectedRefs = new Set();

        const getSeqIdxForGroupId = (groupId) => {
            let seqTokens = this.sequenceTokens || [];
            let activeIndices = this.activeSequenceIndices || new Set();
            let focused = this.focused_seq_idx;

            if (focused !== undefined && focused !== -1 && focused < seqTokens.length) {
                let t = seqTokens[focused];
                let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
                if (groupId === gid && activeIndices.has(focused)) return focused;
            }

            for (let i = 0; i < seqTokens.length; i++) {
                let t = seqTokens[i];
                let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
                if (groupId === gid && activeIndices.has(i)) return i;
            }
            for (let i = 0; i < seqTokens.length; i++) {
                let t = seqTokens[i];
                let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
                if (groupId === gid) return i;
            }
            return -1;
        };

        const computeSelectionTransformBounds = () => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            for (let curve of this.selected_curves) {
                if (!curve || curve.visible === false || curve.locked === true) continue;
                const seqIdx = getSeqIdxForGroupId(curve.groupId);
                if (seqIdx !== -1 && !this.activeSequenceIndices.has(seqIdx)) continue;
                const seqOff = seqIdx !== -1 ? this.getSeqOffset(seqIdx) : 0;
                const b = curve.getTransformBounds(null);
                if (!b) continue;
                minX = Math.min(minX, b.minX + seqOff);
                maxX = Math.max(maxX, b.maxX + seqOff);
                minY = Math.min(minY, b.minY);
                maxY = Math.max(maxY, b.maxY);
            }

            for (let ref of this.selected_refs) {
                if (!ref || ref.visible === false || ref.locked === true) continue;
                const refRootId = this.getRootGroupId(ref.id);
                const refSeqIdx = getSeqIdxForGroupId(refRootId);
                if (refSeqIdx !== -1 && !this.activeSequenceIndices.has(refSeqIdx)) continue;
                const refSeqOff = refSeqIdx !== -1 ? this.getSeqOffset(refSeqIdx) : 0;
                const cdList = this.getCurvesForGroup(ref.id);
                for (let cd of cdList) {
                    if (!cd || !cd.curve || cd.curve.visible === false || cd.curve.locked === true) continue;
                    const b = cd.curve.getTransformBounds(cd.matrix);
                    if (!b) continue;
                    minX = Math.min(minX, b.minX + refSeqOff);
                    maxX = Math.max(maxX, b.maxX + refSeqOff);
                    minY = Math.min(minY, b.minY);
                    maxY = Math.max(maxY, b.maxY);
                }
            }

            if (minX === Infinity) return null;
            return { minX, minY, maxX, maxY };
        };

        for (let curve of this.selected_curves) {
            if (!curve || curve.visible === false || curve.locked === true) continue;

            const seqIdx = getSeqIdxForGroupId(curve.groupId);
            if (seqIdx !== -1 && !this.activeSequenceIndices.has(seqIdx)) continue;
            const seqOff = seqIdx !== -1 ? this.getSeqOffset(seqIdx) : 0;

            let current = curve.startNode;
            while (current) {
                const gX = current.x + seqOff;
                const gY = current.y;
                const newX = scaleOriginX + (gX - scaleOriginX) * sx + dx - seqOff;
                const newY = scaleOriginY + (gY - scaleOriginY) * sy + dy;
                if (current.x !== newX || current.y !== newY) {
                    current.x = newX;
                    current.y = newY;
                    changed = true;
                }

                if (current.control1) {
                    const gC1x = current.control1.x + seqOff;
                    const c1x = scaleOriginX + (gC1x - scaleOriginX) * sx + dx - seqOff;
                    const c1y = scaleOriginY + (current.control1.y - scaleOriginY) * sy + dy;
                    if (current.control1.x !== c1x || current.control1.y !== c1y) {
                        current.control1.x = c1x;
                        current.control1.y = c1y;
                        changed = true;
                    }
                }
                if (current.control2) {
                    const gC2x = current.control2.x + seqOff;
                    const c2x = scaleOriginX + (gC2x - scaleOriginX) * sx + dx - seqOff;
                    const c2y = scaleOriginY + (current.control2.y - scaleOriginY) * sy + dy;
                    if (current.control2.x !== c2x || current.control2.y !== c2y) {
                        current.control2.x = c2x;
                        current.control2.y = c2y;
                        changed = true;
                    }
                }

                current = current.nextOnCurve;
            }
            if (curve.groupId) affectedGroups.add(curve.groupId);
        }

        for (let ref of this.selected_refs) {
            if (!ref || ref.visible === false || ref.locked === true) continue;
            const refRootId = this.getRootGroupId(ref.id);
            const refSeqIdx = getSeqIdxForGroupId(refRootId);
            const refSeqOff = refSeqIdx !== -1 ? this.getSeqOffset(refSeqIdx) : 0;
            const baseTransform = ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix();

            const worldTransform = new DOMMatrix()
                .translate(scaleOriginX + dx, scaleOriginY + dy)
                .scale(sx, sy)
                .translate(-scaleOriginX, -scaleOriginY);

            const globalStart = new DOMMatrix().translate(refSeqOff, 0).multiply(baseTransform);
            const globalEnd = worldTransform.multiply(globalStart);
            const localEnd = new DOMMatrix().translate(-refSeqOff, 0).multiply(globalEnd);

            const hasDiff =
                baseTransform.a !== localEnd.a ||
                baseTransform.b !== localEnd.b ||
                baseTransform.c !== localEnd.c ||
                baseTransform.d !== localEnd.d ||
                baseTransform.e !== localEnd.e ||
                baseTransform.f !== localEnd.f;

            if (hasDiff) {
                ref.transform = localEnd;
                changed = true;
                if (ref.id) affectedRefs.add(ref.id);
            }
        }

        if (changed && (prop === 'w' || prop === 'h')) {
            const updatedBounds = computeSelectionTransformBounds();
            if (updatedBounds) {
                // smart-stroke 下，单轴缩放也可能让另一轴的视觉边界漂移；
                // 因此 W/H 提交后统一回钉到原始 minX/minY。
                const corrDx = bounds.minX - updatedBounds.minX;
                const corrDy = bounds.minY - updatedBounds.minY;
                if (corrDx !== 0 || corrDy !== 0) {
                    for (let curve of this.selected_curves) {
                        if (!curve || curve.visible === false || curve.locked === true) continue;
                        const seqIdx = getSeqIdxForGroupId(curve.groupId);
                        if (seqIdx !== -1 && !this.activeSequenceIndices.has(seqIdx)) continue;
                        const seqOff = seqIdx !== -1 ? this.getSeqOffset(seqIdx) : 0;

                        let current = curve.startNode;
                        while (current) {
                            current.x += corrDx;
                            current.y += corrDy;
                            if (current.control1) {
                                current.control1.x += corrDx;
                                current.control1.y += corrDy;
                            }
                            if (current.control2) {
                                current.control2.x += corrDx;
                                current.control2.y += corrDy;
                            }
                            current = current.nextOnCurve;
                        }
                        if (curve.groupId) affectedGroups.add(curve.groupId);
                    }

                    for (let ref of this.selected_refs) {
                        if (!ref || ref.visible === false || ref.locked === true) continue;
                        const refRootId = this.getRootGroupId(ref.id);
                        const refSeqIdx = getSeqIdxForGroupId(refRootId);
                        const refSeqOff = refSeqIdx !== -1 ? this.getSeqOffset(refSeqIdx) : 0;
                        const baseTransform = ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix();
                        const worldTransform = new DOMMatrix().translate(corrDx, corrDy);
                        const globalStart = new DOMMatrix().translate(refSeqOff, 0).multiply(baseTransform);
                        const globalEnd = worldTransform.multiply(globalStart);
                        const localEnd = new DOMMatrix().translate(-refSeqOff, 0).multiply(globalEnd);

                        const hasDiff =
                            baseTransform.a !== localEnd.a ||
                            baseTransform.b !== localEnd.b ||
                            baseTransform.c !== localEnd.c ||
                            baseTransform.d !== localEnd.d ||
                            baseTransform.e !== localEnd.e ||
                            baseTransform.f !== localEnd.f;
                        if (hasDiff) {
                            ref.transform = localEnd;
                            if (ref.id) affectedRefs.add(ref.id);
                        }
                    }
                }
            }
        }

        if (changed) {
            for (let gid of affectedGroups) this.invalidateGroupCache(gid);
            for (let rid of affectedRefs) this.invalidateGroupCache(rid);
            if (affectedGroups.size === 0 && affectedRefs.size === 0) this.notifyModelUpdate();
        }
        if (useSession && options.commitBoundsSession === true) {
            this._clearBoundsEditSession();
        }
        return changed;
    }

    // =========================================================================
    // 原有逻辑区域
    // =========================================================================

    initTree() {
        this.treeItems.clear();
        this.rootChildren = [];
        this.activeGroupId = null;
        this.defaultGlyphs.clear();
        this.clearAllSelection();
    }

    getGroupByName(name) {
        for (let item of this.treeItems.values()) {
            if (item.type === 'group' && item.name === name && item.parentId === null && !item.isRef) return item;
        }
        return null;
    }

    renameItem(oldId, newName) {
        if (oldId === newName) return true;
        if (this.treeItems.has(newName)) return false; 

        let item = this.treeItems.get(oldId);
        if (!item) return false;

        if (item.type === 'group' && item.parentId === null && !item.isRef) {
            let oldRef = `\\${oldId}\\`;
            let newRef = `\\${newName}\\`;
            if (this.sequenceText.includes(oldRef)) {
                this.sequenceText = this.sequenceText.split(oldRef).join(newRef);
            }
        }

        this.treeItems.delete(oldId);
        item.id = newName;
        item.name = newName;
        item.is_modified = true; 
        if (item.type === 'curve') {
            item.curveId = newName;
            let curve = this.curves.find(c => c.id === oldId);
            if (curve) curve.id = newName;
        }
        this.treeItems.set(newName, item);

        if (item.parentId) {
            let parent = this.treeItems.get(item.parentId);
            if (parent) {
                let idx = parent.children.indexOf(oldId);
                if (idx !== -1) parent.children[idx] = newName;
            }
        } else {
            let idx = this.rootChildren.indexOf(oldId);
            if (idx !== -1) this.rootChildren[idx] = newName;
        }

        for (let v of this.treeItems.values()) {
            if (v.parentId === oldId) v.parentId = newName;
            if (v.isRef && v.refId === oldId) v.refId = newName;
        }
        
        if (item.type === 'group') {
            for (let c of this.curves) {
                if (c.groupId === oldId) c.groupId = newName;
            }
        }

        for (let [char, gid] of this.defaultGlyphs.entries()) {
            if (gid === oldId) this.defaultGlyphs.set(char, newName);
        }
        
        if (this.selectedTreeIds.has(oldId)) {
            this.selectedTreeIds.delete(oldId);
            this.selectedTreeIds.add(newName);
        }
        if (this.activeGroupId === oldId) this.activeGroupId = newName;

        this.updateSequenceParsing();
        this.rebuildDefaultGlyphs();
        this.notifyTreeUpdate();
        
        return true;
    }

    ensureUniqueName(baseName, ignoreId = null) {
        let name = baseName.replace(/[^A-Za-z0-9_.-]/g, '_');
        if (name.length === 0) name = 'Object';
        let counter = 1;
        let testName = name;
        while (true) {
            let conflict = false;
            for (let item of this.treeItems.values()) {
                if (item.id === testName && item.id !== ignoreId) {
                    conflict = true; break;
                }
            }
            if (!conflict) return testName;
            testName = `${name}_${counter}`;
            counter++;
        }
    }

    _getDisplayChar(char) {
        return getSequenceDisplayChar(char);
    }

    getAGLName(charStr) {
        if (!charStr) return null;
        const aglMap = {
            ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand', '\'': 'quotesingle', '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'hyphen', '.': 'period', '/': 'slash',
            '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
            ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at',
            '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', '_': 'underscore', '`': 'grave',
            '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde'
        };
        let chars = Array.from(charStr);
        let names = chars.map(c => {
            if (aglMap[c]) return aglMap[c];
            if (/^[a-zA-Z]$/.test(c)) return c; 
            let cp = c.codePointAt(0);
            let hex = cp.toString(16).toUpperCase();
            if (cp <= 0xFFFF) return "uni" + hex.padStart(4, '0');
            else return "u" + hex.padStart(5, '0');
        });
        return names.join('_'); 
    }

    parseSequence(text) {
        return parseSequenceTokens(text, {
            resolveGroupByName: (name) => this.getGroupByName(name),
            getDisplayChar: (char) => this._getDisplayChar(char)
        });
    }

    rebuildDefaultGlyphs() {
        this.defaultGlyphs.clear();
        for (let [id, item] of this.treeItems.entries()) {
            if (item.type === 'group' && item.parentId === null && !item.isRef && item.charCode) {
                this.defaultGlyphs.set(item.charCode, item.id);
            }
        }
    }

    getDefaultGroupForChar(char) {
        if (this.defaultGlyphs.has(char)) {
            let id = this.defaultGlyphs.get(char);
            if (this.treeItems.has(id)) return id;
        }
        
        let aglName = this.getAGLName(char);
        let newId = this.ensureUniqueName(aglName); 
        this.treeItems.set(newId, {
            id: newId, type: 'group', name: newId, charCode: char,
            parentId: null, children: [], isRef: false, refId: null, collapsed: false,
            hidden_by_sequence: false, advance: 1000, is_modified: false 
        });
        this.rootChildren.push(newId);
        this.defaultGlyphs.set(char, newId);
        return newId;
    }

    updateSequenceParsing() {
        this.sequenceTokens = this.parseSequence(this.sequenceText);
        let newActive = new Set();
        for (let i of this.activeSequenceIndices) {
            if (i < this.sequenceTokens.length) newActive.add(i);
        }
        this.activeSequenceIndices = newActive;
        this.cleanupUnusedEmptyGroups();
        this.calculateSequenceOffsets(); 
        this.syncTreeWithSequence();
    }

    cleanupUnusedEmptyGroups() {
        let referencedIds = new Set();
        for (let t of this.sequenceTokens) {
            if (t.isChar) {
                let id = this.defaultGlyphs.get(t.value);
                if (id) referencedIds.add(id);
            } else {
                referencedIds.add(t.value); 
            }
        }

        let deletedAny = false;
        for (let i = this.rootChildren.length - 1; i >= 0; i--) {
            let id = this.rootChildren[i];
            let item = this.treeItems.get(id);

            if (item && item.type === 'group' && !item.isRef && item.children.length === 0) {
                if (!referencedIds.has(id) && !item.is_modified) {
                    this.treeItems.delete(id);
                    this.rootChildren.splice(i, 1);
                    if (this.selectedTreeIds.has(id)) this.selectedTreeIds.delete(id);
                    if (this.activeGroupId === id) this.activeGroupId = null;
                    deletedAny = true;
                }
            }
        }

        if (deletedAny) this.rebuildDefaultGlyphs();
    }

    setSequence(text) {
        this.sequenceText = text;
        this.updateSequenceParsing();
    }

    /**
     * Action: 一次性更新 sequence text 与 active indices
     */
    setSequenceState({ text, activeIndices } = {}) {
        const hasText = typeof text === 'string';
        const hasActive = activeIndices !== undefined;
        if (!hasText && !hasActive) return false;

        let changed = false;
        if (hasText && this.sequenceText !== text) {
            this.sequenceText = text;
            changed = true;
        }
        if (hasActive) {
            const nextSet = new Set(Array.isArray(activeIndices) ? activeIndices : Array.from(activeIndices || []));
            const prevSet = this.activeSequenceIndices || new Set();
            const sameSize = prevSet.size === nextSet.size;
            const sameItems = sameSize && Array.from(nextSet).every(i => prevSet.has(i));
            if (!sameItems) {
                this.activeSequenceIndices = nextSet;
                changed = true;
            }
        }
        if (changed) this.updateSequenceParsing();
        return changed;
    }

    setActiveIndices(indicesSet) {
        this.activeSequenceIndices = indicesSet;
        this.updateSequenceParsing();
    }

    getRootGroupId(groupId) {
        let curr = this.treeItems.get(groupId);
        while (curr && curr.parentId) { curr = this.treeItems.get(curr.parentId); }
        return curr ? curr.id : null;
    }

    syncTreeWithSequence() {
        let activeReferencedIds = new Set();
        let allInTextIds = new Set(); 

        for (let i = 0; i < this.sequenceTokens.length; i++) {
            let t = this.sequenceTokens[i];
            let groupId = null;
            if (t.isChar) {
                groupId = this.getDefaultGroupForChar(t.value);
            } else {
                if (t.value !== null) {
                    groupId = t.value;
                } else {
                    let existing = this.getGroupByName(t.name);
                    if (existing) {
                        groupId = existing.id;
                        t.value = groupId;
                    } else if (this.activeSequenceIndices.has(i)) {
                        let newName = this.ensureUniqueName(t.name);
                        this.treeItems.set(newName, {
                            id: newName, type: 'group', name: newName, charCode: null,
                            parentId: null, children: [], isRef: false, refId: null, collapsed: false,
                            hidden_by_sequence: false, advance: 1000, is_modified: false 
                        });
                        this.rootChildren.push(newName);
                        groupId = newName;
                        t.value = newName;
                    }
                }
            }

            if (groupId) {
                allInTextIds.add(groupId);
                if (this.activeSequenceIndices.has(i)) activeReferencedIds.add(groupId);
            }
        }

        let toDelete = [];
        for (let [id, item] of this.treeItems.entries()) {
            if (item.type === 'group' && item.parentId === null) {
                if (allInTextIds.has(item.id)) {
                    item.hidden_by_sequence = false;
                } else {
                    item.hidden_by_sequence = true;
                    if (item.children.length === 0 && !item.isRef && !item.is_modified) toDelete.push(id);
                }
            }
        }
        toDelete.forEach(id => this.deleteTreeItem(id));

        const newActiveIndices = new Set();
        for (let i of this.activeSequenceIndices) {
            const token = this.sequenceTokens[i];
            if (!token) continue;
            const gid = token.isChar ? this.getDefaultGroupForChar(token.value) : token.value;
            const gitem = gid ? this.treeItems.get(gid) : null;
            if (!gitem || gitem.locked === true) continue;
            newActiveIndices.add(i);
        }
        this.activeSequenceIndices = newActiveIndices;

        if (this.validateSelection()) {
            this.syncTreeSelectionFromCanvas();
            this._notifySelectionInvalidated();
        }
        this.notifyTreeUpdate();
    }
    
    ensureActiveGroup() {
        if (this.activeGroupId && this.treeItems.has(this.activeGroupId)) {
            let rootId = this.getRootGroupId(this.activeGroupId);
            let rootItem = this.treeItems.get(rootId);
            if (rootItem && !rootItem.hidden_by_sequence) return this.activeGroupId;
        }

        if (this.activeSequenceIndices.size > 0) {
            let sortedActive = Array.from(this.activeSequenceIndices).sort((a,b)=>a-b);
            let firstIdx = sortedActive.find(i => i < this.sequenceTokens.length);
            if (firstIdx !== undefined) {
                let token = this.sequenceTokens[firstIdx];
                let gid = token.isChar ? this.getDefaultGroupForChar(token.value) : token.value;
                this.activeGroupId = gid;
                this.notifyTreeUpdate();
                return gid;
            }
        }
        return null;
    }

    getCurvesForGroup(groupId) {
        if (this.groupFlatCache.has(groupId)) return this.groupFlatCache.get(groupId);

        const flatten = (nodes, currentMatrix, currentRefId, visited = new Set(), currentRefItem = null, parentVis = true, parentLock = false) => {
            let result = [];
            if (!nodes) return result; 
            
            for(let id of nodes) {
                const item = this.treeItems.get(id);
                if(!item) continue;
                
                let curVis = parentVis && (item.visible !== false);
                let curLock = parentLock || (item.locked === true);

                if(item.type === 'curve') {
                    const c = this.curves.find(x => x.id === item.curveId);
                    if(c) {
                        let finalVis = curVis && (c.visible !== false);
                        let finalLock = curLock || (c.locked === true);
                        result.push({ 
                            curve: c, matrix: currentMatrix, refId: currentRefId, refItem: currentRefItem, 
                            effectiveVis: finalVis, effectiveLock: finalLock 
                        });
                    }
                } else if(item.type === 'group') {
                    if (visited.has(item.id)) continue; 
                    let nextVisited = new Set(visited);
                    nextVisited.add(item.id);

                    if (item.isRef && item.transform) {
                        let nextMatrix = new DOMMatrix(currentMatrix).multiply(item.transform);
                        let passRefItem = currentRefItem !== null ? currentRefItem : item;
                        let passRefId = currentRefId !== null ? currentRefId : item.id;
                        
                        if (!nextVisited.has(item.refId)) {
                            nextVisited.add(item.refId);
                            const sourceGroup = this.treeItems.get(item.refId);
                            if (sourceGroup) {
                                let sub = flatten(sourceGroup.children, nextMatrix, passRefId, nextVisited, passRefItem, curVis, curLock); 
                                sub.forEach(s => result.push(s));
                            }
                        }
                    } else {
                        let sub = flatten(item.children, currentMatrix, currentRefId, nextVisited, currentRefItem, curVis, curLock); 
                        sub.forEach(s => result.push(s));
                    }
                }
            }
            return result;
        };

        if (!this.treeItems.has(groupId)) return [];
        let flatData = flatten([groupId], new DOMMatrix(), null);
        flatData.reverse(); 
        this.groupFlatCache.set(groupId, flatData);
        return flatData;
    }

    notifyTreeUpdate() {
        this.groupFlatCache.clear(); 
        this.calculateSequenceOffsets(); 
        this._emitEvent(DOMAIN_EVENTS.TREE_UPDATED);
    }

    create_temp_curve() { 
        let newId = this.ensureUniqueName("Path"); 
        return new Curve({ id: newId }); 
    }

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

    /**
     * Action: 克隆单条曲线到目标分组
     */
    cloneCurveToGroup(curve, targetGroupId = null) {
        if (!curve || !curve.startNode) return null;

        let newCurve = this.create_temp_curve();
        let current = curve.startNode;
        let lastNodeMarker = null;

        while (current) {
            const mainMarker = generateMarker("vertex");
            this.add_node_by_curve(
                mainMarker,
                "vertex",
                current.x,
                current.y,
                null,
                lastNodeMarker,
                newCurve,
                String(mainMarker.id)
            );

            const newNode = this.find_node_by_curve(mainMarker);
            if (!newNode) return null;
            newNode.smooth = current.smooth;

            // 保持源节点控制模式，必要时强制创建端点手柄
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

    _duplicateGroupTree(sourceGroupId, targetParentId) {
        const sourceGroup = this.treeItems.get(sourceGroupId);
        if (!sourceGroup || sourceGroup.type !== 'group' || sourceGroup.isRef) return null;

        const newName = this.ensureUniqueName(sourceGroup.name + "_Copy");
        this.treeItems.set(newName, {
            id: newName,
            type: 'group',
            name: newName,
            charCode: null,
            parentId: targetParentId,
            children: [],
            isRef: false,
            refId: null,
            collapsed: false,
            advance: sourceGroup.advance !== undefined ? sourceGroup.advance : 1000
        });

        const targetParent = this.treeItems.get(targetParentId);
        if (targetParent && targetParent.type === 'group' && !targetParent.isRef) {
            targetParent.children.push(newName);
        } else {
            this.rootChildren.push(newName);
        }

        for (const childId of [...(sourceGroup.children || [])]) {
            const child = this.treeItems.get(childId);
            if (!child) continue;
            if (child.type === 'curve') {
                const childCurve = this.curves.find(c => c.id === child.curveId);
                if (childCurve) this.cloneCurveToGroup(childCurve, newName);
            } else if (child.type === 'group') {
                if (child.isRef) {
                    this.pasteGroupRef(child.refId, newName, child.transform);
                } else {
                    this._duplicateGroupTree(child.id, newName);
                }
            }
        }

        return newName;
    }

    /**
     * Action: 深拷贝分组（含子项）
     * 返回: { id, sequenceChanged, activeIndices }
     */
    duplicateGroupDeep(groupId, targetParentId) {
        const sourceGroup = this.treeItems.get(groupId);
        if (!sourceGroup) return null;

        if (sourceGroup.isRef) {
            const refId = this.pasteGroupRef(sourceGroup.refId, targetParentId, sourceGroup.transform);
            if (!refId) return null;
            return { id: refId, sequenceChanged: false, activeIndices: Array.from(this.activeSequenceIndices) };
        }

        const newName = this._duplicateGroupTree(groupId, targetParentId);
        if (!newName) return null;

        let sequenceChanged = false;
        if (!targetParentId) {
            const escapeName = `\\${newName}\\`;
            let newActive = new Set();
            newActive.add(0);
            for (let idx of this.activeSequenceIndices) newActive.add(idx + 1);
            this.sequenceText = escapeName + this.sequenceText;
            this.activeSequenceIndices = newActive;
            sequenceChanged = true;
        }

        this.notifyTreeUpdate();
        return { id: newName, sequenceChanged, activeIndices: Array.from(this.activeSequenceIndices) };
    }

    /**
     * Action: 取消单个引用，烘焙为实体对象
     */
    unlinkReferenceDeep(refId) {
        const refItem = this.treeItems.get(refId);
        if (!refItem || !refItem.isRef) return false;
        const sourceItem = this.treeItems.get(refItem.refId);
        if (!sourceItem) return false;

        const transform = refItem.transform;
        const targetParentId = refItem.parentId;

        const cloneAndTransform = (sourceId, parentId, currentMatrix) => {
            const source = this.treeItems.get(sourceId);
            if (!source) return;

            if (source.type === 'curve') {
                const curve = this.curves.find(c => c.id === source.curveId);
                if (!curve) return;
                const newCurve = this.cloneCurveToGroup(curve, parentId);
                if (!newCurve) return;
                let current = newCurve.startNode;
                while (current) {
                    const pt = (x, y) => ({
                        x: x * currentMatrix.a + y * currentMatrix.c + currentMatrix.e,
                        y: x * currentMatrix.b + y * currentMatrix.d + currentMatrix.f
                    });
                    let p = pt(current.x, current.y);
                    current.x = p.x;
                    current.y = p.y;
                    if (current.control1) {
                        let cp = pt(current.control1.x, current.control1.y);
                        current.control1.x = cp.x;
                        current.control1.y = cp.y;
                    }
                    if (current.control2) {
                        let cp = pt(current.control2.x, current.control2.y);
                        current.control2.x = cp.x;
                        current.control2.y = cp.y;
                    }
                    current = current.nextOnCurve;
                }
            } else if (source.type === 'group') {
                if (source.isRef) {
                    let nextMatrix = new DOMMatrix(currentMatrix).multiply(source.transform);
                    this.pasteGroupRef(source.refId, parentId, nextMatrix);
                } else if (source.children) {
                    source.children.forEach(c => cloneAndTransform(c, parentId, currentMatrix));
                }
            }
        };

        if (sourceItem.children) sourceItem.children.forEach(c => cloneAndTransform(c, targetParentId, transform));
        this.deleteTreeItem(refId);
        this.notifyTreeUpdate();
        return true;
    }

    /**
     * Action: 导入图片到当前活动分组
     */
    importImageToCurrentGroup(imgObj, fileName) {
        if (!imgObj) return null;
        const targetGroupId = this.activeGroupId || null;
        const id = `img_${Date.now()}`;
        const imageData = {
            id: id,
            type: 'image',
            name: this.ensureUniqueName(fileName),
            image: imgObj,
            transform: new DOMMatrix().translate(0, 0),
            width: imgObj.width,
            height: imgObj.height,
            parentId: targetGroupId,
            visible: true,
            locked: false
        };

        this.treeItems.set(id, imageData);
        if (targetGroupId) {
            const group = this.treeItems.get(targetGroupId);
            if (group) group.children.push(id);
        } else {
            this.rootChildren.push(id);
        }
        this.notifyTreeUpdate();
        return id;
    }

    /**
     * Action: 恢复会话图片对象到树
     */
    restoreSessionImages(sessionImages = []) {
        if (!Array.isArray(sessionImages) || sessionImages.length === 0) return false;
        let changed = false;
        for (const raw of sessionImages) {
            if (!raw || !raw.id) continue;
            const img = { ...raw };
            this.treeItems.set(img.id, img);
            const parent = this.treeItems.get(img.parentId);
            if (parent && !parent.children.includes(img.id)) parent.children.push(img.id);
            if (!img.parentId && !this.rootChildren.includes(img.id)) this.rootChildren.push(img.id);
            changed = true;
        }
        if (changed) this.notifyTreeUpdate();
        return changed;
    }

    /**
     * Action: 对选中路径执行 Boolean Union
     */
    executeBooleanUnion(targetCurves, parentGroupId) {
        if (!targetCurves || targetCurves.length === 0) return false;
        try {
            const boolEngine = new BooleanEngine(this);
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

    finishAddingPath(curve, targetGroupId = null) {
        return this.addPath(curve, targetGroupId);
    }

    commit_curve(curve, targetGroupId = null) {
        const parentId = targetGroupId || this.ensureActiveGroup();
        if (!parentId) return; 
        
        curve.groupId = parentId;
        this.curves.push(curve);
        
        const itemId = curve.id; 
        this.treeItems.set(itemId, { id: itemId, type: 'curve', curveId: curve.id, name: curve.id, parentId: parentId });
        
        const parent = this.treeItems.get(parentId);
        if (parent && parent.type === 'group' && !parent.isRef) {
            if (!parent.children) parent.children = []; 
            parent.children.push(itemId);
            parent.is_modified = true; 
        }
        this.notifyTreeUpdate();
    }

    remove_curve(id) { 
        const index = this.curves.findIndex(m => m.id === id); 
        if (index !== -1) { 
            this.curves.splice(index, 1); 
            this.deleteTreeItem(id, false); 
            this.notifyTreeUpdate();
            return true; 
        } 
        return false; 
    }

    deleteTreeItem(id, cascade = true) {
        const item = this.treeItems.get(id);
        if (!item) return;

        if (item.parentId) {
            const parent = this.treeItems.get(item.parentId);
            if (parent) parent.children = parent.children.filter(cid => cid !== id);
        } else {
            this.rootChildren = this.rootChildren.filter(cid => cid !== id);
        }

        if (item.type === 'group' && !item.isRef) {
            [...item.children].forEach(childId => this.deleteTreeItem(childId, cascade));
        } else if (item.type === 'curve' && cascade) {
            const index = this.curves.findIndex(c => c.id === item.curveId);
            if (index !== -1) {
                this.unregisterCurveDomMarkers(this.curves[index]);
                this.curves.splice(index, 1);
            }
        }

        this.treeItems.delete(id);
    }

    isDescendant(parentId, targetId, visited = new Set()) {
        if (parentId === targetId) return true;
        if (visited.has(parentId)) return false;
        visited.add(parentId);

        const parent = this.treeItems.get(parentId);
        if (!parent || parent.type !== 'group') return false;

        if (parent.isRef && parent.refId) {
            if (this.isDescendant(parent.refId, targetId, visited)) return true;
        } else {
            for (let childId of parent.children) {
                if (this.isDescendant(childId, targetId, visited)) return true;
            }
        }
        return false;
    }

    pasteGroupRef(sourceGroupId, targetGroupId, transform = null) {
        let parent = this.treeItems.get(targetGroupId);
        if (!parent || parent.type !== 'group' || parent.isRef) {
            let activeId = this.ensureActiveGroup();
            if (!activeId) return null;
            parent = this.treeItems.get(activeId);
        }

        if (this.isDescendant(sourceGroupId, parent.id)) return null;

        const source = this.treeItems.get(sourceGroupId);
        if (!source) return null;

        const uniqueRefName = this.ensureUniqueName(source.name + "_Ref");
        
        this.treeItems.set(uniqueRefName, {
            id: uniqueRefName, type: 'group', name: uniqueRefName, charCode: null,
            parentId: parent.id, children: [], isRef: true, refId: source.id, collapsed: false,
            transform: transform ? new DOMMatrix(transform) : new DOMMatrix(),
            advance: 1000
        });
        parent.children.push(uniqueRefName);
        parent.is_modified = true;
        this.invalidateGroupCache(parent.id);
        this.updateSequenceParsing();
        this.notifyTreeUpdate();
        return uniqueRefName;
    }

    calculateSequenceOffsets() {
        this.sequenceOffsets = new Array(this.sequenceTokens.length).fill(0);
        let currentOffset = 0;
        for (let i = 0; i < this.sequenceTokens.length; i++) {
            this.sequenceOffsets[i] = currentOffset;
            let t = this.sequenceTokens[i];
            let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
            let group = this.treeItems.get(gid);
            currentOffset += (group && group.advance !== undefined) ? group.advance : 1000;
        }
    }

    getSeqOffset(seqIndex) {
        if (seqIndex <= 0 || seqIndex >= this.sequenceOffsets.length) return 0;
        return this.sequenceOffsets[seqIndex];
    }

    get_curves() { return this.curves; }

    add_node_by_curve(main_node, type, x, y, nextOnCurve, lastOnCurve, this_curve, node_id) {
        let next_node = nextOnCurve !== null ? this_curve.find_node_by_dom(nextOnCurve) : null;
        let last_node = lastOnCurve !== null ? this_curve.find_node_by_dom(lastOnCurve) : null;
        const node = this_curve.add_node(main_node, type, x, y, next_node, last_node, node_id);
        if (node) this.domMap.set(main_node, node); 
        return node;
    }

    rollbackLastPathNode(curve) {
        if (!curve || !curve.endNode) return false;
        let node = curve.endNode;
        if (node.type === null) return false;

        const prev = node.lastOnCurve;

        if (node.control1?.main_node) {
            curve.domMap.delete(node.control1.main_node);
            this.domMap.delete(node.control1.main_node);
        }
        if (node.control2?.main_node) {
            curve.domMap.delete(node.control2.main_node);
            this.domMap.delete(node.control2.main_node);
        }
        if (node.main_node) {
            curve.domMap.delete(node.main_node);
            this.domMap.delete(node.main_node);
        }

        if (prev) {
            prev.nextOnCurve = null;
            curve.endNode = prev;
        } else {
            curve.startNode = null;
            curve.endNode = null;
        }

        return true;
    }
    
    invalidateGroupCache(targetId) {
        let visited = new Set();
        const cm = this;

        function invalidate(id) {
            if (!id || visited.has(id)) return;
            visited.add(id);

            if (cm.groupFlatCache.has(id)) cm.groupFlatCache.delete(id);

            let item = cm.treeItems.get(id);
            if (!item) return;

            if (item.parentId) invalidate(item.parentId);

            for (let [otherId, otherItem] of cm.treeItems.entries()) {
                if (otherItem.isRef && otherItem.refId === id) invalidate(otherId);
            }
        }

        invalidate(targetId);
        
        if (typeof this.notifyModelUpdate === 'function') {
            this.notifyModelUpdate();
        }
    }

    notifyModelUpdate() {
        this._emitEvent(DOMAIN_EVENTS.MODEL_UPDATED);
    }

    updateNodeProperty(marker, propId, numVal) {
        let node = this.find_node_by_curve(marker);
        if (!node) return false;

        if (propId === 'prop_x') { 
            let dx = numVal - node.x; node.x = numVal; 
            if(node.control1) node.control1.x += dx; 
            if(node.control2) node.control2.x += dx; 
        }
        else if (propId === 'prop_y') { 
            let dy = numVal - node.y; node.y = numVal; 
            if(node.control1) node.control1.y += dy; 
            if(node.control2) node.control2.y += dy; 
        }
        else if (node.control1 && propId.startsWith('prop_in_')) {
            if (propId === 'prop_in_x') node.control1.x = numVal;
            if (propId === 'prop_in_y') node.control1.y = numVal;
            if (propId === 'prop_in_a') {
                const dist = Math.hypot(node.control1.x - node.x, node.control1.y - node.y);
                node.control1.x = node.x + dist * Math.cos(numVal * Math.PI / 180);
                node.control1.y = node.y + dist * Math.sin(numVal * Math.PI / 180);
            }
            if(propId.includes('in_')) node.set_both_control(node.control1.main_node, node.control_mode);
        }
        else if (node.control2 && propId.startsWith('prop_out_')) {
            if (propId === 'prop_out_x') node.control2.x = numVal;
            if (propId === 'prop_out_y') node.control2.y = numVal;
            if (propId === 'prop_out_a') {
                const dist = Math.hypot(node.control2.x - node.x, node.control2.y - node.y);
                node.control2.x = node.x + dist * Math.cos(numVal * Math.PI / 180);
                node.control2.y = node.y + dist * Math.sin(numVal * Math.PI / 180);
            }
            if(propId.includes('out_')) node.set_both_control(node.control2.main_node, node.control_mode);
        }
        
        let curve = this.find_curve_by_dom(marker);
        if (curve && curve.groupId) {
            this.invalidateGroupCache(curve.groupId);
        } else {
            this.notifyModelUpdate();
        }
        return true;
    }

    async loadFromJSON(jsonStr) {
        if (!jsonStr) return;
        let data;

        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            this._reportMessage('warn', "Warning: The JSON file format appears corrupted. The editor will attempt a relaxed parse to recover your data.");
            try {
                let relaxedJson = jsonStr.replace(/,\s*([\]}])/g, '$1');
                data = JSON.parse(relaxedJson);
            } catch (e2) {
                this._reportMessage('error', "Critical Error: The file is completely unreadable or severely damaged.");
                return;
            }
        }

        await this.loadFromSnapshotObject(data);
    }

    /** 从快照对象全量重建（仅用于打开文件 / 补丁降级，不用于常规 undo/redo） */
    async loadFromSnapshotObject(data) {
        if (!data) return;

        this.initTree();
        this.curves = [];
        this.domMap.clear();

        if (data.editor_sequence) this.sequenceText = data.editor_sequence;
        if (data.editor_active_indices) {
            this.activeSequenceIndices = new Set(data.editor_active_indices);
        }

        this.defaultGlyphs.clear();
        if (data.editor_default_glyphs) {
            for (let [charCode, groupName] of Object.entries(data.editor_default_glyphs)) {
                this.defaultGlyphs.set(charCode, groupName);
            }
        }

        let hasPartialErrors = false;

        if (data.components) {
            for (let compKey in data.components) {
                try {
                    let comp = data.components[compKey];
                    let gid = comp.name || compKey;
                    this._reconstructGroup(gid, comp, null, comp.char_code || null);
                } catch (e) {
                    hasPartialErrors = true;
                }
            }
        }

        if (data.ch) {
            for (let charKey in data.ch) {
                try {
                    let charData = data.ch[charKey];
                    let gid = charData.name || charKey;
                    let charCode = charData.char_code !== undefined ? charData.char_code : charKey;
                    this._reconstructGroup(gid, charData, null, charCode);
                } catch (e) {
                    hasPartialErrors = true;
                }
            }
        }

        if (hasPartialErrors) this._reportMessage('warn', "Notice: Some parts of the file were corrupted and have been skipped.");

        if (Array.isArray(data.editor_root_order)) {
            this.applyTreeChildOrder(null, data.editor_root_order);
        }

        this.rebuildDefaultGlyphs();
        this.updateSequenceParsing();
        this.notifyTreeUpdate();
    }

    /**
     * 单条路径增量替换（undo/redo 补丁：paths[pathName] 整段变更）
     */
    replacePathFromSnapshotData(groupName, pathName, pData) {
        const group = this.getGroupByName(groupName);
        if (!group || !pData) return false;
        const gid = group.id;

        for (const childId of [...(group.children || [])]) {
            const child = this.treeItems.get(childId);
            if (child?.type === "curve" && child.name === pathName) {
                this.deleteSingleObject(childId);
            }
        }

        try {
            const uniqueCurveId = this.ensureUniqueName(pathName);
            const curve = new Curve({ id: uniqueCurveId });
            curve.closed = pData.closed;
            curve.stroke_width = pData.stroke_width;
            curve.smart_stroke = pData.smart_stroke !== undefined ? pData.smart_stroke : true;
            curve.smart_stroke_clockwise =
                pData.smart_stroke_clockwise !== undefined ? pData.smart_stroke_clockwise : true;
            curve.show_skeleton = pData.show_skeleton !== undefined ? pData.show_skeleton : true;
            curve.visible = pData.visible !== undefined ? pData.visible : true;
            curve.locked = pData.locked !== undefined ? pData.locked : false;
            curve.groupId = gid;

            const sortedNodes = Object.values(pData.vertices || {}).sort((a, b) => a.order - b.order);
            let lastCreatedNode = null;

            for (const vData of sortedNodes) {
                const nId = vData.node_id || `n_${Date.now().toString(36)}_${Math.floor(Math.random() * 10000)}`;
                const marker = { id: `m_${nId}` };
                const node = new CurveNode(marker, "vertex", vData.x, vData.y, null, lastCreatedNode, nId);
                node.curve = curve;
                node.control_mode = vData.control_mode;

                if (vData.control_1 && vData.control_1.active) {
                    const m1 = { id: `c1_${nId}` };
                    node.control1 = new CurveNode(m1, null, vData.control_1.x, vData.control_1.y, node, null, m1.id);
                    node.control1.curve = curve;
                }
                if (vData.control_2 && vData.control_2.active) {
                    const m2 = { id: `c2_${nId}` };
                    node.control2 = new CurveNode(m2, null, vData.control_2.x, vData.control_2.y, node, null, m2.id);
                    node.control2.curve = curve;
                }

                if (!curve.startNode) curve.startNode = node;
                if (lastCreatedNode) lastCreatedNode.nextOnCurve = node;

                this._registerNodeDomMarkers(curve, node);
                lastCreatedNode = node;
                if (vData.end) curve.endNode = node;
            }

            this.curves.push(curve);
            const itemId = uniqueCurveId;
            this.treeItems.set(itemId, {
                id: itemId,
                type: "curve",
                curveId: uniqueCurveId,
                name: pathName,
                parentId: gid
            });
            group.children.push(itemId);
            this.groupFlatCache.clear();
            return true;
        } catch (e) {
            return false;
        }
    }

    _reconstructGroup(gid, gData, parentId, charCode = null) {
        this.treeItems.set(gid, {
            id: gid, type: 'group', name: gData.name || gid, charCode: charCode, parentId: parentId,
            children: [], isRef: false, advance: gData.advance !== undefined ? gData.advance : 1000,
            is_modified: true
        });

        if (!parentId) this.rootChildren.push(gid);
        
        if (charCode !== null && !gData.isRef) {
            if (!this.defaultGlyphs.has(charCode)) this.defaultGlyphs.set(charCode, gid);
        }

        if (gData.paths) {
            for (let pathName in gData.paths) { 
                try {
                    const pData = gData.paths[pathName];
                    const uniqueCurveId = this.ensureUniqueName(pathName);
                    
                    const curve = new Curve({ id: uniqueCurveId });
                    curve.closed = pData.closed; curve.stroke_width = pData.stroke_width;
                    curve.smart_stroke = pData.smart_stroke !== undefined ? pData.smart_stroke : true;
                    curve.smart_stroke_clockwise = pData.smart_stroke_clockwise !== undefined ? pData.smart_stroke_clockwise : true;
                    curve.show_skeleton = pData.show_skeleton !== undefined ? pData.show_skeleton : true;
                    curve.visible = pData.visible !== undefined ? pData.visible : true;
                    curve.locked = pData.locked !== undefined ? pData.locked : false;
                    curve.groupId = gid; 

                    const sortedNodes = Object.values(pData.vertices).sort((a, b) => a.order - b.order);
                    let lastCreatedNode = null;

                    for (let vData of sortedNodes) {
                        let nId = vData.node_id || `n_${Date.now().toString(36)}_${Math.floor(Math.random()*10000)}`;
                        const marker = { id: `m_${nId}` }; 
                        const node = new CurveNode(marker, "vertex", vData.x, vData.y, null, lastCreatedNode, nId);
                        node.curve = curve; node.control_mode = vData.control_mode;

                        if (vData.control_1 && vData.control_1.active) {
                            const m1 = { id: `c1_${nId}` };
                            node.control1 = new CurveNode(m1, null, vData.control_1.x, vData.control_1.y, node, null, m1.id);
                            node.control1.curve = curve;
                        }
                        if (vData.control_2 && vData.control_2.active) {
                            const m2 = { id: `c2_${nId}` };
                            node.control2 = new CurveNode(m2, null, vData.control_2.x, vData.control_2.y, node, null, m2.id);
                            node.control2.curve = curve;
                        }

                        if (!curve.startNode) curve.startNode = node;
                        if (lastCreatedNode) lastCreatedNode.nextOnCurve = node;

                        this._registerNodeDomMarkers(curve, node);
                        lastCreatedNode = node;
                        if (vData.end) curve.endNode = node;
                    }

                    this.curves.push(curve);
                    const itemId = uniqueCurveId;
                    this.treeItems.set(itemId, { id: itemId, type: 'curve', curveId: uniqueCurveId, name: uniqueCurveId, parentId: gid });
                    this.treeItems.get(gid).children.push(itemId);
                } catch (e) {}
            }
        }

        if (gData.components) {
            for (let refName in gData.components) {
                try {
                    const rData = gData.components[refName];
                    const matrix = Array.isArray(rData.transform) ? new DOMMatrix(rData.transform) : new DOMMatrix();
                    const uniqueRefName = this.ensureUniqueName(refName);
                    this.treeItems.set(uniqueRefName, {
                        id: uniqueRefName, type: 'group', name: uniqueRefName, parentId: gid,
                        children: [], isRef: true, refId: rData.component_id, transform: matrix
                    });
                    this.treeItems.get(gid).children.push(uniqueRefName);
                } catch (e) {}
            }
        }

        this.applyTreeChildOrder(gid, gData.tree_child_order);
    }

    /**
     * 按快照中的名称顺序重排 treeItems.children（同组内拖拽排序）
     * @param {string|null} groupId null 表示重排 rootChildren
     * @param {string[]} nameOrder 子项 name/id
     */
    applyTreeChildOrder(groupId, nameOrder) {
        if (!Array.isArray(nameOrder) || nameOrder.length === 0) return;

        let children;
        if (groupId === null || groupId === undefined) {
            children = this.rootChildren;
        } else {
            const group = this.treeItems.get(groupId);
            if (!group || !Array.isArray(group.children)) return;
            children = group.children;
        }

        const ordered = [];
        const used = new Set();

        const matchesName = (item, name) => {
            if (!item || name == null) return false;
            if (item.name === name || item.id === name) return true;
            if (item.type === "curve" && item.curveId === name) return true;
            if (item.type === "group" && item.isRef && (item.refId === name || item.name === name)) {
                return true;
            }
            return false;
        };

        for (const name of nameOrder) {
            for (const cid of children) {
                if (used.has(cid)) continue;
                const item = this.treeItems.get(cid);
                if (matchesName(item, name)) {
                    ordered.push(cid);
                    used.add(cid);
                    break;
                }
            }
        }
        for (const cid of children) {
            if (!used.has(cid)) ordered.push(cid);
        }

        if (groupId === null || groupId === undefined) {
            this.rootChildren = ordered;
        } else {
            this.treeItems.get(groupId).children = ordered;
        }
    }

    exportJSON(editorState) {
        let file = {
            "version": "1.0", "canvas_size_width": editorState.canvas_size_width, "canvas_size_height": editorState.canvas_size_height,
            "editor_guideline_h": editorState.guidelines_h || [], "editor_guideline_v": editorState.guidelines_v || [],
            "editor_guideline_lock": editorState.guideline_lock || false,
            "editor_sequence": this.sequenceText, "editor_active_indices": Array.from(this.activeSequenceIndices),
            "editor_fill_color": editorState.fill_color, "editor_stroke_color": editorState.stroke_color,
            "family_name": "Antumbra_Default_Font", "basic_spacing": 1000, "ch": {}, "components": {}
        };

        const serializeCurve = (curve) => {
            let pathData = {
                "closed": curve.closed, "stroke_width": curve.stroke_width, "smart_stroke": curve.smart_stroke,
                "smart_stroke_clockwise": curve.smart_stroke_clockwise !== false,
                "show_skeleton": curve.show_skeleton, "visible": curve.visible !== false, "locked": curve.locked === true,    
                "render_mode": "auto", "vertices": {}
            };
            let current = curve.startNode; let order = 0; 
            while (current) {
                let cleanNodeId = current.node_id || `n_${Date.now().toString(36)}_${Math.floor(Math.random()*10000)}`;
                pathData.vertices[cleanNodeId] = {
                    "order": order, "node_id": cleanNodeId, "x": current.x, "y": current.y, 
                    "start": current === curve.startNode, "end": current === curve.endNode,
                    "smooth": current.control_mode === 1 || current.control_mode === 2, "control_mode": current.control_mode, "relate_last": null, "relate_next": null,
                    "control_1": { "active": current.control1 !== null, "x": current.control1 ? current.control1.x : current.x, "y": current.control1 ? current.control1.y : current.y },
                    "control_2": { "active": current.control2 !== null, "x": current.control2 ? current.control2.x : current.x, "y": current.control2 ? current.control2.y : current.y }
                };
                order++; current = current.nextOnCurve;
            }
            return pathData;
        };

        const serializeGroup = (groupItem) => {
            let result = {
                "original_id": groupItem.name, "name": groupItem.name, "char_code": groupItem.charCode, 
                "advance": groupItem.advance !== undefined ? groupItem.advance : 1000, "paths": {}, "components": {},
                "tree_child_order": groupItem.children
                    .map((cid) => this.treeItems.get(cid)?.name || cid)
                    .filter(Boolean)
            };

            for (let childId of groupItem.children) {
                let child = this.treeItems.get(childId);
                if (!child) continue;

                if (child.type === 'curve') {
                    let curve = this.curves.find(c => c.id === child.curveId);
                    if (curve) result.paths[child.name] = serializeCurve(curve);
                } else if (child.type === 'group') {
                    if (child.isRef) {
                        let targetGroup = this.treeItems.get(child.refId);
                        result.components[child.name] = { 
                            "component_id": targetGroup ? targetGroup.name : child.refId, 
                            "transform": [1, 0, 0, 1, child.transform.e, child.transform.f], "visible": child.visible !== false, "locked": child.locked === true
                        };
                    } else {
                        result.components[child.name] = { "component_id": child.name, "transform": [1, 0, 0, 1, 0, 0] };
                    }
                }
            }
            return result;
        };

        file.editor_root_order = this.rootChildren
            .map((cid) => this.treeItems.get(cid)?.name || cid)
            .filter(Boolean);

        for (let [id, item] of this.treeItems.entries()) {
            if (item.type === 'group' && !item.isRef && item.parentId === null) {
                let serializedData = serializeGroup(item);
                if (item.charCode !== null && item.charCode !== undefined) file.ch[item.name] = serializedData; 
                else file.components[item.name] = serializedData; 
            }
        }
        return JSON.stringify(file, null, 4);
    }
}