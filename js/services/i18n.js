import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
// js/services/i18n.js

export const translations = {
    en: {
        "menu.load": "Load", "menu.save": "Save", "menu.export": "Export As", "menu.prefs": "Preferences", "menu.help": "Help",
        "menu.new": "New", "menu.font": "Font",
        "dropdown.load_file": "Load from File", "dropdown.load_cache": "Load from Cache", "dropdown.no_projects": "No cached projects",
        "font.project_name": "Project Name",
        "tool.select": "Select and transform objects", "tool.node": "Edit paths by nodes", "tool.draw": "Draw Bezier curves", "tool.ellipse": "Create Ellipses", "tool.measure": "Measure objects",
        "mode.corner": "Make selected nodes corner", "mode.smooth": "Make selected nodes smooth", "mode.symmetric": "Make selected nodes symmetric",
        "action.union": "Create union of selected paths", "action.expand": "Expand a stroke into a filled path",
        
        "pref.title": "Preferences", "pref.general": "General & Appearance", "pref.lang": "Language", "pref.theme": "Color Theme", "pref.theme.light": "Light Mode (Default)", "pref.theme.dark": "Dark Mode", "pref.override": "Canvas Colors Override", "pref.reset": "Reset to Theme Default",
        
        "help.title": "Help & Shortcuts", "help.close": "Close", "help.shortcuts": "Keyboard Shortcuts",
        "help.s.undo": "Ctrl + Z : Undo", "help.s.redo": "Ctrl + Y / Ctrl + Shift + Z : Redo", "help.s.pan": "Space + Drag / Mid-Click : Pan Canvas", "help.s.del": "Del : Delete Selected", "help.s.save": "Ctrl + S : Quick Save",
        
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
        "font.upm": "Units Per Em (UPM)", "font.ascender": "Ascender", "font.descender": "Descender", 
        "font.version": "Version",

        "menu.import": "Import",
        "prop.image_details": "Image Details"
    },
    zh: {
        "menu.load": "加载", "menu.save": "保存", "menu.export": "导出为", "menu.prefs": "首选项", "menu.help": "帮助",
        "menu.new": "新建", "menu.font": "字体",
        "dropdown.load_file": "从文件加载", "dropdown.load_cache": "从缓存加载", "dropdown.no_projects": "没有缓存的项目",
        "font.project_name": "项目名称",
        "tool.select": "选择与变换对象", "tool.node": "编辑路径节点", "tool.draw": "绘制贝塞尔曲线", "tool.ellipse": "创建椭圆", "tool.measure": "测量对象",
        "mode.corner": "使选中节点成为角点", "mode.smooth": "使选中节点平滑", "mode.symmetric": "使选中节点对称",
        "action.union": "合并选中的路径", "action.expand": "将描边扩展为填充路径",
        
        "pref.title": "首选项", "pref.general": "通用与外观", "pref.lang": "语言 (Language)", "pref.theme": "颜色主题", "pref.theme.light": "浅色模式", "pref.theme.dark": "深色模式", "pref.override": "画布颜色覆盖", "pref.reset": "恢复默认",
        
        "help.title": "帮助与快捷键", "help.close": "关闭", "help.shortcuts": "键盘快捷键",
        "help.s.undo": "Ctrl + Z : 撤销", "help.s.redo": "Ctrl + Y / Ctrl + Shift + Z : 重做", "help.s.pan": "空格 + 拖拽 / 鼠标中键 : 平移画布", "help.s.del": "Del : 删除选中项", "help.s.save": "Ctrl + S : 快速保存",
        
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
        "font.upm": "UPM (Em 框大小)", "font.ascender": "升部 (Ascender)", "font.descender": "降部 (Descender)", 
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
            if (mutations.some(m => m.addedNodes.length > 0)) this.translateDOM();
        });
        this.translateDOM();
    }
}
window.I18n = I18nManager;