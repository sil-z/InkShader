// js/preferences_modal.js
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";

const TEMPLATE_HTML = `
    <div class="pref_modal_overlay" id="pref_overlay">
        <div class="pref_modal_container">
            <div class="pref_modal_header">
                <span data-i18n="pref.title">Preferences</span>
                <div class="pref_close_btn" id="btn_close">✕</div>
            </div>
            <div class="pref_modal_body">
                <div class="pref_sidebar">
                    <div class="pref_tab active" data-target="sec_appearance" data-i18n="pref.general">General & Appearance</div>
                </div>
                <div class="pref_content_area">
                    <div class="pref_section active" id="sec_appearance">
                        <div class="pref_row">
                            <span class="pref_label" data-i18n="pref.lang">Language</span>
                            <select class="theme_select" id="lang_selector">
                                <option value="en">English</option>
                                <option value="zh">中文</option>
                            </select>
                        </div>
                        <div class="pref_row">
                            <span class="pref_label" data-i18n="pref.theme">Color Theme</span>
                            <select class="theme_select" id="theme_selector">
                                <option value="light" data-i18n="pref.theme.light">Light Mode (Default)</option>
                                <option value="dark" data-i18n="pref.theme.dark">Dark Mode</option>
                            </select>
                        </div>
                        <h4 style="margin: 20px 0 10px 0; border-bottom: 1px solid var(--ui-border); padding-bottom: 4px;" data-i18n="pref.override">Canvas Colors Override</h4>
                        <div id="color_overrides_container"></div>
                        <div class="pref_modal_actions">
                            <button id="btn_reset_colors" class="pref_button_secondary" data-i18n="pref.reset">Reset to Theme Default</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
`;

const CONFIGURABLE_COLORS = [
    { varName: '--cvs-path-stroke', key: 'color.path_stroke' },
    { varName: '--cvs-path-fill', key: 'color.path_fill' },
    { varName: '--cvs-preview', key: 'color.preview' },
    { varName: '--cvs-hover-stroke', key: 'color.hover_stroke' },
    { varName: '--cvs-oncurve-stroke', key: 'color.oncurve_stroke' },
    { varName: '--cvs-oncurve-fill', key: 'color.oncurve_fill' },
    { varName: '--cvs-selected-stroke', key: 'color.selected_stroke' },
    { varName: '--cvs-selected-fill', key: 'color.selected_fill' },
    { varName: '--cvs-ctrl-stroke', key: 'color.ctrl_stroke' },
    { varName: '--cvs-ctrl-fill', key: 'color.ctrl_fill' },
    { varName: '--cvs-ctrl-ahead', key: 'color.ctrl_ahead' },
    { varName: '--cvs-ctrl-back', key: 'color.ctrl_back' },
    { varName: '--cvs-guideline', key: 'color.guideline' },
    { varName: '--cvs-measure', key: 'color.measure' },
    { varName: '--cvs-select-box', key: 'color.select_box' },
    { varName: '--cvs-body-bg', key: 'color.body_bg' }
];

export class PreferencesModal extends HTMLElement {
    constructor() {
        super();
        this.customColors = {}; 
    }

    connectedCallback() {
        this.innerHTML = TEMPLATE_HTML;
        this.overlay = this.querySelector('#pref_overlay');
        this.bindEvents();
        this.loadSettings();
        this.buildColorPickers();
        
        this.querySelectorAll('select.theme_select').forEach(sel => this.initCustomSelect(sel));
        
        document.addEventListener('click', () => {
            document.querySelectorAll('.custom-select-wrapper.open').forEach(w => w.classList.remove('open'));
        });
    }

