// js/services/i18n.js
//
// UI text lookup. Two locales ship: `en` (default) and `zh`. Each table is the
// single source of truth for every user-visible string in that language, and the
// markup carries the English text inline as a per-element fallback.
//
// Three rules keep the tables in sync:
//   1. Lookups never invent text. `t(key, fallback)` prefers the table, then the
//      caller's fallback, then the key; translateDOM passes the markup's own text
//      as that fallback, so an unknown key leaves the inline English alone instead
//      of writing the raw key into the DOM.
//   2. A string is defined once. Markup uses data-i18n / data-i18n-tip /
//      data-i18n-placeholder; JS uses t(). No component writes a label literal.
//
//      `test/check_i18n.mjs` enforces this in both directions and also asserts
//      that every locale defines exactly the same key set.
//   3. Text that is language-neutral stays out of the tables: shortcut tokens
//      (Ctrl+Z), axis labels (X / Y / in / out), unit names (UPM), file-format
//      names (OTF, TTF, JSON, UFO) and the command ids in the console panel's
//      raw fallback read the same in every locale.
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";

/** Persisted preference key; holds a locale id from `translations`. */
const LANG_STORAGE_KEY = "InkShader_lang";
/** Locale ids `setLang` accepts, in menu order. */
export const SUPPORTED_LANGS = ["en", "zh"];
/** BCP-47 tags written to <html lang> so the OS picks the right text stack. */
const HTML_LANG = { en: "en", zh: "zh-CN" };

