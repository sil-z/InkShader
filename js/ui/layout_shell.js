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
    dock.initialize(["canvas", "objects", "properties", "console"]);
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
    document.getElementById("btn_action_intersection")?.addEventListener("click", () => CanvasDispatcher.requestBooleanIntersection());
    document.getElementById("btn_action_difference")?.addEventListener("click", () => CanvasDispatcher.requestBooleanDifference());
    document.getElementById("btn_action_exclusion")?.addEventListener("click", () => CanvasDispatcher.requestBooleanExclusion());
    document.getElementById("btn_action_expand")?.addEventListener("click", () => CanvasDispatcher.requestExpandStroke());
    document.getElementById("btn_action_insert_node")?.addEventListener("click", () => CanvasDispatcher.requestInsertNode());
    document.getElementById("btn_action_delete_node")?.addEventListener("click", () => CanvasDispatcher.requestDeleteNode());
    document.getElementById("btn_action_join_node")?.addEventListener("click", () => CanvasDispatcher.requestJoinNode());
    document.getElementById("btn_action_break_node")?.addEventListener("click", () => CanvasDispatcher.requestBreakNode());
    document.getElementById("btn_action_add_segment")?.addEventListener("click", () => CanvasDispatcher.requestAddSegment());
    document.getElementById("btn_action_delete_segment")?.addEventListener("click", () => CanvasDispatcher.requestDeleteSegment());
    document.getElementById("btn_tool_select")?.addEventListener("click", () => dispatchToolMode("SELECT"));
    document.getElementById("btn_tool_node")?.addEventListener("click", () => dispatchToolMode("NODE"));
    document.getElementById("btn_tool_draw")?.addEventListener("click", () => dispatchToolMode("DRAW"));
    document.getElementById("btn_tool_measure")?.addEventListener("click", () => dispatchToolMode("MEASURE"));
    document.getElementById("btn_tool_ellipse")?.addEventListener("click", () => dispatchToolMode("ELLIPSE"));
    updateToolModeUI("DRAW");

    // ── Top menu bar ──
    const topMenuItems = document.querySelectorAll(".top .item");
    const btnFile = document.getElementById("menu_file");
    const btnFont = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.font");
    const btnPreferences = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.prefs");
    const btnHelp = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.help");

    if (!document.querySelector('dropdown-menu')) {
        document.body.appendChild(document.createElement('dropdown-menu'));
    }
    if (!document.querySelector('font-popup')) {
        document.body.appendChild(document.createElement('font-popup'));
    }

    // ── Close any open menu/popup and sync active classes ──
    function closeAnyOpenMenu() {
        const dd = document.querySelector('dropdown-menu');
        if (dd && dd._visible) dd.hide();
        const fp = document.querySelector('font-popup');
        if (fp && fp._visible) fp.hide();
        const pp = document.querySelector('preferences-popup');
        if (pp && pp._visible) pp.hide();
    }

    // ── File menu dropdown ──
    btnFile?.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.querySelector('dropdown-menu');
        if (!menu) return;

        // Toggle off if this item's menu is already showing
        if (btnFile.classList.contains('active')) {
            closeAnyOpenMenu();
            return;
        }

        closeAnyOpenMenu();

        const I18nManager = window.I18n || { t: (k) => k };

        // Build the fixed items first (before the async cache submenu)
        const makeItem = (i18nKey, disabled = false, action = null) => ({
            label: I18nManager.t(i18nKey),
            i18n: i18nKey,
            disabled: disabled,
            action: disabled ? null : action
        });

        const items = [
            makeItem('file.new_project', false, () => CanvasDispatcher.requestNewProject()),
            { separator: true },
            makeItem('file.load_json', false, () => CanvasDispatcher.requestLoad()),
            makeItem('file.load_ufo', true, null),
            makeItem('file.load_svg', true, null),
            { separator: true },
            {
                label: I18nManager.t('file.load_cache'),
                i18n: 'file.load_cache',
                children: []  // Will be populated async
            },
            { separator: true },
            makeItem('file.import_image', false, () => CanvasDispatcher.requestImport()),
            { separator: true },
            makeItem('file.save_json', false, () => CanvasDispatcher.requestSave()),
            makeItem('file.save_ufo', false, () => CanvasDispatcher.requestExport()),
            makeItem('file.save_svg', false, () => _triggerExportSVG())
        ];

        // Fetch cached projects async and populate the submenu
        const pm = window.__canvas?.projectManager;
        const cacheItem = items.find(i => i.i18n === 'file.load_cache');
        if (pm) {
            pm.listCachedProjects().then((projects) => {
                if (projects.length === 0) {
                    cacheItem.children = [{ label: I18nManager.t('file.no_cache'), i18n: 'file.no_cache', disabled: true }];
                } else {
                    cacheItem.children = projects.map(name => ({
                        label: name,
                        action: () => CanvasDispatcher.requestLoadFromCache(name)
                    }));
                }
                menu.show(btnFile, items);
            });
        } else {
            cacheItem.children = [{ label: I18nManager.t('file.no_cache'), i18n: 'file.no_cache', disabled: true }];
            menu.show(btnFile, items);
        }

        btnFile.classList.add('active');
    });

    // ── Edit menu dropdown ──
    const btnEdit = document.getElementById("menu_edit");
    btnEdit?.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.querySelector('dropdown-menu');
        if (!menu) return;

        // Toggle off if this item's menu is already showing
        if (btnEdit.classList.contains('active')) {
            closeAnyOpenMenu();
            return;
        }

        closeAnyOpenMenu();

        const c = window.__canvas;
        const I18nManager = window.I18n || { t: (k) => k };

        const makeItem = (i18nKey, shortcut = null, action = null) => ({
            label: I18nManager.t(i18nKey),
            i18n: i18nKey,
            shortcut,
            action
        });
        const makeToggle = (i18nKey, checked, action) => ({
            label: (checked ? '\u2713 ' : '   ') + I18nManager.t(i18nKey),
            action
        });

        const items = [
            makeItem('edit.copy', 'Ctrl+C', () => CanvasDispatcher.requestCopySelectedObjects()),
            makeItem('edit.paste', 'Ctrl+V', () => CanvasDispatcher.requestEditorAction('paste', c?.getInteractionSnapshot()?.activeGroupId ?? null)),
            makeItem('edit.duplicate', 'Ctrl+D', () => CanvasDispatcher.requestDuplicateSelectedObjects()),
            makeItem('edit.delete', 'Del', () => {
                const tool = c?.getActiveTool?.();
                if (tool === 'NODE') {
                    c?.commands?.deleteSelectedNodes();
                } else {
                    CanvasDispatcher.requestDeleteSelectedObjects();
                }
            }),
            { separator: true },
            makeToggle('edit.snap_alignment', c?.snap_alignment_enabled !== false, () => {
                if (c) c.snap_alignment_enabled = !c.snap_alignment_enabled;
                if (c) c.history?.saveCurrentViewState?.();
            }),
            makeToggle('edit.snap_coincident', c?.snap_coincident_enabled !== false, () => {
                if (c) c.snap_coincident_enabled = !c.snap_coincident_enabled;
                if (c) c.history?.saveCurrentViewState?.();
            }),
            { separator: true },
            makeToggle('edit.divider_visible', c?.divider_visible !== false, () => {
                if (c) c.divider_visible = !c.divider_visible;
                if (c) c.history?.saveCurrentViewState?.();
            })
        ];

        menu.show(btnEdit, items);
        btnEdit.classList.add('active');
    });

    // ── Font popup active class sync ──
    const fontPopup = document.querySelector('font-popup');
    if (fontPopup) {
        const origFontHide = fontPopup.hide.bind(fontPopup);
        fontPopup.hide = function() {
            btnFont?.classList.remove('active');
            return origFontHide();
        };
    }

    // ── Font popup ──
    btnFont?.addEventListener("click", (e) => {
        e.stopPropagation();
        const popup = document.querySelector('font-popup');
        if (!popup) return;

        // Toggle off if already open
        if (btnFont.classList.contains('active')) {
            closeAnyOpenMenu();
            return;
        }

        closeAnyOpenMenu();

        popup.setProjectManager(window.__canvas?.projectManager || null);
        popup.setCanvas(window.__canvas || null);
        popup.show(btnFont);
        btnFont.classList.add('active');
    });

    // ── Preferences popup active class sync ──
    const prefPopup = document.querySelector('preferences-popup');
    if (prefPopup) {
        const origPrefHide = prefPopup.hide.bind(prefPopup);
        prefPopup.hide = function() {
            btnPreferences?.classList.remove('active');
            return origPrefHide();
        };
    }

    // ── Preferences popup ──
    btnPreferences?.addEventListener("click", (e) => {
        e.stopPropagation();
        const popup = document.querySelector('preferences-popup');
        if (!popup) return;

        // Toggle off if already open
        if (btnPreferences.classList.contains('active')) {
            closeAnyOpenMenu();
            return;
        }

        closeAnyOpenMenu();

        popup.show(btnPreferences);
        btnPreferences.classList.add('active');
    });
    // ── Help menu dropdown ──
    btnHelp?.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.querySelector('dropdown-menu');
        if (!menu) return;

        // Toggle off if already showing
        if (btnHelp.classList.contains('active')) {
            closeAnyOpenMenu();
            return;
        }

        closeAnyOpenMenu();

        const I18nManager = window.I18n || { t: (k) => k };

        const items = [
            {
                label: I18nManager.t('help.about'),
                i18n: 'help.about',
                action: null  // No action yet
            },
            {
                label: I18nManager.t('help.documentation'),
                i18n: 'help.documentation',
                action: null  // No action yet
            }
        ];

        menu.show(btnHelp, items);
        btnHelp.classList.add('active');
    });

    // ── Sync active class on menu buttons when dropdown hides/closes ──
    const dropdown = document.querySelector('dropdown-menu');
    if (dropdown) {
        const origHide = dropdown.hide.bind(dropdown);
        dropdown.hide = function() {
            btnFile?.classList.remove('active');
            btnEdit?.classList.remove('active');
            btnHelp?.classList.remove('active');
            return origHide();
        };
    }

    // ── Hover-to-switch: when a menu is open, hovering another item auto-switches ──
    let _hoverTimer = null;
    const topBarItems = document.querySelectorAll('.top > .item');
    topBarItems.forEach(item => {
        if (item.id === 'brand_title') return;
        item.addEventListener('mouseenter', () => {
            // Only act when a menu is open
            const activeItem = document.querySelector('.top > .item.active');
            if (!activeItem || activeItem === item) return;

            clearTimeout(_hoverTimer);
            clearTimeout(_hoverTimer);
            closeAnyOpenMenu();
            item.click();
        });
        item.addEventListener('mouseleave', () => {
            clearTimeout(_hoverTimer);
        });
    });
    // Cancel hover timer when mouse leaves the entire menu bar
    const topBar = document.querySelector('.top');
    if (topBar) {
        topBar.addEventListener('mouseleave', () => {
            clearTimeout(_hoverTimer);
        });
    }
}

