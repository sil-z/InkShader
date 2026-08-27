// js/ui/preferences_modal.js
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import {
    installEnterBlurHandler,
    rememberInputValue
} from "./input_validation.js";
import { createCustomSelect } from "./custom_select.js";
import { THEME_PRESETS, applyAccentPalette, clearAccentPalette } from "../services/theme_generator.js";

function buildAccentOptions() {
    return THEME_PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

const TEMPLATE_HTML = `
<div class="pen-tool-popup-body">
    <div class="pen-tool-row">
        <label data-i18n="pref.lang">Language</label>
        <select id="pref_lang" class="font-popup-input">
            <option value="en">English</option>
            <option value="zh">中文</option>
        </select>
    </div>
    <div class="pen-tool-separator"></div>
    <div class="pen-tool-row">
        <label data-i18n="pref.theme">Theme</label>
        <select id="pref_theme" class="font-popup-input">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
        </select>
    </div>
    <div class="pen-tool-separator"></div>
    <div class="pen-tool-row">
        <label data-i18n="pref.accentHue">Accent</label>
        <select id="pref_accent_hue" class="font-popup-input">
            ${buildAccentOptions()}
        </select>
    </div>
    <div class="pen-tool-separator"></div>
    <div id="pref_colors"></div>
</div>`;

const CONFIGURABLE_COLORS = [
    { varName: '--cvs-path-stroke', key: 'color.path_stroke' }
];

export class PreferencesPopup extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
        this.customColors = {};
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;
        this.innerHTML = TEMPLATE_HTML;
        this._visible = false;
        installEnterBlurHandler(this);

        // Convert native <select> to custom styled dropdowns
        this.querySelectorAll('select').forEach(sel => createCustomSelect(sel));

        this.addEventListener('mousedown', (e) => e.stopPropagation());
        this.addEventListener('focusin', (e) => {
            if (e.target?.tagName === 'INPUT') rememberInputValue(this, e.target);
        });

        this.loadSettings();
        this.bindEvents();
        this.buildColorPickers();

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
            // Allow menu bar items to handle toggle/switch via their click handlers
            if (e.target.closest('.top .item')) return;
            // Custom select panels live in document.body (position:fixed) so they
            // are outside the modal's DOM tree.  Treat clicks on them as inside.
            if (e.target.closest('.cs-panel')) return;
            if (!this.contains(e.target)) this.hide();
        }, true);
    }

    show(anchorEl) {
        this.loadSettings();
        this.refreshColorInputs();
        this.classList.add('visible');
        this._visible = true;

        requestAnimationFrame(() => {
            const btnRect = anchorEl.getBoundingClientRect();
            let left = btnRect.left;
            let top = btnRect.bottom + 2;
            const popupRect = this.getBoundingClientRect();

            if (left + popupRect.width > window.innerWidth - 4) {
                left = window.innerWidth - popupRect.width - 4;
            }
            if (top + popupRect.height > window.innerHeight - 4) {
                top = btnRect.top - popupRect.height - 2;
            }

            this.style.left = left + 'px';
            this.style.top = top + 'px';
        });
    }

    hide() {
        this.classList.remove('visible');
        this._visible = false;
    }

    bindEvents() {
        this.querySelector('#pref_lang').addEventListener('change', (e) => {
            if (window.I18n) window.I18n.setLang(e.target.value);
        });

        this.querySelector('#pref_theme').addEventListener('change', (e) => {
            this.applyTheme(e.target.value);
            this.saveSettings();
        });

        this.querySelector('#pref_accent_hue').addEventListener('change', (e) => {
            this.applyAccentHue(e.target.value);
            this.saveSettings();
        });
    }

    buildColorPickers() {
        const container = this.querySelector('#pref_colors');
        container.innerHTML = '';
        const t = window.I18n ? window.I18n.t.bind(window.I18n) : (k) => k;
        const self = this;

        CONFIGURABLE_COLORS.forEach(item => {
            const row = document.createElement('div');
            row.className = 'pen-tool-row';

            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();

            const swatchId = 'sw_' + item.varName.replace(/-/g, '_');

            row.innerHTML = `
                <label>${t(item.key)}</label>
                <div class="pref-color-swatch" id="${swatchId}" style="background-color:${currentVal};">
                    <div class="pref-color-swatch-checker"></div>
                    <div class="pref-color-swatch-fill" style="background-color:${currentVal};"></div>
                </div>
                <button class="pref-color-reset-btn" data-var-name="${item.varName}" title="Reset">
                    <img src="./assets/icons/reset.svg" alt="Reset">
                </button>
            `;

            container.appendChild(row);

            const swatch = row.querySelector(`#${swatchId}`);

            // Swatch click → open the RGBA picker
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                showRgbaPicker(swatch, item.varName, (rgba) => {
                    swatch.querySelector('.pref-color-swatch-fill').style.backgroundColor = rgba;
                    self.updateCustomColor(item.varName, rgba);
                });
            });

            // Per-row reset: clear the custom color override for this variable
            row.querySelector('.pref-color-reset-btn').addEventListener('click', () => {
                delete this.customColors[item.varName];
                document.documentElement.style.removeProperty(item.varName);
                this.refreshColorInputs();
                this.saveSettings();
                this.notifyCanvasUpdate();
            });
        });
    }

    refreshColorInputs() {
        CONFIGURABLE_COLORS.forEach(item => {
            const sid = 'sw_' + item.varName.replace(/-/g, '_');
            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
            const swatch = this.querySelector(`#${sid}`);
            if (swatch) {
                const fill = swatch.querySelector('.pref-color-swatch-fill');
                if (fill) fill.style.backgroundColor = currentVal;
            }
        });
    }

    updateCustomColor(varName, value) {
        this.customColors[varName] = value;
        document.documentElement.style.setProperty(varName, value);
        this.saveSettings();
        this.notifyCanvasUpdate();
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        Object.keys(this.customColors).forEach(key => {
            document.documentElement.style.setProperty(key, this.customColors[key]);
        });
        // Re-apply accent palette for new mode (light/dark have different values)
        const accentId = document.querySelector('#pref_accent_hue')?.value || 'blue';
        this.applyAccentHue(accentId);
    }

    applyAccentHue(presetId) {
        const preset = THEME_PRESETS.find(p => p.id === presetId);
        if (!preset) return;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        // Store the preset ID separately so saveSettings can read it back
        document.documentElement.dataset.accentPreset = presetId;
        applyAccentPalette(preset.hue, isDark);
        this.notifyCanvasUpdate();
    }

    notifyCanvasUpdate() {
        CanvasDispatcher.notifyThemeAndRedraw();
    }

    saveSettings() {
        const settings = {
            theme: document.documentElement.getAttribute('data-theme') || 'light',
            accentHue: document.documentElement.dataset.accentPreset || 'blue',
            customColors: this.customColors
        };
        localStorage.setItem('InkShader_preferences', JSON.stringify(settings));
    }

    /** Sync a native <select> value AND update the custom select wrapper display */
    _setSelectValue(selector, value) {
        const sel = this.querySelector(selector);
        if (!sel) return;
        sel.value = value;
        // The wrapper is the previous sibling (cs-wrapper inserted before the hidden select)
        const wrapper = sel.previousElementSibling;
        if (wrapper && wrapper._csSetValue) wrapper._csSetValue(value);
    }

    loadSettings() {
        try {
            if (window.I18n) {
                this._setSelectValue('#pref_lang', window.I18n.lang);
            }
            const data = localStorage.getItem('InkShader_preferences');
            if (data) {
                const settings = JSON.parse(data);
                // Set ALL select values BEFORE applying, so applyTheme can read
                // the correct accent from the select without a second notification.
                if (settings.theme) {
                    this._setSelectValue('#pref_theme', settings.theme);
                }
                if (settings.customColors) {
                    this.customColors = settings.customColors;
                }
                if (settings.accentHue) {
                    // Handle legacy 'generated' value from before preset IDs were stored
                    const accentId = (settings.accentHue === 'generated') ? 'blue' : settings.accentHue;
                    this._setSelectValue('#pref_accent_hue', accentId);
                }
                // applyTheme internally reads accent from select and calls applyAccentHue,
                // so a single call handles both theme + accent in one notification.
                const theme = settings.theme || 'light';
                this.applyTheme(theme);
            } else {
                // No saved settings — apply default accent (blue)
                this.applyAccentHue('blue');
            }
        } catch (e) { console.warn("Failed to load preferences", e); }
    }

}

