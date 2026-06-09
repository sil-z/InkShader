import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { readRightPanelLayout } from "../app/layout_metrics_service.js";
import { DockLayout } from "./dock_layout.js";
import "./node_property_popup.js";

export function initializeLayoutShell() {
    const dockContainer = document.querySelector(".dock-container");
    const objectTree = document.querySelector("object-tree");
    const propertyPanel = document.querySelector(".property_panel");
    const loggerPanel = document.querySelector("logger-panel");
    if (!dockContainer || !objectTree || !propertyPanel) return;

    const dock = new DockLayout(dockContainer);
    dock.initialize(["objects", "properties", "terminal"]);
    window.__dock = dock;

    if (!document.querySelector('node-property-popup')) {
        document.body.appendChild(document.createElement('node-property-popup'));
    }

    const middleContainer = document.querySelector(".middle");
    const canvasWrap = document.querySelector(".canvas-wrap");
    if (middleContainer && canvasWrap) {
        const hResizer = document.createElement("div");
        hResizer.className = "horizontal-resizer";
        middleContainer.insertBefore(hResizer, canvasWrap);
        let isHResizing = false;
        let startHX = 0;
        let startRightWidth = 0;
        const rightContainer = dockContainer;
        hResizer.addEventListener("mousedown", (e) => {
            isHResizing = true;
            startHX = e.clientX;
            startRightWidth = readRightPanelLayout({ rightContainer }).rightWidth;
            hResizer.classList.add("is-h-resizing");
            document.body.style.cursor = "ew-resize";
            e.preventDefault();
        });
        document.addEventListener("mousemove", (e) => {
            if (!isHResizing) return;
            const dx = e.clientX - startHX;
            const newWidth = Math.max(150, startRightWidth + dx);
            rightContainer.style.flex = `0 0 ${newWidth}px`;
        });
        document.addEventListener("mouseup", () => {
            if (isHResizing) {
                isHResizing = false;
                hResizer.classList.remove("is-h-resizing");
                document.body.style.cursor = "";
                CanvasDispatcher.requestSaveViewState(true);
            }
        });
    }

    const dispatchMode = (modeVal) => CanvasDispatcher.requestSetNodeMode(modeVal);
    document.getElementById("btn_mode_corner")?.addEventListener("click", () => dispatchMode(0));
    document.getElementById("btn_mode_smooth")?.addEventListener("click", () => dispatchMode(1));
    document.getElementById("btn_mode_symmetric")?.addEventListener("click", () => dispatchMode(2));
    const updateToolModeUI = (modeVal) => {
        document.querySelectorAll(".tool_button").forEach((btn) => btn.classList.remove("active-tool"));
        const targetBtn = document.getElementById("btn_tool_" + modeVal.toLowerCase());
        if (targetBtn) targetBtn.classList.add("active-tool");
    };
    const dispatchToolMode = (modeVal) => {
        updateToolModeUI(modeVal);
        CanvasDispatcher.requestSetToolMode(modeVal);
    };
    appEventBus.on(CANVAS_EVENTS.SYNC_TOOL_UI, (e) => {
        const mode = e?.detail?.mode;
        if (typeof mode === "string" && mode.length > 0) updateToolModeUI(mode);
    });
    appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, (e) => {
        const mode = e?.detail?.afterState?.currentTool;
        if (typeof mode === "string" && mode.length > 0) updateToolModeUI(mode);
    });
    document.getElementById("btn_action_union")?.addEventListener("click", () => CanvasDispatcher.requestBooleanUnion());
    document.getElementById("btn_action_expand")?.addEventListener("click", () => CanvasDispatcher.requestExpandStroke());
    document.getElementById("btn_tool_select")?.addEventListener("click", () => dispatchToolMode("SELECT"));
    document.getElementById("btn_tool_node")?.addEventListener("click", () => dispatchToolMode("NODE"));
    document.getElementById("btn_tool_draw")?.addEventListener("click", () => dispatchToolMode("DRAW"));
    document.getElementById("btn_tool_measure")?.addEventListener("click", () => dispatchToolMode("MEASURE"));
    updateToolModeUI("DRAW");
    const topMenuItems = document.querySelectorAll(".top .item");
    const btnLoad = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.load");
    const btnSave = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.save");
    const btnExport = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.export");
    const btnPreferences = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.prefs");
    const btnHelp = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.help");
    const btnImport = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.import");
    btnLoad?.addEventListener("click", () => CanvasDispatcher.requestLoad());
    btnSave?.addEventListener("click", () => CanvasDispatcher.requestSave());
    btnExport?.addEventListener("click", () => CanvasDispatcher.requestExport());
    btnImport?.addEventListener("click", () => CanvasDispatcher.requestImport());
    const prefModal = document.getElementById("app_preferences_modal");
    btnPreferences?.addEventListener("click", () => {
        if (prefModal) prefModal.open();
    });
    const helpModal = document.getElementById("app_help_modal");
    btnHelp?.addEventListener("click", () => {
        if (helpModal) helpModal.open();
    });
}
