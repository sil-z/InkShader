// js/services/theme.js
export let param_set = { "1": {} };

export function updateThemeParams() {
    const rootStyles = getComputedStyle(document.documentElement);
    const getVar = (name, fallback) => rootStyles.getPropertyValue(name).trim() || fallback;

    param_set["1"] = {
        "path_stroke_color": getVar('--cvs-path-stroke', 'rgba(127, 127, 127, 1)'),
        "path_fill_color": getVar('--cvs-path-fill', 'rgba(0,0,0,1)'),
        "control_ahead_color": getVar('--cvs-ctrl-ahead', 'rgba(0, 0, 255, 0.6)'),
        "control_back_color": getVar('--cvs-ctrl-back', 'rgba(255, 0, 0, 0.6)'),
        "preview_color": getVar('--cvs-preview', 'rgba(0, 255, 0, 0.6)'),
        "oncurve_stroke_color": getVar('--cvs-oncurve-stroke', 'rgba(113, 201, 206, 1)'),
        "oncurve_fill_color": getVar('--cvs-oncurve-fill', 'rgba(113, 201, 206, 0.6)'),
        "control_stroke_color": getVar('--cvs-ctrl-stroke', 'rgba(166, 227, 233, 1)'),
        "control_fill_color": getVar('--cvs-ctrl-fill', 'rgba(166, 227, 233, 0.6)'),
        "selected_fill_color": getVar('--cvs-selected-fill', 'rgba(249, 237, 105, 0.6)'),
        "selected_stroke_color": getVar('--cvs-selected-stroke', 'rgba(249, 237, 105, 1)'),
        "body_bg_color": getVar('--cvs-body-bg', 'rgba(240, 255, 255, 0.5)'),
        "hovered_curve_stroke_color": getVar('--cvs-hover-stroke', 'rgba(113, 201, 206, 1)'),
        "ruler_text_color": getVar('--cvs-ruler-text', '#888888'),
        "ruler_line_color": getVar('--cvs-ruler-line', '#888888'),
        "guideline_color": getVar('--cvs-guideline', 'rgba(255, 120, 0, 0.7)'),
        "measure_color": getVar('--cvs-measure', '#e74c3c'),
        "measure_text_bg": getVar('--cvs-measure-text-bg', 'rgba(255, 255, 255, 0.85)'),
        "select_box_stroke": getVar('--cvs-select-box', 'rgba(13, 153, 255, 0.4)'),
        "select_handle_fill": getVar('--cvs-select-handle-fill', '#ffffff'),
        "select_handle_stroke": getVar('--cvs-select-handle-stroke', '#0d99ff'),
        "marquee_stroke": getVar('--cvs-marquee-stroke', '#0ea5e9'),
        "marquee_fill": getVar('--cvs-marquee-fill', 'rgba(13, 153, 255, 0.08)'),
        "canvas_divider": getVar('--cvs-divider-line', 'rgba(0, 0, 0, 0.2)'),
        "char_preview_color": getVar('--cvs-char-preview-color', 'rgba(160, 160, 160, 0.3)'),
        "guide_stroke": getVar('--cvs-guide-stroke', 'rgba(2, 132, 199, 0.6)'),
        "guide_fill": getVar('--cvs-guide-fill', 'rgba(2, 132, 199, 0.4)'),
        "guide_hover_stroke": getVar('--cvs-guide-hover-stroke', 'rgba(250, 204, 21, 0.8)'),
        "guide_hover_fill": getVar('--cvs-guide-hover-fill', 'rgba(250, 204, 21, 0.6)'),
        "guide_drag_stroke": getVar('--cvs-guide-drag-stroke', 'rgba(250, 204, 21, 0.7)'),
        "guide_drag_fill": getVar('--cvs-guide-drag-fill', 'rgba(250, 204, 21, 0.5)'),
        "metric_guide_color": getVar('--cvs-metric-guide', 'rgba(100, 100, 200, 0.5)'),
        "metric_guide_label": getVar('--cvs-metric-label', '#6666cc'),
        "divider_highlight": getVar('--cvs-divider-highlight', 'rgba(250, 204, 21, 0.8)'),
        "measure_hover_color": getVar('--cvs-measure-hover', '#facc15'),
        "preview_fallback": getVar('--cvs-preview-fallback', 'rgba(128, 128, 128, 0.4)'),
        "boolean_fill": getVar('--cvs-boolean-fill', '#000000'),
        "control_line_width": 1, 
        "path_stroke_width": 1,
        "hovered_curve_width_multiplier": 2
    };
}
updateThemeParams();