/**
 * Expand Stroke Options Popup — right-click context menu for the expand stroke button.
 * Single checkbox to toggle between straight-line caps and semicircle (round) caps.
 */
const POPUP_HTML = `
<div class="property_group_title" data-i18n="prop.expand_stroke">Expand Stroke</div>
<div class="npp-fields">
    <div class="npp-row">
        <label data-i18n="prop.expand_round_cap">Round Cap</label>
        <input type="checkbox" id="expand_popup_round_cap">
    </div>
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

        this.addEventListener('change', (e) => {
            if (e.target.id === 'expand_popup_round_cap') {
                this._applyRoundCap(e.target.checked);
            }
        });

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

    _applyRoundCap(checked) {
        const canvas = this._canvas || window.__canvas;
        if (!canvas) return;
        canvas.expandStrokeRoundCap = !!checked;

        // Propagate to all smart-stroke curves so the live preview updates immediately
        const cm = canvas.curve_manager;
        const curveStore = cm?.curveStore;
        if (curveStore?.curveById) {
            curveStore.curveById.forEach((curve) => {
                if (curve.smart_stroke && curve.stroke_width > 0) {
                    curve._expandRoundCap = !!checked;
                    curve._lastHash = null;
                    curve._booleanContentHash = null;
                }
            });
            canvas.is_dirty = true;
        }
    }

    _syncFromCanvas() {
        const canvas = this._canvas || window.__canvas;
        const cb = this.querySelector('#expand_popup_round_cap');
        if (cb && canvas) {
            cb.checked = canvas.expandStrokeRoundCap === true;
        }
    }

    show(anchorEl) {
        this._canvas = window.__canvas;
        this._syncFromCanvas();
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
