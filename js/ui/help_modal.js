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
                    <li data-i18n="help.s.undo">Ctrl + Z : Undo</li>
                    <li data-i18n="help.s.redo">Ctrl + Y / Ctrl + Shift + Z : Redo</li>
                    <li data-i18n="help.s.pan">Space + Drag / Mid-Click : Pan Canvas</li>
                    <li data-i18n="help.s.del">Del : Delete Selected</li>
                    <li data-i18n="help.s.save">Ctrl + S : Quick Save</li>
                </ul>
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