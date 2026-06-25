import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { DockLayout } from "./dock_layout.js";
import "./node_property_popup.js";
import "./path_property_popup.js";
import "./bounding_box_popup.js";
import "./group_settings_popup.js";
import "./pen_tool_popup.js";
import "./ellipse_tool_popup.js";
import "./dropdown_menu.js";
import "./font_popup.js";

export function initializeLayoutShell() {
    const dockContainer = document.querySelector(".dock-container");
    const objectTree = document.querySelector("object-tree");
    const propertyPanel = document.querySelector(".property_panel");
    const loggerPanel = document.querySelector("logger-panel");
    if (!dockContainer || !objectTree || !propertyPanel) return;

    const dock = new DockLayout(dockContainer);
    dock.initialize(["canvas", "objects", "properties", "terminal"]);
    window.__dock = dock;

    if (!document.querySelector('node-property-popup')) {
        document.body.appendChild(document.createElement('node-property-popup'));
    }
    if (!document.querySelector('path-property-popup')) {
        document.body.appendChild(document.createElement('path-property-popup'));
    }
    if (!document.querySelector('pen-tool-popup')) {
        document.body.appendChild(document.createElement('pen-tool-popup'));
    }
    const penBtn = document.querySelector('#btn_tool_draw');
    if (penBtn) {
        penBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const popup = document.querySelector('pen-tool-popup');
            if (popup) {
                popup.show(penBtn);
            }
        });
    }
    if (!document.querySelector('ellipse-tool-popup')) {
        document.body.appendChild(document.createElement('ellipse-tool-popup'));
    }
    const ellipseBtn = document.querySelector('#btn_tool_ellipse');
    if (ellipseBtn) {
        ellipseBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const popup = document.querySelector('ellipse-tool-popup');
            if (popup) {
                popup.show(ellipseBtn);
            }
        });
    }
    if (!document.querySelector('bounding-box-popup')) {
        document.body.appendChild(document.createElement('bounding-box-popup'));
    }
    if (!document.querySelector('group-settings-popup')) {
        document.body.appendChild(document.createElement('group-settings-popup'));
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
    document.getElementById("btn_tool_ellipse")?.addEventListener("click", () => dispatchToolMode("ELLIPSE"));
    updateToolModeUI("DRAW");
    const topMenuItems = document.querySelectorAll(".top .item");
    const btnLoad = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.load");
    const btnNew = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.new");
    const btnSave = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.save");
    const btnExport = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.export");
    const btnFont = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.font");
    const btnPreferences = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.prefs");
    const btnHelp = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.help");
    const btnImport = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.import");

    if (!document.querySelector('dropdown-menu')) {
        document.body.appendChild(document.createElement('dropdown-menu'));
    }
    if (!document.querySelector('font-popup')) {
        document.body.appendChild(document.createElement('font-popup'));
    }

    btnLoad?.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.querySelector('dropdown-menu');
        if (!menu) return;
        if (menu._visible) { menu.hide(); return; }

        const items = [
            {
                label: 'Load from File', i18n: 'dropdown.load_file',
                action: () => CanvasDispatcher.requestLoad()
            },
            { separator: true },
            {
                label: 'Load from Cache', i18n: 'dropdown.load_cache',
                children: []
            }
        ];

        const pm = window.__canvas?.projectManager;
        if (pm) {
            pm.listCachedProjects().then((projects) => {
                const cacheItem = items.find(i => i.i18n === 'dropdown.load_cache');
                if (projects.length === 0) {
                    cacheItem.children = [{ label: 'No cached projects', i18n: 'dropdown.no_projects', disabled: true }];
                } else {
                    cacheItem.children = projects.map(name => ({
                        label: name,
                        action: () => CanvasDispatcher.requestLoadFromCache(name)
                    }));
                }
                menu.show(btnLoad, items);
            });
        } else {
            items[2].children = [{ label: 'No cached projects', i18n: 'dropdown.no_projects', disabled: true }];
            menu.show(btnLoad, items);
        }
    });

    btnNew?.addEventListener("click", () => CanvasDispatcher.requestNewProject());
    btnSave?.addEventListener("click", () => CanvasDispatcher.requestSave());
    btnExport?.addEventListener("click", () => CanvasDispatcher.requestExport());
    btnImport?.addEventListener("click", () => CanvasDispatcher.requestImport());

    btnFont?.addEventListener("click", (e) => {
        e.stopPropagation();
        const popup = document.querySelector('font-popup');
        if (popup) {
            popup.setProjectManager(window.__canvas?.projectManager || null);
            popup.setCanvas(window.__canvas || null);
            popup.show(btnFont);
        }
    });

    const prefModal = document.getElementById("app_preferences_modal");
    btnPreferences?.addEventListener("click", () => {
        if (prefModal) prefModal.open();
    });
    const helpModal = document.getElementById("app_help_modal");
    btnHelp?.addEventListener("click", () => {
        if (helpModal) helpModal.open();
    });
}
