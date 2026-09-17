// js/help_modal.js

const TEMPLATE_HTML = `
    <div class="pref_modal_overlay" id="help_overlay">
        <div class="pref_modal_container help_modal_container">
            <div class="pref_modal_header">
                <span data-i18n="help.title">Help & Shortcuts</span>
                <div class="pref_close_btn" id="btn_close_help">✕</div>
            </div>
            <div class="pref_modal_body help_modal_body">
                <h4 class="help_title" data-i18n="help.shortcuts">Keyboard Shortcuts</h4>
                <ul class="help_list">
                    <li data-i18n="help.s.tools">1-5 : Select / Node / Draw / Ellipse / Measure</li>
                    <li data-i18n="help.s.undo">Ctrl+Z : Undo</li>
                    <li data-i18n="help.s.redo">Ctrl+Y / Ctrl+Shift+Z : Redo</li>
                    <li data-i18n="help.s.copy">Ctrl+C / Ctrl+V : Copy / Paste</li>
                    <li data-i18n="help.s.duplicate">Ctrl+D : Duplicate</li>
                    <li data-i18n="help.s.del">Del / Backspace : Delete Objects</li>
                    <li data-i18n="help.s.node_modes">C / S / Y (Node tool) : Corner / Smooth / Symmetric</li>
                    <li data-i18n="help.s.node_ops">I / D (Node tool) : Insert Node / Delete Nodes</li>
                    <li data-i18n="help.s.union">Ctrl+U : Union</li>
                    <li data-i18n="help.s.intersection">Ctrl+Shift+U : Intersection</li>
                    <li data-i18n="help.s.difference">Ctrl+Alt+U : Difference (bottom minus top)</li>
                    <li data-i18n="help.s.exclusion">Ctrl+Alt+Shift+U : Exclusion</li>
                    <li data-i18n="help.s.expand">Ctrl+Shift+X : Expand Stroke</li>
                    <li data-i18n="help.s.new">Ctrl+N : New Project</li>
                    <li data-i18n="help.s.open">Ctrl+O : Open Project</li>
                    <li data-i18n="help.s.save">Ctrl+S : Save Project</li>
                    <li data-i18n="help.s.save_as">Ctrl+Shift+J : Save as JSON Project</li>
                    <li data-i18n="help.s.export_ufo">Ctrl+Shift+E : Save as UFO Project</li>
                    <li data-i18n="help.s.export_svg">Ctrl+Shift+S : Save as SVG File</li>
                    <li data-i18n="help.s.pan">Space+Drag / Middle-Click : Pan Canvas</li>
                    <li data-i18n="help.s.pan_arrow">Ctrl+Arrow : Pan</li>
                    <li data-i18n="help.s.zoom">Ctrl+Wheel / Ctrl+= / Ctrl+- : Zoom</li>
                    <li data-i18n="help.s.zoom_fixed">Alt+Wheel : Zoom at Fixed Center</li>
                    <li data-i18n="help.s.rotate_drag">Alt+Drag : Rotate Canvas View</li>
                    <li data-i18n="help.s.rotate_step">Alt+Left / Alt+Right : Rotate 5°</li>
                    <li data-i18n="help.s.rotate_reset">Alt+0 : Reset Rotation</li>
                    <li data-i18n="help.s.fullscreen">F11 : Toggle Fullscreen</li>
                    <li data-i18n="help.s.esc">Esc : Cancel / Deselect</li>
                </ul>
                <p class="help_note" data-i18n="help.notes.rotation">With the canvas rotated, only the sheet turns: the rulers, the sequence bar and the tool strip stay upright, so ruler ticks no longer sit under the document position they name.</p>
                <div class="pref_modal_actions">
                    <button id="btn_help_ok" class="pref_button_primary" data-i18n="help.close">Close</button>
                </div>
            </div>
        </div>
    </div>
`;

export class HelpModal extends HTMLElement {
    connectedCallback() {
        this.innerHTML = TEMPLATE_HTML;
        this.overlay = this.querySelector('#help_overlay');
        
        const closeAction = () => this.close();
        this.querySelector('#btn_close_help').addEventListener('click', closeAction);
        this.querySelector('#btn_help_ok').addEventListener('click', closeAction);
        this.overlay.addEventListener('mousedown', (e) => {
            if (e.target === this.overlay) closeAction();
        });
    }

    open() { this.overlay.classList.add('active'); }
    close() { this.overlay.classList.remove('active'); }
}
customElements.define('help-modal', HelpModal);