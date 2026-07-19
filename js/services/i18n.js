import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
// js/services/i18n.js

export const translations = {
    en: {
        "menu.file": "File", "menu.edit": "Edit", "menu.prefs": "Preferences", "menu.help": "Help",
        "menu.font": "Font",
        "file.new_project": "New Project",
        "file.load_json": "Load Project (JSON)",
        "file.load_ufo": "Load Project (UFO)",
        "file.load_svg": "Load Project (SVG)",
        "file.load_cache": "Load from Browser Cache",
        "file.import_image": "Import image",
        "file.save_json": "Save as JSON Project",
        "file.save_ufo": "Save as UFO Project",
        "file.save_svg": "Save as SVG File",
        "file.no_cache": "No cached projects",
        "edit.copy": "Copy",
        "edit.paste": "Paste",
        "edit.duplicate": "Duplicate",
        "edit.delete": "Delete",
        "edit.snap_alignment": "Snap to Alignment",
        "edit.snap_coincident": "Snap to Coincident",
        "edit.guides": "Guides",
        "edit.guides.divider": "Divider Guides",
        "edit.guides.ascender": "Ascender",
        "edit.guides.descender": "Descender",
        "edit.guides.x_height": "x-Height",
        "edit.guides.cap_height": "Cap Height",
        "edit.guides.baseline": "Baseline",
        "edit.guides.lock_divider": "Lock Dividers",
        "edit.guides.lock_metric": "Lock Metric Guides",
        "edit.guides.lock_group": "Lock",
        "edit.guides.show_group": "Show",
        "edit.guides.section_divider": "Dividers",
        "edit.guides.section_metric": "Metric Guides",
        "font.project_name": "Project Name",
        "tool.select": "Select and transform objects", "tool.node": "Edit paths by nodes", "tool.draw": "Draw Bezier curves", "tool.ellipse": "Create ellipses", "tool.measure": "Measure objects",
        "mode.corner": "Make selected nodes corner", "mode.smooth": "Make selected nodes smooth", "mode.symmetric": "Make selected nodes symmetric",
        "action.union": "Create union of selected paths", "action.expand": "Expand a stroke into a filled path",
        "action.insert_node": "Insert new nodes into selected segments", "action.delete_node": "Delete selected nodes", "action.join_node": "Join selected nodes", "action.break_node": "Break path at selected nodes", "action.add_segment": "Join selected endnodes with a new segment", "action.delete_segment": "Delete segment between selected nodes",
        "action.intersection": "Create intersection of selected paths", "action.difference": "Create difference of selected paths (bottom minus top)", "action.exclusion": "Create exclusive or of selected paths",
        
        "pref.title": "Preferences", "pref.general": "General", "pref.appearance": "Appearance", "pref.lang": "Language", "pref.theme": "Color Theme", "pref.theme.light": "Light Mode (Default)", "pref.theme.dark": "Dark Mode", "pref.override": "Canvas Colors Override", "pref.reset": "Reset to Theme Default",
        
        "help.title": "Help & Shortcuts", "help.close": "Close", "help.shortcuts": "Keyboard Shortcuts",
        "help.s.undo": "Ctrl + Z : Undo", "help.s.redo": "Ctrl + Y / Ctrl + Shift + Z : Redo", "help.s.pan": "Space + Drag / Mid-Click : Pan Canvas", "help.s.del": "Del : Delete Selected", "help.s.save": "Ctrl + S : Quick Save",
        "help.about": "About", "help.documentation": "Documentation",
        
        "log.title": "Log Console",
        "tree.title": "Objects", "seq.title": "Sequence", "seq.placeholder": "Type characters here...", "seq.add_tip": "Add created group",
        "seq.empty": "Click to type...", "seq.no_obj": "No created objects yet",
        
        "canvas.mouse_pos": "Mouse Pos",

        "prop.title": "Properties",
        "prop.node_pos": "Node Position", "prop.pos": "Pos", "prop.handles": "Handles & Angles", "prop.in": "In", "prop.out": "Out", "prop.angle": "Angle", "prop.nodes_selected": "nodes selected", "prop.node_props": "Node Properties",
        "prop.bbox": "Bounding Box", "prop.multiple_paths": "Multiple Paths", "prop.path_props": "Path Properties", "prop.weight": "Weight", "prop.closed": "Closed", "prop.smart": "Smart", "prop.skel": "Skeleton", "prop.path_details": "Path Details", "prop.name": "Name",
        "prop.path_direction": "Path Direction", "prop.smart_expand_direction": "Smart Expand Direction",
        "prop.toggle_path_direction": "Toggle path direction", "prop.toggle_smart_expand_direction": "Toggle smart expand direction",
        "prop.dir_cw": "Clockwise", "prop.dir_ccw": "Counter-clockwise", "prop.dir_open": "Open",
        "prop.pen_settings": "Pen Tool Settings", "prop.trans_ref": "Transform (Ref)", "prop.trans": "Trans", "prop.ref_details": "Reference Details", "prop.group_spacing": "Group Spacing", "prop.advance": "Advance", "prop.group_details": "Group Details", "prop.char": "Char", "prop.mixed": "Mixed", "prop.group_settings": "Group Settings",

        "tree.menu.delete": "Delete", "tree.menu.copy": "Copy", "tree.menu.copy_ref": "Copy Reference", "tree.menu.paste": "Paste", "tree.menu.duplicate": "Duplicate", "tree.menu.unlink": "Unlink Reference", "tree.menu.go_source": "Go to Reference Source",

        "color.path_stroke": "Path Stroke", "color.path_fill": "Path Fill", "color.preview": "Preview Curve", "color.hover_stroke": "Hovered Curve", "color.oncurve_stroke": "Node Stroke", "color.oncurve_fill": "Node Fill", "color.selected_stroke": "Selected Node Stroke", "color.selected_fill": "Selected Node Fill", "color.ctrl_stroke": "Handle Line", "color.ctrl_fill": "Handle Point", "color.ctrl_ahead": "Handle Ahead", "color.ctrl_back": "Handle Back", "color.guideline": "Guideline Color", "color.measure": "Measure Tool Color", "color.select_box": "Select Box Color", "color.body_bg": "Canvas Background",

        "pref.font": "Font Info", "font.family": "Family Name", "font.style": "Style Name", 
        "font.postscript_name": "PostScript Name", "font.preferred_family": "Preferred Family", "font.preferred_subfamily": "Preferred Subfamily",
        "font.copyright": "Copyright", "font.designer": "Designer", "font.designer_url": "Designer URL",
        "font.manufacturer": "Manufacturer", "font.manufacturer_url": "Manufacturer URL",
        "font.license": "License", "font.license_url": "License URL",
        "font.trademark": "Trademark", "font.description": "Description", "font.sample_text": "Sample Text",
        "font.upm": "Units Per Em (UPM)", "font.weight_class": "Weight Class", "font.width_class": "Width Class",
        "font.ascender": "Ascender", "font.descender": "Descender", 
        "font.x_height": "x-Height", "font.cap_height": "Cap Height",
        "font.version": "Version",

        "menu.import": "Import",
        "prop.image_details": "Image Details"
    },
    zh: {
        "menu.file": "文件", "menu.edit": "编辑", "menu.prefs": "首选项", "menu.help": "帮助",
        "menu.font": "字体",
        "file.new_project": "新建项目",
        "file.load_json": "加载本地项目 (JSON)",
        "file.load_ufo": "加载本地项目 (UFO)",
        "file.load_svg": "加载本地项目 (SVG)",
        "file.load_cache": "从浏览器缓存加载之前的项目",
        "file.import_image": "导入图片",
        "file.save_json": "保存为 JSON 项目",
        "file.save_ufo": "保存为 UFO 项目",
        "file.save_svg": "保存为 SVG 文件",
        "file.no_cache": "没有缓存的项目",
        "edit.copy": "复制",
        "edit.paste": "粘贴",
        "edit.duplicate": "建立副本",
        "edit.delete": "删除",
        "edit.snap_alignment": "吸附到对齐线",
        "edit.snap_coincident": "吸附到重合位置",
        "edit.guides": "辅助线",
        "edit.guides.divider": "分组分隔线",
        "edit.guides.ascender": "升部线 (Ascender)",
        "edit.guides.descender": "降部线 (Descender)",
        "edit.guides.x_height": "x-高度线",
        "edit.guides.cap_height": "大写高度线",
        "edit.guides.baseline": "基线",
        "edit.guides.lock_divider": "锁定分隔线",
        "edit.guides.lock_metric": "锁定度量辅助线",
        "edit.guides.lock_group": "锁定",
        "edit.guides.show_group": "显示",
        "edit.guides.section_divider": "分隔线",
        "edit.guides.section_metric": "度量辅助线",
        "font.project_name": "项目名称",
        "tool.select": "选择与变换对象", "tool.node": "编辑路径节点", "tool.draw": "绘制贝塞尔曲线", "tool.ellipse": "创建椭圆", "tool.measure": "测量对象",
        "mode.corner": "使选中节点成为角点", "mode.smooth": "使选中节点平滑", "mode.symmetric": "使选中节点对称",
        "action.union": "合并选中的路径", "action.expand": "将描边扩展为填充路径",
        "action.insert_node": "在选中线段中插入新节点", "action.delete_node": "删除选中节点", "action.join_node": "连接选中的节点", "action.break_node": "在选中节点处断开路径", "action.add_segment": "在选中端点间添加新线段", "action.delete_segment": "删除选中节点间的线段",
        "action.intersection": "创建选中路径的交集", "action.difference": "创建选中路径的差集", "action.exclusion": "创建选中路径的异或",
        
        "pref.title": "首选项", "pref.general": "通用", "pref.appearance": "外观", "pref.lang": "语言 (Language)", "pref.theme": "颜色主题", "pref.theme.light": "浅色模式", "pref.theme.dark": "深色模式", "pref.override": "画布颜色覆盖", "pref.reset": "恢复默认",
        
        "help.title": "帮助与快捷键", "help.close": "关闭", "help.shortcuts": "键盘快捷键",
        "help.s.undo": "Ctrl + Z : 撤销", "help.s.redo": "Ctrl + Y / Ctrl + Shift + Z : 重做", "help.s.pan": "空格 + 拖拽 / 鼠标中键 : 平移画布", "help.s.del": "Del : 删除选中项", "help.s.save": "Ctrl + S : 快速保存",
        "help.about": "关于", "help.documentation": "使用文档",
        
        "log.title": "运行日志",
        "tree.title": "对象", "seq.title": "序列", "seq.placeholder": "输入字符...", "seq.add_tip": "添加已创建的组",
        "seq.empty": "点击输入...", "seq.no_obj": "暂无已创建的对象",
        
        "canvas.mouse_pos": "鼠标位置",

        "prop.title": "属性",
        "prop.node_pos": "节点位置", "prop.pos": "坐标", "prop.handles": "控制柄与角度", "prop.in": "入场", "prop.out": "出场", "prop.angle": "角度", "prop.nodes_selected": "个节点被选中", "prop.node_props": "节点属性",
        "prop.bbox": "包围盒", "prop.multiple_paths": "多个路径", "prop.path_props": "路径属性", "prop.weight": "粗细", "prop.closed": "闭合", "prop.smart": "智能", "prop.skel": "骨架", "prop.path_details": "路径详情", "prop.name": "名称",
        "prop.path_direction": "路径方向", "prop.smart_expand_direction": "智能描边方向",
        "prop.toggle_path_direction": "切换路径方向", "prop.toggle_smart_expand_direction": "切换智能描边方向",
        "prop.dir_cw": "顺时针", "prop.dir_ccw": "逆时针", "prop.dir_open": "开放",
        "prop.pen_settings": "钢笔工具设置", "prop.trans_ref": "变换 (引用)", "prop.trans": "平移", "prop.ref_details": "引用详情", "prop.group_spacing": "字距", "prop.advance": "步进宽度", "prop.group_details": "分组详情", "prop.char": "字符映射", "prop.mixed": "混合", "prop.group_settings": "分组设置",

        "tree.menu.delete": "删除", "tree.menu.copy": "复制", "tree.menu.copy_ref": "复制为引用", "tree.menu.paste": "粘贴", "tree.menu.duplicate": "建立副本", "tree.menu.unlink": "取消引用链接", "tree.menu.go_source": "跳转至源对象",

        "color.path_stroke": "路径描边", "color.path_fill": "路径填充", "color.preview": "预览曲线", "color.hover_stroke": "悬停高亮", "color.oncurve_stroke": "节点描边", "color.oncurve_fill": "节点填充", "color.selected_stroke": "选中边缘", "color.selected_fill": "选中填充", "color.ctrl_stroke": "控制柄连线", "color.ctrl_fill": "控制柄端点", "color.ctrl_ahead": "出场手柄", "color.ctrl_back": "入场手柄", "color.guideline": "参考线", "color.measure": "测量工具", "color.select_box": "选中包围盒", "color.body_bg": "画布底色",
        "pref.font": "字体信息", "font.family": "字体家族名称", "font.style": "字重/样式名称",
        "font.postscript_name": "PostScript 名称", "font.preferred_family": "首选家族名称", "font.preferred_subfamily": "首选子家族名称",
        "font.copyright": "版权信息", "font.designer": "设计师", "font.designer_url": "设计师网址",
        "font.manufacturer": "制造商", "font.manufacturer_url": "制造商网址",
        "font.license": "授权协议", "font.license_url": "授权协议网址",
        "font.trademark": "商标信息", "font.description": "字体描述", "font.sample_text": "示例文本",
        "font.upm": "UPM (Em 框大小)", "font.weight_class": "字重等级", "font.width_class": "字宽等级",
        "font.ascender": "升部 (Ascender)", "font.descender": "降部 (Descender)",
        "font.x_height": "x-高度 (x-Height)", "font.cap_height": "大写高度 (Cap Height)",
        "font.version": "字体版本",

        "menu.import": "导入",
        "prop.image_details": "图片详情"
    }
};

