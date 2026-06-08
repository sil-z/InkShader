const TEMPLATE_HTML = `
    <div class="logger-scroll">
        <div class="prop_panel_title_wrapper">
            <div class="panel_title">Terminal</div>
        </div>
        <div class="logger-output" id="logger_output"></div>
    </div>
    <div class="input-wrapper">
        <input type="text" class="logger-input" id="logger_input" data-i18n-placeholder="log.placeholder">
    </div>
`;

export class LoggerPanel extends HTMLElement {
    connectedCallback() {
        if (!this._domReady) {
            this._domReady = true;
            this.innerHTML = TEMPLATE_HTML;
            this.output = this.querySelector('#logger_output');
            this.input = this.querySelector('#logger_input');
            this.scrollEl = this.querySelector('.logger-scroll');

            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && this.input.value.trim()) {
                    this.log(`> ${this.input.value}`, 'user');
                    this.input.value = '';
                }
            });

            this.scrollEl.addEventListener('mouseenter', () => {
                this.scrollEl.classList.add('show-scrollbar');
            });
            this.scrollEl.addEventListener('mouseleave', () => {
                this.scrollEl.classList.remove('show-scrollbar');
            });

            this.hijackConsole();
        }
    }

    log(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-msg">${message}</span>`;
        this.output.appendChild(entry);
        this.output.scrollTop = this.output.scrollHeight;
        if (this.output.children.length > 100) this.output.removeChild(this.output.firstChild);
    }

    hijackConsole() {
        const wrap = (original, type) => (...args) => {
            original.apply(console, args);
            this.log(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), type);
        };
        console.log = wrap(console.log, 'info');
        console.warn = wrap(console.warn, 'warn');
        console.error = wrap(console.error, 'error');
    }
}
customElements.define('logger-panel', LoggerPanel);