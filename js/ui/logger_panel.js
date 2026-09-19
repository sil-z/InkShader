import { appEventBus } from "../app/event_bus.js";

const TEMPLATE_HTML = `
    <div class="logger-scroll">
        <div class="prop_panel_title_wrapper">
            <div class="panel_title" data-i18n="panel.console">Console</div>
        </div>
        <div class="logger-output" id="logger_output"></div>
    </div>
    <div class="input-wrapper">
        <input type="text" class="logger-input" id="logger_input">
    </div>
`;

/**
 * Command id → { key, label }: `key` is the translation-table entry and `label`
 * the English text used when the table is not available. Commands without an
 * entry fall through to a mechanical Title Case rendering of their id.
 */
const COMMAND_LABELS = {
    'changeControlNodePosition': { key: 'log.cmd.move_control_point', label: 'Move Control Point' },
    'deleteControlNode': { key: 'log.cmd.delete_control_point', label: 'Delete Control Point' },
    'changeSelectedNodesPosition': { key: 'log.cmd.move_nodes', label: 'Move Nodes' },
    'insertMainNode': { key: 'log.cmd.insert_node', label: 'Insert Node' },
    'finishAddingPathCommand': { key: 'log.cmd.add_path', label: 'Add Path' },
    'deleteSelectedNodes': { key: 'log.cmd.delete_nodes', label: 'Delete Nodes' },
    'deleteSelectedObjects': { key: 'log.cmd.delete_objects', label: 'Delete Objects' },
    'changeSelectedObjectsGroup': { key: 'log.cmd.change_group', label: 'Change Group' },
    'changeSelectedObjectsTransform': { key: 'log.cmd.transform_objects', label: 'Transform Objects' },
    'expandSelectedStroke': { key: 'log.cmd.expand_stroke', label: 'Expand Stroke' },
    'booleanUnionSelectedCurves': { key: 'log.cmd.boolean_union', label: 'Boolean Union' },
    'unlinkSelectedReferences': { key: 'log.cmd.unlink_reference', label: 'Unlink Reference' },

    'PASTE_COPIED_OBJECTS': { key: 'log.cmd.paste_objects', label: 'Paste Objects' },
    'DUPLICATE_SELECTED_OBJECTS': { key: 'log.cmd.duplicate_objects', label: 'Duplicate Objects' },
    'DELETE_SELECTED_OBJECTS': { key: 'log.cmd.delete_objects', label: 'Delete Objects' },
    'CHANGE_SELECTED_OBJECTS_GROUP': { key: 'log.cmd.change_group', label: 'Change Group' },
    'SET_SINGLE_OBJECT_PROPERTIES': { key: 'log.cmd.edit_properties', label: 'Edit Properties' },
    'CHANGE_SELECTED_OBJECTS_BOUNDS': { key: 'log.cmd.resize_objects', label: 'Resize Objects' },
    'RENAME_TREE_ITEM': { key: 'log.cmd.rename', label: 'Rename' },
    'SET_GROUP_ADVANCE': { key: 'log.cmd.set_advance', label: 'Set Advance Width' },
    'UPDATE_NODE_PROPERTY': { key: 'log.cmd.edit_node_property', label: 'Edit Node Property' },
    'SET_PEN_PROPERTIES': { key: 'log.cmd.pen_settings', label: 'Pen Settings' },
    'SET_GROUP_CHAR_CODE': { key: 'log.cmd.set_char_code', label: 'Set Character Code' },
    'SET_SEQUENCE_EDITOR_STATE': { key: 'log.cmd.edit_sequence', label: 'Edit Sequence' },
    'DELETE_GROUP_AND_UPDATE_SEQUENCE': { key: 'log.cmd.delete_group', label: 'Delete Group' },
    'EXPAND_STROKE': { key: 'log.cmd.expand_stroke', label: 'Expand Stroke' },
    'BOOLEAN_UNION': { key: 'log.cmd.boolean_union', label: 'Boolean Union' },
    'UNLINK': { key: 'log.cmd.unlink_reference', label: 'Unlink Reference' },
    'IMPORT_IMAGE': { key: 'log.cmd.import_image', label: 'Import Image' },
    'TOGGLE_SELECTED_OBJECTS_LOCK': { key: 'log.cmd.toggle_lock', label: 'Toggle Lock' },
    'TOGGLE_SELECTED_OBJECTS_DISPLAY': { key: 'log.cmd.toggle_visibility', label: 'Toggle Visibility' },
    'COMMIT_HISTORY': { key: 'log.cmd.commit', label: 'Commit' },
    'COMMIT_SEQUENCE_HISTORY': { key: 'log.cmd.commit_sequence', label: 'Commit Sequence' },
};

/** Translation shorthand: table first, English literal as the fallback. */
const t = (key, fallback) => (window.I18n ? window.I18n.t(key, fallback) : fallback);

/** Fill a "{n}"-style template key from the translation table. */
function tCount(key, n, fallback) {
    return t(key, fallback).replace('{n}', String(n));
}

function formatCommandName(name) {
    if (!name) return '';
    const entry = COMMAND_LABELS[name];
    if (entry) return t(entry.key, entry.label);

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
        if (Array.isArray(p.markerIds) && p.markerIds.length) parts.push(tCount('log.detail.markers', p.markerIds.length, '{n} markers'));
        if (Array.isArray(p.curveIds) && p.curveIds.length) parts.push(tCount('log.detail.curves', p.curveIds.length, '{n} curves'));
        if (Array.isArray(p.ids) && p.ids.length) parts.push(tCount('log.detail.items', p.ids.length, '{n} items'));
        if (Array.isArray(p.refIds) && p.refIds.length) parts.push(tCount('log.detail.refs', p.refIds.length, '+{n} refs'));
        return parts.join(', ');
    }

    // Delete operations
    if (/DELETE/.test(commandName)) {
        if (Array.isArray(p.ids)) return tCount('log.detail.items', p.ids.length, '{n} items');
        if (p.count) return tCount('log.detail.items', p.count, '{n} items');
    }

    // Paste / Duplicate
    if (/PASTE|DUPLICATE/.test(commandName)) {
        if (Array.isArray(p.ids)) return tCount('log.detail.items', p.ids.length, '{n} items');
    }

    // Rename
    if (/RENAME/.test(commandName)) {
        return p.newName ? `→ "${p.newName}"` : '';
    }

    // Toggle lock / visibility
    if (/TOGGLE/.test(commandName)) {
        if (p.locked !== undefined) return p.locked ? t('tree.lock', 'lock') : t('tree.unlock', 'unlock');
        if (p.visible !== undefined) return p.visible ? t('tree.show', 'show') : t('tree.hide', 'hide');
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
        return keys.length ? tCount('log.detail.settings', keys.length, '{n} settings') : '';
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
                this.logHistory(t('log.undo', 'Undo'), action.meta.commandName);
            } else if (action.type === 'REDO') {
                this.logHistory(t('log.redo', 'Redo'), action.meta.commandName);
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