customElements.define('preferences-popup', PreferencesPopup);

// ── Standalone helpers ──
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = mx === 0 ? 0 : d / mx, v = mx;
    if (d !== 0) {
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (mx === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return { h, s, v };
}
function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ── Custom RGBA picker ──
let _rgbaEl = null, _rgbaCleanup = null;

function getPickerEl() {
    if (_rgbaEl) return _rgbaEl;
    const el = document.createElement('div');
    el.className = 'rgba-picker';
    document.body.appendChild(el);
    // Enter blurs the input, committing its value (same convention as the app popups)
    el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.target?.tagName !== 'INPUT') return;
        event.preventDefault();
        event.target.blur();
    });
    _rgbaEl = el;
    return el;
}

let _probeCtx = null;
function getProbeCtx() {
    if (!_probeCtx) _probeCtx = document.createElement('canvas').getContext('2d');
    return _probeCtx;
}

/**
 * Parse any CSS color string (hex, rgb/rgba, hsl/hsla, named colors, ...)
 * into { r, g, b, a } via the canvas serializer + CSS.supports, so every
 * format the browser understands is accepted. Returns null when invalid.
 *
 * @param {string} str - Color string to parse
 * @returns {{ r: number, g: number, b: number, a: number }|null} Parsed RGBA
 */
