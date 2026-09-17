import { StorageUtils } from "../../services/storage.js";
import { ProjectManager } from "../../services/project_manager.js";
import { desktopApi, isDesktop, isDesktopAsync } from "../../app/app_mode.js";
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
        // Session 25: window event-bus listeners are PERMANENT. They survive the
        // element being detached (hidden dock panel), so CanvasDispatcher
        // requests and model-sync events keep flowing while the canvas is hidden.
        // disconnectedCallback only cleans globalEventTrackers (DOM-side);
        // reconnect() therefore never re-registers these.
        this.canvas.globalBusTrackers.push(cleanup);
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
                c.transform_pivot = null;
                return c.commands.setTreeSelection(payload.ids || [], payload.activeGroupId);
            case CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION:
                c.transform_pivot = null;
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
            case CANVAS_ACTIONS.MARK_GROUP_EXPLICIT: return c.commands.markGroupExplicit(payload.id);
            case CANVAS_ACTIONS.SET_KERNING_PAIRS: return c.commands.setKerningPairs(payload.pairs || [], payload.options || {});

            case CANVAS_ACTIONS.UPDATE_NODE_PROPERTY:
                return c.commands.updateSingleNodeProperty(payload.marker, payload.propId, payload.value, payload.options || {});
            case CANVAS_ACTIONS.SET_PEN_PROPERTIES: {
                const penResult = c.commands.setPenProperties(payload.updates || {}, payload.options || {});
                // Persist drawToolSettings immediately (same pattern as applyToolMode)
                c.history?.saveCurrentViewState?.(true);
                return penResult;
            }
            case CANVAS_ACTIONS.SET_ELLIPSE_PROPERTIES: {
                const ellipseResult = c.commands.setEllipseProperties(payload.updates || {}, payload.options || {});
                c.history?.saveCurrentViewState?.(true);
                return ellipseResult;
            }
            case CANVAS_ACTIONS.SET_FONT_SETTINGS: return c.commands.setFontSettings(payload.updates || {}, payload.options || {});
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
            case CANVAS_ACTIONS.BOOLEAN_INTERSECTION: return c.commands.booleanIntersectionSelectedCurves();
            case CANVAS_ACTIONS.BOOLEAN_DIFFERENCE: return c.commands.booleanDifferenceSelectedCurves();
            case CANVAS_ACTIONS.BOOLEAN_EXCLUSION: return c.commands.booleanExclusionSelectedCurves();
            case CANVAS_ACTIONS.INSERT_NODE: return c.commands.insertNodeSelectedSegments();
            case CANVAS_ACTIONS.DELETE_NODE: return c.commands.deleteSelectedNodes();
            case CANVAS_ACTIONS.JOIN_NODE: return c.commands.joinSelectedNodes();
            case CANVAS_ACTIONS.BREAK_NODE: return c.commands.breakPathAtSelectedNodes();
            case CANVAS_ACTIONS.ADD_SEGMENT: return c.commands.addSegmentBetweenEndnodes();
            case CANVAS_ACTIONS.DELETE_SEGMENT: return c.commands.deleteSegmentBetweenNodes();
            case CANVAS_ACTIONS.ADD_EXTREMA: return c.commands.addExtrema();
            case CANVAS_ACTIONS.SIMPLIFY_PATH: return c.commands.simplifyPath();
            case CANVAS_ACTIONS.OPTIMIZE_PATH: return c.commands.optimizePath();
            case CANVAS_ACTIONS.ROUND_NODES: return c.commands.roundNodes();
            case CANVAS_ACTIONS.SMOOTH_CURVES: return c.commands.smoothCurves();
            case CANVAS_ACTIONS.CORRECT_DIRECTION: return c.commands.correctDirectionSelected();
            case CANVAS_ACTIONS.REMOVE_OVERLAP: return c.commands.removeOverlapSelected();
            case CANVAS_ACTIONS.UNLINK: return c.commands.unlinkSelectedReferences(payload.ids || []);
            case CANVAS_ACTIONS.IMPORT_IMAGE: c.io.triggerImportImage(); return true;
            case CANVAS_ACTIONS.UNDO:
                return c.editorStore.undo();
            case CANVAS_ACTIONS.REDO:
                return c.editorStore.redo();
            default: return false;
        }
    }

    /** Single entry point for domain side effects (ordered, silenced by CurveManager during restore) */
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
                // Node-drag frames update geometry locally; defer Store/UI sync until mouseup.
                if (c.current_state === "DRAGGING_NODE") break;
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
            c.drag_preview = null;
            c._ellipseWorldStartX = undefined;
            c._ellipseWorldStartY = undefined;
            c._ellipseWorldEndX = undefined;
            c._ellipseWorldEndY = undefined;
        } else {
            const gid = c.curve_manager.ensureActiveGroup();
            if (gid) {
                c.commands.syncActiveGroupForDraw(gid);
            } else {
                // No active group in sequence — clear stale drawing state so
                // a leftover last_on_curve_node_marker can't produce a preview
                c.current_curve = null;
                c.previewData = null;
                c.last_on_curve_node_marker = null;
                c.new_curve_handle = null;
                c.drawing_seq_offset = undefined;
                c.closing_path_on_mouseup = false;
                c.current_state = "IDLE";
            }
        }

        if (unchanged) {
            c.is_dirty = true;
            return true;
        }
        c.history.saveCurrentViewState(true);

        // Guideline lock: force-locked + disabled in DRAW/ELLIPSE, restored on exit
        const isDrawMode = mode === "DRAW" || mode === "ELLIPSE";
        const wasDrawMode = previousTool === "DRAW" || previousTool === "ELLIPSE";
        if (isDrawMode && !wasDrawMode) {
            c._guidelineLockSaved = c.guideline_lock;
            c.guideline_lock = true;
            c._guidelineLockDisabled = true;
        } else if (wasDrawMode && !isDrawMode) {
            c.guideline_lock = c._guidelineLockSaved;
            c._guidelineLockDisabled = false;
        }
        if (c.lock_guideline_icon) c.lock_guideline_icon.classList.toggle('is-visible', !!c.guideline_lock);
        if (c.lock_guideline_icon_unlocked) c.lock_guideline_icon_unlocked.classList.toggle('is-visible', !c.guideline_lock);

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
        c.hovered_node_refId = null;
        c.hovered_node_seqIndex = null;
        c.hovered_node_matrix = null;
        c.hovered_curve_segment = null;
        c.is_box_selecting = false;
        c.renderer?.endBoxSelectPreview?.();
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
            c.renderer?.invalidateStableSceneCache?.();
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
            if (c._guidelineLockDisabled) return;
            c.guideline_lock = !c.guideline_lock;
            if(c.guideline_lock) { c.lock_guideline_icon.classList.add('is-visible'); c.lock_guideline_icon_unlocked.classList.remove('is-visible'); }
            else { c.lock_guideline_icon.classList.remove('is-visible'); c.lock_guideline_icon_unlocked.classList.add('is-visible'); }
            c.history?.saveCurrentViewState?.();
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
                // Restore offset; recalculate if saved viewport size differs from current
                // (offset depends on viewport size, direct restore would misalign canvas paper)
                c.offset = { x: viewState.offset_x || 0, y: viewState.offset_y || 0 };
                if (viewState.vp_width && viewState.vp_height) {
                    const vp = c.viewportConfig;
                    if (vp && vp.viewportWidth > 0 &&
                        Math.abs(vp.viewportWidth - viewState.vp_width) > 10) {
                        const ruler = c.ruler_size;
                        const paperW = c.canvas_size_width * c.scale;
                        const paperH = ((c.fontSettings?.ascender ?? 800) - (c.fontSettings?.descender ?? -200)) * c.scale;
                        // Calculate center offset for save, preserving user's pan offset
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
                // Restore guideline_lock from viewState
                if (viewState.guideline_lock !== undefined) {
                    c.guideline_lock = !!viewState.guideline_lock;
                    if (c.guideline_lock) { c.lock_guideline_icon?.classList.add('is-visible'); c.lock_guideline_icon_unlocked?.classList.remove('is-visible'); }
                    else { c.lock_guideline_icon?.classList.remove('is-visible'); c.lock_guideline_icon_unlocked?.classList.add('is-visible'); }
                }
                // Restore snap toggle states from viewState
                if (viewState.snap_alignment_enabled !== undefined) {
                    c.snap_alignment_enabled = viewState.snap_alignment_enabled;
                }
                if (viewState.snap_coincident_enabled !== undefined) {
                    c.snap_coincident_enabled = viewState.snap_coincident_enabled;
                }
                if (viewState.divider_visible !== undefined) {
                    c.divider_visible = viewState.divider_visible;
                }
                if (viewState.coord_transform_mode) {
                    c.coordTransformMode = viewState.coord_transform_mode;
                }
                // Restore canvas view rotation (0 when a project saved before this feature)
                c.setViewRotation?.(viewState.view_rotation || 0);
                // Restore draw_tool_settings from viewState (persisted tool preferences)
                if (viewState.draw_tool_settings) {
                    Object.assign(c.drawToolSettings, viewState.draw_tool_settings);
                }
                if (viewState.ellipse_tool_settings) {
                    Object.assign(c.ellipseToolSettings, viewState.ellipse_tool_settings);
                }
                c.editorStore?.syncViewFromCanvas?.();

                // Old fixed-width restoration (right_width) is now handled by dock layout; removed to avoid
                // container being set to `flex: 0 0 <px>` and unable to scale with viewport, causing right-side truncation.
                // See restoreState for dock_layout deserialization. CSS .right.dock-container already has flex: 1.
                // Guard: only deserialize if the saved tree includes the canvas panel.
                // Old cached data (pre-dock-integration) may lack canvas, causing it to disappear.
                // 版本门：仅恢复当前版本（v3 新默认）保存的布局；旧版本布局已被
                // 新默认取代，恢复它会覆盖用户期望的新默认布局
                if (viewState.dock_layout_version === 3 && viewState.dock_layout && window.__dock && _treeHasLeaf(viewState.dock_layout, 'canvas')) {
                    window.__dock.deserialize(viewState.dock_layout);
                }
                c.is_dirty = true;
            }

            await StorageUtils.migrateIfNeeded();

            // 桌面模式（pywebview 窗口）或 ?new=1 新标签：不恢复浏览器缓存项目，
            // 作为全新会话启动（随后 initialize() 会自动创建新项目）。
            const freshStart = isDesktop() || new URLSearchParams(window.location.search).has("new");
            // pywebview 桥可能在页面加载早期尚未注入，等注入判定稳定后再决定
            const desktop = await isDesktopAsync();
            const effectiveFreshStart = freshStart || desktop;

            const pm = c.projectManager;

            // 全新会话：清掉其它会话通过 localStorage 留下的活动项目名，
            // 否则 initialize() 误以为已有项目而不会自动新建。
            if (effectiveFreshStart && pm && pm.getActiveProjectName()) {
                pm.setActiveProjectName(null);
            }

            let activeName = pm ? pm.getActiveProjectName() : StorageUtils.loadActiveProject();
            let projectData = null;

            // 活动项目槽位可能已不存在（被改名/清理/其他标签覆盖）：
            // 回退到缓存项目栈顶（MRU，最后保存/加载的项目）。
            if (activeName && !effectiveFreshStart) {
                projectData = await StorageUtils.loadProject(activeName);
                if (!projectData && pm) {
                    const mru = await StorageUtils.latestCachedProject();
                    if (mru && mru !== activeName) {
                        activeName = mru;
                        pm.setActiveProjectName(mru);
                        projectData = await StorageUtils.loadProject(mru);
                    } else if (!mru) {
                        pm.setActiveProjectName(null);
                        activeName = null;
                    }
                }
            }

            let loaded = false;
            if (activeName && !effectiveFreshStart && projectData) {
                    try {
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
                    } catch (loadError) {
                        console.error(`[Restore] Failed to load project "${activeName}":`, loadError);
                        // Fall through to !loaded path below
                    }
            }

            if (!loaded && !effectiveFreshStart && !activeName) {
                const savedState = await StorageUtils.load();
                if (savedState) {
                    let snapshotStr = "";
                    let data = null;
                    if (typeof savedState === 'string') {
                        snapshotStr = savedState;
                        data = JSON.parse(savedState);
                    } else if (savedState.latestSnapshot) {
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
            } else if (effectiveFreshStart && !loaded) {
                // 全新会话（桌面 / ?new=1）：初始化空的序列状态
                this.dispatchAction(
                    CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
                    { payload: { text: '', activeIndices: [] }, options: { recordHistory: false } },
                    { source: "restore-state" }
                );
            }

            c.is_dirty = true;
            c.currentStateObj = c.history.getHistoryState();

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
            pm.syncActiveProjectNameFromCanvas?.();
        } catch (err) { console.error(" [Storage] Restore state failed:", err); }
    }

    /** Kept for lifecycle symmetry — the gen>1 connectedCallback path still calls
     *  it. Since Session 25, window event-bus listeners (registered via onBus into
     *  globalBusTrackers) are PERMANENT: disconnectedCallback never removes them,
     *  so there is nothing to re-register here. Direct DOM listeners (guidelines,
     *  rulers) survive re-attach on their own; pointer/keyboard listeners are
     *  re-registered by canvasInputController.bind(). */
    reconnect() {
        // Intentionally empty — see comment above.
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
        // 新标签页（?new=1）：作为全新项目启动，不继承其他会话的活动项目
        const isFreshTab = new URLSearchParams(window.location.search).has("new");
        // 关闭窗口警告选「保存并退出」时由桌面后端调用（window.__inkshader_save_and_quit）。
        // 保存成功后请求退出；用户取消保存则留在编辑器中。
        if (typeof window !== "undefined" && !window.__inkshader_save_and_quit) {
            window.__inkshader_save_and_quit = async () => {
                try {
                    const ok = await this.canvas.io.triggerSaveAndQuit();
                    if (ok) {
                        desktopApi()?.request_quit();
                    }
                } catch (err) {
                    console.error("[InkShader] save-and-quit failed:", err);
                }
            };
        }
        await pm.init(isFreshTab);

        // Show brand title immediately from cached project name (localStorage),
        // before restoreState() which does heavy IndexedDB reads + snapshot
        // deserialization. This eliminates the ~1s delay where the user sees
        // "InkShader" instead of their project name. restoreState() will later
        // call syncActiveProjectNameFromCanvas() which re-runs _updateBrandTitle()
        // from the actual canvas fontSettings.
        const cachedName = pm.getActiveProjectName();
        if (cachedName) {
            const brandEl = document.getElementById('brand_title');
            if (brandEl) brandEl.textContent = `${cachedName} - InkShader`;
        }

        this.onBus(CANVAS_EVENTS.STATE_CHANGED, () => {
            pm.syncActiveProjectNameFromCanvas?.().catch((err) => {
                console.error("[ProjectManager] Failed to sync project name:", err);
            });
        });

        await this.restoreState();

        // 桌面模式：从其他窗口移交来的待打开/导入文件（打开或导入需要新窗口时，
        // 由父窗口暂存到本地后端，本窗口启动时消费）
        let pendingHandled = false;
        if (!pm.getActiveProjectName()) {
            pendingHandled = !!(await this.canvas.io.consumePendingImport());
            // Auto-create a default project on fresh startup (no name, no cached data)
            if (!pendingHandled) {
                await pm.createNewProject();
            }
        }

        // 启动完成后记录保存点：新建/恢复的项目初始均为「已保存」状态；
        // 从暂存导入的项目保持「未保存」（无磁盘根，首次 Save 走 save-as-json）
        if (!pendingHandled) {
            pm.markSaved();
        }
        this.canvas.currentStateObj = this.canvas.history.getHistoryState();
    }
}
