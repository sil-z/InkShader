// js/object_tree.js
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import { createEmptyEditorInteractionState } from "../app/editor_interaction_state.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { readElementRect } from "../app/layout_metrics_service.js";

const TEMPLATE_HTML = `
    <div class="placeholder tree_panel" id="object_tree" tabindex="0">
        <div class="title_panel">
            <div class="panel_title" data-i18n="tree.title">Objects</div>
        </div>
        <div class="tree_content"></div>
    </div>
`;

export class ObjectTree extends HTMLElement {
    constructor() {
        super();
        this.tree = null;
        this.treeContent = null;
        this.interaction = createEmptyEditorInteractionState();
        this.scrollDirection = 0;
        this.isScrolling = false;
        
        this.dragItems = null;
        this.currentDropTarget = null;
        this.lastDragOverItem = null;
        this.lastSelectedIndex = -1; 
        this.dragPreventClick = false; 
        this.globalEventTrackers = [];
        this.isDragStarting = false;
        /** @type {Map<string, HTMLElement>} */
        this._treeElById = new Map();
        /** 可见行 id 顺序指纹；未变时跳过 DOM 重排 */
        this._lastTreeRowKey = "";
    }

    addGlobalListener(target, type, listener, options = false) {
        if (target === window) {
            const cleanup = appEventBus.on(type, listener, options);
            this.globalEventTrackers.push(cleanup);
            return;
        }
        target.addEventListener(type, listener, options);
        this.globalEventTrackers.push(() => target.removeEventListener(type, listener, options));
    }

    connectedCallback() {
        const temp = document.createElement("template");
        temp.innerHTML = TEMPLATE_HTML;
        this.appendChild(temp.content.cloneNode(true));

        this.tree = this.querySelector("#object_tree");
        this.treeContent = this.querySelector(".tree_content");
        EditorModel.whenEditorStoreReady((st) => {
            this.interaction.applyEventDetail({ afterState: st });
            this.renderTree();
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => {
            this.interaction.applyEventDetail(e?.detail);
            const actionType = e?.detail?.action?.type;
            if (
                actionType === "UNDO" ||
                actionType === "REDO" ||
                actionType === "TREE_REVISION" ||
                actionType === "HISTORY_REVISION" ||
                actionType === "DOCUMENT_REVISION" ||
                actionType === "SEED_FROM_RUNTIME" ||
                actionType === "MODEL_REVISION"
            ) {
                this._lastTreeRowKey = "";
                this.renderTree();
                return;
            }
            const before = e?.detail?.beforeState;
            const after = e?.detail?.afterState;
            const selectionChanged =
                before &&
                after &&
                (JSON.stringify(before.selectedTreeIds) !== JSON.stringify(after.selectedTreeIds) ||
                    before.activeGroupId !== after.activeGroupId);
            if (
                selectionChanged ||
                actionType === "SET_TREE_SELECTION" ||
                actionType === "SET_ACTIVE_GROUP" ||
                actionType === "CHANGE_NODE_SELECTION" ||
                actionType === "CHANGE_OBJECT_SELECTION"
            ) {
                this._patchTreeSelectionOnly();
            }
        });

        // draggable 项会先触发 dragstart 并置 dragPreventClick，click 无法选中；用 pointerdown 在拖拽前选中
        this.tree.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            if (e.target.closest(".tree_action_btn") || e.target.closest(".tree_toggle")) return;
            if (e.target.classList.contains("tree_checkbox")) return;
            const itemDiv = e.target.closest(".tree_item");
            if (!itemDiv) return;
            this.applyTreeItemSelection(e, itemDiv);
        });

        this.tree.addEventListener("click", (e) => {
            if (e.button === 0) this.handleLeftClick(e);
        });

        this.tree.addEventListener("contextmenu", e => {
            e.preventDefault();
            this.handleRightClick(e);
        });

        this.initDragAndDrop();