export const translations = {
    en: {
        "app.title": "InkShader: Free Font Editor",
        "menu.file": "File", "menu.edit": "Edit", "menu.layout": "Layout", "menu.prefs": "Preferences", "menu.help": "Help",
        "panel.canvas": "Canvas", "panel.objects": "Objects", "panel.properties": "Properties",
        "panel.console": "Console", "panel.sample": "Sample Text",
        "panel.font": "Font", "panel.kerning": "Kerning", "panel.glyphs": "Glyphs",
        "file.new_project": "New Project",
        "file.load_json": "Open Project (JSON)",
        "file.load_ufo": "Open Project (UFO)",
        "file.load_svg": "Open Project (SVG)",
        "file.load_cache": "Open from Browser Cache",
        "file.import_image": "Import an image into the canvas",
        "file.save": "Save",
        "file.save_json": "Save as JSON Project",
        "file.save_ufo": "Save as UFO Project",
        "file.save_svg": "Save as SVG File",
        "file.export_otf": "Export as OTF",
        "file.export_ttf": "Export as TTF",
        "file.no_cache": "No cached projects",
        "edit.copy": "Copy",
        "edit.paste": "Paste",
        "edit.duplicate": "Duplicate",
        "edit.delete": "Delete",
        "edit.add_extrema": "Add Extrema",
        "edit.simplify_path": "Simplify Path",
        "edit.optimize_path": "Optimize Path",
        "edit.round_nodes": "Round Coordinates",
        "edit.smooth_curves": "Smooth Paths",
        "edit.snap_alignment": "Snap to Alignment",
        "edit.snap_coincident": "Snap to Coincident",
        "edit.snap_nodes": "Snap Nodes while Dragging Objects",
        "edit.guides": "Guides",
        "edit.guides.divider": "Divider Guides",
        "edit.guides.ascender": "Ascender",
        "edit.guides.descender": "Descender",
        "edit.guides.x_height": "x-Height",
        "edit.guides.cap_height": "Cap Height",
        "edit.guides.baseline": "Baseline",
        "edit.guides.lock_divider": "Lock Dividers",
        "edit.guides.lock_metric": "Lock Metric Guides",
        "edit.guides.section_divider": "Dividers",
        "edit.guides.section_metric": "Metric Guides",
        "edit.coord_transform": "Coordinate Transform",
        "edit.coord_transform.section": "Coordinate Origin",
        "edit.coord_transform.global": "Global (fixed zero)",
        "edit.coord_transform.active_group": "Active Glyph (zero at left divider)",
        "edit.coord_transform.per_glyph": "Per Glyph (zero resets each glyph)",
        "font.project_name": "Project Name",
        "tool.select": "Select and transform objects (1)", "tool.node": "Edit paths by nodes (2)", "tool.draw": "Draw Bezier paths (3)", "tool.ellipse": "Create ellipses (4)", "tool.measure": "Measure objects (5)",
        "mode.corner": "Make selected nodes corner (C)", "mode.smooth": "Make selected nodes smooth (S)", "mode.symmetric": "Make selected nodes symmetric (Y)",
        // Boolean operations and stroke expansion appear as toolbar tooltips only: they
        // have no menu entries, so the tooltip is the one place their shortcut surfaces.
        "action.union": "Create union of selected paths (Ctrl+U)",
        "action.intersection": "Create intersection of selected paths (Ctrl+Shift+U)",
        "action.difference": "Create difference of selected paths (bottom minus top) (Ctrl+Alt+U)",
        "action.exclusion": "Create exclusive or of selected paths (Ctrl+Alt+Shift+U)",
        "action.expand": "Convert strokes into filled paths (Ctrl+Shift+X)",
        "action.insert_node": "Insert new nodes into selected segments (I)", "action.delete_node": "Delete selected nodes (D)",
        "action.join_node": "Join selected end nodes", "action.break_node": "Break path at selected nodes",
        "action.add_segment": "Add segment between selected end nodes", "action.delete_segment": "Delete segment between selected nodes",
        
        "pref.theme": "Color Theme", "pref.theme.light": "Light", "pref.theme.dark": "Dark",
        "pref.accentHue": "Accent", "pref.language": "Language",
        "pref.reset": "Reset to Theme Default",
        "accent.blue": "Blue", "accent.red": "Red", "accent.orange": "Orange", "accent.green": "Green",
        "accent.teal": "Teal", "accent.purple": "Purple", "accent.pink": "Pink",
        
        "help.title": "Help & Shortcuts", "help.close": "Close", "help.shortcuts": "Keyboard Shortcuts",
        "help.s.tools": "1-5 : Select / Node / Draw / Ellipse / Measure",
        "help.s.undo": "Ctrl+Z : Undo",
        "help.s.redo": "Ctrl+Y / Ctrl+Shift+Z : Redo",
        "help.s.copy": "Ctrl+C / Ctrl+V : Copy / Paste",
        "help.s.duplicate": "Ctrl+D : Duplicate",
        "help.s.del": "Del / Backspace : Delete Objects",
        "help.s.union": "Ctrl+U : Union",
        "help.s.intersection": "Ctrl+Shift+U : Intersection",
        "help.s.difference": "Ctrl+Alt+U : Difference (bottom minus top)",
        "help.s.exclusion": "Ctrl+Alt+Shift+U : Exclusion",
        "help.s.expand": "Ctrl+Shift+X : Expand Stroke",
        "help.s.node_modes": "C / S / Y (Node tool) : Corner / Smooth / Symmetric",
        "help.s.node_ops": "I / D (Node tool) : Insert Node / Delete Nodes",
        "help.s.new": "Ctrl+N : New Project",
        "help.s.open": "Ctrl+O : Open Project",
        "help.s.save": "Ctrl+S : Save Project",
        "help.s.save_as": "Ctrl+Shift+J : Save as JSON Project",
        "help.s.export_ufo": "Ctrl+Shift+E : Save as UFO Project",
        "help.s.export_svg": "Ctrl+Shift+S : Save as SVG File",
        "help.s.pan": "Space+Drag / Middle-Click : Pan Canvas",
        "help.s.pan_arrow": "Ctrl+Arrow : Pan",
        "help.s.zoom": "Ctrl+Wheel / Ctrl+= / Ctrl+- : Zoom",
        "help.s.zoom_fixed": "Alt+Wheel : Zoom at Fixed Center",
        "help.s.rotate_drag": "Alt+Drag : Rotate Canvas View",
        "help.s.rotate_step": "Alt+Left / Alt+Right : Rotate 5°",
        "help.s.rotate_reset": "Alt+0 : Reset Rotation",
        "help.s.fullscreen": "F11 : Toggle Fullscreen",
        "help.s.esc": "Esc : Cancel / Deselect",
        // Not a shortcut: a caveat about the rotated view, shown as a note under the table.
        "help.notes.rotation": "With the canvas rotated, only the sheet turns: the rulers, the sequence bar and the tool strip stay upright, so ruler ticks no longer sit under the document position they name.",
        "help.documentation": "Documentation",
        
        "tree.title": "Objects",
        "tree.lock": "Lock", "tree.unlock": "Unlock", "tree.show": "Show", "tree.hide": "Hide",
        "seq.placeholder": "Type characters here...", "seq.add_tip": "Add Glyph", "seq.edit_tip": "Click to edit text, press Enter to finish",
        "seq.empty": "Click to type...", "seq.no_obj": "No created objects yet", "seq.add_glyphs": "Click to add glyphs",
        
        "canvas.mouse_pos": "Mouse Pos",

        "prop.title": "Properties",
        "prop.pos": "Pos", "prop.size": "Size", "prop.in": "In", "prop.out": "Out", "prop.angle": "Angle",
        "prop.nodes_selected": "nodes selected", "prop.node_props": "Node Properties",
        "prop.bbox": "Bounding Box", "prop.multiple_paths": "Multiple Paths", "prop.path_props": "Path Properties", "prop.weight": "Width", "prop.closed": "Closed", "prop.smart": "Live Stroke", "prop.skel": "Skeleton", "prop.name": "Name",
        "prop.path_direction": "Path Direction", "prop.smart_expand_direction": "Stroke Direction",
        "prop.toggle_path_direction": "Toggle path direction", "prop.toggle_smart_expand_direction": "Toggle stroke direction",
        "prop.dir_cw": "Clockwise", "prop.dir_ccw": "Counter-clockwise", "prop.dir_open": "Open",
        "prop.pen_settings": "Pen Tool Settings", "prop.ellipse_settings": "Ellipse Tool Settings",
        "prop.expand_stroke": "Expand Stroke", "prop.expand_round_cap": "Round Cap", "prop.ref_properties": "Reference Properties", "prop.advance": "Advance Width", "prop.char": "Char", "prop.mixed": "Mixed",
        "prop.lsb": "LSB", "prop.rsb": "RSB", "prop.kern_left": "Left Kern", "prop.kern_right": "Right Kern", "prop.glyph_settings": "Glyph Settings", "prop.position": "Position", "prop.scale": "Scale", "prop.rotation": "Rotation", "prop.shear": "Shear",

        "tree.menu.delete": "Delete", "tree.menu.copy": "Copy", "tree.menu.copy_ref": "Copy Reference", "tree.menu.paste": "Paste", "tree.menu.duplicate": "Duplicate", "tree.menu.unlink": "Unlink Reference", "tree.menu.go_source": "Go to Reference Source",
        "tree.menu.paste_group": "Paste ({n} Group Ref)", "tree.menu.paste_curve": "Paste ({n} Curve)",

        // One key per --cvs-* custom property in css/style.css. Only the two listed in
        // preferences_modal.js CONFIGURABLE_COLORS are exposed today; the rest name the
        // remaining variables so a future palette panel has nothing to invent.
        "color.path_stroke": "Path Stroke", "color.path_fill": "Path Fill", "color.preview": "Preview Path", "color.hover_stroke": "Hovered Path", "color.oncurve_stroke": "Node Stroke", "color.oncurve_fill": "Node Fill", "color.selected_stroke": "Selected Node Stroke", "color.selected_fill": "Selected Node Fill", "color.ctrl_stroke": "Handle Line", "color.ctrl_fill": "Handle Point", "color.ctrl_ahead": "Handle Ahead", "color.ctrl_back": "Handle Back", "color.guideline": "Guideline Color", "color.measure": "Measure Tool Color", "color.select_box": "Select Box Color", "color.body_bg": "Canvas Background",

        "font.family": "Family Name", "font.style": "Style Name",
        "font.postscript_name": "PostScript Name", "font.preferred_family": "Preferred Family", "font.preferred_subfamily": "Preferred Subfamily",
        "font.style_map_family": "Style Map Family",
        "font.copyright": "Copyright", "font.designer": "Designer", "font.designer_url": "Designer URL",
        "font.manufacturer": "Manufacturer", "font.manufacturer_url": "Manufacturer URL",
        "font.license": "License", "font.license_url": "License URL",
        "font.trademark": "Trademark", "font.description": "Description", "font.sample_text": "Sample Text",
        "font.upm": "Units Per Em (UPM)", "font.weight_class": "Weight Class", "font.width_class": "Width Class",
        "font.ascender": "Ascender", "font.descender": "Descender", 
        "font.x_height": "x-Height", "font.cap_height": "Cap Height",
        "font.italic_angle": "Italic Angle",
        "font.version": "Version",

        "kern.add": "Add", "kern.no_pairs": "No kerning pairs defined.",
        "kern.pick_left": "-- Left --", "kern.pick_right": "-- Right --",
        "kern.left_glyph": "Left glyph", "kern.right_glyph": "Right glyph",
        "kern.value_tip": "Kerning value (UPM)", "kern.remove_tip": "Remove",
        "sample.title": "Sample Text", "sample.kerning": "Kerning", "sample.guides": "Metric Guides",
        "sample.fontSize": "Size",
        "sample.placeholder": "Type sample text, \\name\\ for non-character glyphs, Enter for new line",

        "seq.menu.name": "Name", "seq.menu.name_tip": "Glyph name", "seq.menu.group_name_tip": "Group name",
        "seq.menu.code": "Code", "seq.menu.code_tip": "Type a character or Unicode code point (U+XXXX)",
        "seq.menu.adv": "Adv", "seq.menu.add": "Add",
        "seq.menu.default_chars": "Default Characters", "seq.menu.other_groups": "Other Groups",

        "common.ok": "OK", "common.none": "(none)",
        "dialog.copy": "Copy", "dialog.close": "Close", "dialog.copied": "Copied",
        "dialog.copy_key": "Press Ctrl+C to copy",
        "dialog.copy_hint": "Select all to copy (Ctrl+A / Ctrl+C), or use the button on the right",
        "dialog.repeat": "(this failure has occurred {n} times; merged into this window for this session)",
        "dialog.truncated": "… (diagnostic text truncated; full content in error.log)",
        "dialog.cache_overwrite": "Project \"{name}\" already exists in cache. Overwrite?",

        "err.load_failed": "Failed to load project: ",
        "err.critical_load": "Critical error during file loading: ",
        "err.save_failed": "Save failed: ",
        "err.backend_required": "This feature requires the local backend (fonttools). It is unavailable in the frontend-only build.",
        "err.jszip_missing": "JSZip library is not loaded.",
        "err.jszip_missing_ufo": "JSZip library is not loaded. Cannot export UFO.",
        "err.jszip_missing_import": "JSZip library is not loaded. Cannot import UFO.",
        "err.export_failed": "Export failed: ",
        "err.ufo_import_failed": "Failed to import UFO: ",
        "err.svg_no_font": "No <font> element found in the SVG file.",
        "err.svg_no_glyph": "No <glyph> elements found in the SVG font.",
        "err.ufo_no_fontinfo": "Invalid UFO: missing fontinfo.plist",
        "err.ufo_no_contents": "Invalid UFO: missing glyphs/contents.plist",
        "err.ufo_no_glyphs": "No valid glyphs found in the UFO file.",
        "err.operation_failed": "Operation failed: ",

        // Console panel: one label per command id logged there. The panel resolves
        // these through a lookup map, so the static key scan cannot see them.
        "log.undo": "Undo", "log.redo": "Redo",
        "log.cmd.move_control_point": "Move Control Point", "log.cmd.delete_control_point": "Delete Control Point",
        "log.cmd.move_nodes": "Move Nodes", "log.cmd.insert_node": "Insert Node", "log.cmd.add_path": "Add Path",
        "log.cmd.delete_nodes": "Delete Nodes", "log.cmd.delete_objects": "Delete Objects",
        "log.cmd.change_group": "Change Group", "log.cmd.transform_objects": "Transform Objects",
        "log.cmd.expand_stroke": "Expand Stroke", "log.cmd.boolean_union": "Boolean Union",
        "log.cmd.unlink_reference": "Unlink Reference", "log.cmd.paste_objects": "Paste Objects",
        "log.cmd.duplicate_objects": "Duplicate Objects", "log.cmd.rename": "Rename",
        "log.cmd.set_advance": "Set Advance Width", "log.cmd.edit_node_property": "Edit Node Property",
        "log.cmd.pen_settings": "Pen Settings", "log.cmd.set_char_code": "Set Character Code",
        "log.cmd.edit_sequence": "Edit Sequence", "log.cmd.delete_group": "Delete Group",
        "log.cmd.import_image": "Import Image", "log.cmd.toggle_lock": "Toggle Lock",
        "log.cmd.toggle_visibility": "Toggle Visibility", "log.cmd.commit": "Commit",
        "log.cmd.commit_sequence": "Commit Sequence",
        "log.cmd.edit_properties": "Edit Properties", "log.cmd.resize_objects": "Resize Objects",
        "log.detail.markers": "{n} markers", "log.detail.curves": "{n} curves",
        "log.detail.items": "{n} items", "log.detail.refs": "+{n} refs",
        "log.detail.settings": "{n} settings"
    },
    zh: {
        "app.title": "InkShader：自由字体编辑器",
        "menu.file": "文件", "menu.edit": "编辑", "menu.layout": "布局", "menu.prefs": "首选项", "menu.help": "帮助",
        "panel.canvas": "画布", "panel.objects": "对象", "panel.properties": "属性",
        "panel.console": "控制台", "panel.sample": "示例文本",
        "panel.font": "字体", "panel.kerning": "字距", "panel.glyphs": "字形",
        "file.new_project": "新建项目",
        "file.load_json": "打开项目（JSON）",
        "file.load_ufo": "打开项目（UFO）",
        "file.load_svg": "打开项目（SVG）",
        "file.load_cache": "从浏览器缓存打开",
        "file.import_image": "导入图片至画布",
        "file.save": "保存",
        "file.save_json": "另存为 JSON 项目",
        "file.save_ufo": "另存为 UFO 项目",
        "file.save_svg": "另存为 SVG 文件",
        "file.export_otf": "导出为 OTF",
        "file.export_ttf": "导出为 TTF",
        "file.no_cache": "无缓存项目",
        "edit.copy": "复制",
        "edit.paste": "粘贴",
        "edit.duplicate": "创建副本",
        "edit.delete": "删除",
        "edit.add_extrema": "添加极值点",
        "edit.simplify_path": "简化路径",
        "edit.optimize_path": "优化路径",
        "edit.round_nodes": "坐标取整",
        "edit.smooth_curves": "平滑路径",
        "edit.snap_alignment": "吸附至对齐线",
        "edit.snap_coincident": "吸附至重合点",
        "edit.snap_nodes": "拖动对象时吸附节点",
        "edit.guides": "辅助线",
        "edit.guides.divider": "分隔辅助线",
        "edit.guides.ascender": "升部",
        "edit.guides.descender": "降部",
        "edit.guides.x_height": "x 高度",
        "edit.guides.cap_height": "大写高度",
        "edit.guides.baseline": "基线",
        "edit.guides.lock_divider": "锁定分隔辅助线",
        "edit.guides.lock_metric": "锁定度量辅助线",
        "edit.guides.section_divider": "分隔线",
        "edit.guides.section_metric": "度量辅助线",
        "edit.coord_transform": "坐标变换",
        "edit.coord_transform.section": "坐标原点",
        "edit.coord_transform.global": "全局（零点固定）",
        "edit.coord_transform.active_group": "活动字形（零点位于左分隔线）",
        "edit.coord_transform.per_glyph": "逐字形（每个字形重置零点）",
        "font.project_name": "项目名称",
        "tool.select": "选择并变换对象 (1)", "tool.node": "按节点编辑路径 (2)", "tool.draw": "绘制贝塞尔路径 (3)", "tool.ellipse": "创建椭圆 (4)", "tool.measure": "测量对象 (5)",
        "mode.corner": "将选中节点设为角点 (C)", "mode.smooth": "将选中节点设为平滑点 (S)", "mode.symmetric": "将选中节点设为对称点 (Y)",
        "action.union": "合并选中路径 (Ctrl+U)",
        "action.intersection": "求选中路径的交集 (Ctrl+Shift+U)",
        "action.difference": "求选中路径的差集（底层减顶层）(Ctrl+Alt+U)",
        "action.exclusion": "求选中路径的异或 (Ctrl+Alt+Shift+U)",
        "action.expand": "将描边转换为填充路径 (Ctrl+Shift+X)",
        "action.insert_node": "在选中段上插入节点 (I)", "action.delete_node": "删除选中节点 (D)",
        "action.join_node": "连接选中的端节点", "action.break_node": "在选中节点处断开路径",
        "action.add_segment": "在选中的端节点之间添加段", "action.delete_segment": "删除选中节点之间的段",
        
        "pref.theme": "颜色主题", "pref.theme.light": "浅色", "pref.theme.dark": "深色",
        "pref.accentHue": "强调色", "pref.language": "语言",
        "pref.reset": "恢复主题默认",
        "accent.blue": "蓝色", "accent.red": "红色", "accent.orange": "橙色", "accent.green": "绿色",
        "accent.teal": "青色", "accent.purple": "紫色", "accent.pink": "粉色",
        
        "help.title": "帮助与快捷键", "help.close": "关闭", "help.shortcuts": "键盘快捷键",
        "help.s.tools": "1-5：选择 / 节点 / 绘制 / 椭圆 / 测量",
        "help.s.undo": "Ctrl+Z：撤销",
        "help.s.redo": "Ctrl+Y / Ctrl+Shift+Z：重做",
        "help.s.copy": "Ctrl+C / Ctrl+V：复制 / 粘贴",
        "help.s.duplicate": "Ctrl+D：创建副本",
        "help.s.del": "Del / Backspace：删除对象",
        "help.s.union": "Ctrl+U：合并",
        "help.s.intersection": "Ctrl+Shift+U：交集",
        "help.s.difference": "Ctrl+Alt+U：差集（底层减顶层）",
        "help.s.exclusion": "Ctrl+Alt+Shift+U：异或",
        "help.s.expand": "Ctrl+Shift+X：展开描边",
        "help.s.node_modes": "C / S / Y（节点工具）：角点 / 平滑点 / 对称点",
        "help.s.node_ops": "I / D（节点工具）：插入节点 / 删除节点",
        "help.s.new": "Ctrl+N：新建项目",
        "help.s.open": "Ctrl+O：打开项目",
        "help.s.save": "Ctrl+S：保存项目",
        "help.s.save_as": "Ctrl+Shift+J：另存为 JSON 项目",
        "help.s.export_ufo": "Ctrl+Shift+E：另存为 UFO 项目",
        "help.s.export_svg": "Ctrl+Shift+S：另存为 SVG 文件",
        "help.s.pan": "空格+拖动 / 鼠标中键：平移画布",
        "help.s.pan_arrow": "Ctrl+方向键：平移",
        "help.s.zoom": "Ctrl+滚轮 / Ctrl+= / Ctrl+-：缩放",
        "help.s.zoom_fixed": "Alt+滚轮：以固定中心缩放",
        "help.s.rotate_drag": "Alt+拖动：旋转画布视图",
        "help.s.rotate_step": "Alt+左 / Alt+右：旋转 5°",
        "help.s.rotate_reset": "Alt+0：重置旋转",
        "help.s.fullscreen": "F11：切换全屏",
        "help.s.esc": "Esc：取消 / 取消选择",
        "help.notes.rotation": "画布旋转时只有画布随之转动：标尺、序列栏和工具栏保持正立，因此标尺刻度不再对应其标注的文档位置。",
        "help.documentation": "文档",
        
        "tree.title": "对象",
        "tree.lock": "锁定", "tree.unlock": "解锁", "tree.show": "显示", "tree.hide": "隐藏",
        "seq.placeholder": "在此输入字符...", "seq.add_tip": "添加字形", "seq.edit_tip": "点击编辑文本，按 Enter 完成",
        "seq.empty": "点击输入...", "seq.no_obj": "暂无已创建对象", "seq.add_glyphs": "点击添加字形",
        
        "canvas.mouse_pos": "鼠标位置",

        "prop.title": "属性",
        "prop.pos": "位置", "prop.size": "尺寸", "prop.in": "入", "prop.out": "出", "prop.angle": "角度",
        "prop.nodes_selected": "个节点已选中", "prop.node_props": "节点属性",
        "prop.bbox": "包围盒", "prop.multiple_paths": "多个路径", "prop.path_props": "路径属性", "prop.weight": "宽度", "prop.closed": "闭合", "prop.smart": "实时描边", "prop.skel": "骨架", "prop.name": "名称",
        "prop.path_direction": "路径方向", "prop.smart_expand_direction": "描边方向",
        "prop.toggle_path_direction": "切换路径方向", "prop.toggle_smart_expand_direction": "切换描边方向",
        "prop.dir_cw": "顺时针", "prop.dir_ccw": "逆时针", "prop.dir_open": "开放",
        "prop.pen_settings": "钢笔工具设置", "prop.ellipse_settings": "椭圆工具设置",
        "prop.expand_stroke": "展开描边", "prop.expand_round_cap": "圆头端点", "prop.ref_properties": "引用属性", "prop.advance": "步进宽度", "prop.char": "字符", "prop.mixed": "多个值",
        "prop.lsb": "左侧边距", "prop.rsb": "右侧边距", "prop.kern_left": "左侧字距", "prop.kern_right": "右侧字距", "prop.glyph_settings": "字形设置", "prop.position": "位置", "prop.scale": "缩放", "prop.rotation": "旋转", "prop.shear": "倾斜",

        "tree.menu.delete": "删除", "tree.menu.copy": "复制", "tree.menu.copy_ref": "复制为引用", "tree.menu.paste": "粘贴", "tree.menu.duplicate": "创建副本", "tree.menu.unlink": "取消引用", "tree.menu.go_source": "跳转到引用源",
        "tree.menu.paste_group": "粘贴（{n} 个引用组）", "tree.menu.paste_curve": "粘贴（{n} 条路径）",

        "color.path_stroke": "路径描边", "color.path_fill": "路径填充", "color.preview": "预览路径", "color.hover_stroke": "悬停路径", "color.oncurve_stroke": "节点描边", "color.oncurve_fill": "节点填充", "color.selected_stroke": "选中节点描边", "color.selected_fill": "选中节点填充", "color.ctrl_stroke": "控制柄连线", "color.ctrl_fill": "控制柄端点", "color.ctrl_ahead": "前置控制柄", "color.ctrl_back": "后置控制柄", "color.guideline": "辅助线颜色", "color.measure": "测量工具颜色", "color.select_box": "选择框颜色", "color.body_bg": "画布背景",

        "font.family": "家族名称", "font.style": "样式名称",
        "font.postscript_name": "PostScript 名称", "font.preferred_family": "首选家族", "font.preferred_subfamily": "首选子样式",
        "font.style_map_family": "样式映射家族",
        "font.copyright": "版权", "font.designer": "设计师", "font.designer_url": "设计师网址",
        "font.manufacturer": "厂商", "font.manufacturer_url": "厂商网址",
        "font.license": "许可", "font.license_url": "许可网址",
        "font.trademark": "商标", "font.description": "描述", "font.sample_text": "示例文本",
        "font.upm": "每 em 单位数 (UPM)", "font.weight_class": "字重等级", "font.width_class": "宽度等级",
        "font.ascender": "升部", "font.descender": "降部",
        "font.x_height": "x 高度", "font.cap_height": "大写高度",
        "font.italic_angle": "倾斜角",
        "font.version": "版本",

        "kern.add": "添加", "kern.no_pairs": "尚未定义字距对。",
        "kern.pick_left": "-- 左侧 --", "kern.pick_right": "-- 右侧 --",
        "kern.left_glyph": "左侧字形", "kern.right_glyph": "右侧字形",
        "kern.value_tip": "字距值 (UPM)", "kern.remove_tip": "移除",
        "sample.title": "示例文本", "sample.kerning": "字距", "sample.guides": "度量辅助线",
        "sample.fontSize": "字号",
        "sample.placeholder": "输入示例文本，非字符字形用 \\name\\，按 Enter 换行",

        "seq.menu.name": "名称", "seq.menu.name_tip": "字形名称", "seq.menu.group_name_tip": "组名称",
        "seq.menu.code": "字符", "seq.menu.code_tip": "输入字符或 Unicode 码位 (U+XXXX)",
        "seq.menu.adv": "步进", "seq.menu.add": "添加",
        "seq.menu.default_chars": "默认字符", "seq.menu.other_groups": "其他组",

        "common.ok": "确定", "common.none": "（无）",
        "dialog.copy": "复制", "dialog.close": "关闭", "dialog.copied": "已复制",
        "dialog.copy_key": "请按 Ctrl+C 复制",
        "dialog.copy_hint": "全选以复制（Ctrl+A / Ctrl+C），或使用右侧按钮",
        "dialog.repeat": "（本会话内该故障已发生 {n} 次，合并显示于本窗口）",
        "dialog.truncated": "…（诊断文本已截断，完整内容见 error.log）",
        "dialog.cache_overwrite": "缓存中已存在项目“{name}”，是否覆盖？",

        "err.load_failed": "加载项目失败：",
        "err.critical_load": "加载文件时发生严重错误：",
        "err.save_failed": "保存失败：",
        "err.backend_required": "该功能需要本地后端（fonttools），纯前端版本不可用。",
        "err.jszip_missing": "JSZip 库未加载。",
        "err.jszip_missing_ufo": "JSZip 库未加载，无法导出 UFO。",
        "err.jszip_missing_import": "JSZip 库未加载，无法导入 UFO。",
        "err.export_failed": "导出失败：",
        "err.ufo_import_failed": "导入 UFO 失败：",
        "err.svg_no_font": "SVG 文件中未找到 <font> 元素。",
        "err.svg_no_glyph": "SVG 字体中未找到 <glyph> 元素。",
        "err.ufo_no_fontinfo": "UFO 无效：缺少 fontinfo.plist",
        "err.ufo_no_contents": "UFO 无效：缺少 glyphs/contents.plist",
        "err.ufo_no_glyphs": "UFO 文件中没有有效字形。",
        "err.operation_failed": "操作失败：",

        "log.undo": "撤销", "log.redo": "重做",
        "log.cmd.move_control_point": "移动控制点", "log.cmd.delete_control_point": "删除控制点",
        "log.cmd.move_nodes": "移动节点", "log.cmd.insert_node": "插入节点", "log.cmd.add_path": "添加路径",
        "log.cmd.delete_nodes": "删除节点", "log.cmd.delete_objects": "删除对象",
        "log.cmd.change_group": "更改组", "log.cmd.transform_objects": "变换对象",
        "log.cmd.expand_stroke": "展开描边", "log.cmd.boolean_union": "布尔合并",
        "log.cmd.unlink_reference": "取消引用", "log.cmd.paste_objects": "粘贴对象",
        "log.cmd.duplicate_objects": "创建副本", "log.cmd.rename": "重命名",
        "log.cmd.set_advance": "设置步进宽度", "log.cmd.edit_node_property": "编辑节点属性",
        "log.cmd.pen_settings": "钢笔设置", "log.cmd.set_char_code": "设置字符码位",
        "log.cmd.edit_sequence": "编辑序列", "log.cmd.delete_group": "删除组",
        "log.cmd.import_image": "导入图片", "log.cmd.toggle_lock": "切换锁定",
        "log.cmd.toggle_visibility": "切换可见性", "log.cmd.commit": "提交",
        "log.cmd.commit_sequence": "提交序列",
        "log.cmd.edit_properties": "编辑属性", "log.cmd.resize_objects": "调整对象尺寸",
        "log.detail.markers": "{n} 个标记", "log.detail.curves": "{n} 条路径",
        "log.detail.items": "{n} 个对象", "log.detail.refs": "+{n} 个引用",
        "log.detail.settings": "{n} 项设置"
    }
};

