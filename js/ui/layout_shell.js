import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { readRightPanelLayout } from "../app/layout_metrics_service.js";

/** 应用外壳：分割条、工具栏、顶栏菜单（不直接访问 main-canvas） */
export function initializeLayoutShell() {
    const rightContainer = document.querySelector(".right");
    const objectTree = document.querySelector("object-tree");
    const propertyPanel = document.querySelector(".property_panel");

    if (!rightContainer || !objectTree || !propertyPanel) return;

    const resizer = document.createElement("div");
    resizer.className = "vertical-resizer";
    rightContainer.insertBefore(resizer, propertyPanel);

    let isResizing = false;
    let startY = 0;
    let startTreeFlex = 0;
    let startPropFlex = 0;

    const persistLayoutIfChanged = () => CanvasDispatcher.requestSaveViewState(true);

    resizer.addEventListener("mousedown", (e) => {
        isResizing = true;
        startY = e.clientY;
        const layout = readRightPanelLayout({ rightContainer, objectTree, propertyPanel });
        startTreeFlex = layout.treeFlex;
        startPropFlex = layout.propFlex;
        resizer.classList.add("is-resizing");
        document.body.style.cursor = "ns-resize";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const dy = e.clientY - startY;
        const totalDynamicHeight = readRightPanelLayout({ objectTree, propertyPanel }).totalDynamicHeight;
        if (totalDynamicHeight <= 0) return;
        const deltaPercent = (dy / totalDynamicHeight) * 100;
        let newTreeFlex = startTreeFlex + deltaPercent;
        let newPropFlex = startPropFlex - deltaPercent;
        const minPercent = 10;
        if (newTreeFlex < minPercent) {
            newTreeFlex = minPercent;
            newPropFlex = 100 - minPercent;
        } else if (newPropFlex < minPercent) {
            newPropFlex = minPercent;
            newTreeFlex = 100 - minPercent;
        }
        objectTree.style.flex = `1 1 ${newTreeFlex}%`;
        propertyPanel.style.flex = `1 1 ${newPropFlex}%`;
    });

    const middleContainer = document.querySelector(".middle");
    const leftContainer = document.querySelector(".left");
    if (middleContainer && leftContainer) {
        const hResizer = document.createElement("div");
        hResizer.className = "horizontal-resizer";
        middleContainer.insertBefore(hResizer, leftContainer);

        let isHResizing = false;
        let startHX = 0;
        let startRightWidth = 0;

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
            let layoutChanged = false;
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove("is-resizing");
                document.body.style.cursor = "";
                layoutChanged = true;
            }
            if (isHResizing) {
                isHResizing = false;
                hResizer.classList.remove("is-h-resizing");
                document.body.style.cursor = "";
                layoutChanged = true;
            }
            if (layoutChanged) persistLayoutIfChanged();
        });
    } else {
        document.addEventListener("mouseup", () => {
            if (!isResizing) return;
            isResizing = false;
            resizer.classList.remove("is-resizing");
            document.body.style.cursor = "";
            persistLayoutIfChanged();
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

        document.querySelectorAll(".node_op_btn").forEach((el) => {
            el.style.display = modeVal === "NODE" ? "" : "none";
        });
        document.querySelectorAll(".select_op_btn").forEach((el) => {
            el.style.display = modeVal === "SELECT" ? "" : "none";
        });
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
        if (typeof mode === "string" && mode.length > 0) {
            updateToolModeUI(mode);
        }
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
