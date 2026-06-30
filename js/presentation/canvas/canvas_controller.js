import { StorageUtils } from "../../services/storage.js";
import { ProjectManager } from "../../services/project_manager.js";
import { updateThemeParams } from "../../services/theme.js";
import { CANVAS_ACTIONS, CANVAS_EVENTS, createCanvasAction } from "../../app/canvas_events.js";
import { REQUEST_ACTION_ROUTES, REQUEST_IO_ROUTES, TOOL_ACTION_ROUTES } from "../../app/canvas_request_routes.js";
import { appEventBus } from "../../app/event_bus.js";
import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import {
    deriveObjectSelectionFromStoreState,
    resolveMarkersFromStore
} from "../../app/editor_interaction_state.js";

/** Check if a dock-layout tree contains a leaf with the given panel id. */
function _treeHasLeaf(node, panelId) {
    if (!node) return false;
    if (node.type === 'leaf') return node.id === panelId;
    if (node.type === 'tabs') return node.children?.some(c => _treeHasLeaf(c, panelId));
    if (node.type === 'split') return node.children?.some(c => _treeHasLeaf(c, panelId));
    return false;
}

export class CanvasController {
    constructor(canvas) {
        this.canvas = canvas;
    }

    dispatchAction(type, payload = {}, meta = {}) {
        const action = createCanvasAction(type, payload, meta);
        this.canvas.__dispatchingAction = action;
        try {
            if (this.canvas.editorStore && typeof this.canvas.editorStore.dispatchAction === "function") {
                return this.canvas.editorStore.dispatchAction(action, (nextAction) => this.handleAction(nextAction));
            }
            return this.handleAction(action);
        } finally {
            this.canvas.__dispatchingAction = null;
        }
    }

    onBus(eventName, listener, options = false) {
        const cleanup = appEventBus.on(eventName, listener, options);
        this.canvas.globalEventTrackers.push(cleanup);
    }

    handleAction(action) {
        const c = this.canvas;
        const payload = action?.payload || {};
        switch (action?.type) {
            case CANVAS_ACTIONS.SET_TOOL_MODE: return this.applyToolMode(payload.mode);
            case CANVAS_ACTIONS.SET_NODE_MODE: return this.applyNodeMode(payload.mode);
            case CANVAS_ACTIONS.COPY_SELECTED_OBJECTS: return c.commands.copySelectedObjects(payload.ids || null);
            case CANVAS_ACTIONS.PASTE_COPIED_OBJECTS: return c.commands.pasteCopiedObjects(payload.targetId || null);
            case CANVAS_ACTIONS.DUPLICATE_SELECTED_OBJECTS: return c.commands.duplicateSelectedObjects(payload.ids || null);
            case CANVAS_ACTIONS.SET_TREE_SELECTION:
                return c.commands.setTreeSelection(payload.ids || [], payload.activeGroupId);
            case CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION:
                return c.commands.changeObjectSelection(payload.strategy || "replace", payload);
            case CANVAS_ACTIONS.CHANGE_NODE_SELECTION:
                return c.commands.changeNodeSelection(payload.strategy || "replace", payload);
            case CANVAS_ACTIONS.SET_ACTIVE_GROUP: return c.commands.setActiveGroup(payload.id);
            case CANVAS_ACTIONS.TOGGLE_GROUP_COLLAPSED: return c.commands.toggleGroupCollapsed(payload.id);
            case CANVAS_ACTIONS.TOGGLE_SELECTED_OBJECTS_LOCK: return c.commands.toggleSelectedObjectsLock(payload.ids || null, payload.locked);
            case CANVAS_ACTIONS.TOGGLE_SELECTED_OBJECTS_DISPLAY: return c.commands.toggleSelectedObjectsDisplay(payload.ids || null, payload.visible);
            case CANVAS_ACTIONS.DELETE_SELECTED_OBJECTS: return c.commands.deleteSelectedObjects(payload.ids);
            case CANVAS_ACTIONS.CHANGE_SELECTED_OBJECTS_GROUP:
                return c.commands.changeSelectedObjectsGroup(payload.ids || [], payload.targetId || null, payload.mode || "inside");
            case CANVAS_ACTIONS.SET_SINGLE_OBJECT_PROPERTIES:
                return c.commands.setSingleObjectProperties(payload.updates || [], payload.options || {});
            case CANVAS_ACTIONS.CHANGE_SELECTED_OBJECTS_BOUNDS:
                return c.commands.changeSelectedObjectsBounds(payload.prop, payload.value, payload.options || {});
            case CANVAS_ACTIONS.RENAME_TREE_ITEM: return c.commands.renameTreeItem(payload.id, payload.newName);
            case CANVAS_ACTIONS.SET_GROUP_ADVANCE: return c.commands.setGroupAdvance(payload.id, payload.value, payload.options || {});
            case CANVAS_ACTIONS.UPDATE_NODE_PROPERTY:
                return c.commands.updateSingleNodeProperty(payload.marker, payload.propId, payload.value, payload.options || {});
            case CANVAS_ACTIONS.SET_PEN_PROPERTIES: return c.commands.setPenProperties(payload.updates || {}, payload.options || {});
            case CANVAS_ACTIONS.SET_GROUP_CHAR_CODE: return c.commands.setGroupCharCode(payload.id, payload.value, payload.options || {});
            case CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE:
                return c.commands.setSequenceEditorState(payload.payload || {}, payload.options || {});
            case CANVAS_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE:
                return c.commands.deleteGroupAndUpdateSequence(payload.groupId, payload.payload || {}, payload.options || {});
            case CANVAS_ACTIONS.COMMIT_SEQUENCE_HISTORY:
            case CANVAS_ACTIONS.COMMIT_HISTORY:
                return c.editorStore?.commitCommand
                    ? c.editorStore.commitCommand(action)
                    : c.history.recordHistory({
                          commandName: payload.commandName || "history-commit",
                          payload: payload.payload || payload || {}
                      });
            case CANVAS_ACTIONS.EXPAND_STROKE: return c.commands.expandSelectedStroke();
            case CANVAS_ACTIONS.BOOLEAN_UNION: return c.commands.booleanUnionSelectedCurves();
            case CANVAS_ACTIONS.UNLINK: return c.commands.unlinkSelectedReferences(payload.ids || []);
            case CANVAS_ACTIONS.IMPORT_IMAGE: c.io.triggerImportImage(); return true;
            case CANVAS_ACTIONS.UNDO:
                return c.editorStore.undo();
            case CANVAS_ACTIONS.REDO:
                return c.editorStore.redo();
            default: return false;
        }
    }

