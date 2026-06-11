// js/ui/dropdown_menu.js

export class DropdownMenu extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
        this._cleanup = null;
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;
        this.classList.add('save-dropdown');

        this.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    show(anchorEl, items = []) {
        this.innerHTML = '';
        this._buildItems(items, this);
        this.classList.add('show');
        this._visible = true;

        requestAnimationFrame(() => {
            const btnRect = anchorEl.getBoundingClientRect();
            let left = btnRect.left;
            let top = btnRect.bottom + 2;
            const menuRect = this.getBoundingClientRect();

            if (left + menuRect.width > window.innerWidth - 4) {
                left = window.innerWidth - menuRect.width - 4;
            }
            if (top + menuRect.height > window.innerHeight - 4) {
                top = btnRect.top - menuRect.height - 2;
            }

            this.style.left = left + 'px';
            this.style.top = top + 'px';
        });

        this._cleanup = (e) => {
            if (!this.contains(e.target)) this.hide();
        };
        document.addEventListener('mousedown', this._cleanup, true);
    }

    hide() {
        this.classList.remove('show');
        this._visible = false;
        this.querySelectorAll('.save-dropdown-sub.show').forEach(s => s.classList.remove('show'));
        if (this._cleanup) {
            document.removeEventListener('mousedown', this._cleanup, true);
            this._cleanup = null;
        }
    }

    _positionSub(sub, parentItem) {
        const r = parentItem.getBoundingClientRect();
        let left = r.right + 2;
        let top = r.top;

        sub.style.left = left + 'px';
        sub.style.top = top + 'px';

        requestAnimationFrame(() => {
            const sr = sub.getBoundingClientRect();
            if (sr.right > window.innerWidth - 4) {
                sub.style.left = (r.left - sr.width - 2) + 'px';
            }
            if (sr.bottom > window.innerHeight - 4) {
                sub.style.top = (window.innerHeight - sr.height - 4) + 'px';
            }
        });
    }

    _buildItems(items, container) {
        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'save-dropdown-separator';
                container.appendChild(sep);
                continue;
            }

            const div = document.createElement('div');
            div.className = 'save-dropdown-item' + (item.disabled ? ' disabled' : '');

            const label = document.createElement('span');
            label.className = 'save-dropdown-label';
            label.textContent = item.label || '';
            if (item.i18n) label.setAttribute('data-i18n', item.i18n);
            div.appendChild(label);

            if (item.shortcut) {
                const sc = document.createElement('span');
                sc.className = 'shortcut';
                sc.textContent = item.shortcut;
                div.appendChild(sc);
            }

            if (item.children && item.children.length) {
                const arrow = document.createElement('span');
                arrow.className = 'save-dropdown-arrow';
                arrow.textContent = '\u25B8';
                div.appendChild(arrow);

                const sub = document.createElement('div');
                sub.className = 'save-dropdown save-dropdown-sub';
                this._buildItems(item.children, sub);
                div.appendChild(sub);

                let hideTimer = null;
                div.addEventListener('mouseenter', () => {
                    clearTimeout(hideTimer);
                    this._positionSub(sub, div);
                    sub.classList.add('show');
                });
                div.addEventListener('mouseleave', () => {
                    hideTimer = setTimeout(() => sub.classList.remove('show'), 80);
                });
                sub.addEventListener('mouseenter', () => clearTimeout(hideTimer));
                sub.addEventListener('mouseleave', () => sub.classList.remove('show'));
            }

            if (!item.disabled && item.action) {
                div.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hide();
                    item.action();
                });
            }

            container.appendChild(div);
        }
    }
}

customElements.define('dropdown-menu', DropdownMenu);