/** Locale stored by the user, falling back to the default when unset or invalid. */
function readStoredLang() {
    try {
        const stored = localStorage.getItem(LANG_STORAGE_KEY);
        return SUPPORTED_LANGS.includes(stored) ? stored : 'en';
    } catch (_) {
        // No storage available (disabled cookies / private mode) — keep the default.
        return 'en';
    }
}

export class I18nManager {
    static lang = readStoredLang();
    static observer = null;

    /**
     * Table lookup. `fallback` is returned when the key is absent, so callers can pass
     * the literal they would use in markup; with no fallback at all the key itself is
     * returned, which is visibly wrong rather than silently plausible.
     */
    static t(key, fallback) {
        const dict = translations[this.lang] || translations.en;
        const hit = dict[key];
        if (hit !== undefined) return hit;
        return fallback !== undefined ? fallback : key;
    }

    /**
     * Look up a key in an explicit locale. Used where a label must not follow the UI
     * language (e.g. a locale's own name in the language picker).
     */
    static tIn(lang, key, fallback) {
        const dict = translations[lang] || translations.en;
        const hit = dict[key];
        if (hit !== undefined) return hit;
        return fallback !== undefined ? fallback : key;
    }

    /**
     * Switch the display language: persist it, retranslate the DOM, then let
     * components that build text in JS (menus, panels, popups) rebuild it via
     * CANVAS_EVENTS.LANGUAGE_CHANGED. Unknown ids are ignored, not stored.
     * @returns {boolean} whether the language was applied
     */
    static setLang(lang) {
        if (!SUPPORTED_LANGS.includes(lang) || !translations[lang]) return false;
        this.lang = lang;
        try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (_) { /* no storage */ }
        this.applyDocumentLang();
        this.translateDOM();
        appEventBus.emit(CANVAS_EVENTS.LANGUAGE_CHANGED, { lang });
        return true;
    }