// ── Save current project on page close ──
window.addEventListener('beforeunload', () => {
    const pm = window.__canvas?.projectManager;
    if (pm && pm.activeProjectName) {
        pm.saveToCache(pm.activeProjectName);
    }
});

/**
 * Basic SVG export: creates an SVG string from the current canvas curves
 * and triggers a file download.
 */
function _triggerExportSVG() {
    const canvas = window.__canvas;
    if (!canvas) return;

    const c = canvas;
    const cm = c.curve_manager;
    if (!cm) return;

    const w = c.canvas_size_width || 1000;
    const h = c.canvas_size_height || 1000;

    let svgContent = '';
    // Iterate all curve items in the tree (dedup by curveId)
    const seenIds = new Set();
    const allCurves = [];
    for (const [id, item] of cm.treeItems.entries()) {
        if (item.type === 'curve' && item.curveId && !seenIds.has(item.curveId)) {
            seenIds.add(item.curveId);
            allCurves.push({ id: item.curveId });
        }
    }
    for (const { id } of allCurves) {
        const curve = cm.curves.find(crv => crv.id === id);
        if (!curve || !curve.startNode) continue;

        let d = '';
        let node = curve.startNode;
        let first = true;
        while (node) {
            const x = node.x;
            const y = h - node.y; // Flip Y for SVG
            if (first) {
                d += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
                first = false;
            } else {
                const c1x = node.control1 ? node.control1.x : null;
                const c1y = node.control1 ? h - node.control1.y : null;
                const c2x = node.control2 ? node.control2.x : null;
                const c2y = node.control2 ? h - node.control2.y : null;
                if (c1x !== null && c1y !== null && c2x !== null && c2y !== null) {
                    d += `C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`;
                } else {
                    d += `L ${x.toFixed(2)} ${y.toFixed(2)}`;
                }
            }
            if (node === curve.endNode) {
                if (curve.closed && d.length > 0) d += ' Z';
                break;
            }
            node = node.nextOnCurve;
        }
        if (d) {
            const fill = curve.closed ? ' fill="black"' : '';
            svgContent += `  <path d="${d}" stroke="black" stroke-width="${curve.stroke_width || 1}"${fill} />\n`;
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${svgContent}</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    a.download = `InkShader_export_${dateStr}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