        this.addGlobalListener(window, CANVAS_EVENTS.REQUEST_EDITOR_ACTION, (e) => {
            const { action, contextId } = e.detail;
            this.executeTreeAction(action, contextId);
        });
    }

    disconnectedCallback() {
        this.globalEventTrackers.forEach((cleanup) => cleanup());
        this.globalEventTrackers = [];
        this._treeElById.clear();
        this._lastTreeRowKey = "";
    }

    executeTreeAction(action, contextId = null) {
        this.removeMenu();
        const ids = [...this.interaction.selectedTreeIds];
        if (action === 'delete') {
            CanvasDispatcher.requestDeleteSelectedObjects(ids);
        } else if (action === 'copy') {
            CanvasDispatcher.requestCopySelectedObjects(ids);
        } else if (action === 'paste') {
            if (EditorModel.getClipboardSummary().canPaste) {
                CanvasDispatcher.requestPasteCopiedObjects(contextId);
            }
        } else if (action === 'duplicate') {
            CanvasDispatcher.requestDuplicateSelectedObjects(ids);
        } else if (action === 'go_source') {
            const item = EditorModel.getTreeItem(contextId);
            if (item && item.isRef && item.refId) {
                CanvasDispatcher.requestSetTreeSelection([item.refId]);
            }
        } else if (action === 'unlink') {
            CanvasDispatcher.requestUnlink(ids);
        }
    }

    applyTreeItemSelection(e, itemDiv) {
        const id = itemDiv.dataset.id;
        const item = EditorModel.getTreeItem(id);
        if (!item) return;

        let activeGroupId = null;
        if (item.type === "group") {
            activeGroupId = item.isRef ? item.parentId : id;
        } else if (item.parentId) {
            activeGroupId = item.parentId;
        }

        const isCheckbox = e.target.classList.contains("tree_checkbox");
        const allItems = Array.from(this.tree.querySelectorAll(".tree_item"));
        const currentIndex = allItems.findIndex((el) => el.dataset.id === id);

        let newSelection = new Set(this.interaction.selectedTreeIds);

        if (e.shiftKey && this.lastSelectedIndex !== -1) {
            const start = Math.min(this.lastSelectedIndex, currentIndex);
            const end = Math.max(this.lastSelectedIndex, currentIndex);
            newSelection.clear();
            for (let i = start; i <= end; i++) {
                newSelection.add(allItems[i].dataset.id);
            }
        } else if (isCheckbox) {
            return;
        } else if (e.ctrlKey || e.metaKey) {
            if (newSelection.has(id)) newSelection.delete(id);
            else newSelection.add(id);
            this.lastSelectedIndex = currentIndex;
        } else {
            newSelection.clear();
            newSelection.add(id);
            this.lastSelectedIndex = currentIndex;
        }

        CanvasDispatcher.requestSetTreeSelection(Array.from(newSelection), activeGroupId);
    }

    handleLeftClick(e) {
        const actionBtn = e.target.closest('.tree_action_btn');
        if (actionBtn) {
            e.stopPropagation();
            const itemDiv = actionBtn.closest('.tree_item');
            const clickedId = itemDiv.dataset.id;
            const clickedItem = EditorModel.getTreeItem(clickedId);
            
            if (!clickedItem) return;

            const isVisAction = actionBtn.dataset.action === 'vis';
            const isLockAction = actionBtn.dataset.action === 'lock';

            const visState = EditorModel.getTreeItemVisibilityState(clickedItem);
            let currentState = isVisAction ? visState.isVis : visState.isLocked;
            let newState = !currentState;

            let targetIds = this.interaction.hasTreeSelection(clickedId)
                ? [...this.interaction.selectedTreeIds]
                : [clickedId];
            if (isLockAction) {
                CanvasDispatcher.requestToggleSelectedObjectsLock(targetIds, newState);
            } else if (isVisAction) {
                CanvasDispatcher.requestToggleSelectedObjectsDisplay(targetIds, newState);
            }
            return;
        }

        const toggle = e.target.closest(".tree_toggle");
        if (toggle && toggle.querySelector("svg")) {
            const itemDiv = toggle.closest(".tree_item");
            if (!itemDiv || itemDiv.dataset.type !== "group" || itemDiv.dataset.isref === "true") return;
            CanvasDispatcher.requestToggleGroupCollapsed(itemDiv.dataset.id);
            return;
        }

        const itemDiv = e.target.closest(".tree_item");
        if (!itemDiv) return;

        if (e.target.classList.contains("tree_checkbox")) {
            const id = itemDiv.dataset.id;
            const allItems = Array.from(this.tree.querySelectorAll(".tree_item"));
            const currentIndex = allItems.findIndex((el) => el.dataset.id === id);
            let newSelection = new Set(this.interaction.selectedTreeIds);
            if (!e.target.checked) newSelection.delete(id);
            else newSelection.add(id);
            this.lastSelectedIndex = currentIndex;
            let activeGroupId = null;
            const item = EditorModel.getTreeItem(id);
            if (item?.type === "group") activeGroupId = item.isRef ? item.parentId : id;
            else if (item?.parentId) activeGroupId = item.parentId;
            CanvasDispatcher.requestSetTreeSelection(Array.from(newSelection), activeGroupId);
        }
    }

    handleRightClick(e) {
        const itemDiv = e.target.closest(".tree_item");
        this.removeMenu();

        if (!itemDiv) return;

        let id = itemDiv.dataset.id;
        let type = itemDiv.dataset.type;
        const itemObj = EditorModel.getTreeItem(id);
        let isRef = itemObj ? itemObj.isRef : false;

        const allItems = Array.from(this.tree.querySelectorAll(".tree_item"));
        const currentIndex = allItems.findIndex(el => el.dataset.id === id);
        this.lastSelectedIndex = currentIndex;

        if (!this.interaction.hasTreeSelection(id)) {
            CanvasDispatcher.requestSetTreeSelection([id]);
        }

        const menu = document.createElement("div");
        menu.className = "tree_menu";
        menu.style.left = e.clientX + "px"; menu.style.top = e.clientY + "px";

        const t = (k, defaultStr) => window.I18n ? window.I18n.t(k) : defaultStr;
        const clip = EditorModel.getClipboardSummary();
        let canPaste = clip.canPaste;
        let pasteText = t('tree.menu.paste', 'Paste');
        if (canPaste) {
            let typeText = clip.firstType === 'group' ? 'Group Ref' : 'Curve';
            let count = clip.count;
            pasteText = `${t('tree.menu.paste', 'Paste')} (${count} ${typeText}${count > 1 ? 's' : ''})`;
        }

        const createItem = (label, shortcut, action, contextId = null, disabled = false) => {
            const div = document.createElement("div");
            div.className = "tree_menu_item" + (disabled ? " disabled" : "");
            div.appendChild(document.createTextNode(label));
            if (shortcut) {
                const sc = document.createElement("span");
                sc.className = "shortcut";
                sc.textContent = shortcut;
                div.appendChild(document.createTextNode(" "));
                div.appendChild(sc);
            }
            if (!disabled) {
                div.addEventListener("click", () => {
                    this.executeTreeAction(action, contextId);
                });
            }
            return div;
        };

        if (type === "curve") {
            menu.appendChild(createItem(t('tree.menu.delete', 'Delete'), 'Del', 'delete'));
            menu.appendChild(createItem(t('tree.menu.copy', 'Copy'), 'Ctrl+C', 'copy'));
            menu.appendChild(createItem(t('tree.menu.duplicate', 'Duplicate'), 'Ctrl+D', 'duplicate'));
        } else if (type === "group") {
            if (isRef) {
                menu.appendChild(createItem(t('tree.menu.unlink', 'Unlink Reference'), '', 'unlink', id));
                menu.appendChild(createItem(t('tree.menu.go_source', 'Go to Reference Source'), '', 'go_source', id));
                menu.appendChild(createItem(t('tree.menu.delete', 'Delete'), 'Del', 'delete'));
                menu.appendChild(createItem(t('tree.menu.copy', 'Copy'), 'Ctrl+C', 'copy'));
                menu.appendChild(createItem(t('tree.menu.duplicate', 'Duplicate'), 'Ctrl+D', 'duplicate'));
            } else {
                menu.appendChild(createItem(t('tree.menu.delete', 'Delete'), 'Del', 'delete'));
                menu.appendChild(createItem(t('tree.menu.copy_ref', 'Copy Reference'), 'Ctrl+C', 'copy'));
                menu.appendChild(createItem(pasteText, 'Ctrl+V', 'paste', id, !canPaste));
                menu.appendChild(createItem(t('tree.menu.duplicate', 'Duplicate'), 'Ctrl+D', 'duplicate'));
            }
        } 

        document.body.appendChild(menu);
        document.addEventListener("mousedown", (ev) => { if(!menu.contains(ev.target)) this.removeMenu(); }, { once: true });
    }

    _collectVisibleTreeRows() {
        const treeItems = EditorModel.getTreeItemsMap();
        if (!treeItems) return [];
        const rows = [];
        const walk = (id, depth) => {
            const item = treeItems.get(id);
            if (!item || item.hidden_by_sequence) return;
            rows.push({ id, depth, item });
            if (item.type === "group" && !item.isRef && !item.collapsed && item.children) {
                item.children.forEach((childId) => walk(childId, depth + 1));
            }
        };
        EditorModel.getRootChildren().forEach((id) => walk(id, 0));
        return rows;
    }

    _getTreeItemDisplayName(item) {
        let displayName = item.name;
        if (item.charCode) displayName = `${item.name} '${item.charCode}'`;
        if (item.type === "group" && item.isRef) {
            const sourceItem = EditorModel.getTreeItem(item.refId);
            displayName = `${item.name} '${sourceItem ? sourceItem.name : "Unknown"}'`;
        }
        return displayName;
    }

    _getTreeItemVisibility(item) {
        const { isVis, isLocked } = EditorModel.getTreeItemVisibilityState(item);
        return { isVis, isLoc: isLocked };
    }

    _createTreeItemElement(id) {
        const el = document.createElement("div");
        el.className = "tree_item";
        el.dataset.id = id;
        el.draggable = true;

        const left = document.createElement("div");
        left.className = "tree_left";

        const indent = document.createElement("div");
        indent.className = "tree_indent";

        const toggle = document.createElement("button");
        toggle.className = "tree_toggle";
        toggle.type = "button";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree_checkbox";

        const label = document.createElement("div");
        label.className = "tree_label";

        left.append(indent, toggle, checkbox, label);

        const actions = document.createElement("div");
        actions.className = "tree_item_actions";

        const lockBtn = document.createElement("button");
        lockBtn.className = "tree_action_btn";
        lockBtn.dataset.action = "lock";
        lockBtn.title = "Lock/Unlock";
        lockBtn.type = "button";
        const lockImg = document.createElement("img");
        lockBtn.appendChild(lockImg);

        const visBtn = document.createElement("button");
        visBtn.className = "tree_action_btn";
        visBtn.dataset.action = "vis";
        visBtn.title = "Show/Hide";
        visBtn.type = "button";
        const visImg = document.createElement("img");
        visBtn.appendChild(visImg);

        actions.append(lockBtn, visBtn);
        el.append(left, actions);

        el._treeParts = { indent, toggle, checkbox, label, actions, lockBtn, visBtn, lockImg, visImg };
        return el;
    }

    _ensureGroupToggleSvg(toggle) {
        if (toggle.querySelector("svg")) return;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M7 10l5 5 5-5z");
        svg.appendChild(path);
        toggle.appendChild(svg);
    }

    _treeRowKey(rows) {
        return rows.map((r) => r.id).join("\0");
    }

    _treeItemSignature({ id, depth, item, focusedId }) {
        const isActive = this.interaction.activeGroupId === id;
        const isSelected = this.interaction.hasTreeSelection(id);
        const { isVis, isLoc } = this._getTreeItemVisibility(item);
        return [
            depth,
            this._getTreeItemDisplayName(item),
            item.type,
            item.isRef ? 1 : 0,
            item.collapsed ? 1 : 0,
            isActive ? 1 : 0,
            isSelected ? 1 : 0,
            isVis ? 1 : 0,
            isLoc ? 1 : 0,
            focusedId === id ? 1 : 0
        ].join("|");
    }

    _patchTreeItemElement(el, { id, depth, item, focusedId }) {
        const parts = el._treeParts;
        if (!parts) return;

        const sig = this._treeItemSignature({ id, depth, item, focusedId });
        if (el._treeSig === sig) return;
        el._treeSig = sig;

        const isActive = this.interaction.activeGroupId === id;
        const isSelected = this.interaction.hasTreeSelection(id);

        el.classList.toggle("active-group", isActive);
        el.classList.toggle("selected", isSelected);
        el.classList.toggle("collapsed", !!item.collapsed);
        el.classList.toggle("group-reference", item.type === "group" && item.isRef);

        el.dataset.type = item.type;
        el.dataset.isref = item.isRef ? "true" : "false";
        el.dataset.depth = String(depth);

        if (focusedId === id) el.tabIndex = -1;
        else el.removeAttribute("tabindex");

        const indentWidth = `${depth * 14}px`;
        if (parts.indent.style.width !== indentWidth) parts.indent.style.width = indentWidth;

        const showToggle = item.type === "group" && !item.isRef;
        if (showToggle) {
            this._ensureGroupToggleSvg(parts.toggle);
        } else if (parts.toggle.firstChild) {
            parts.toggle.replaceChildren();
        }

        if (parts.checkbox.checked !== isSelected) parts.checkbox.checked = isSelected;

        const labelClass = item.type === "group" ? "tree_label_group" : "tree_label";
        if (parts.label.className !== labelClass) parts.label.className = labelClass;
        const labelText = this._getTreeItemDisplayName(item);
        if (parts.label.textContent !== labelText) parts.label.textContent = labelText;

        const { isVis, isLoc } = this._getTreeItemVisibility(item);
        parts.actions.classList.toggle("all-default", isVis && !isLoc);
        parts.lockBtn.classList.toggle("is-default", !isLoc);
        parts.visBtn.classList.toggle("is-default", isVis);
        const lockSrc = isLoc ? "./assets/icons/lock.svg" : "./assets/icons/unlock.svg";
        const visSrc = isVis ? "./assets/icons/show.svg" : "./assets/icons/hide.svg";
        if (parts.lockImg.getAttribute("src") !== lockSrc) parts.lockImg.src = lockSrc;
        if (parts.visImg.getAttribute("src") !== visSrc) parts.visImg.src = visSrc;
    }

    _removeStaleTreeElements(visibleIds) {
        for (const id of [...this._treeElById.keys()]) {
            if (!visibleIds.has(id)) {
                this._treeElById.get(id)?.remove();
                this._treeElById.delete(id);
            }
        }
    }

    _getOrCreateTreeElement(id) {
        let el = this._treeElById.get(id);
        if (!el) {
            el = this._createTreeItemElement(id);
            this._treeElById.set(id, el);
            el._treeSig = null;
        }
        return el;
    }

    /** 自后向前 insertBefore，保证 reference 节点已在 parent 内（避免正向时 next 尚未挂载） */
    _syncTreeRowOrder(rows, focusedId) {
        const parent = this.treeContent;
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            const el = this._getOrCreateTreeElement(row.id);
            this._patchTreeItemElement(el, { ...row, focusedId });
            let desiredNext = i + 1 < rows.length ? this._treeElById.get(rows[i + 1].id) : null;
            if (desiredNext && desiredNext.parentNode !== parent) {
                desiredNext = null;
            }
            if (el.parentNode !== parent || el.nextSibling !== desiredNext) {
                parent.insertBefore(el, desiredNext);
            }
        }
    }

    /** 可见行集合与顺序未变：只更新各节点展示，不重排 DOM */
    _patchVisibleTreeRows(rows, focusedId) {
        const parent = this.treeContent;
        for (const row of rows) {
            const el = this._getOrCreateTreeElement(row.id);
            this._patchTreeItemElement(el, { ...row, focusedId });
            if (el.parentNode !== parent) {
                parent.appendChild(el);
            }
        }
    }

    _patchTreeSelectionOnly() {
        if (!this.treeContent) return;
        const activeId = this.interaction.activeGroupId;
        for (const el of this.treeContent.querySelectorAll(".tree_item")) {
            const id = el.dataset.id;
            const isSelected = this.interaction.hasTreeSelection(id);
            const isActive = activeId === id;
            el.classList.toggle("selected", isSelected);
            el.classList.toggle("active-group", isActive);
            const cb = el._treeParts?.checkbox ?? el.querySelector(".tree_checkbox");
            if (cb) cb.checked = isSelected;
        }
    }

    _purgeLegacyTreeNodes() {
        for (const child of [...this.treeContent.children]) {
            if (!child._treeParts) {
                const id = child.dataset?.id;
                if (id) this._treeElById.delete(id);
                child.remove();
            }
        }
    }

    renderTree() {
        if (this.isDragStarting) return;
        if (!EditorModel.getTreeItemsMap() || !this.treeContent) return;
        const prevScrollTop = this.tree.scrollTop;
        const focusedId =
            document.activeElement?.closest?.(".tree_item")?.dataset?.id ?? null;

        this._purgeLegacyTreeNodes();

        const rows = this._collectVisibleTreeRows();
        const visibleIds = new Set(rows.map((r) => r.id));
        this._removeStaleTreeElements(visibleIds);

        const rowKey = this._treeRowKey(rows);
        if (rowKey === this._lastTreeRowKey) {
            this._patchVisibleTreeRows(rows, focusedId);
        } else {
            this._lastTreeRowKey = rowKey;
            this._syncTreeRowOrder(rows, focusedId);
        }

        this.tree.scrollTop = prevScrollTop;

        if (focusedId) {
            const elToFocus = this._treeElById.get(focusedId);
            elToFocus?.focus();
        }
    }

    removeMenu() { document.querySelectorAll(".tree_menu").forEach(m => m.remove()); }

    cleanupDrag() {
        if (this.dragItems) this.dragItems.forEach(el => el.classList.remove('dragging'));
        this.dragItems = null;
        this.currentDropTarget = null;
        this.stopAutoScroll();
        if (this.lastDragOverItem) {
            this.lastDragOverItem.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-inside');
            this.lastDragOverItem = null;
        }
        setTimeout(() => this.dragPreventClick = false, 100);
    }

    initDragAndDrop() {
        this.tree.addEventListener('dragstart', e => {
            this.isDragStarting = true; 

            const item = e.target.closest('.tree_item');
            if (!item) {
                this.isDragStarting = false; 
                return;
            }
            const id = item.dataset.id;
            
            if (!this.interaction.hasTreeSelection(id)) {
                CanvasDispatcher.requestSetTreeSelection([id]);
                this.tree.querySelectorAll('.tree_item.selected').forEach(el => {
                    el.classList.remove('selected');
                    const cb = el.querySelector('.tree_checkbox');
                    if (cb) cb.checked = false;
                });
                
                item.classList.add('selected');
                const currentCb = item.querySelector('.tree_checkbox');
                if (currentCb) currentCb.checked = true;
            }

            this.dragItems = [];
            this.interaction.selectedTreeIds.forEach(selId => {
                const el = this.tree.querySelector(`.tree_item[data-id="${selId}"]`);
                if (el) {
                    el.classList.add('dragging');
                    this.dragItems.push(el);
                }
            });

            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');

            const onDragEnd = () => {
                this.cleanupDrag();
                item.removeEventListener('dragend', onDragEnd);
            };
            item.addEventListener('dragend', onDragEnd);

            this.isDragStarting = false;
        });

        this.tree.addEventListener('dragover', e => {
            e.preventDefault(); 
            const treeRect = readElementRect(this.tree);
            if (e.clientY < treeRect.top + 35) { this.scrollDirection = -1; }
            else if (e.clientY > treeRect.top + treeRect.height - 35) { this.scrollDirection = 1; } 
            else { this.scrollDirection = 0; }
            
            if (this.scrollDirection !== 0 && !this.isScrolling) {
                this.isScrolling = true;
                requestAnimationFrame(() => this.autoScroll());
            }

            const targetItem = e.target.closest('.tree_item');
            
            if (this.lastDragOverItem && this.lastDragOverItem !== targetItem) {
                this.lastDragOverItem.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-inside');
            }

            if (!targetItem || (this.dragItems && this.dragItems.includes(targetItem))) {
                this.currentDropTarget = null;
                this.lastDragOverItem = null;
                return;
            }

            this.lastDragOverItem = targetItem; 

            const mainDragItem = this.dragItems[0];
            const dragType = mainDragItem.dataset.type;
            const dragIsRef = mainDragItem.dataset.isref === 'true';
            const targetId = targetItem.dataset.id;
            const targetType = targetItem.dataset.type;
            const targetObj = EditorModel.getTreeItem(targetId);
            
            if (!targetObj) return;

            const bounding = readElementRect(targetItem);
            const offsetY = e.clientY - bounding.top;
            const height = bounding.height;
            let dropMode = '';
            
            if (dragType === 'group' && !dragIsRef) {
                if (targetObj.parentId !== null) { this.currentDropTarget = null; return; }
                if (targetType === 'group') {
                    if (offsetY < height * 0.25) dropMode = 'before';
                    else if (offsetY > height * 0.75) dropMode = 'after';
                    else dropMode = 'inside';
                } else {
                    if (offsetY < height * 0.5) dropMode = 'before';
                    else dropMode = 'after';
                }
            } else {
                if (targetType === 'group' && !targetObj.isRef) dropMode = 'inside';
                else {
                    if (offsetY < height * 0.5) dropMode = 'before';
                    else dropMode = 'after';
                }
            }

            this.currentDropTarget = { id: targetId, mode: dropMode };

            targetItem.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-inside');
            if (dropMode === 'before') targetItem.classList.add('drag-over-top');
            else if (dropMode === 'after') targetItem.classList.add('drag-over-bottom');
            else if (dropMode === 'inside') targetItem.classList.add('drag-over-inside');
        });

        this.tree.addEventListener('dragleave', e => {
            if (!this.tree.contains(e.relatedTarget)) this.stopAutoScroll();
            const targetItem = e.target.closest('.tree_item');
            if (targetItem) targetItem.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-inside');
        });

        this.tree.addEventListener('drop', e => {
            e.preventDefault();
            this.stopAutoScroll();
            
            if (!this.dragItems || this.dragItems.length === 0 || !this.currentDropTarget) {
                this.cleanupDrag(); return;
            }

            const targetId = this.currentDropTarget.id;
            const dropMode = this.currentDropTarget.mode;
            const targetObj = EditorModel.getTreeItem(targetId);

            if (!targetObj) { this.cleanupDrag(); return; }

            let newParentId = (dropMode === 'inside') ? targetId : targetObj.parentId;
            const dragIds = this.dragItems.map(el => el.dataset.id);

            for (let dragId of dragIds) {
                if (newParentId !== null && EditorModel.isTreeDescendant(dragId, newParentId)) {
                    this.cleanupDrag(); return;
                }
            }

            CanvasDispatcher.requestChangeSelectedObjectsGroup(dragIds, targetId, dropMode);
            this.cleanupDrag();
        });
    }

    autoScroll() {
        if (!this.isScrolling) return;
        this.tree.scrollTop += this.scrollDirection * 5;
        requestAnimationFrame(() => this.autoScroll());
    }

    stopAutoScroll() { this.isScrolling = false; }
}

customElements.define("object-tree", ObjectTree);