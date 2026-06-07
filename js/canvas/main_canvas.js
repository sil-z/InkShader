// components/main_canvas/main_canvas.js
import { CurveManager } from "../core/bezier/manager.js";
import { wireCanvasHost } from "../app/canvas_host_wiring.js";
import { EnvironmentAdapter } from "./environment_adapter.js";
import { CanvasController } from "../presentation/canvas/canvas_controller.js";
import { CanvasInputController } from "../presentation/canvas/canvas_input_controller.js";
import { CanvasInteractionController } from "../presentation/canvas/canvas_interaction_controller.js";
import { setupCanvasResizeBehavior, setupCanvasView } from "../presentation/canvas/canvas_view.js";
import { attachCanvasCommands } from "../domain/commands/attach_canvas_commands.js";
import { attachCanvasServices } from "./services/canvas_services.js";
import { CanvasRenderRuntimeService } from "./services/canvas_render_runtime_service.js";
import { CanvasViewportService } from "./services/canvas_viewport_service.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { EditorStore } from "../app/editor_store.js";
import {
    createEmptyInteractionSnapshot,
    mergeInteractionFromStoreState,
    resolveActiveCanvasTool
} from "../app/editor_interaction_state.js";
import { appEventBus } from "../app/event_bus.js";
/**
 * MainCanvas：视图宿主 + 交互瞬时状态 + 显式组合的服务/命令门面。
 * 不再通过 _callServiceMethod 把 service 方法代理为 canvas 顶级 API。
 */
