// js/services/i18n.js
//
// UI text lookup. English is the only shipped language: the table below is the
// single source of truth for every user-visible string, and the markup carries
// the same English text inline as a per-element fallback.
//
// Two rules keep the two in sync:
//   1. Lookups never invent text. `t(key, fallback)` prefers the table, then the
//      caller's fallback, then the key; translateDOM passes the markup's own text
//      as that fallback, so an unknown key leaves the inline English alone instead
//      of writing the raw key into the DOM.
//   2. A string is defined once. Markup uses data-i18n / data-i18n-tip /
//      data-i18n-placeholder; JS uses t(). No component writes a label literal.
//
// The scaffolding (key table + DOM translation + LANGUAGE_CHANGED event) is kept
// on purpose so translations can be added later: add a locale object next to
// `en`, expose it in the preferences modal, and setLang() switches the app.
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";

export const translations = {
    en: {
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
        "action.join_node": "Join selected nodes", "action.break_node": "Break path at selected nodes",
        "action.add_segment": "Join selected end nodes", "action.delete_segment": "Delete segment between selected nodes",
        
        "pref.theme": "Color Theme", "pref.accentHue": "Accent",
        "pref.override": "Canvas Colors Override", "pref.reset": "Reset to Theme Default",
        
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
        "help.about": "About", "help.documentation": "Documentation",
        
        "tree.title": "Objects",
        "seq.placeholder": "Type characters here...", "seq.add_tip": "Add Glyph", "seq.edit_tip": "Click to edit text, press Enter to finish",
        "seq.empty": "Click to type...", "seq.no_obj": "No created objects yet",
        
        "canvas.mouse_pos": "Mouse Pos",

        "prop.title": "Properties",
        "prop.pos": "Pos", "prop.size": "Size", "prop.in": "In", "prop.out": "Out", "prop.angle": "Angle",
        "prop.nodes_selected": "nodes selected", "prop.node_props": "Node Properties",
        "prop.bbox": "Bounding Box", "prop.multiple_paths": "Multiple Paths", "prop.path_props": "Path Properties", "prop.weight": "Width", "prop.closed": "Closed", "prop.smart": "Live Stroke", "prop.skel": "Skeleton", "prop.name": "Name",
        "prop.path_direction": "Path Direction", "prop.smart_expand_direction": "Stroke Direction",
        "prop.toggle_path_direction": "Toggle path direction", "prop.toggle_smart_expand_direction": "Toggle stroke direction",
        "prop.dir_cw": "Clockwise", "prop.dir_ccw": "Counter-clockwise", "prop.dir_open": "Open",
        "prop.pen_settings": "Pen Tool Settings", "prop.expand_stroke": "Expand Stroke", "prop.expand_round_cap": "Round Cap", "prop.ref_properties": "Reference Properties", "prop.advance": "Advance Width", "prop.char": "Char", "prop.mixed": "Mixed",
        "prop.lsb": "LSB", "prop.rsb": "RSB", "prop.kern_left": "Left Kern", "prop.kern_right": "Right Kern", "prop.glyph_settings": "Glyph Settings", "prop.position": "Position", "prop.scale": "Scale", "prop.rotation": "Rotation", "prop.shear": "Shear",

        "tree.menu.delete": "Delete", "tree.menu.copy": "Copy", "tree.menu.copy_ref": "Copy Reference", "tree.menu.paste": "Paste", "tree.menu.duplicate": "Duplicate", "tree.menu.unlink": "Unlink Reference", "tree.menu.go_source": "Go to Reference Source",

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
        "kern.left_glyph": "Left glyph", "kern.right_glyph": "Right glyph",
        "kern.value_tip": "Kerning value (UPM)", "kern.remove_tip": "Remove",
        "sample.title": "Sample Text", "sample.kerning": "Kerning", "sample.guides": "Metric Guides",
        "sample.fontSize": "Size",
        "sample.placeholder": "Type sample text, \\name\\ for non-character glyphs, Enter for new line"
    }
};

export class I18nManager {
    static lang = 'en';
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

    /** Switch language. No non-English locale ships today, so this is the hook
     *  for a future translations release rather than a live code path. */
    static setLang(lang) {
        if (!translations[lang]) return;
        this.lang = lang;
        this.translateDOM();
        appEventBus.emit(CANVAS_EVENTS.LANGUAGE_CHANGED, { lang });
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
        this.translateDOM();
    }
}
window.I18n = I18nManager;