export class I18nManager {
    static lang = localStorage.getItem('InkShader_lang') || 'en';
    static observer = null;

    static t(key) {
        const dict = translations[this.lang] || translations['en'];
        return dict[key] || key;
    }

    static setLang(lang) {
        if (!translations[lang]) return;
        this.lang = lang;
        localStorage.setItem('InkShader_lang', lang);
        this.translateDOM();
        appEventBus.emit(CANVAS_EVENTS.LANGUAGE_CHANGED, { lang });
    }

    static translateDOM(root = document) {
        if (this.observer) this.observer.disconnect();

        root.querySelectorAll('[data-i18n]').forEach(el => {
            const val = this.t(el.getAttribute('data-i18n'));
            if (el.innerHTML !== val && el.textContent !== val) {
                el.innerHTML = val;
            }
        });
        root.querySelectorAll('[data-i18n-tip]').forEach(el => {
            const val = this.t(el.getAttribute('data-i18n-tip'));
            if (el.getAttribute('data-tip') !== val) el.setAttribute('data-tip', val);
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const val = this.t(el.getAttribute('data-i18n-placeholder'));
            if (el.getAttribute('placeholder') !== val) el.setAttribute('placeholder', val);
        });

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
        this.translateDOM();
    }
}
window.I18n = I18nManager;