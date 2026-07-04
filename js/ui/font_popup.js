// js/ui/font_popup.js
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";

const POPUP_HTML = `
<div class="pen-tool-popup-body">
    <!-- Project -->
    <div class="pen-tool-row">
        <label data-i18n="font.project_name">Project Name</label>
        <input type="text" id="font_popup_project_name" class="font-popup-input">
    </div>

    <div class="pen-tool-separator"></div>

    <!-- Naming (name table) -->
    <div class="pen-tool-row">
        <label data-i18n="font.family">Family Name</label>
        <input type="text" id="font_popup_family" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.style">Style Name</label>
        <input type="text" id="font_popup_style" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.postscript_name">PostScript Name</label>
        <input type="text" id="font_popup_postscript_name" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.preferred_family">Preferred Family</label>
        <input type="text" id="font_popup_preferred_family" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.preferred_subfamily">Preferred Subfamily</label>
        <input type="text" id="font_popup_preferred_subfamily" class="font-popup-input">
    </div>

    <div class="pen-tool-separator"></div>

    <!-- Legal -->
    <div class="pen-tool-row">
        <label data-i18n="font.copyright">Copyright</label>
        <input type="text" id="font_popup_copyright" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.designer">Designer</label>
        <input type="text" id="font_popup_designer" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.designer_url">Designer URL</label>
        <input type="text" id="font_popup_designer_url" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.manufacturer">Manufacturer</label>
        <input type="text" id="font_popup_manufacturer" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.manufacturer_url">Manufacturer URL</label>
        <input type="text" id="font_popup_manufacturer_url" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.license">License</label>
        <input type="text" id="font_popup_license" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.license_url">License URL</label>
        <input type="text" id="font_popup_license_url" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.trademark">Trademark</label>
        <input type="text" id="font_popup_trademark" class="font-popup-input">
    </div>

    <div class="pen-tool-separator"></div>

    <!-- Description -->
    <div class="pen-tool-row">
        <label data-i18n="font.description">Description</label>
        <textarea id="font_popup_description" class="font-popup-input" rows="2"></textarea>
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.sample_text">Sample Text</label>
        <textarea id="font_popup_sample_text" class="font-popup-input" rows="2"></textarea>
    </div>

    <div class="pen-tool-separator"></div>

    <!-- Metrics (OS/2 + head) -->
    <div class="pen-tool-row">
        <label data-i18n="font.upm">UPM</label>
        <input type="number" min="16" max="16384" step="1" id="font_popup_upm" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.weight_class">Weight Class</label>
        <select id="font_popup_weight_class" class="font-popup-input">
            <option value="100">100 Thin</option>
            <option value="200">200 ExtraLight</option>
            <option value="300">300 Light</option>
            <option value="400" selected>400 Regular</option>
            <option value="500">500 Medium</option>
            <option value="600">600 SemiBold</option>
            <option value="700">700 Bold</option>
            <option value="800">800 ExtraBold</option>
            <option value="900">900 Black</option>
        </select>
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.width_class">Width Class</label>
        <select id="font_popup_width_class" class="font-popup-input">
            <option value="1">1 UltraCondensed</option>
            <option value="2">2 ExtraCondensed</option>
            <option value="3">3 Condensed</option>
            <option value="4">4 SemiCondensed</option>
            <option value="5" selected>5 Medium</option>
            <option value="6">6 SemiExpanded</option>
            <option value="7">7 Expanded</option>
            <option value="8">8 ExtraExpanded</option>
            <option value="9">9 UltraExpanded</option>
        </select>
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
        <label data-i18n="font.x_height">x-Height</label>
        <input type="number" step="1" id="font_popup_x_height" class="font-popup-input">
    </div>
    <div class="pen-tool-row">
        <label data-i18n="font.cap_height">Cap Height</label>
        <input type="number" step="1" id="font_popup_cap_height" class="font-popup-input">
    </div>

    <div class="pen-tool-separator"></div>

    <!-- Version -->
    <div class="pen-tool-row">
        <label data-i18n="font.version">Version</label>
        <input type="text" id="font_popup_version" class="font-popup-input">
    </div>

</div>`;

