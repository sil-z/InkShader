// js/ui/preferences_modal.js
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import {
    installEnterBlurHandler,
    rememberInputValue,
    restoreRememberedInputValue,
    trimmedInputValue
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

        CONFIGURABLE_COLORS.forEach(item => {
            const row = document.createElement('div');
            row.className = 'pen-tool-row';

            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
            let hexVal = this.rgbaToHex(currentVal);

            const textId = 'txt_' + item.varName.replace(/-/g, '_');
            const cpId = 'cp_' + item.varName.replace(/-/g, '_');

            row.innerHTML = `
                <label>${t(item.key)}</label>
                <input type="color" id="${cpId}" value="${hexVal}" style="width:28px;height:22px;padding:1px;flex:none;">
                <input type="text" id="${textId}" value="${currentVal}" style="width:80px;flex:none;">
                <button class="pref-color-reset-btn" data-var-name="${item.varName}" title="Reset">
                    <img src="./assets/icons/reset.svg" alt="Reset">
                </button>
            `;

            container.appendChild(row);

            const colorInput = row.querySelector(`#${cpId}`);
            const textInput = row.querySelector(`#${textId}`);

            // Per-row reset: clear the custom color override for this variable
            row.querySelector('.pref-color-reset-btn').addEventListener('click', () => {
                delete this.customColors[item.varName];
                document.documentElement.style.removeProperty(item.varName);
                this.refreshColorInputs();
                this.saveSettings();
                this.notifyCanvasUpdate();
            });

            colorInput.addEventListener('input', (e) => {
                textInput.value = e.target.value;
                this.updateCustomColor(item.varName, e.target.value);
            });

            textInput.addEventListener('change', (e) => {
                let val = trimmedInputValue(e.target);
                if (!this.isValidColorValue(val)) {
                    restoreRememberedInputValue(this, e.target, currentVal);
                    colorInput.value = this.rgbaToHex(e.target.value);
                    return;
                }
                e.target.value = val;
                colorInput.value = this.rgbaToHex(val);
                this.updateCustomColor(item.varName, val);
            });
        });
    }

    refreshColorInputs() {
        CONFIGURABLE_COLORS.forEach(item => {
            const tid = 'txt_' + item.varName.replace(/-/g, '_');
            const cid = 'cp_' + item.varName.replace(/-/g, '_');
            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
            const textInput = this.querySelector(`#${tid}`);
            const colorInput = this.querySelector(`#${cid}`);
            if (textInput && colorInput) {
                textInput.value = currentVal;
                colorInput.value = this.rgbaToHex(currentVal);
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

    rgbaToHex(color) {
        if (!color) return "#000000";
        if (color.startsWith('#')) return color.substring(0, 7);
        const match = color.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const r = parseInt(match[1]).toString(16).padStart(2, '0');
            const g = parseInt(match[2]).toString(16).padStart(2, '0');
            const b = parseInt(match[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        return "#000000";
    }

    isValidColorValue(value) {
        return typeof value === 'string' && value.trim().length > 0 && CSS.supports('color', value.trim());
    }
}

customElements.define('preferences-popup', PreferencesPopup);