function parseCssColorToRgba(str) {
    if (typeof str !== 'string') return null;
    const s = str.trim();
    if (!s || !CSS.supports('color', s)) return null;
    const ctx = getProbeCtx();
    ctx.fillStyle = s;
    const res = ctx.fillStyle;
    // Canvas serializes opaque colors as "#rrggbb" and translucent ones as "rgba(r, g, b, a)"
    let m = res.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (m) {
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
    }
    m = res.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!m) return null;
    return {
        r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
        g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
        b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
        a: m[4] !== undefined ? Math.max(0, Math.min(1, roundAlpha(parseFloat(m[4])))) : 1
    };
}

// Clamp an alpha value to 0-1 with 2-decimal precision (matches slider step)
function roundAlpha(a) {
    return Math.max(0, Math.min(1, Math.round((Number.isFinite(a) ? a : 0) * 100) / 100));
}

/** Format an alpha value (0-1) as a trimmed decimal string, e.g. "1", "0.5". */
function fmtAlpha(a) {
    return String(parseFloat(a.toFixed(2)));
}

/** Canonical rgba() string without spaces, e.g. "rgba(255,0,0,1)". */
function rgbaString(r, g, b, a) {
    return `rgba(${r},${g},${b},${fmtAlpha(a)})`;
}

// Checkerboard layers used behind the alpha slider track and the preview swatch
const CHECKER_LAYERS = [
    'linear-gradient(45deg, #d8d8d8 25%, transparent 25%)',
    'linear-gradient(-45deg, #d8d8d8 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, #d8d8d8 75%)',
    'linear-gradient(-45deg, transparent 75%, #d8d8d8 75%)'
].join(',');
const CHECKER_SIZE = 8;