    /** 领域副作用单入口（有序、恢复中由 CurveManager 静默） */
    onDomainEffect(effect) {
        const c = this.canvas;
        if (c.is_restoring) return;
        c.is_dirty = true;
        switch (effect) {
            case "tree":
                c.bumpEditorStoreTreeRevision();
                c.history.saveCurrentViewState(true);
                break;
            case "model":
                c.bumpEditorStoreModelRevision();
                break;
            case "selection":
                c.history.saveCurrentViewState(true);
                break;
            case "activeGroup":
                break;
            default:
                break;
        }
    }

    applyToolMode(mode) {
        const c = this.canvas;
        if (!mode) return false;

        const previousTool = c.__dispatchingAction?.meta?.previousTool ?? c.getActiveTool();
        const unchanged = previousTool === mode;

        if (!unchanged && previousTool === "DRAW" && mode !== "DRAW") {
            c.commands.finishAddingPathCommand();
        }

        if (mode !== "DRAW" && mode !== "ELLIPSE") {
            c.current_curve = null;
            c.previewData = null;
            c.new_curve_handle = null;
            c.last_on_curve_node_marker = null;
            c.drawing_seq_offset = undefined;
            c.closing_path_on_mouseup = false;
            c.current_state = "IDLE";
            c._ellipseWorldStartX = undefined;
            c._ellipseWorldStartY = undefined;
            c._ellipseWorldEndX = undefined;
            c._ellipseWorldEndY = undefined;
        } else {
            const gid = c.curve_manager.ensureActiveGroup();
            if (gid) c.commands.syncActiveGroupForDraw(gid);
        }

        if (unchanged) {
            c.is_dirty = true;
            return true;
        }
        c.history.saveCurrentViewState(true);

        if (previousTool === "NODE" && mode !== "NODE") {
            const st = c.editorStore?.getState?.() || {};
            const { curveIds, refIds } = deriveObjectSelectionFromStoreState(st, c.curve_manager);
            if (curveIds.length > 0 || refIds.length > 0) {
                this.dispatchAction(CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION, {
                    strategy: "replace",
                    curveIds,
                    refIds
                });
            }
        }

        c.hovered_node_marker = null;
        c.hovered_curve_segment = null;
        c.is_box_selecting = false;
        c.is_measuring = false;
        c.measure_start = null;
        c.measure_end = null;
        if (c.current_state !== "IDLE" && mode !== "DRAW") {
            c.current_state = "IDLE";
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
        return true;
    }

    applyNodeMode(mode) {
        const c = this.canvas;
        if (![0, 1, 2].includes(mode)) return false;
        const markers = resolveMarkersFromStore(c);
        if (markers.length === 0) return false;
        return c.commands.changeSmoothModeOnSelectedNode(markers, mode);
    }

    registerModelSyncListeners() {
        const c = this.canvas;
        this.onBus(CANVAS_EVENTS.TREE_UPDATED, () => this.onDomainEffect("tree"));
        this.onBus(CANVAS_EVENTS.SEQUENCE_CHANGED, (e) => {
            this.dispatchAction(
                CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                { payload: { text: e?.detail?.text }, options: { recordHistory: false } },
                { source: CANVAS_EVENTS.SEQUENCE_CHANGED }
            );
        });
        this.onBus(CANVAS_EVENTS.SEQUENCE_ACTIVE_CHANGED, (e) => {
            this.dispatchAction(
                CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                { payload: { activeIndices: e?.detail?.activeIndices }, options: { recordHistory: false } },
                { source: CANVAS_EVENTS.SEQUENCE_ACTIVE_CHANGED }
            );
            c.history.saveCurrentViewState(true);
        });
        this.onBus(CANVAS_EVENTS.GLOBAL_SELECTION_UPDATED, () => this.onDomainEffect("selection"));
        this.onBus(CANVAS_EVENTS.ACTIVE_GROUP_CHANGED, () => this.onDomainEffect("activeGroup"));
        this.onBus(CANVAS_EVENTS.FORCE_CANVAS_REDRAW, () => { c.is_dirty = true; });
        this.onBus(CANVAS_EVENTS.MODEL_UPDATED, () => this.onDomainEffect("model"));
    }

    registerToolListeners() {
        for (const route of TOOL_ACTION_ROUTES) {
            this.onBus(route.event, (e) => {
                const detail = e?.detail || {};
                const payload = route.mapPayload(detail);
                this.dispatchAction(route.action, payload, { source: route.event });
            });
        }
    }

    registerRequestListeners() {
        for (const route of REQUEST_ACTION_ROUTES) {
            this.onBus(route.event, (e) => {
                const detail = e?.detail || {};
                const payload = route.mapPayload(detail);
                const result = this.dispatchAction(route.action, payload, { source: route.event });
                if (route.assignResult && e.detail) {
                    e.detail.result = result;
                }
            });
        }
        for (const route of REQUEST_IO_ROUTES) {
            this.onBus(route.event, (e) => route.handler(this.canvas, e?.detail));
        }
    }

    registerCommandBridgeListeners() {
        this.registerRequestListeners();
    }

    registerThemeListener() {
        const c = this.canvas;
        this.onBus(CANVAS_EVENTS.THEME_PARAMS_UPDATED, () => {
            updateThemeParams();
            c.is_dirty = true;
        });
    }

    setupGuidelineToggle() {
        if (this._guidelineToggleSetup) return;
        this._guidelineToggleSetup = true;
        const c = this.canvas;
        const base = c.env.getLocationHref();
        if(c.lock_guideline_icon) c.lock_guideline_icon.src = new URL(c.lock_guideline_icon.dataset.src, base).href;
        if(c.lock_guideline_icon_unlocked) c.lock_guideline_icon_unlocked.src = new URL(c.lock_guideline_icon_unlocked.dataset.src, base).href;
        if(c.lock_guideline_icon) c.lock_guideline_icon.classList.remove('is-visible');
        if(c.lock_guideline_icon_unlocked) c.lock_guideline_icon_unlocked.classList.add('is-visible');

        c.lock_guideline_button?.addEventListener("mousedown", () => {
            c.guideline_lock = !c.guideline_lock;
            if(c.guideline_lock) { c.lock_guideline_icon.classList.add('is-visible'); c.lock_guideline_icon_unlocked.classList.remove('is-visible'); }
            else { c.lock_guideline_icon.classList.remove('is-visible'); c.lock_guideline_icon_unlocked.classList.add('is-visible'); }
        });
    }

    async restoreState() {
        const c = this.canvas;
        try {
            const viewState = await StorageUtils.loadViewState();
            if (viewState) {
                // Restore zoomTicks (modern) or compute from stored scale (legacy)
                if (viewState.zoom_ticks !== undefined) {
                    c.zoomTicks = viewState.zoom_ticks;
                    c.scale = c.zoomTicksToScale(c.zoomTicks);
                } else {
                    c.scale = viewState.scale || c.scale;
                    c.zoomTicks = Math.round(Math.log(c.scale / c.scaleBase) / Math.log(c.zoomFactor));
                }
                // 恢复偏移，但如果保存时的视口尺寸与当前不同则重新计算
                // （偏移量依赖视口尺寸，直接恢复会导致画纸定位偏移）
                c.offset = { x: viewState.offset_x || 0, y: viewState.offset_y || 0 };
                if (viewState.vp_width && viewState.vp_height) {
                    const vp = c.viewportConfig;
                    if (vp && vp.viewportWidth > 0 &&
                        Math.abs(vp.viewportWidth - viewState.vp_width) > 10) {
                        const ruler = c.ruler_size;
                        const paperW = c.canvas_size_width * c.scale;
                        const paperH = c.canvas_size_height * c.scale;
                        // 计算保存时的中心偏移，保留用户的平移偏移（pan）
                        const oldCenterX = (viewState.vp_width - ruler - paperW) / 2;
                        const oldCenterY = (viewState.vp_height - ruler - paperH) / 2;
                        const panX = viewState.offset_x - oldCenterX;
                        const panY = viewState.offset_y - oldCenterY;
                        const newCenterX = (vp.viewportWidth - ruler - paperW) / 2;
                        const newCenterY = (vp.viewportHeight - ruler - paperH) / 2;
                        c.offset.x = newCenterX + panX;
                        c.offset.y = newCenterY + panY;
                    }
                }
                if (viewState.draw_tool_settings) {
                    c.drawToolSettings = viewState.draw_tool_settings;
                    c.editorStore?.commitInteraction?.(
                        {
                            type: "SET_DRAW_TOOL_SETTINGS",
                            payload: { ...viewState.draw_tool_settings }
                        },
                        { emit: true }
                    );
                }
                c.editorStore?.syncViewFromCanvas?.();

                // 旧的固定宽度恢复（right_width）已由 dock 布局接管，移除避免
                // 容器被设为 `flex: 0 0 <px>` 而无法随视口缩放，导致右侧截断。
                // 见 restoreState 中的 dock_layout 反序列化。CSS 中 .right.dock-container 已有 flex: 1。
                // Guard: only deserialize if the saved tree includes the canvas panel.
                // Old cached data (pre-dock-integration) may lack canvas, causing it to disappear.
                if (viewState.dock_layout && window.__dock && _treeHasLeaf(viewState.dock_layout, 'canvas')) {
                    window.__dock.deserialize(viewState.dock_layout);
                }
                c.is_dirty = true;
            }

            await StorageUtils.migrateIfNeeded();

            const pm = c.projectManager;
            const activeName = pm ? pm.getActiveProjectName() : StorageUtils.loadActiveProject();

            let loaded = false;
            if (activeName) {
                const projectData = await StorageUtils.loadProject(activeName);
                if (projectData) {
                    let snapshotStr = "";
                    let data = null;
                    if (projectData.latestSnapshot) {
                        snapshotStr = JSON.stringify(projectData.latestSnapshot);
                        data = projectData.latestSnapshot;
                    } else if (typeof projectData === 'string') {
                        snapshotStr = projectData;
                        data = JSON.parse(projectData);
                    } else {
                        snapshotStr = JSON.stringify(projectData);
                        data = projectData;
                    }
                    await c.commands.loadSnapshotCommand(snapshotStr);
                    const sanitize = (entry) => (typeof c.history._sanitizeCommandEntry === 'function' ? c.history._sanitizeCommandEntry(entry) : entry);
                    c.commandStack = Array.isArray(projectData.commandStack) ? projectData.commandStack.map(sanitize).filter(Boolean) : [];
                    c.redoCommandStack = Array.isArray(projectData.redoCommandStack) ? projectData.redoCommandStack.map(sanitize).filter(Boolean) : [];
                    loaded = true;

                    let seqText = viewState?.sequence_text ?? data?.editor_sequence ?? "";
                    let seqActiveIndices = viewState?.active_sequence_indices ?? data?.editor_active_indices ?? [];
                    if (!seqActiveIndices.length && seqText) {
                        let tokens = c.curve_manager.parseSequence(seqText);
                        seqActiveIndices = tokens.map((_, i) => i);
                    }
                    this.dispatchAction(
                        CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                        { payload: { text: seqText, activeIndices: seqActiveIndices }, options: { recordHistory: false } },
                        { source: "restore-state" }
                    );
                }
            }

            if (!loaded) {
                const savedState = await StorageUtils.load();
                if (savedState) {
                    let snapshotStr = "";
                    let data = null;
                    if (typeof savedState === 'string') {
                        snapshotStr = savedState;
                        data = JSON.parse(savedState);
                    } else if (savedState.runtimeVersion === 2 && savedState.latestSnapshot) {
                        snapshotStr = JSON.stringify(savedState.latestSnapshot);
                        data = savedState.latestSnapshot;
                    } else {
                        snapshotStr = JSON.stringify(savedState);
                        data = savedState;
                    }
                    await c.commands.loadSnapshotCommand(snapshotStr);
                    c.commandStack = [];
                    c.redoCommandStack = [];
                    let seqText = viewState?.sequence_text ?? data?.editor_sequence ?? "";
                    let seqActiveIndices = viewState?.active_sequence_indices ?? data?.editor_active_indices ?? [];
                    if (!seqActiveIndices.length && seqText) {
                        let tokens = c.curve_manager.parseSequence(seqText);
                        seqActiveIndices = tokens.map((_, i) => i);
                    }
                    this.dispatchAction(
                        CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                        { payload: { text: seqText, activeIndices: seqActiveIndices }, options: { recordHistory: false } },
                        { source: "restore-state" }
                    );
                } else {
                    // No data at all (e.g. cache cleared) — initialize empty sequence editor state
                    this.dispatchAction(
                        CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                        { payload: { text: '', activeIndices: [] }, options: { recordHistory: false } },
                        { source: "restore-state" }
                    );
                }
            }

            c.is_dirty = true;
            c.currentStateObj = c.history.getHistoryState();
            if (typeof c.history._reconcileRuntimeHistoryStacks === 'function') c.history._reconcileRuntimeHistoryStacks();

            if (viewState && viewState.selected_tree_ids?.length) {
                const validIds = viewState.selected_tree_ids.filter((id) => c.curve_manager.treeItems.has(id));
                this.dispatchAction(CANVAS_ACTIONS.SET_TREE_SELECTION, { ids: validIds });
            }

            if (viewState?.active_group_id) {
                this.dispatchAction(CANVAS_ACTIONS.SET_ACTIVE_GROUP, { id: viewState.active_group_id });
            }

            if (viewState?.current_tool) {
                this.dispatchAction(CANVAS_ACTIONS.SET_TOOL_MODE, { mode: viewState.current_tool });
                CanvasDispatcher.syncToolUi(viewState.current_tool);
            }

            c.editorStore?.mergeViewFromCanvas?.();
            c.editorStore?.bumpTreeRevision?.();
        } catch (err) { console.error(" [Storage] 恢复状态失败:", err); }
    }

    /** Re-register event bus listeners after the dock system removed/re-attached
     *  the <main-canvas> element, which triggered disconnectedCallback → cleanup.
     *  Does NOT call setupGuidelineToggle() — those are direct DOM listeners on
     *  elements that survive re-attach, so calling it again would register duplicates. */
    reconnect() {
        this.registerModelSyncListeners();
        this.registerToolListeners();
        this.registerCommandBridgeListeners();
        this.registerThemeListener();
    }

    async initialize() {
        StorageUtils.requestPersistence();
        this.registerModelSyncListeners();
        this.registerToolListeners();
        this.registerCommandBridgeListeners();
        this.registerThemeListener();
        this.setupGuidelineToggle();

        const pm = new ProjectManager(this.canvas);
        this.canvas.projectManager = pm;
        window.__canvas = this.canvas;
        await pm.init();

        await this.restoreState();
        this.canvas.currentStateObj = this.canvas.history.getHistoryState();
        if (typeof this.canvas.history._reconcileRuntimeHistoryStacks === 'function') this.canvas.history._reconcileRuntimeHistoryStacks();
    }
}
