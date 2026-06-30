import { generateMarker } from "../../core/bezier/utils.js";
import { EDITOR_ACTIONS } from "../actions/editor_actions.js";
import {
    commandCanvas,
    commitCommandHistoryFromHost,
    commitCommandHistoryUnlessDispatching,
    commitInteractionFromCommand,
    finishInteractionCommand,
    isStoreInteractionDispatch,
    refreshStoreSequence,
    selectedTreeIdsFromStore,
    syncActiveGroupToStore
} from "./command_runtime.js";
import { resolveMarkersFromCanvas } from "../selection/marker_resolution.js";

export class CanvasCommands {
    /** 不经 dispatch 的画布直连命令写栈（其余走 EditorStore 自动 commit） */
    _commitHistory(commandName, payload = {}) {
        return commitCommandHistoryFromHost(this, commandName, payload);
    }

    /** 画布 Delete 等：dispatch 路径由 finalize 写栈，直连命令需自行 commit */
    _commitHistoryUnlessDispatching(commandName, payload = {}) {
        return commitCommandHistoryUnlessDispatching(this, commandName, payload);
    }

    async loadSnapshotCommand(jsonStr) {
        if (jsonStr === null || jsonStr === undefined) return false;
        if (typeof jsonStr === "object") {
            await this.curve_manager.loadFromSnapshotObject(jsonStr);
            return true;
        }
        if (typeof jsonStr !== "string" || jsonStr.length === 0) return false;
        await this.curve_manager.loadFromJSON(jsonStr);
        return true;
    }