class MainCanvasBase extends HTMLElement {
    constructor(env = new EnvironmentAdapter()) {
        super();
        this.env = env;
        this.lock_guideline_button = null; this.lock_guideline_icon = null; this.lock_guideline_icon_unlocked = null;
        this.ruler_horizontal = null; this.ruler_vertical = null;
        this.main_canvas = null; this.main_canvas_large = null;
        this.canvas_size_width = 1000; this.canvas_size_height = 1000;
        /** 与 css/style.css 中 .ruler_horizontal / .ruler_vertical 尺寸一致 */
        this.ruler_size = 18;
        this.current_state = 'IDLE';
        this.drag_start = { x: 0, y: 0 }; this.painting_handle_start = { x: 0, y: 0 };
        this.dragging_node_start = { x: 0, y: 0 }; this.dragging_node_seq_idx = -1;
        this.dragging_node_matrix = null; this.drawing_seq_offset = undefined;
        this.is_measuring = false; this.measure_start = null; this.measure_end = null;
        this.is_box_selecting = false; this.box_select_start = null; this.box_select_end = null;
        this.transform_action = null; this.transform_snapshot = null;
        this.transform_snapshot_refs = null; this.transform_pivot = null; this.transform_start_world = null;
        this.transform_start_bounds = null;
        this.new_curve_handle = null; this.dragging_node_marker = null; this.last_on_curve_node_marker = null;
        this.hovered_node_marker = null; this.hovered_curve_segment = null;
        this.scale_min = 0.02; this.scale_max = 50; this.scale = 0.4;
        this.offset = { x: 0, y: 0 }; this.offset_start = { x: 0, y: 0 };
        this.guideline_lock = false;
        this.viewportConfig = {
            rulerWidth: this.ruler_size,
            rulerHeight: this.ruler_size,
            viewportWidth: 0,
            viewportHeight: 0,
            viewportLeft: 0,
            viewportTop: 0
        };
        this.curve_manager = CurveManager.getInstance();
        this._ensureCommandHostPort = () => wireCanvasHost(this);
        wireCanvasHost(this);
        this.curve_manager.setMessageReporter((level, message) => {
            if (level === 'error' || level === 'warn') alert(message);
            else console.log(message);
        });
        this.current_curve = null; this.new_selected_temp = null;
        this.ctrl_click_added_selection = false;
        this.closing_path_on_mouseup = false;
        this.previewData = null; this.mouse_pos_output = null;
        this.last_mouse_pos_x = 0; this.last_mouse_pos_y = 0;
        this.active_guidelines = []; this.drag_initial_mouse = null;
        this.drag_initial_target = null; this.drag_initial_nodes = new Map();
        this.user_guidelines = [];
        this._draggingUserGuide = null;
        this._hoveredUserGuideId = null;
        this._nextUserGuideId = 1;
        this.is_dirty = true; this.globalEventTrackers = []; this.rAF_id = null;
        /** 高频编辑期间仅这些曲线 id 走智能描边预览（骨架 + 浏览器 lineWidth） */
        this._interactiveStrokePreviewIds = new Set();
        this.commandStack = []; this.redoCommandStack = [];
        this.currentStateObj = null; this.is_restoring = false;
        this.max_command_log = 100;
        this.max_command_patch_count = 800;
        this.max_granular_array_length = 256;
        this.max_granular_object_keys = 160;
        this.granular_patch_paths = [["ch"], ["components"], ["editor_guideline_h"], ["editor_guideline_v"], ["editor_active_indices"], ["editor_user_guidelines"]];
        this.coarse_patch_paths = [];
        /** undo/redo 优先用 snapshotPatches 增量改运行时 */
        this.history_use_patch_runtime = true;
        /** 补丁无法应用时 console 告警（开发期发现未覆盖命令） */
        this.history_patch_warnings = true;
        /** true：运行时补丁失败即抛错，禁止全量降级 */
        this.history_strict_patch_runtime = false;
        /** false：禁止 undo/redo 静默 loadFromSnapshotObject（仅恢复/打开文件可用） */
        this.history_allow_snapshot_fallback = false;
        this.drawToolSettings = {
            stroke_width: 1, closed: false, smart_expand: true, show_skeleton: true
        };
        this.viewportService = new CanvasViewportService(this);
        this.renderRuntimeService = new CanvasRenderRuntimeService(this);
        // EditorStore 在 connectedCallback 中 services 就绪后初始化（history 回调依赖 this.history）
        this.editorStore = null;
        this.services = null;
        this.utils = null;
        this.renderer = null;
        this.io = null;
        this.history = null;
        this.commands = null;
    }
    notifyPropertiesUpdate() {
        if (typeof this.curve_manager.notifyModelUpdate === "function") {
            this.curve_manager.notifyModelUpdate();
        } else {
            this.bumpEditorStoreModelRevision();
        }
    }
    refreshViewportConfig() {
        return this.viewportService.refreshViewportConfig();
    }
    getViewportMousePosition(clientX, clientY, event = null) {
        return this.viewportService.getViewportMousePosition(clientX, clientY, event);
    }
    addGlobalListener(targetType, type, listener, options = false) {
        const cleanup = this.env.listen(targetType, type, listener, options);
        this.globalEventTrackers.push(cleanup);
    }
    bumpEditorStoreModelRevision() {
        if (this.editorStore && typeof this.editorStore.bumpModelRevision === "function") {
            this.editorStore.bumpModelRevision();
        }
    }
    bumpEditorStoreTreeRevision() {
        if (this.editorStore && typeof this.editorStore.bumpTreeRevision === "function") {
            this.editorStore.bumpTreeRevision();
        }
    }
    setInteractiveStrokePreviewCurveIds(ids = []) {
        this._interactiveStrokePreviewIds = new Set((ids || []).filter(Boolean));
        this.is_dirty = true;
    }
    clearInteractiveStrokePreview() {
        if (!this._interactiveStrokePreviewIds?.size) return;
        this._interactiveStrokePreviewIds.clear();
        this.is_dirty = true;
    }
    /**
     * @param {string|null} refId 引用实例 id；与 curveId 组合可只降级该实例
     */
    isCurveInInteractiveStrokePreview(curveId, refId = null) {
        if (!curveId) return false;
        const set = this._interactiveStrokePreviewIds;
        if (!set?.size) return false;
        if (refId && set.has(`${curveId}::${refId}`)) return true;
        return set.has(curveId);
    }
    /** 交互结束后使受影响曲线在下一帧重建布尔缓存 */
    flushSmartStrokeBooleanCache(curveIds = null) {
        const cm = this.curve_manager;
        if (!cm) return;
        const targets = curveIds
            ? curveIds.map((id) => cm.curves.find((c) => c.id === id)).filter(Boolean)
            : cm.curves.filter((c) => c.smart_stroke);
        for (const curve of targets) {
            curve.invalidateBooleanCache?.();
        }
        this.is_dirty = true;
    }
    get current_tool() {
        return resolveActiveCanvasTool(this);
    }
    getActiveTool() {
        return resolveActiveCanvasTool(this);
    }
    getInteractionSnapshot() {
        const storeState = this.editorStore?.getState?.();
        if (storeState) {
            return mergeInteractionFromStoreState(storeState);
        }
        return createEmptyInteractionSnapshot();
    }
    syncEditorStoreHistoryStacks() {
        if (this.editorStore && typeof this.editorStore.syncHistoryStacks === "function") {
            this.editorStore.syncHistoryStacks();
        }
    }
    commitCommandHistory(detail = {}) {
        return this.editorStore?.commitCommand?.(detail) ?? false;
    }
    async connectedCallback() {
        this.services = attachCanvasServices(this);
        this.utils = this.services.utils;
        this.renderer = this.services.renderer;
        this.io = this.services.io;
        this.history = this.services.history;
        this.editorStore = new EditorStore({
            emit: (eventName, detail) => appEventBus.emit(eventName, detail),
            getCanvas: () => this,
            recordHistory: (detail) => this.history.recordHistory(detail),
            undoHistory: () => this.history.undo(),
            redoHistory: () => this.history.redo()
        });
        wireCanvasHost(this);
        setupCanvasView(this);
        this.refreshViewportConfig();
        setupCanvasResizeBehavior(this);
        attachCanvasCommands(this);
        this.interactionController = new CanvasInteractionController(this);
        this.canvasController = new CanvasController(this);
        await this.canvasController.initialize();
        this.editorStore.seedFromCanvas({ emit: true, applyToRuntime: false });
        this.canvasInputController = new CanvasInputController(this);
        this.canvasInputController.bind();
        this.renderRuntimeService.startLoop();
    }
    disconnectedCallback() {
        this.globalEventTrackers.forEach(cleanup => cleanup());
        this.globalEventTrackers = [];
        if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
        this.renderRuntimeService.stopLoop();
    }
    resizeCanvas() {
        this.renderRuntimeService.resizeCanvas();
    }
}
class MainCanvas extends MainCanvasBase {}
customElements.define("main-canvas", MainCanvas);