    initCustomSelect(select) {
        select.style.display = 'none';
        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select-wrapper';
        select.parentNode.insertBefore(wrapper, select);

        const trigger = document.createElement('div');
        trigger.className = 'custom-select-trigger';
        const span = document.createElement('span');
        
        const selOpt = select.options[select.selectedIndex];
        span.textContent = selOpt.text;
        if(selOpt.hasAttribute('data-i18n')) span.setAttribute('data-i18n', selOpt.getAttribute('data-i18n'));
        
        trigger.appendChild(span);
        trigger.innerHTML += `<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'custom-select-options';

        Array.from(select.options).forEach(opt => {
            const optionEl = document.createElement('div');
            optionEl.className = 'custom-option' + (opt.selected ? ' selected' : '');
            optionEl.textContent = opt.text;
            optionEl.dataset.value = opt.value;
            if(opt.hasAttribute('data-i18n')) optionEl.setAttribute('data-i18n', opt.getAttribute('data-i18n'));

            optionEl.addEventListener('click', (e) => {
                e.stopPropagation();
                select.value = opt.value;
                select.dispatchEvent(new Event('change'));

                const newSpan = trigger.querySelector('span');
                newSpan.textContent = opt.text;
                if (opt.hasAttribute('data-i18n')) newSpan.setAttribute('data-i18n', opt.getAttribute('data-i18n'));
                else newSpan.removeAttribute('data-i18n');

                optionsContainer.querySelectorAll('.custom-option').forEach(el => el.classList.remove('selected'));
                optionEl.classList.add('selected');
                wrapper.classList.remove('open');
            });
            optionsContainer.appendChild(optionEl);
        });

        wrapper.appendChild(trigger);
        wrapper.appendChild(optionsContainer);

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select-wrapper.open').forEach(w => {
                if (w !== wrapper) w.classList.remove('open');
            });
            wrapper.classList.toggle('open');
        });

        select.addEventListener('change', () => {
            const opt = select.options[select.selectedIndex];
            const newSpan = trigger.querySelector('span');
            newSpan.textContent = opt.text;
            if (opt.hasAttribute('data-i18n')) newSpan.setAttribute('data-i18n', opt.getAttribute('data-i18n'));
            optionsContainer.querySelectorAll('.custom-option').forEach(el => {
                el.classList.toggle('selected', el.dataset.value === select.value);
            });
        });
    }

    bindEvents() {
        this.querySelector('#btn_close').addEventListener('click', () => this.close());
        this.overlay.addEventListener('mousedown', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.querySelectorAll('.pref_tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.querySelectorAll('.pref_tab').forEach(t => t.classList.remove('active'));
                this.querySelectorAll('.pref_section').forEach(s => s.classList.remove('active'));
                
                const targetId = e.currentTarget.getAttribute('data-target');
                e.currentTarget.classList.add('active');
                this.querySelector('#' + targetId).classList.add('active');
            });
        });

        const langSelector = this.querySelector('#lang_selector');
        langSelector.addEventListener('change', (e) => {
            if (window.I18n) window.I18n.setLang(e.target.value);
        });

        const themeSelector = this.querySelector('#theme_selector');
        themeSelector.addEventListener('change', (e) => {
            this.applyTheme(e.target.value);
            this.saveSettings();
            this.refreshColorInputs();
        });

        this.querySelector('#btn_reset_colors').addEventListener('click', () => {
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
        const container = this.querySelector('#color_overrides_container');
        container.innerHTML = '';
        const t = window.I18n ? window.I18n.t.bind(window.I18n) : (k) => k;

        CONFIGURABLE_COLORS.forEach(item => {
            const row = document.createElement('div');
            row.className = 'pref_row';
            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
            let hexVal = this.rgbaToHex(currentVal);

            row.innerHTML = `
                <span class="pref_label">${t(item.key)}</span>
                <div class="color_picker_group">
                    <input type="color" id="cp_${item.varName}" value="${hexVal}">
                    <input type="text" id="txt_${item.varName}" value="${currentVal}">
                </div>
            `;

            container.appendChild(row);

            const colorInput = row.querySelector(`#cp_${item.varName}`);
            const textInput = row.querySelector(`#txt_${item.varName}`);

            colorInput.addEventListener('input', (e) => {
                textInput.value = e.target.value;
                this.updateCustomColor(item.varName, e.target.value);
            });

            textInput.addEventListener('change', (e) => {
                let val = e.target.value;
                colorInput.value = this.rgbaToHex(val);
                this.updateCustomColor(item.varName, val);
            });
        });
    }

    updateCustomColor(varName, value) {
        this.customColors[varName] = value;
        document.documentElement.style.setProperty(varName, value);
        this.saveSettings();
        this.notifyCanvasUpdate();
    }

    refreshColorInputs() {
        CONFIGURABLE_COLORS.forEach(item => {
            let currentVal = this.customColors[item.varName] || getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
            const colorInput = this.querySelector(`[id="cp_${item.varName}"]`);
            const textInput = this.querySelector(`[id="txt_${item.varName}"]`);
            if (colorInput && textInput) {
                colorInput.value = this.rgbaToHex(currentVal);
                textInput.value = currentVal;
            }
        });
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
        const theme = this.querySelector('#theme_selector').value;
        const settings = { 
            theme, 
            customColors: this.customColors
        };
        const existing = JSON.parse(localStorage.getItem('InkShader_preferences') || '{}');
        settings.fontSettings = existing.fontSettings || {};
        localStorage.setItem('InkShader_preferences', JSON.stringify(settings));
    }

    loadSettings() {
        try {
            if (window.I18n) {
                const langSel = this.querySelector('#lang_selector');
                langSel.value = window.I18n.lang;
                langSel.dispatchEvent(new Event('change'));
            }
            const data = localStorage.getItem('InkShader_preferences');
            if (data) {
                const settings = JSON.parse(data);
                if (settings.theme) {
                    const themeSel = this.querySelector('#theme_selector');
                    themeSel.value = settings.theme;
                    themeSel.dispatchEvent(new Event('change'));
                    this.applyTheme(settings.theme);
                }
                if (settings.customColors) {
                    this.customColors = settings.customColors;
                    this.applyTheme(settings.theme || 'light');
                }
            }
        } catch(e) { console.warn("Failed to load preferences", e); }
    }

    open() {
        this.overlay.classList.add('active');
        this.refreshColorInputs();
    }

    close() {
        this.overlay.classList.remove('active');
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
}
customElements.define('preferences-modal', PreferencesModal);