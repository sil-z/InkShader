import { appEventBus } from "../app/event_bus.js";

const TEMPLATE_HTML = `
    <div class="logger-scroll">
        <div class="prop_panel_title_wrapper">
            <div class="panel_title">Console</div>
        </div>
        <div class="logger-output" id="logger_output"></div>
    </div>
    <div class="input-wrapper">
        <input type="text" class="logger-input" id="logger_input">
    </div>
`;

const COMMAND_LABELS = {
    'changeControlNodePosition': 'Move Control Point',
    'deleteControlNode': 'Delete Control Point',
    'changeSelectedNodesPosition': 'Move Nodes',
    'insertMainNode': 'Insert Node',
    'finishAddingPathCommand': 'Add Path',
    'deleteSelectedNodes': 'Delete Nodes',
    'deleteSelectedObjects': 'Delete Objects',
    'changeSelectedObjectsGroup': 'Change Group',
    'changeSelectedObjectsTransform': 'Transform Objects',
    'expandSelectedStroke': 'Expand Stroke',
    'booleanUnionSelectedCurves': 'Boolean Union',
    'unlinkSelectedReferences': 'Unlink Reference',

    'PASTE_COPIED_OBJECTS': 'Paste Objects',
    'DUPLICATE_SELECTED_OBJECTS': 'Duplicate Objects',
    'DELETE_SELECTED_OBJECTS': 'Delete Objects',
    'CHANGE_SELECTED_OBJECTS_GROUP': 'Change Group',
    'SET_SINGLE_OBJECT_PROPERTIES': 'Edit Properties',
    'CHANGE_SELECTED_OBJECTS_BOUNDS': 'Resize Objects',
    'RENAME_TREE_ITEM': 'Rename',
    'SET_GROUP_ADVANCE': 'Set Advance Width',
    'UPDATE_NODE_PROPERTY': 'Edit Node Property',
    'SET_PEN_PROPERTIES': 'Pen Settings',
    'SET_GROUP_CHAR_CODE': 'Set Character Code',
    'SET_SEQUENCE_EDITOR_STATE': 'Edit Sequence',
    'DELETE_GROUP_AND_UPDATE_SEQUENCE': 'Delete Group',
    'EXPAND_STROKE': 'Expand Stroke',
    'BOOLEAN_UNION': 'Boolean Union',
    'UNLINK': 'Unlink Reference',
    'IMPORT_IMAGE': 'Import Image',
    'TOGGLE_SELECTED_OBJECTS_LOCK': 'Toggle Lock',
    'TOGGLE_SELECTED_OBJECTS_DISPLAY': 'Toggle Visibility',
    'COMMIT_HISTORY': 'Commit',
    'COMMIT_SEQUENCE_HISTORY': 'Commit Sequence',
};

function formatCommandName(name) {
    if (!name) return '';
    if (COMMAND_LABELS[name]) return COMMAND_LABELS[name];

    // SNAKE_CASE: CHANGE_NODE_SELECTION → "Change Node Selection"
    if (name.includes('_')) {
        return name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    // camelCase: changeSelectedNodesPosition → "Change Selected Nodes Position"
    return name
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, s => s.toUpperCase())
        .trim();
}

/** Extract readable details from command payload */
function formatCommandDetail(commandName, payload = {}) {
    if (!payload || Object.keys(payload).length === 0) return '';
    const p = payload;

    // Selection changes
    if (/CHANGE_NODE_SELECTION|SET_TREE_SELECTION|CHANGE_OBJECT_SELECTION/.test(commandName)) {
        const parts = [];
        if (p.strategy) parts.push(p.strategy);
        if (Array.isArray(p.markerIds) && p.markerIds.length) parts.push(`${p.markerIds.length} markers`);
        if (Array.isArray(p.curveIds) && p.curveIds.length) parts.push(`${p.curveIds.length} curves`);
        if (Array.isArray(p.ids) && p.ids.length) parts.push(`${p.ids.length} items`);
        if (Array.isArray(p.refIds) && p.refIds.length) parts.push(`+${p.refIds.length} refs`);
        return parts.join(', ');
    }

    // Delete operations
    if (/DELETE/.test(commandName)) {
        if (Array.isArray(p.ids)) return `${p.ids.length} items`;
        if (p.count) return `${p.count} items`;
    }

    // Paste / Duplicate
    if (/PASTE|DUPLICATE/.test(commandName)) {
        if (Array.isArray(p.ids)) return `${p.ids.length} items`;
    }

    // Rename
    if (/RENAME/.test(commandName)) {
        return p.newName ? `→ "${p.newName}"` : '';
    }

    // Toggle lock / visibility
    if (/TOGGLE/.test(commandName)) {
        if (p.locked !== undefined) return p.locked ? 'lock' : 'unlock';
        if (p.visible !== undefined) return p.visible ? 'show' : 'hide';
    }

    // Resize / bounds
    if (/BOUNDS/.test(commandName)) {
        const parts = [];
        if (p.prop !== undefined) parts.push(p.prop);
        if (p.value !== undefined) parts.push(p.value);
        return parts.join('=');
    }

    // Import
    if (/IMPORT/.test(commandName)) {
        return p.fileName || p.imageId || '';
    }

    // Pen settings
    if (/SET_PEN_PROPERTIES/.test(commandName)) {
        const keys = Object.keys(p.updates || p);
        return keys.length ? `${keys.length} settings` : '';
    }

    // Generic: show key-value pairs for first few payload keys
    const keys = Object.keys(p).filter(k => !k.startsWith('_') && !k.endsWith('_'));
    if (keys.length === 0) return '';
    const shown = keys.slice(0, 3).map(k => {
        const v = p[k];
        if (typeof v === 'number') return `${k}=${v}`;
        if (typeof v === 'string') return v.length > 0 ? v : '';
        if (Array.isArray(v)) return `${k}[${v.length}]`;
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return k;
        return '';
    }).filter(Boolean).join(', ');
    return keys.length > 3 ? shown + ' …' : shown;
}

export class LoggerPanel extends HTMLElement {
    connectedCallback() {
        // One-time DOM setup — survives disconnect/reconnect cycles
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
        }

        // Always re-attach appEventBus listeners (cleaned up in disconnectedCallback)
        this._cleanups = [];
        this._cleanups.push(appEventBus.on('COMMAND_COMMITTED', (e) => {
            const detail = e.detail || {};
            if (detail.commandName === 'CHANGE_NODE_SELECTION') return;
            this.logCommand(detail.commandName, detail.payload);
        }));
        this._cleanups.push(appEventBus.on('canvas-state-changed', (e) => {
            const action = e.detail?.action;
            if (!action || action?.meta?.source !== 'history') return;
            if (action.type === 'UNDO') {
                this.logHistory('Undo', action.meta.commandName);
            } else if (action.type === 'REDO') {
                this.logHistory('Redo', action.meta.commandName);
            }
        }));
    }

    disconnectedCallback() {
        this._cleanups.forEach(fn => fn());
        this._cleanups = [];
        // Do NOT reset _domReady — preserve DOM and log content across reconnect
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

    /** Log an undoable command with formatted name and details */
    logCommand(commandName, payload) {
        const label = formatCommandName(commandName);
        const detail = formatCommandDetail(commandName, payload);
        this.log(label + (detail ? ' — ' + detail : ''), 'command');
    }

    /** Log undo/redo history navigation */
    logHistory(direction, commandName) {
        const label = formatCommandName(commandName);
        const detail = formatCommandDetail(commandName, null);
        this.log(`${direction}: ${label}`, 'history');
    }
}
customElements.define('logger-panel', LoggerPanel);