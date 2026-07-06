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
 * MainCanvas: view host + transient interaction state + explicitly composed service/command facade.
 * No longer proxies service methods as canvas top-level API via _callServiceMethod.
 */
class MainCanvasBase extends HTMLElement {
    constructor(env = new EnvironmentAdapter()) {
        super();
        this.env = env;
        this.lock_guideline_button = null; this.lock_guideline_icon = null; this.lock_guideline_icon_unlocked = null;
        this.ruler_horizontal = null; this.ruler_vertical = null;
        this.main_canvas = null; this.main_canvas_large = null;
        this.canvas_size_width = 1000; this.canvas_size_height = 1000;
        /** Matches .ruler_horizontal / .ruler_vertical dimensions in css/style.css */
        this.ruler_size = 18;
        this.current_state = 'IDLE';
        this.drag_start = { x: 0, y: 0 }; this.painting_handle_start = { x: 0, y: 0 };
        this.dragging_node_start = { x: 0, y: 0 }; this.dragging_node_seq_idx = -1;
        this.dragging_node_matrix = null; this.drawing_seq_offset = undefined;
        this.is_measuring = false; this.measure_start = null; this.measure_end = null;
        this.rulers = [];
        this._nextRulerId = 1;
        this._draggingRulerEndpoint = null; // {rulerId, endpoint:'start'|'end'}
        this.is_box_selecting = false; this.box_select_start = null; this.box_select_end = null;
        this.transform_action = null; this.transform_snapshot = null;
        this.transform_snapshot_refs = null; this.transform_pivot = null; this.transform_start_world = null;
        this.transform_start_bounds = null;
        this.new_curve_handle = null; this.dragging_node_marker = null; this.last_on_curve_node_marker = null;
        this.hovered_node_marker = null; this.hovered_curve_segment = null;
        this.scale_min = 0.02; this.scale_max = 50; this.scale = 0.4;
        this.zoomFactor = 1.1;         // Geometric zoom factor per tick
        this.zoomTicks = 0;            // Tick counter (incremented on zoom-in, decremented on zoom-out)
        this.scaleBase = this.scale;   // Scale at zoomTicks = 0 (initially 0.4, matched to current default)
        this.offset = { x: 0, y: 0 }; this.offset_start = { x: 0, y: 0 };
        this.guideline_lock = false;
        this.snap_alignment_enabled = true;
        this.snap_coincident_enabled = true;
        this.divider_visible = true;
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
            else console.debug(message);
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
        this._draggingDivider = null;
        this._hoveredDividerId = null;
        this._hoveredRulerId = null;
        this._hoveredRulerEndpoint = null;
        this.is_dirty = true; this.globalEventTrackers = []; this.rAF_id = null;
        /** During high-frequency edits, only these curve ids use smart-stroke preview (skeleton + browser lineWidth) */
        this._interactiveStrokePreviewIds = new Set();
        this.commandStack = []; this.redoCommandStack = [];
        this.currentStateObj = null; this.is_restoring = false;
        this.max_command_log = 100;
        this.max_command_patch_count = 800;
        this.max_granular_array_length = 256;
        this.max_granular_object_keys = 160;
        this.granular_patch_paths = [["ch"], ["components"], ["editor_guideline_h"], ["editor_guideline_v"], ["editor_active_indices"], ["editor_user_guidelines"]];
        this.coarse_patch_paths = [];
        /** undo/redo prefers snapshotPatches for incremental runtime updates */
        this.history_use_patch_runtime = true;
        /** Console warning when patch cannot be applied (catches uncovered commands during development) */
        this.history_patch_warnings = true;
        /** true: throw on runtime patch failure, disallow full fallback */
        this.history_strict_patch_runtime = false;
        /** false: disallow undo/redo from silently calling loadFromSnapshotObject (restore/open-file only) */
        this.history_allow_snapshot_fallback = false;
        this.drawToolSettings = {
            stroke_width: 0, closed: true, smart_expand: true, show_skeleton: true
        };
        this.ellipseToolSettings = {
            stroke_width: 0, closed: true, smart_expand: true, show_skeleton: true
        };
        this.fontSettings = {
            family: "InkShader Default Font",
            style: "Regular",
            postscript_name: "",
            preferred_family: "",
            preferred_subfamily: "",
            copyright: "",
            designer: "",
            designer_url: "",
            manufacturer: "",
            manufacturer_url: "",
            license: "",
            license_url: "",
            trademark: "",
            description: "",
            sample_text: "",
            upm: 1000,
            weight_class: 400,
            width_class: 5,
            ascender: 800,
            descender: -200,
            x_height: 500,
            cap_height: 700,
            version: "1.0",
            project_name: ""
        };
        this.viewportService = new CanvasViewportService(this);
        this.renderRuntimeService = new CanvasRenderRuntimeService(this);
        // EditorStore initializes in connectedCallback after services are ready (history callback depends on this.history)
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
     * @param {string|null} refId Reference instance id; combined with curveId to degrade only that instance
     */
    isCurveInInteractiveStrokePreview(curveId, refId = null) {
        if (!curveId) return false;
        const set = this._interactiveStrokePreviewIds;
        if (!set?.size) return false;
        if (refId && set.has(`${curveId}::${refId}`)) return true;
        return set.has(curveId);
    }
    /** After interaction ends, rebuild boolean cache for affected curves on next frame */
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
    /** Compute canvas scale from zoomTicks using geometric formula. */
    zoomTicksToScale(ticks) {
        let s = this.scaleBase * Math.pow(this.zoomFactor, ticks);
        // Snap to 100% when within 0.5%
        if (Math.abs(s - 1.0) < 0.005) s = 1.0;
        return Math.min(Math.max(s, this.scale_min), this.scale_max);
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
        this._initGen = (this._initGen || 0) + 1;
        const gen = this._initGen;

        if (gen > 1) {
            // Reconnect path (dock system moved the element).
            // disconnectedCallback already cleaned up globalEventTrackers,
            // disconnected the ResizeObserver, and stopped the render loop.
            // Re-establish everything that was destroyed.
            this.globalEventTrackers = [];
            wireCanvasHost(this);
            setupCanvasView(this);
            this.resizeCanvas();
            this.is_dirty = true;
            this.refreshViewportConfig();
            setupCanvasResizeBehavior(this);
            attachCanvasCommands(this);
            if (this.canvasInputController) this.canvasInputController.bind();
            // Re-register event-bus listeners that disconnectedCallback cleaned up
            if (this.canvasController) this.canvasController.reconnect();
            this.renderRuntimeService.startLoop();
            return;
        }

        // First-time initialization
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
        this.canvasInputController = new CanvasInputController(this);
        this.canvasInputController.bind();
        await this.canvasController.initialize();
        if (gen !== this._initGen) return; // Stale continuation — reconnect happened during await
        this.editorStore.seedFromCanvas({ emit: true, applyToRuntime: false });
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