function showRgbaPicker(anchorEl, varName, onChange) {
    if (_rgbaCleanup) _rgbaCleanup();
    const el = getPickerEl();

    const cur = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || 'rgba(128,128,128,1)';
    const parsed = parseCssColorToRgba(cur) || { r: 128, g: 128, b: 128, a: 1 };
    // RGB is the source of truth; HSV is derived for the SV box + hue bar
    const st = { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a };

    const SW = 220, SH = 150, HH = 14;

    el.innerHTML = `
        <div class="rgba-picker-sat">
            <canvas width="${SW}" height="${SH}"></canvas>
            <div class="rgba-picker-sat-cur"></div>
        </div>
        <div class="rgba-picker-hue">
            <canvas width="${SW}" height="${HH}"></canvas>
            <div class="rgba-picker-hue-cur"></div>
        </div>
        <div class="rgba-picker-rows">
            <div class="rgba-picker-row">
                <label>R</label>
                <input type="range" class="rgba-picker-ch-slider" data-ch="r" min="0" max="255" step="1">
                <input type="text" class="rgba-picker-ch-val" data-ch="r" inputmode="numeric" spellcheck="false" autocomplete="off">
            </div>
            <div class="rgba-picker-row">
                <label>G</label>
                <input type="range" class="rgba-picker-ch-slider" data-ch="g" min="0" max="255" step="1">
                <input type="text" class="rgba-picker-ch-val" data-ch="g" inputmode="numeric" spellcheck="false" autocomplete="off">
            </div>
            <div class="rgba-picker-row">
                <label>B</label>
                <input type="range" class="rgba-picker-ch-slider" data-ch="b" min="0" max="255" step="1">
                <input type="text" class="rgba-picker-ch-val" data-ch="b" inputmode="numeric" spellcheck="false" autocomplete="off">
            </div>
            <div class="rgba-picker-row">
                <label>A</label>
                <input type="range" class="rgba-picker-ch-slider" data-ch="a" min="0" max="1" step="0.01">
                <input type="text" class="rgba-picker-ch-val" data-ch="a" inputmode="decimal" spellcheck="false" autocomplete="off">
            </div>
        </div>
        <div class="rgba-picker-footer">
            <div class="rgba-picker-preview">
                <div class="rgba-picker-preview-checker"></div>
                <div class="rgba-picker-preview-fill"></div>
            </div>
            <input class="rgba-picker-rgba-text" type="text" spellcheck="false" autocomplete="off">
        </div>
    `;
    el.removeAttribute('style');

    const satCv = el.querySelector('.rgba-picker-sat canvas');
    const satCur = el.querySelector('.rgba-picker-sat-cur');
    const satArea = el.querySelector('.rgba-picker-sat');
    const hueCv = el.querySelector('.rgba-picker-hue canvas');
    const hueCur = el.querySelector('.rgba-picker-hue-cur');
    const hueBar = el.querySelector('.rgba-picker-hue');
    const previewFill = el.querySelector('.rgba-picker-preview-fill');
    const rgbaText = el.querySelector('.rgba-picker-rgba-text');
    const sliders = [...el.querySelectorAll('.rgba-picker-ch-slider')];
    const chVals = [...el.querySelectorAll('.rgba-picker-ch-val')];

    function currentHsv() {
        return rgbToHsv(st.r, st.g, st.b);
    }
    function applyHsv(h, s, v) {
        const c = hsvToRgb(h, s, v);
        st.r = c.r; st.g = c.g; st.b = c.b;
    }

    function drawSat() {
        const ctx = satCv.getContext('2d');
        const c = hsvToRgb(currentHsv().h, 1, 1);
        ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        ctx.fillRect(0, 0, SW, SH);
        const wG = ctx.createLinearGradient(0, 0, SW, 0);
        wG.addColorStop(0, '#fff'); wG.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = wG; ctx.fillRect(0, 0, SW, SH);
        const bG = ctx.createLinearGradient(0, 0, 0, SH);
        bG.addColorStop(0, 'rgba(0,0,0,0)'); bG.addColorStop(1, '#000');
        ctx.fillStyle = bG; ctx.fillRect(0, 0, SW, SH);
    }
    function drawHue() {
        const ctx = hueCv.getContext('2d');
        hueCv.width = SW; hueCv.height = HH;
        const g = ctx.createLinearGradient(0, 0, SW, 0);
        g.addColorStop(0, '#ff0000'); g.addColorStop(1/6, '#ffff00'); g.addColorStop(2/6, '#00ff00');
        g.addColorStop(3/6, '#00ffff'); g.addColorStop(4/6, '#0000ff'); g.addColorStop(5/6, '#ff00ff'); g.addColorStop(1, '#ff0000');
        ctx.fillStyle = g; ctx.fillRect(0, 0, SW, HH);
    }
    // Paint each channel track with a preview gradient (checkerboard for alpha)
    function setSliderTrackBg() {
        sliders.forEach(sl => {
            const ch = sl.dataset.ch;
            let bg = '', size = '', pos = '';
            if (ch === 'r') bg = `linear-gradient(to right, rgb(0,${st.g},${st.b}), rgb(255,${st.g},${st.b}))`;
            else if (ch === 'g') bg = `linear-gradient(to right, rgb(${st.r},0,${st.b}), rgb(${st.r},255,${st.b}))`;
            else if (ch === 'b') bg = `linear-gradient(to right, rgb(${st.r},${st.g},0), rgb(${st.r},${st.g},255))`;
            else {
                bg = `linear-gradient(to right, rgba(${st.r},${st.g},${st.b},0), rgba(${st.r},${st.g},${st.b},1)), ${CHECKER_LAYERS}`;
                size = `100% 100%, ${CHECKER_SIZE}px ${CHECKER_SIZE}px, ${CHECKER_SIZE}px ${CHECKER_SIZE}px, ${CHECKER_SIZE}px ${CHECKER_SIZE}px, ${CHECKER_SIZE}px ${CHECKER_SIZE}px`;
                pos = `0 0, 0 0, 0 ${CHECKER_SIZE / 2}px, ${CHECKER_SIZE / 2}px -${CHECKER_SIZE / 2}px, -${CHECKER_SIZE / 2}px 0`;
            }
            sl.style.setProperty('--track-bg', bg);
            if (size) {
                sl.style.setProperty('--track-size', size);
                sl.style.setProperty('--track-pos', pos);
            } else {
                sl.style.removeProperty('--track-size');
                sl.style.removeProperty('--track-pos');
            }
        });
    }
    function render() {
        drawSat(); drawHue();
        const hsv = currentHsv();
        satCur.style.left = (hsv.s * SW) + 'px';
        satCur.style.top = ((1 - hsv.v) * SH) + 'px';
        hueCur.style.left = (hsv.h * SW) + 'px';
        const text = rgbaString(st.r, st.g, st.b, st.a);
        previewFill.style.backgroundColor = text;
        rgbaText.value = text;
        sliders.forEach(sl => {
            const ch = sl.dataset.ch;
            sl.value = (ch === 'a') ? st.a : st[ch];
        });
        chVals.forEach(inp => {
            const ch = inp.dataset.ch;
            inp.value = (ch === 'a') ? fmtAlpha(st.a) : String(st[ch]);
        });
        setSliderTrackBg();
    }
    function emit() {
        onChange(rgbaString(st.r, st.g, st.b, st.a));
    }
    render();

    el.classList.add('visible');
    requestAnimationFrame(() => {
        const ar = anchorEl.getBoundingClientRect();
        const pr = el.getBoundingClientRect();
        let left = ar.right + 6, top = ar.top;
        if (left + pr.width > window.innerWidth - 4) left = ar.left - pr.width - 6;
        if (top + pr.height > window.innerHeight - 4) top = window.innerHeight - pr.height - 4;
        if (top < 4) top = 4; if (left < 4) left = 4;
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    });

    // Channel sliders → update the matching channel directly
    sliders.forEach(sl => {
        sl.addEventListener('input', () => {
            const ch = sl.dataset.ch;
            st[ch] = (ch === 'a') ? roundAlpha(parseFloat(sl.value)) : parseInt(sl.value, 10);
            render(); emit();
        });
    });

    // Channel value inputs → parse, clamp, and fall back to the canonical value on garbage
    chVals.forEach(inp => {
        inp.addEventListener('change', () => {
            const ch = inp.dataset.ch;
            const v = parseFloat(inp.value);
            if (Number.isNaN(v)) { render(); return; }
            if (ch === 'a') {
                st.a = Math.max(0, Math.min(1, roundAlpha(v)));
            } else {
                st[ch] = Math.max(0, Math.min(255, Math.round(v)));
            }
            render(); emit();
        });
    });

    // rgba string input → accept any CSS color, normalize to rgba(), fall back on failure
    rgbaText.addEventListener('change', () => {
        const p = parseCssColorToRgba(rgbaText.value);
        if (!p) {
            rgbaText.classList.add('invalid');
            setTimeout(() => rgbaText.classList.remove('invalid'), 600);
            render();
            return;
        }
        st.r = p.r; st.g = p.g; st.b = p.b; st.a = p.a;
        render(); emit();
    });

    let drag = null;
    function mv(e) {
        if (drag === 's') {
            const r = satArea.getBoundingClientRect();
            const hsv = currentHsv();
            applyHsv(hsv.h, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)));
            render(); emit();
        } else if (drag === 'h') {
            const r = hueBar.getBoundingClientRect();
            const hsv = currentHsv();
            applyHsv(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), hsv.s, hsv.v);
            render(); emit();
        }
    }
    function up() { drag = null; }
    function close(e) {
        if (!el.contains(e.target) && !anchorEl.contains(e.target)) hideRgbaPicker();
    }
    satArea.addEventListener('mousedown', (e) => { drag = 's'; mv(e); e.preventDefault(); });
    hueBar.addEventListener('mousedown', (e) => { drag = 'h'; mv(e); e.preventDefault(); });
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);

    _rgbaCleanup = () => {
        el.classList.remove('visible');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('mousedown', close, true);
        _rgbaCleanup = null;
    };
}

function hideRgbaPicker() {
    if (_rgbaCleanup) _rgbaCleanup();
    if (_rgbaEl) _rgbaEl.classList.remove('visible');
}
