// js/ui/preferences_modal.js
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import {
    installEnterBlurHandler,
    rememberInputValue,
    restoreRememberedInputValue,
    trimmedInputValue
} from "./input_validation.js";

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
    <div id="pref_colors"></div>
    <div style="display:flex;justify-content:center;margin-top:6px;">
        <button id="pref_reset" class="pref_button_secondary" data-i18n="pref.reset">Reset to Default</button>
    </div>
</div>`;

const CONFIGURABLE_COLORS = [
    { varName: '--cvs-path-stroke', key: 'color.path_stroke' },
    { varName: '--cvs-path-fill', key: 'color.path_fill' }
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

        this.addEventListener('mousedown', (e) => e.stopPropagation());
        this.addEventListener('focusin', (e) => {
            if (e.target?.tagName === 'INPUT') rememberInputValue(this, e.target);
        });

        this.loadSettings();
        this.bindEvents();
        this.buildColorPickers();

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
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

        this.querySelector('#pref_reset').addEventListener('click', () => {
            this.customColors = {};
            CONFIGURABLE_COLORS.forEach(item => {
                document.documentElement.style.removeProperty(item.varName);
            });
            this.refreshColorInputs();
            this.saveSettings();
            this.notifyCanvasUpdate();
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
            `;

            container.appendChild(row);

            const colorInput = row.querySelector(`#${cpId}`);
            const textInput = row.querySelector(`#${textId}`);

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
        this.notifyCanvasUpdate();
    }

    notifyCanvasUpdate() {
        CanvasDispatcher.notifyThemeAndRedraw();
    }

    saveSettings() {
        const existing = JSON.parse(localStorage.getItem('InkShader_preferences') || '{}');
        const theme = existing.theme || document.documentElement.getAttribute('data-theme') || 'light';
        const settings = {
            theme,
            customColors: this.customColors
        };
        localStorage.setItem('InkShader_preferences', JSON.stringify(settings));
    }

    loadSettings() {
        try {
            if (window.I18n) {
                const langSel = this.querySelector('#pref_lang');
                if (langSel) langSel.value = window.I18n.lang;
            }
            const data = localStorage.getItem('InkShader_preferences');
            if (data) {
                const settings = JSON.parse(data);
                if (settings.theme) {
                    const themeSel = this.querySelector('#pref_theme');
                    if (themeSel) themeSel.value = settings.theme;
                }
                if (settings.customColors) {
                    this.customColors = settings.customColors;
                }
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
