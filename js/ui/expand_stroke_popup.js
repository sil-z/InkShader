/**
 * Expand Stroke Options Popup — right-click context menu for the expand stroke button.
 * Round cap is now set per-curve in Path Properties (property-panel).
 */
const POPUP_HTML = `
<div class="property_group_title" data-i18n="prop.expand_stroke">Expand Stroke</div>
<div class="npp-fields">
</div>`;

export class ExpandStrokePopup extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
        this._canvas = null;
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;

        this.innerHTML = POPUP_HTML;

        this.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        document.addEventListener('mousedown', (e) => {
            if (!this._visible) return;
            if (!this.contains(e.target)) {
                this.hide();
            }
        }, true);
    }

    show(anchorEl) {
        this._canvas = window.__canvas;
        this.classList.add('visible');

        requestAnimationFrame(() => {
            const rect = anchorEl.getBoundingClientRect();
            let left = rect.right + 2;
            let top = rect.top;
            const popupRect = this.getBoundingClientRect();

            if (left + popupRect.width > window.innerWidth - 4) {
                left = rect.left - popupRect.width - 2;
            }
            if (top + popupRect.height > window.innerHeight - 4) {
                top = window.innerHeight - popupRect.height - 4;
            }
            if (top < 4) top = 4;

            this.style.left = left + 'px';
            this.style.top = top + 'px';
        });
        this._visible = true;
    }

    hide() {
        this.classList.remove('visible');
        this._visible = false;
    }
}

customElements.define('expand-stroke-popup', ExpandStrokePopup);
