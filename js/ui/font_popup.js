// js/ui/font_popup.js
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";

const POPUP_HTML = `
<div class="pen-tool-popup-header" data-i18n="menu.font">Font</div>
<div class="pen-tool-popup-body">
    <div class="pen-tool-row">
        <label data-i18n="font.project_name">Project Name</label>
        <input type="text" id="font_popup_project_name" class="font-popup-input" placeholder="Auto-generated">
    </div>
    <div class="pen-tool-separator"></div>
    <div class="pen-tool-row">
        <label data-i18n="font.family">Family Name</label>
        <input type="text" id="font_popup_family" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.style">Style Name</label>
        <input type="text" id="font_popup_style" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.upm">UPM</label>
        <input type="number" min="1" step="1" id="font_popup_upm" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.ascender">Ascender</label>
        <input type="number" step="1" id="font_popup_ascender" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.descender">Descender</label>
        <input type="number" step="1" id="font_popup_descender" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.version">Version</label>
        <input type="text" id="font_popup_version" class="font-popup-input" placeholder="e.g. 1.0">
    </div>
    <div class="pen-tool-separator"></div>
    <div class="pen-tool-actions">
        <button type="button" id="font_popup_save" class="pref_button_primary" data-i18n="common.save">Save</button>
    </div>
</div>`;

const DEFAULT_FONT = {
    family: "InkShader Default Font",
    style: "Regular",
    upm: 1000,
    ascender: 800,
    descender: -200,
    version: "1.0"
};

export class FontPopup extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
        this._projectManager = null;
        this._canvas = null;
    }

    setProjectManager(pm) { this._projectManager = pm; }
    setCanvas(c) { this._canvas = c; }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;
        this.innerHTML = POPUP_HTML;

        this.addEventListener('mousedown', (e) => e.stopPropagation());

        this.querySelector('#font_popup_save')?.addEventListener('click', () => {
            this._save();
            this.hide();
        });

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
            if (e.button !== 0) return;
            if (!this.contains(e.target)) this.hide();
        }, true);
    }

    _loadSettings() {
        let fontSettings = { ...DEFAULT_FONT };
        try {
            const data = localStorage.getItem('InkShader_preferences');
            if (data) {
                const parsed = JSON.parse(data);
                if (parsed.fontSettings) fontSettings = { ...fontSettings, ...parsed.fontSettings };
            }
        } catch (e) {}

        let projectName = '';
        if (this._projectManager) {
            projectName = this._projectManager.getActiveProjectName() || '';
        }

        this.querySelector('#font_popup_project_name').value = projectName;
        this.querySelector('#font_popup_family').value = fontSettings.family;
        this.querySelector('#font_popup_style').value = fontSettings.style;
        this.querySelector('#font_popup_upm').value = fontSettings.upm;
        this.querySelector('#font_popup_ascender').value = fontSettings.ascender;
        this.querySelector('#font_popup_descender').value = fontSettings.descender;
        this.querySelector('#font_popup_version').value = fontSettings.version;
    }

    _save() {
        const projectName = this.querySelector('#font_popup_project_name').value.trim();
        const fontSettings = {
            family: this.querySelector('#font_popup_family').value.trim() || DEFAULT_FONT.family,
            style: this.querySelector('#font_popup_style').value.trim() || DEFAULT_FONT.style,
            upm: parseInt(this.querySelector('#font_popup_upm').value) || DEFAULT_FONT.upm,
            ascender: parseInt(this.querySelector('#font_popup_ascender').value) || DEFAULT_FONT.ascender,
            descender: parseInt(this.querySelector('#font_popup_descender').value) || DEFAULT_FONT.descender,
            version: this.querySelector('#font_popup_version').value.trim() || DEFAULT_FONT.version
        };

        try {
            const data = JSON.parse(localStorage.getItem('InkShader_preferences') || '{}');
            data.fontSettings = fontSettings;
            localStorage.setItem('InkShader_preferences', JSON.stringify(data));
        } catch (e) {}

        if (projectName && this._projectManager) {
            const oldName = this._projectManager.getActiveProjectName();
            if (oldName && oldName !== projectName) {
                this._projectManager.saveToCache(oldName).then(() => {
                    this._canvas?.history?._idbPut?.("projects", undefined);
                    import('./storage.js').then(({ StorageUtils }) => {
                        StorageUtils.renameProject(oldName, projectName).then(() => {
                            this._projectManager.setActiveProjectName(projectName);
                        });
                    });
                });
            } else if (!oldName) {
                this._projectManager.setActiveProjectName(projectName);
            }
        }

        this._canvas?.notifyPropertiesUpdate?.();
    }

    show(anchorEl) {
        this._loadSettings();
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
}

customElements.define('font-popup', FontPopup);