const DEFAULT_FONT = {
    family: "InkShader Default Font",
    style: "Regular",
    postscript_name: "",
    preferred_family: "",
    preferred_subfamily: "",
    copyright: "",
    designer: "",
    designer_url: "",
    manufacturer: "",
    manufacturer_url: "",
    license: "",
    license_url: "",
    trademark: "",
    description: "",
    sample_text: "",
    upm: 1000,
    weight_class: 400,
    width_class: 5,
    ascender: 800,
    descender: -200,
    x_height: 500,
    cap_height: 700,
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

        // Auto-save on focusout: when any input/select/textarea loses focus
        this.addEventListener('focusout', (e) => {
            if (!this._visible) return;
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
                this._save();
            }
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
        this.querySelector('#font_popup_postscript_name').value = fontSettings.postscript_name || '';
        this.querySelector('#font_popup_preferred_family').value = fontSettings.preferred_family || '';
        this.querySelector('#font_popup_preferred_subfamily').value = fontSettings.preferred_subfamily || '';
        this.querySelector('#font_popup_copyright').value = fontSettings.copyright || '';
        this.querySelector('#font_popup_designer').value = fontSettings.designer || '';
        this.querySelector('#font_popup_designer_url').value = fontSettings.designer_url || '';
        this.querySelector('#font_popup_manufacturer').value = fontSettings.manufacturer || '';
        this.querySelector('#font_popup_manufacturer_url').value = fontSettings.manufacturer_url || '';
        this.querySelector('#font_popup_license').value = fontSettings.license || '';
        this.querySelector('#font_popup_license_url').value = fontSettings.license_url || '';
        this.querySelector('#font_popup_trademark').value = fontSettings.trademark || '';
        this.querySelector('#font_popup_description').value = fontSettings.description || '';
        this.querySelector('#font_popup_sample_text').value = fontSettings.sample_text || '';
        this.querySelector('#font_popup_upm').value = fontSettings.upm;
        this.querySelector('#font_popup_weight_class').value = fontSettings.weight_class || DEFAULT_FONT.weight_class;
        this.querySelector('#font_popup_width_class').value = fontSettings.width_class || DEFAULT_FONT.width_class;
        this.querySelector('#font_popup_ascender').value = fontSettings.ascender;
        this.querySelector('#font_popup_descender').value = fontSettings.descender;
        this.querySelector('#font_popup_x_height').value = fontSettings.x_height != null ? fontSettings.x_height : DEFAULT_FONT.x_height;
        this.querySelector('#font_popup_cap_height').value = fontSettings.cap_height != null ? fontSettings.cap_height : DEFAULT_FONT.cap_height;
        this.querySelector('#font_popup_version').value = fontSettings.version;
    }

    _save() {
        const projectName = this.querySelector('#font_popup_project_name').value.trim();
        const fontSettings = {
            family: this.querySelector('#font_popup_family').value.trim() || DEFAULT_FONT.family,
            style: this.querySelector('#font_popup_style').value.trim() || DEFAULT_FONT.style,
            postscript_name: this.querySelector('#font_popup_postscript_name').value.trim(),
            preferred_family: this.querySelector('#font_popup_preferred_family').value.trim(),
            preferred_subfamily: this.querySelector('#font_popup_preferred_subfamily').value.trim(),
            copyright: this.querySelector('#font_popup_copyright').value.trim(),
            designer: this.querySelector('#font_popup_designer').value.trim(),
            designer_url: this.querySelector('#font_popup_designer_url').value.trim(),
            manufacturer: this.querySelector('#font_popup_manufacturer').value.trim(),
            manufacturer_url: this.querySelector('#font_popup_manufacturer_url').value.trim(),
            license: this.querySelector('#font_popup_license').value.trim(),
            license_url: this.querySelector('#font_popup_license_url').value.trim(),
            trademark: this.querySelector('#font_popup_trademark').value.trim(),
            description: this.querySelector('#font_popup_description').value.trim(),
            sample_text: this.querySelector('#font_popup_sample_text').value.trim(),
            upm: parseInt(this.querySelector('#font_popup_upm').value) || DEFAULT_FONT.upm,
            weight_class: parseInt(this.querySelector('#font_popup_weight_class').value) || DEFAULT_FONT.weight_class,
            width_class: parseInt(this.querySelector('#font_popup_width_class').value) || DEFAULT_FONT.width_class,
            ascender: parseInt(this.querySelector('#font_popup_ascender').value) || DEFAULT_FONT.ascender,
            descender: parseInt(this.querySelector('#font_popup_descender').value) || DEFAULT_FONT.descender,
            x_height: parseInt(this.querySelector('#font_popup_x_height').value) || DEFAULT_FONT.x_height,
            cap_height: parseInt(this.querySelector('#font_popup_cap_height').value) || DEFAULT_FONT.cap_height,
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
