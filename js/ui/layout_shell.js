import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { isDesktop, openExternalUrl } from "../app/app_mode.js";
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
import "./expand_stroke_popup.js";
import "./kern_popup.js";
import "./glyph_popup.js";

/** The project page the Help menu points at. */
const PROJECT_URL = "https://github.com/sil-z/InkShader";

export function initializeLayoutShell() {
    const dockContainer = document.querySelector(".dock-container");
    const objectTree = document.querySelector("object-tree");
    const propertyPanel = document.querySelector(".property_panel");
    const loggerPanel = document.querySelector("logger-panel");
    if (!dockContainer || !objectTree || !propertyPanel) return;

    // Font/Kerning/Glyphs are dock panels now (hidden by default). They MUST
    // exist on the page BEFORE DockLayout.initialize() runs — initialize
    // captures their elements into _componentRefs, and the Edit menu's
    // show/hide moves those exact elements between the dock and the hidden set.
    if (!document.querySelector('font-popup')) {
        document.body.appendChild(document.createElement('font-popup'));
    }
    if (!document.querySelector('kern-popup')) {
        document.body.appendChild(document.createElement('kern-popup'));
    }
    if (!document.querySelector('glyph-popup')) {
        document.body.appendChild(document.createElement('glyph-popup'));
    }

    const dock = new DockLayout(dockContainer);
    dock.initialize(["canvas", "objects", "properties", "console", "sample", "font", "kerning", "glyphs"]);
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
    if (!document.querySelector('expand-stroke-popup')) {
        document.body.appendChild(document.createElement('expand-stroke-popup'));
    }
    // Right-click context menu for expand stroke is temporarily disabled.
    // const expandBtn = document.querySelector('#btn_action_expand');
    // if (expandBtn) {
    //     expandBtn.addEventListener('contextmenu', (e) => {
    //         e.preventDefault();
    //         const popup = document.querySelector('expand-stroke-popup');
    //         if (popup) {
    //             popup.show(expandBtn);
    //         }
    //     });
    // }
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
    document.getElementById("btn_action_import_image")?.addEventListener("click", () => CanvasDispatcher.requestImport());
    updateToolModeUI("DRAW");

    // ── Top menu bar ──
    const topMenuItems = document.querySelectorAll(".top .item");
    const btnFile = document.getElementById("menu_file");
    const btnPreferences = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.prefs");
    const btnHelp = Array.from(topMenuItems).find((el) => el.getAttribute("data-i18n") === "menu.help");

    if (!document.querySelector('dropdown-menu')) {
        document.body.appendChild(document.createElement('dropdown-menu'));
    }

    // ── Close any open menu/popup and sync active classes ──
    function closeAnyOpenMenu() {
        const dd = document.querySelector('dropdown-menu');
        if (dd && dd._visible) dd.hide();
        const pp = document.querySelector('preferences-popup');
        if (pp && pp._visible) pp.hide();
    }

    // ── File menu dropdown ──
    btnFile?.addEventListener("click", async (e) => {
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
        // 后端可用性（fonttools 功能）：纯前端模式下置灰
        const backendOk = await (window.__canvas?.io?.backendAvailable?.() ?? Promise.resolve(false));

        // Shortcut labels mirror the global keydown shortcuts in
        // canvas_input_controller.js (keep in sync with the header comment).
        const FILE_SHORTCUTS = {
            'file.new_project': 'Ctrl+N',
            'file.load_json': 'Ctrl+O',
            'file.save': 'Ctrl+S',
            'file.save_json': 'Ctrl+Shift+J',
            'file.save_ufo': 'Ctrl+Shift+E',
            'file.save_svg': 'Ctrl+Shift+S'
        };
        const makeItem = (i18nKey, disabled = false, action = null) => ({
            label: I18nManager.t(i18nKey),
            i18n: i18nKey,
            shortcut: FILE_SHORTCUTS[i18nKey] || null,
            disabled: disabled,
            action: disabled ? null : action
        });
        // 「新建/加载」组
        const loadGroup = () => [
            makeItem('file.new_project', false, () => CanvasDispatcher.requestNewProject()),
            { separator: true },
            makeItem('file.load_json', false, () => CanvasDispatcher.requestLoad()),
            makeItem('file.load_ufo', false, () => _triggerImportUFO()),
            makeItem('file.load_svg', false, () => _triggerImportSVG())
        ];
        // 「保存」组：Save(Ctrl+S) -> 直接保存 / 转 save as json；Save as JSON 快捷键已改为 Ctrl+Shift+J
        const saveGroup = () => [
            makeItem('file.save', false, () => CanvasDispatcher.requestSave()),
            makeItem('file.save_json', false, () => CanvasDispatcher.requestSaveAs()),
            makeItem('file.save_ufo', false, () => CanvasDispatcher.requestExport()),
            makeItem('file.save_svg', false, () => _triggerExportSVG()),
            { separator: true },
            // fonttools 导出（以 UFO 为输入，需要本地后端）：纯前端模式置灰
            makeItem('file.export_otf', !backendOk, () => _triggerExportFont('otf')),
            makeItem('file.export_ttf', !backendOk, () => _triggerExportFont('ttf'))
        ];

        // 桌面模式：禁用「从浏览器缓存加载」菜单项（及其相关逻辑一起消失）
        if (isDesktop()) {
            menu.show(btnFile, [
                ...loadGroup(),
                { separator: true },
                ...saveGroup()
            ]);
            btnFile.classList.add('active');
            return;
        }

        const items = [
            ...loadGroup(),
            { separator: true },
            {
                label: I18nManager.t('file.load_cache'),
                i18n: 'file.load_cache',
                children: []  // Will be populated async
            },
            { separator: true },
            ...saveGroup()
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
    btnEdit?.addEventListener("click", async (e) => {
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
        // 后端可用性（fonttools 功能）：纯前端模式下置灰
        const backendOk = await (window.__canvas?.io?.backendAvailable?.() ?? Promise.resolve(false));

        const makeItem = (i18nKey, shortcut = null, action = null, disabled = false) => ({
            label: I18nManager.t(i18nKey),
            i18n: i18nKey,
            shortcut,
            action: disabled ? null : action,
            disabled
        });
        const makeToggle = (i18nKey, checked, action) => ({
            label: (checked ? '\u2713 ' : '   ') + I18nManager.t(i18nKey),
            action
        });

        const items = [
            makeItem('edit.copy', 'Ctrl+C', () => CanvasDispatcher.requestCopySelectedObjects()),
            makeItem('edit.paste', 'Ctrl+V', () => CanvasDispatcher.requestEditorAction('paste', c?.getInteractionSnapshot()?.activeGroupId ?? null)),
            makeItem('edit.duplicate', 'Ctrl+D', () => CanvasDispatcher.requestDuplicateSelectedObjects()),
            makeItem('edit.delete', 'Del', () => CanvasDispatcher.requestDeleteSelectedObjects()),
            { separator: true },
            makeItem('edit.add_extrema', null, () => CanvasDispatcher.requestAddExtrema()),
            makeItem('edit.simplify_path', null, () => CanvasDispatcher.requestSimplifyPath()),
            makeItem('edit.optimize_path', null, () => CanvasDispatcher.requestOptimizePath()),
            makeItem('edit.round_nodes', null, () => CanvasDispatcher.requestRoundNodes()),
            makeItem('edit.smooth_curves', null, () => CanvasDispatcher.requestSmoothCurves()),
            // correct direction 与 remove overlap 均已集成到导出流程（导出前自动校正+去重叠），
            // 编辑期布尔/去重叠统一由工具栏 Union（Ctrl+U）承担，不再作为手动菜单项
            { separator: true },
            makeToggle('edit.snap_alignment', c?.snap_alignment_enabled !== false, () => {
                if (c) c.snap_alignment_enabled = !c.snap_alignment_enabled;
                if (c) c.history?.saveCurrentViewState?.();
            }),
            makeToggle('edit.snap_coincident', c?.snap_coincident_enabled !== false, () => {
                if (c) c.snap_coincident_enabled = !c.snap_coincident_enabled;
                if (c) c.history?.saveCurrentViewState?.();
            }),
            // Object-drag node snapping: while dragging whole objects, their nodes
            // snap to other nodes (coincident) and to their X/Y alignment lines,
            // using the two modes above. Ctrl during the drag disables it.
            makeToggle('edit.snap_nodes', c?.snap_nodes_enabled !== false, () => {
                if (c) c.snap_nodes_enabled = !c.snap_nodes_enabled;
                if (c) c.history?.saveCurrentViewState?.();
            }),
            { separator: true },
            {
                label: I18nManager.t('edit.guides'),
                i18n: 'edit.guides',
                children: [
                    { label: I18nManager.t('edit.guides.section_divider'), disabled: true },
                    makeToggle('edit.guides.lock_divider', c?.divider_locked !== false, () => {
                        if (c) c.divider_locked = !c.divider_locked;
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.divider', c?.divider_visible !== false, () => {
                        if (c) c.divider_visible = !c.divider_visible;
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    { separator: true },
                    { label: I18nManager.t('edit.guides.section_metric'), disabled: true },
                    makeToggle('edit.guides.lock_metric', c?.metric_guidelines?.locked === true, () => {
                        if (c) c.metric_guidelines.locked = !c.metric_guidelines.locked;
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.ascender', c?.metric_guidelines?.items?.ascender?.visible !== false, () => {
                        if (c) { c.metric_guidelines.items.ascender.visible = !c.metric_guidelines.items.ascender.visible; }
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.descender', c?.metric_guidelines?.items?.descender?.visible !== false, () => {
                        if (c) { c.metric_guidelines.items.descender.visible = !c.metric_guidelines.items.descender.visible; }
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.x_height', c?.metric_guidelines?.items?.x_height?.visible !== false, () => {
                        if (c) { c.metric_guidelines.items.x_height.visible = !c.metric_guidelines.items.x_height.visible; }
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.cap_height', c?.metric_guidelines?.items?.cap_height?.visible !== false, () => {
                        if (c) { c.metric_guidelines.items.cap_height.visible = !c.metric_guidelines.items.cap_height.visible; }
                        if (c) c.history?.saveCurrentViewState?.();
                    }),
                    makeToggle('edit.guides.baseline', c?.metric_guidelines?.items?.baseline?.visible !== false, () => {
                        if (c) { c.metric_guidelines.items.baseline.visible = !c.metric_guidelines.items.baseline.visible; }
                        if (c) c.history?.saveCurrentViewState?.();
                    })
                ]
            },
            { separator: true },
            {
                label: I18nManager.t('edit.coord_transform'),
                i18n: 'edit.coord_transform',
                children: [
                    { label: I18nManager.t('edit.coord_transform.section'), disabled: true },
                    {
                        label: ((c?.coordTransformMode || 'global') === 'global' ? '\u2713 ' : '   ') + I18nManager.t('edit.coord_transform.global'),
                        action: () => {
                            if (c) c.coordTransformMode = 'global';
                            if (c) c.is_dirty = true;
                            if (c) c.notifyPropertiesUpdate?.();
                            if (c) c.history?.saveCurrentViewState?.();
                        }
                    },
                    {
                        label: (c?.coordTransformMode === 'active-group' ? '\u2713 ' : '   ') + I18nManager.t('edit.coord_transform.active_group'),
                        action: () => {
                            if (c) c.coordTransformMode = 'active-group';
                            if (c) c.is_dirty = true;
                            if (c) c.notifyPropertiesUpdate?.();
                            if (c) c.history?.saveCurrentViewState?.();
                        }
                    },
                    {
                        label: (c?.coordTransformMode === 'per-glyph' ? '\u2713 ' : '   ') + I18nManager.t('edit.coord_transform.per_glyph'),
                        action: () => {
                            if (c) c.coordTransformMode = 'per-glyph';
                            if (c) c.is_dirty = true;
                            if (c) c.notifyPropertiesUpdate?.();
                            if (c) c.history?.saveCurrentViewState?.();
                        }
                    }
                ]
            }
        ];

        menu.show(btnEdit, items);
        btnEdit.classList.add('active');
    });

    // Font/Kerning/Glyphs are dock panels now — shown/hidden via the Layout menu.
    // The popup components resolve the canvas lazily via document.querySelector, so no
    // setCanvas/setProjectManager wiring is needed here anymore.

    // ── Layout menu dropdown ──
    const btnLayout = document.getElementById("menu_layout");
    if (btnLayout) {
        // Wrap dropdown.hide() so the 'active' class is cleared when the menu closes
        // (either by item click or outside click). The dropdown-menu element doesn't
        // know about top-bar buttons, so we monkey-patch hide once per show cycle.
        let _layoutMenuPatched = false;
        const _origLayoutHide = null; // not needed — we patch per-show

        btnLayout.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.querySelector('dropdown-menu');
            if (!menu) return;

            if (btnLayout.classList.contains('active')) {
                closeAnyOpenMenu();
                return;
            }

            closeAnyOpenMenu();

            // Patch hide once so it also clears our button's active class
            if (!_layoutMenuPatched) {
                const origHide = menu.hide.bind(menu);
                menu.hide = function() {
                    btnLayout.classList.remove('active');
                    return origHide();
                };
                _layoutMenuPatched = true;
            }

            const I18nManager = window.I18n || { t: (k) => k };

            const makePanelToggle = (i18nKey, panelId) => {
                const d = window.__dock;
                const visible = d ? !d.isPanelHidden(panelId) : true;
                return {
                    label: (visible ? '\u2713 ' : '   ') + I18nManager.t(i18nKey),
                    action: () => {
                        const dock = window.__dock;
                        if (!dock) return;
                        if (dock.isPanelHidden(panelId)) dock.showPanel(panelId);
                        else dock.hidePanel(panelId);
                    }
                };
            };

            const items = [
                makePanelToggle('panel.canvas', 'canvas'),
                makePanelToggle('panel.objects', 'objects'),
                makePanelToggle('panel.properties', 'properties'),
                // Console is temporarily withdrawn from the layout menu. The panel and
                // its dock tab still work and `panel.console` is still its label; only
                // this toggle that reveals it is gone.
                makePanelToggle('panel.sample', 'sample'),
                makePanelToggle('panel.font', 'font'),
                makePanelToggle('panel.kerning', 'kerning'),
                makePanelToggle('panel.glyphs', 'glyphs'),
            ];

            menu.show(btnLayout, items);
            btnLayout.classList.add('active');
        });
    }

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

        // Help is a single link out to the project page; the in-app shortcut list
        // (help-modal) is kept in the tree but has no menu entry for now.
        const items = [
            {
                label: I18nManager.t('help.documentation'),
                i18n: 'help.documentation',
                action: () => openExternalUrl(PROJECT_URL)
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

// ── Save current project on page close（桌面模式无浏览器缓存，不保存）──
window.addEventListener('beforeunload', () => {
    if (isDesktop()) return;
    const c = window.__canvas;
    // 1. 强制提交进行中的手势（等价于用户松手）。live-reload / 插件刷新常在编辑中途触发：
    //    拖拽节点、绘制路径等手势中的改动只存在于实时数据，尚未写入 history，
    //    而自动保存（_saveRuntimeState）用的是上次提交的 currentStateObj ——
    //    不先提交的话，unload 保存的是旧状态，最后一步操作必丢。
    //    复用 handleWindowMouseMove 已有的“buttons=0 时自动提交”恢复路径：
    //    直接派发一次 window mouseup，让所有 window 级 mouseup 监听（含引导线/分割线）生效。
    if (c) {
        try {
            if (c.current_state && c.current_state !== 'IDLE') {
                window.dispatchEvent(new MouseEvent('mouseup', {
                    button: 0,
                    buttons: 0,
                    clientX: c.last_mouse_pos_x ?? 0,
                    clientY: c.last_mouse_pos_y ?? 0,
                    bubbles: true,
                    cancelable: true
                }));
            }
            // DRAW 画到一半的路径：mouseup 只收起手柄、不会结束路径 —— 强制完成（同右键行为），
            // 否则未完成路径不会进入 history/序列化，刷新即丢。
            if (c.current_curve && c.current_curve.startNode && c.commands?.finishAddingPathCommand) {
                if (c.drawToolSettings?.closed) c.current_curve.closed = true;
                c.commands.finishAddingPathCommand();
            }
        } catch (e) {
            console.error("[beforeunload] force-commit gesture failed:", e);
        }
    }
    // 2. 快速落盘：用 fast 直写（单次微任务即派发 IndexedDB put）。页面在 beforeunload
    //    返回后立即销毁，普通 saveProject 的 get→put→排序链走不完、put 根本不会发出；
    //    saveToCache 同理，故不再调用（fast 直写已覆盖同一缓存键）。
    if (c?.history && typeof c.history._flushRuntimeStateSave === "function") {
        try {
            c.history._flushRuntimeStateSave(true);
        } catch (e) {
            console.error("[beforeunload] fast flush failed:", e);
        }
    }
});

/**
 * SVG export: delegates to CanvasIOService.exportToSVG() which generates
 * a proper SVG with font layer (FontForge-compatible) + visual path layers.
 */
function _triggerExportSVG() {
    const canvas = window.__canvas;
    if (!canvas) return;
    canvas.io.exportToSVG();
}

/**
 * OTF / TTF 导出：fonttools 后端（ufo2ft 编译，以 UFO 为输入）。
 */
function _triggerExportFont(fmt) {
    const canvas = window.__canvas;
    if (!canvas) return;
    canvas.io.exportBinaryFont(fmt);
}


/**
 * UFO import: delegates to CanvasIOService.triggerImportUFO().
 */
function _triggerImportUFO() {
    const canvas = window.__canvas;
    if (!canvas) return;
    canvas.io.triggerImportUFO();
}

/**
 * SVG import: auto-detects between font import (has <defs><font>) and
 * image import (visual path layers), delegates accordingly.
 */
function _triggerImportSVG() {
    const canvas = window.__canvas;
    if (!canvas) return;
    canvas.io.triggerImportSVGAuto();
}