    /**
     * Command: 确认对控制点坐标的改变
     * 作用: 用户拖拽释放(mouseup)时终期调用，统一写入一次历史
     */
    changeControlNodePosition(marker, x, y) {
        let success = this.curve_manager.adjustControlNode(marker, x, y);
        if (success) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this._commitHistory("changeControlNodePosition");
        }
        return success;
    }

    deleteControlNode(marker) {
        let success = this.curve_manager.deleteControlNode(marker);
        if (success) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this._commitHistory("deleteControlNode");
        }
        return success;
    }

    /**
     * Command: 确认对选中主节点坐标的改变
     * 作用: 拖拽主节点释放(mouseup)时终期调用，统一写入一次历史
     */
    changeSelectedNodesPosition(updates = null) {
        if (updates && updates.length > 0) {
            this.curve_manager.moveSelectedNodes(updates);
        }
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this._commitHistory("changeSelectedNodesPosition");
        return true;
    }

    /**
     * Command: 修改所有选中节点的平滑状态
     */
    changeSmoothModeOnSelectedNode(markers, mode, forceCreateHandles = false) {
        let changed = false;
        for (const marker of markers) {
            if (this.curve_manager.changeSmoothModeOnSingleNode(marker, mode, forceCreateHandles)) {
                changed = true;
            }
        }
        if (changed) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
        }
        return changed;
    }

    /**
     * Command: 在已有路径中插入新节点
     */
    insertMainNode(segment, localX, localY) {
        if (!segment) return null;

        let best_t = this.utils.getClosestTOnSegment(segment.startNode, segment.nextNode, localX, localY, 0);

        if (segment.startNode && segment.startNode.control_mode === 2) {
            segment.startNode.control_mode = 1;
        }
        if (segment.nextNode && segment.nextNode.control_mode === 2) {
            segment.nextNode.control_mode = 1;
        }

        let newMarker = segment.curve.insertNodeAt(segment.startNode, best_t, this.curve_manager);
        if (!newMarker) return null;

        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "replace", markerIds: [newMarker.id] }
        });
        this.hovered_curve_segment = null;
        this.hovered_node_marker = newMarker;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this._commitHistory("insertMainNode");
        return newMarker;
    }

    /** 将 CM 活动组写入 Store（绘制渲染读 Store.activeGroupId） */
    syncActiveGroupForDraw(groupId) {
        return syncActiveGroupToStore(this, groupId);
    }

    /**
     * Action: 开始创建一个新路径
     */
    startAddingPath(activeGroupId, seqOffsetX) {
        syncActiveGroupToStore(this, activeGroupId);
        const curve = this.curve_manager.startAddingPath(activeGroupId, {
            stroke_width: this.drawToolSettings.stroke_width,
            closed: this.drawToolSettings.closed,
            smart_stroke: this.drawToolSettings.smart_expand,
            show_skeleton: this.drawToolSettings.show_skeleton
        });
        if (!curve) return false;

        this.current_curve = curve;
        this.drawing_seq_offset = seqOffsetX;
        this.last_on_curve_node_marker = null;
        return true;
    }

    /**
     * Action: 结束当前路径创建
     */
    finishAddingPath() {
        this.curve_manager.finishAddingPath(this.current_curve);
        this.current_curve = null;
        this.last_on_curve_node_marker = null;
        this.previewData = null;
        this.new_curve_handle = null;
        this.drawing_seq_offset = undefined;
        this.closing_path_on_mouseup = false;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
    }

    /**
     * Command: 完成当前路径并写入一次历史
     */
    finishAddingPathCommand() {
        const hasPath = !!(this.current_curve && this.current_curve.startNode);
        this.finishAddingPath();
        if (hasPath) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this._commitHistory("finishAddingPathCommand");
        }
        return hasPath;
    }

    /**
     * Command: 在当前绘制路径末尾追加一个主节点
     */
    addMainNode(worldX, worldY) {
        if (!this.current_curve) return null;

        let new_marker = generateMarker("vertex");
        this.curve_manager.add_node_by_curve(new_marker, "vertex", worldX, worldY, null, this.last_on_curve_node_marker, this.current_curve, String(new_marker.id));

        this.last_on_curve_node_marker = new_marker;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "replace", markerIds: [new_marker.id] }
        });
        return new_marker;
    }

    /**
     * Action: 绘制中撤回上一个主节点（不写历史）
     */
    undoDrawingStep() {
        if (!this.current_curve || !this.current_curve.startNode) return false;
        this.curve_manager.rollbackLastPathNode(this.current_curve);
        if (this.current_curve.startNode) {
            this.last_on_curve_node_marker = this.current_curve.endNode ? this.current_curve.endNode.main_node : null;
            if (this.last_on_curve_node_marker) {
                commitInteractionFromCommand(this, {
                    type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                    payload: { strategy: "replace", markerIds: [this.last_on_curve_node_marker.id] }
                });
            }
        } else {
            this.current_curve = null;
            this.last_on_curve_node_marker = null;
            this.drawing_seq_offset = undefined;
            this.new_curve_handle = null;
            this.closing_path_on_mouseup = false;
            commitInteractionFromCommand(this, {
                type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                payload: { strategy: "clear" }
            });
        }

        this.previewData = null;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 删除所有选中节点
     * 作用: 批量执行删除 Action 后，做清理与单次快照保存
     */
    deleteSelectedNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length === 0) return false;

        let changed = false;
        for (let marker of markers) {
            if (this.curve_manager.deleteSingleNode(marker)) {
                changed = true;
            }
        }

        if (changed) {
            commitInteractionFromCommand(this, {
                type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                payload: { strategy: "clear" }
            });
            this.curve_manager.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this._commitHistory("deleteSelectedNodes");
        }
        return changed;
    }

    /**
     * Command: 删除所有选中对象
     * 作用: 批量执行对象删除 Action，并在结束后统一写入一次历史
     */
    deleteSelectedObjects(ids = null) {
        const canvas = commandCanvas(this);
        const targetIds = selectedTreeIdsFromStore(canvas, ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.deleteSingleObject(id)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.updateSequenceParsing();
        const remaining = targetIds.filter((id) => this.curve_manager.treeItems.has(id));
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_TREE_SELECTION,
            payload: { ids: remaining }
        });
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this._commitHistoryUnlessDispatching("deleteSelectedObjects");
        return true;
    }

    /**
     * Command: 更改多个对象归属组/层级位置
     * 作用: 批量调用 changeSingleObjectGroup，并统一写入一次历史
     */
    changeSelectedObjectsGroup(ids = [], targetId = null, mode = 'inside') {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        if (!targetId) return false;

        let changed = false;
        for (const id of ids) {
            if (this.curve_manager.changeSingleObjectGroup(id, targetId, mode)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.updateSequenceParsing();
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this._commitHistoryUnlessDispatching("changeSelectedObjectsGroup");
        return true;
    }

    /**
     * Command: 批量修改单对象属性
     * updates: [{ id, props }]
     */
    setSingleObjectProperties(updates = [], options = {}) {
        if (!Array.isArray(updates) || updates.length === 0) return false;
        let changed = false;
        for (const update of updates) {
            if (!update || !update.id || !update.props) continue;
            if (this.curve_manager.setSingleObjectProperties(update.id, update.props)) changed = true;
        }
        // If recordHistory is requested (e.g. change/blur event), do NOT return false
        // when no model change is detected: the value may have already been applied
        // by a prior input event (realtimeIds path) — we still need the dispatch
        // chain to reach editorStore.commitCommand so the snapshot change delta
        // (currentStateObj → current model) is captured into history.
        if (!changed && !options.recordHistory) return false;

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 确认对象变换（拖拽/缩放/旋转）
     * 作用: 统一收口状态同步与历史记录
     */
    changeSelectedObjectsTransform(hasChanged = false) {
        this.curve_manager.syncTreeSelectionFromCanvas();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        if (hasChanged) this._commitHistory("changeSelectedObjectsTransform");
        return hasChanged;
    }

    /**
     * Command: 修改选中对象边界框参数（x/y/w/h）
     */
    changeSelectedObjectsBounds(prop, value, options = {}) {
        const bounds = this.utils.getSelectionBounds();
        if (!bounds) return false;
        const geometryBounds = (prop === 'w' || prop === 'h') ? this.utils.getSelectionBounds('geometry') : null;

        const changed = this.curve_manager.changeSelectedObjectsBounds(prop, value, bounds, geometryBounds, options);
        // Same input-event race as setSingleObjectProperties: input events via realtimeIds
        // pre-apply the value, so the change event finds nothing to do. Always proceed when
        // recordHistory is requested so the snapshot delta is captured.
        if (!changed && !options.recordHistory) return false;

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 复制选中对象到剪贴板
     */
    copySelectedObjects(ids = null) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        const payload = [];
        for (const id of targetIds) {
            const item = this.curve_manager.treeItems.get(id);
            if (!item) continue;
            if (item.type === 'curve') {
                const curve = this.curve_manager.curves.find(c => c.id === item.curveId);
                if (curve) payload.push({ type: 'curve', data: curve });
            } else if (item.type === 'group') {
                const actualRefId = item.isRef ? item.refId : id;
                payload.push({
                    type: 'group',
                    id: actualRefId,
                    name: item.name,
                    transform: item.isRef ? item.transform : null
                });
            }
        }
        this.curve_manager.clipboard = payload;
        return payload.length > 0;
    }

    /**
     * Command: 将剪贴板对象粘贴到目标组
     */
    pasteCopiedObjects(targetId = null) {
        const cm = this.curve_manager;
        if (!cm.clipboard || cm.clipboard.length === 0) return false;
        const resolvedTargetId = targetId || cm.ensureActiveGroup();
        if (!resolvedTargetId) return false;

        let changed = false;
        for (const item of cm.clipboard) {
            if (!item) continue;
            if (item.type === 'curve' && item.data) {
                const duplicated = cm.cloneCurveToGroup(item.data, resolvedTargetId);
                if (duplicated) changed = true;
            } else if (item.type === 'group' && item.id) {
                cm.pasteGroupRef(item.id, resolvedTargetId, item.transform || null);
                changed = true;
            }
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 复制（duplicate）选中对象
     */
    duplicateSelectedObjects(ids = null) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        const duplicatedTreeIds = [];
        for (const id of targetIds) {
            const item = this.curve_manager.treeItems.get(id);
            if (!item) continue;
            if (item.type === 'curve') {
                const curve = this.curve_manager.curves.find(c => c.id === item.curveId);
                const duplicated = curve ? this.curve_manager.cloneCurveToGroup(curve, item.parentId) : null;
                if (duplicated) {
                    duplicatedTreeIds.push(duplicated.id);
                    changed = true;
                }
            } else if (item.type === 'group') {
                const duplicatedGroup = this.curve_manager.duplicateGroupDeep(item.id, item.parentId);
                if (duplicatedGroup?.id) {
                    duplicatedTreeIds.push(duplicatedGroup.id);
                    if (duplicatedGroup.sequenceChanged) {
                        refreshStoreSequence(this);
                    }
                    changed = true;
                }
            }
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();

        if (duplicatedTreeIds.length > 0) {
            const validIds = duplicatedTreeIds.filter((id) => this.curve_manager.treeItems.has(id));
            if (validIds.length > 0) {
                commitInteractionFromCommand(this, {
                    type: EDITOR_ACTIONS.SET_TREE_SELECTION,
                    payload: { ids: validIds }
                });
            }
        }

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 锁定/解锁所有选中对象
     */
    toggleSelectedObjectsLock(ids = null, locked = undefined) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        const cm = this.curve_manager;
        const targetGroupIds = new Set(
            targetIds
                .map((id) => cm.treeItems.get(id))
                .filter((item) => item && item.type === "group" && item.parentId === null)
                .map((item) => item.id)
        );

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.toggleSingleObjectLock(id, locked)) changed = true;
        }
        if (!changed) return false;

        // 锁定/解锁与序列激活状态等价：
        // - 锁定 => 对应序列索引设为不激活
        // - 解锁 => 对应序列索引设为激活
        // 对曲线的 locked 仍是独立属性；这里只同步“分组(root group)”。
        const nextActive = new Set(cm.activeSequenceIndices || []);
        if (targetGroupIds.size > 0 && Array.isArray(cm.sequenceTokens)) {
            for (let i = 0; i < cm.sequenceTokens.length; i++) {
                const token = cm.sequenceTokens[i];
                if (!token) continue;
                const gid = token.isChar ? cm.getDefaultGroupForChar(token.value) : token.value;
                if (!gid || !targetGroupIds.has(gid)) continue;

                const item = cm.treeItems.get(gid);
                const isNowLocked = !!(item && item.locked === true);
                if (isNowLocked) nextActive.delete(i);
                else nextActive.add(i);
            }
        }
        cm.setActiveIndices(nextActive);
        refreshStoreSequence(this);

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 显示/隐藏所有选中对象
     */
    toggleSelectedObjectsDisplay(ids = null, visible = undefined) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.toggleSingleObjectDisplay(id, visible)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 重命名单个树对象
     */
    renameTreeItem(itemId, newName) {
        const item = this.curve_manager.treeItems.get(itemId);
        if (!item) return false;
        if (item.name === newName) return false;
        if (!this.curve_manager.renameItem(itemId, newName)) return false;

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 更新分组 advance
     */
    setGroupAdvance(groupId, advance, options = {}) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group') return false;
        const num = Number(advance);
        if (!Number.isFinite(num)) return false;
        if (item.advance === num) return false;

        item.advance = num;
        item.is_modified = true;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 更新单节点属性
     */
    updateSingleNodeProperty(marker, propId, value, options = {}) {
        const num = Number(value);
        if (!Number.isFinite(num)) return false;
        const changed = this.curve_manager.updateNodeProperty(marker, propId, num);
        if (!changed) return false;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 更新钢笔工具默认属性
     */
    setPenProperties(updates = {}, options = {}) {
        if (!updates || typeof updates !== 'object') return false;
        let changed = false;
        const allowed = ['stroke_width', 'closed', 'smart_expand', 'show_skeleton'];
        for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
            const nextVal = updates[key];
            if (this.drawToolSettings[key] !== nextVal) {
                this.drawToolSettings[key] = nextVal;
                changed = true;
            }
        }
        if (!changed) return false;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_DRAW_TOOL_SETTINGS,
            payload: { ...this.drawToolSettings }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 更新分组字符映射（g_char）
     */
    setGroupCharCode(groupId, rawValue, options = {}) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) {
            return { success: false, error: 'Invalid group target.' };
        }

        const newVal = rawValue === '' ? null : rawValue;
        if (item.charCode === newVal) return { success: false };

        if (newVal !== null) {
            for (let [otherId, otherItem] of this.curve_manager.treeItems.entries()) {
                if (otherId === groupId) continue;
                if (otherItem.type === 'group' && otherItem.parentId === null && !otherItem.isRef) {
                    if (otherItem.charCode === newVal) {
                        return { success: false, error: `Character code '${newVal}' is already used by '${otherItem.name}'. Character codes must be unique.` };
                    }
                }
            }
        }

        const oldChar = item.charCode;
        item.charCode = newVal;
        item.is_modified = true;
        this.curve_manager.rebuildDefaultGlyphs();

        const tokens = this.curve_manager.sequenceTokens || [];
        let newText = '';
        let seqChanged = false;
        for (let t of tokens) {
            if ((t.isChar && oldChar !== null && t.value === oldChar) || (!t.isChar && t.value === item.id)) {
                newText += `\\${item.name}\\`;
                seqChanged = true;
            } else {
                newText += t.raw;
            }
        }

        if (seqChanged) {
            this.curve_manager.setSequenceState({
                text: newText,
                activeIndices: Array.from(this.curve_manager.activeSequenceIndices)
            });
            refreshStoreSequence(this);
        } else {
            this.curve_manager.notifyTreeUpdate();
        }

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return { success: true };
    }

    /**
     * Command: 更新序列编辑器状态（text + activeIndices）
     * 默认不写历史，按需由 options.recordHistory 控制
     */
    setSequenceEditorState({ text, activeIndices } = {}, options = {}) {
        const cm = this.curve_manager;
        if (typeof text !== "string" && activeIndices === undefined) return false;
        cm.setSequenceState({ text, activeIndices });
        cm.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 删除分组并同步序列状态（供 sequence editor 菜单使用）
     */
    deleteGroupAndUpdateSequence(groupId, { text, activeIndices } = {}, options = {}) {
        if (!groupId || typeof text !== 'string') return false;
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) return false;

        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: { strategy: "clear" }
        });
        const deleted = this.curve_manager.deleteSingleObject(groupId);
        if (!deleted) return false;

        this.curve_manager.setSequenceState({ text, activeIndices });

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 画布对象选区（SELECT 工具点击/框选，不写历史）
     * payload: { strategy, curveIds?, refIds?, activeGroupId? }
     */
    changeObjectSelection(strategy = "replace", payload = {}) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: { strategy, ...payload }
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: 节点选区（NODE/DRAW 工具；Store 已在 dispatch 前 apply，此处与 CM 对齐）
     */
    changeNodeSelection(strategy = "replace", payload = {}) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy, ...payload }
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: 设置树选中（仅交互态，不写历史）
     */
    setTreeSelection(ids = [], activeGroupId = undefined) {
        if (!Array.isArray(ids)) return false;
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const payload = { ids };
        if (activeGroupId !== undefined && activeGroupId !== null) {
            payload.activeGroupId = activeGroupId;
        }
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_TREE_SELECTION,
            payload
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: 设置当前活动组（仅交互态，不写历史）
     */
    setActiveGroup(groupId) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_ACTIVE_GROUP,
            payload: { id: groupId }
        });
        if (!ok) return false;
        return finishInteractionCommand(this);
    }

    /**
     * Command: 折叠/展开分组（仅交互态，不写历史）
     */
    toggleGroupCollapsed(groupId) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) return false;
        item.collapsed = !item.collapsed;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 合并选中路径（Boolean Union）
     */
    booleanUnionSelectedCurves() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let firstGroupId = null;
        let validCurves = [];
        for (let id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') {
                console.warn("Union Failed: Please select ONLY basic paths.");
                return false;
            }
            const curve = cm.curves.find(c => c.id === item.curveId);
            if (!curve) continue;
            if (firstGroupId === null) {
                firstGroupId = curve.groupId;
            } else if (curve.groupId !== firstGroupId) {
                console.warn("Union Failed: All selected paths must belong to the exact same Group.");
                return false;
            }
            validCurves.push(curve);
        }
        if (validCurves.length === 0) return false;
        const changed = cm.executeBooleanUnion(validCurves, firstGroupId);
        if (!changed) return false;
        cm.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 取消引用（批量）
     */
    unlinkSelectedReferences(ids = []) {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        let changed = false;
        for (const id of ids) {
            if (this.curve_manager.unlinkReferenceDeep(id)) changed = true;
        }
        if (!changed) return false;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: 扩展描边（批量）
     */
    expandSelectedStroke() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let changed = false;
        const expandedCurves = [];
        let validCurves = [];
        for (let id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curves.find(c => c.id === item.curveId);
            if (!curve) continue;
            validCurves.push(curve);
        }
        if (validCurves.length === 0) return false;

        for (let curve of validCurves) {
            let originalSmart = curve.smart_stroke;
            curve.smart_stroke = true;
            curve.updateBooleanCache();

            if (!Array.isArray(curve.cached_boolean_geometry) || curve.cached_boolean_geometry.length === 0) {
                curve.smart_stroke = originalSmart;
                continue;
            }

            let parentGroupId = curve.groupId;
            for (let sub of curve.cached_boolean_geometry) {
                if (sub.segments.length < 2) continue;
                let newCurve = cm.create_temp_curve();
                newCurve.closed = sub.closed;
                newCurve.stroke_width = 0;
                newCurve.smart_stroke = true;
                newCurve.smart_stroke_clockwise = curve.smart_stroke_clockwise !== false;

                let prev_curve = this.current_curve;
                let prev_last = this.last_on_curve_node_marker;
                this.current_curve = newCurve;
                this.last_on_curve_node_marker = null;

                for (let i = 0; i < sub.segments.length; i++) {
                    let seg = sub.segments[i];
                    if (sub.closed && i === sub.segments.length - 1 && i > 0) {
                        let firstSeg = sub.segments[0];
                        if (Math.abs(firstSeg.x - seg.x) < 0.001 && Math.abs(firstSeg.y - seg.y) < 0.001) {
                            let firstNode = newCurve.startNode;
                            if (seg.inX !== 0 || seg.inY !== 0) {
                                if (!firstNode.control2) cm.changeSmoothModeOnSingleNode(firstNode.main_node, 1, true);
                                if (firstNode.control2) {
                                    firstNode.control2.x = seg.x + seg.inX;
                                    firstNode.control2.y = seg.y + seg.inY;
                                }
                            }
                            continue;
                        }
                    }

                    let marker = this.addMainNode(seg.x, seg.y);
                    let node = cm.find_node_by_curve(marker);
                    let controlMode = (seg.inX !== 0 || seg.inY !== 0 || seg.outX !== 0 || seg.outY !== 0) ? 1 : 0;
                    if (controlMode !== 0) cm.changeSmoothModeOnSingleNode(marker, controlMode, true);
                    if (node.control1) {
                        node.control1.x = seg.x + (seg.outX || 0);
                        node.control1.y = seg.y + (seg.outY || 0);
                    }
                    if (node.control2) {
                        node.control2.x = seg.x + (seg.inX || 0);
                        node.control2.y = seg.y + (seg.inY || 0);
                    }
                    newCurve.endNode = node;
                }

                this.current_curve = prev_curve;
                this.last_on_curve_node_marker = prev_last;

                cm.addPath(newCurve, parentGroupId);
                expandedCurves.push(newCurve);
            }

            cm.remove_curve(curve.id);
            changed = true;
        }

        if (!changed) return false;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: {
                strategy: "replace",
                curveIds: expandedCurves.map((c) => c.id),
                refIds: []
            }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }
}