    /** Mirror the locale onto <html lang> and the window title. */
    static applyDocumentLang() {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        if (root) root.setAttribute('lang', HTML_LANG[this.lang] || this.lang);
        document.title = this.t('app.title', 'InkShader');
    }

    /**
     * Replace text / tooltip / placeholder of every [data-i18n*] element with the table
     * value for the current language.
     *
     * Each element's own value is captured once, on the first pass, and reused as the
     * fallback afterwards. That is what turns the inline markup into a real fallback
     * instead of decoration, and what keeps a missing key from printing itself.
     */
    static translateDOM(root = document) {
        if (this.observer) this.observer.disconnect();

        const apply = (el, attr, store, read, write) => {
            const key = el.getAttribute(attr);
            if (!key) return;
            if (!el.hasAttribute(store)) el.setAttribute(store, read(el));
            const val = this.t(key, el.getAttribute(store));
            if (read(el) !== val) write(el, val);
        };

        root.querySelectorAll('[data-i18n]').forEach(el =>
            apply(el, 'data-i18n', 'data-i18n-fallback',
                e => e.textContent, (e, v) => { e.innerHTML = v; }));

        root.querySelectorAll('[data-i18n-tip]').forEach(el => {
            apply(el, 'data-i18n-tip', 'data-i18n-tip-fallback',
                e => e.getAttribute('data-tip') || '', (e, v) => e.setAttribute('data-tip', v));

            // Elements that declared a native `title` tooltip in the markup keep it in
            // sync as well; the toolbar's custom tooltip layer only reads `data-tip`,
            // so without this those titles would stay untranslated forever.
            if (el.hasAttribute('title')) {
                const val = this.t(el.getAttribute('data-i18n-tip'), el.getAttribute('data-i18n-tip-fallback'));
                if (el.getAttribute('title') !== val) el.setAttribute('title', val);
            }
        });

        root.querySelectorAll('[data-i18n-placeholder]').forEach(el =>
            apply(el, 'data-i18n-placeholder', 'data-i18n-placeholder-fallback',
                e => e.getAttribute('placeholder') || '', (e, v) => e.setAttribute('placeholder', v)));

        if (this.observer) this.observer.observe(document.body, { childList: true, subtree: true });
    }

    static init() {
        this.observer = new MutationObserver(mutations => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue; // text/comment — no i18n attrs
                    if (node.hasAttribute?.('data-i18n') || node.hasAttribute?.('data-i18n-tip') || node.hasAttribute?.('data-i18n-placeholder')) {
                        this.translateDOM();
                        return;
                    }
                    if (node.querySelector?.('[data-i18n],[data-i18n-tip],[data-i18n-placeholder]')) {
                        this.translateDOM();
                        return;
                    }
                }
            }
        });
        this.applyDocumentLang();
        this.translateDOM();
    }
}
window.I18n = I18nManager;