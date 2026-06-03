// js/logger_panel.js

const TEMPLATE_HTML = `
    <div class="logger-panel collapsed" id="logger_main">
        <div class="logger-header" id="logger_header">
            <span class="logger-ball-icon">🐚</span> <span class="logger-title" data-i18n="log.title">Log Console</span>
            <span class="logger-close-icon">✕</span>
        </div>
        <div class="logger-body">
            <div class="logger-output" id="logger_output"></div>
            <input type="text" class="logger-input" id="logger_input" data-i18n-placeholder="log.placeholder">
        </div>
    </div>
`;

export class LoggerPanel extends HTMLElement {
    connectedCallback() {
        this.innerHTML = TEMPLATE_HTML;
        this.panel = this.querySelector('#logger_main');
        this.header = this.querySelector('#logger_header');
        this.output = this.querySelector('#logger_output');
        this.input = this.querySelector('#logger_input');

        this.header.addEventListener('click', () => {
            this.panel.classList.toggle('collapsed');
            if (!this.panel.classList.contains('collapsed')) {
                setTimeout(() => this.output.scrollTop = this.output.scrollHeight, 100);
            }
        });

        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.input.value.trim()) {
                this.log(`> ${this.input.value}`, 'user');
                this.input.value = '';
            }
        });

        this.hijackConsole();
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