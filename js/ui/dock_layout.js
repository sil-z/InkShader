const PANEL_DEFS = {
    objects: { label: "Objects", compSelector: "object-tree" },
    properties: { label: "Properties", compSelector: ".property_panel" },
    terminal: { label: "Terminal", compSelector: "logger-panel" }
};

function createNode(type, data = {}) {
    return { type, ...data };
}

export class DockLayout {
    constructor(container) {
        this.container = container;
        this.root = null;
        this._panels = {};
        this._dragInfo = null;
        this._previewEl = document.createElement("div");
        this._previewEl.className = "dock-preview";
        document.body.appendChild(this._previewEl);
        this._resizing = null;
    }

    initialize(panelIds) {
        this._componentRefs = {};
        for (const [id, def] of Object.entries(PANEL_DEFS)) {
            this._componentRefs[id] = document.querySelector(def.compSelector);
        }
        this.root = createNode("split", {
            direction: "v",
            children: panelIds.map(id => createNode("leaf", { id, component: null })),
            sizes: panelIds.map(() => 100 / panelIds.length)
        });
        this._buildDOM();
    }

    serialize() {
        const walk = (n) => {
            if (n.type === "leaf") return { type: "leaf", id: n.id };
            if (n.type === "tabs") return { type: "tabs", activeIndex: n.activeIndex, children: n.children.map(c => walk(c)) };
            if (n.type === "split") return { type: "split", direction: n.direction, sizes: n.sizes, children: n.children.map(c => walk(c)) };
            return null;
        };
        return walk(this.root);
    }

    deserialize(state) {
        this.container.textContent = "";
        const el = this._buildNodeDOM(state);
        this.container.appendChild(el);
        this._attachComponentElements();
        this._initDragHandles();
    }

    _buildDOM() {
        this.container.textContent = "";
        const el = this._buildNodeDOM(this.root);
        this.container.appendChild(el);
        this._attachComponentElements();
        this._initDragHandles();
    }

    _buildNodeDOM(n) {
        if (n.type === "leaf") {
            return this._createTabsEl({ type: "tabs", activeIndex: 0, children: [n] });
        }
        if (n.type === "tabs") return this._createTabsEl(n);
        if (n.type === "split") return this._createSplitEl(n);
    }

    _createTabsEl(n) {
        const el = document.createElement("div");
        el.className = "dock-tabs";
        el.dataset.activeIndex = n.activeIndex || 0;
        const tabBar = document.createElement("div");
        tabBar.className = "dock-tab-bar";
        n.children.forEach((c, i) => {
            if (typeof c === "string") c = { id: c, type: "leaf" };
            const tb = document.createElement("span");
            tb.className = "dock-tab" + (i === (n.activeIndex || 0) ? " active" : "");
            tb.textContent = PANEL_DEFS[c.id].label;
            tb.dataset.panelId = c.id;
            tb.addEventListener("click", () => this._activateTab(el, i));
            tabBar.appendChild(tb);
        });
        el.appendChild(tabBar);
        n.children.forEach((c, i) => {
            if (typeof c === "string") c = { id: c, type: "leaf" };
            const leafEl = document.createElement("div");
            leafEl.className = "dock-leaf" + (i === (n.activeIndex || 0) ? "" : " dock-hidden");
            leafEl.dataset.panelId = c.id;
            const content = document.createElement("div");
            content.className = "dock-content";
            leafEl.appendChild(content);
            el.appendChild(leafEl);
        });
        return el;
    }

    _createSplitEl(n) {
        const el = document.createElement("div");
        el.className = "dock-split dock-split-" + n.direction;
        el._treeNode = n;
        n.children.forEach((c, i) => {
            if (i > 0) el.appendChild(this._createResizer());
            el.appendChild(this._buildNodeDOM(c));
        });
        this._applySplitFlex(el, n);
        return el;
    }

    _applySplitFlex(el, n) {
        const children = Array.from(el.children).filter(ch => !ch.classList.contains("dock-resizer"));
        children.forEach((ch, i) => {
            const basis = n.sizes ? n.sizes[i] + "%" : (100 / children.length) + "%";
            ch.style.flex = `1 1 ${basis}`;
        });
    }

    _createResizer() {
        const r = document.createElement("div");
        r.className = "dock-resizer";
        r.addEventListener("mousedown", (e) => this._startResize(e, r));
        return r;
    }

    _initDragHandles() {
        this.container.querySelectorAll(".dock-leaf").forEach(leaf => {
            const pid = leaf.dataset.panelId;
            if (!pid) return;
            const comp = this._componentRefs?.[pid];
            if (!comp) return;
            const handle = this._findDragHandle(comp);
            if (!handle) return;
            handle._dragPid = pid;
            handle.removeEventListener('mousedown', this._onPanelDragStart);
            handle.addEventListener('mousedown', this._onPanelDragStart);
        });
        this.container.querySelectorAll(".dock-tab").forEach(tab => {
            const pid = tab.dataset.panelId;
            if (!pid) return;
            tab._dragPid = pid;
            tab.removeEventListener('mousedown', this._onPanelDragStart);
            tab.addEventListener('mousedown', this._onPanelDragStart);
        });
    }

    _onPanelDragStart = (e) => {
        if (e.button !== 0) return;
        document.removeEventListener('mousemove', this._onPanelDragThreshold);
        document.removeEventListener('mouseup', this._onPanelDragCancel);
        const handle = e.currentTarget;
        this._dragInfo = {
            panelId: handle._dragPid,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            handle
        };
        document.addEventListener('mousemove', this._onPanelDragThreshold);
        document.addEventListener('mouseup', this._onPanelDragCancel);
        e.preventDefault();
    };

    _onPanelDragThreshold = (e) => {
        const info = this._dragInfo;
        if (!info) return;
        const dx = e.clientX - info.startMouseX;
        const dy = e.clientY - info.startMouseY;
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        document.removeEventListener('mousemove', this._onPanelDragThreshold);
        document.removeEventListener('mouseup', this._onPanelDragCancel);
        const ghost = document.createElement("div");
        ghost.className = "dock-drag-ghost";
        ghost.textContent = PANEL_DEFS[info.panelId]?.label || info.panelId;
        ghost.style.left = e.clientX + "px";
        ghost.style.top = e.clientY + "px";
        document.body.appendChild(ghost);
        info.ghostEl = ghost;
        const origTab = this.container.querySelector(`.dock-tab[data-panel-id="${info.panelId}"]`);
        if (origTab) origTab.classList.add("dock-tab-dragging");
        info.origTab = origTab;
        document.addEventListener('mousemove', this._onDragMove);
        document.addEventListener('mouseup', this._onDragUp);
        this._onDragMove(e);
    };

    _onPanelDragCancel = () => {
        document.removeEventListener('mousemove', this._onPanelDragThreshold);
        document.removeEventListener('mouseup', this._onPanelDragCancel);
        if (this._dragInfo?.ghostEl) {
            this._dragInfo.ghostEl.remove();
        }
        this._dragInfo = null;
    };

    _findDragHandle(comp) {
        const tag = comp.tagName;
        if (tag === 'OBJECT-TREE') {
            return comp.querySelector('.title_panel') || comp.querySelector('.panel_title');
        }
        if (comp.classList?.contains('property_panel') || comp.id === 'main_property_panel') {
            return comp.querySelector('.prop_panel_title_wrapper') || comp.querySelector('.panel_title');
        }
        const titleEl = comp.querySelector('.prop_panel_title_wrapper') || comp.querySelector('.panel_title');
        if (titleEl) return titleEl;
        let strip = comp.querySelector('.dock-drag-strip');
        if (!strip) {
            strip = document.createElement('div');
            strip.className = 'dock-drag-strip';
            strip.setAttribute('draggable', 'true');
            comp.insertBefore(strip, comp.firstChild);
        }
        return strip;
    }

    _attachComponentElements() {
        for (const id of Object.keys(PANEL_DEFS)) {
            const def = PANEL_DEFS[id];
            const contentAreas = this.container.querySelectorAll(`.dock-leaf[data-panel-id="${id}"] .dock-content`);
            const comp = this._componentRefs?.[id];
            if (comp && contentAreas.length > 0) {
                let attached = false;
                contentAreas.forEach(area => {
                    if (!attached && !area.contains(comp)) {
                        area.appendChild(comp);
                        attached = true;
                    }
                });
                this._panels[id] = comp;
            }
        }
    }

    _activateTab(tabsEl, idx) {
        const leaves = tabsEl.querySelectorAll(".dock-leaf");
        const tabs = tabsEl.querySelectorAll(".dock-tab");
        leaves.forEach((l, i) => l.classList.toggle("dock-hidden", i !== idx));
        tabs.forEach((t, i) => t.classList.toggle("active", i === idx));
        tabsEl.dataset.activeIndex = idx;
        const activeLeaf = leaves[idx];
        if (activeLeaf) {
            const pid = activeLeaf.dataset.panelId;
            const comp = this._componentRefs?.[pid];
            const content = activeLeaf.querySelector(".dock-content");
            if (comp && content && !content.contains(comp)) {
                content.appendChild(comp);
            }
        }
    }

    _startResize(e, resizer) {
        e.preventDefault();
        const splitEl = resizer.parentElement;
        if (!splitEl || !splitEl.classList.contains("dock-split")) return;
        const direction = splitEl.classList.contains("dock-split-h") ? "h" : "v";
        const children = Array.from(splitEl.children).filter(ch => !ch.classList.contains("dock-resizer"));
        // 找出当前拖动条对应的是哪两个子节点
        let leftIdx = -1, nonResizerCount = 0;
        for (const ch of splitEl.children) {
            if (ch === resizer) { leftIdx = nonResizerCount - 1; break; }
            if (!ch.classList.contains("dock-resizer")) nonResizerCount++;
        }
        const leftChild = children[leftIdx];
        const rightChild = children[leftIdx + 1];
        if (!leftChild || !rightChild) return;
        const rect = splitEl.getBoundingClientRect();
        const total = direction === "h" ? rect.width : rect.height;
        const startPos = direction === "h" ? e.clientX : e.clientY;
        const parsePct = (el) => parseFloat((el.style.flex || "1 1 50%").split(/\s+/).pop() || "50");
        this._resizing = {
            splitEl, direction, children, leftIdx, leftChild, rightChild,
            total, startPos,
            startPcts: children.map(parsePct)
        };
        document.body.style.cursor = direction === "h" ? "ew-resize" : "ns-resize";
        document.addEventListener("mousemove", this._onResizeMove);
        document.addEventListener("mouseup", this._onResizeUp);
    }

    _onResizeMove = (e) => {
        const r = this._resizing;
        if (!r) return;
        const pos = r.direction === "h" ? e.clientX : e.clientY;
        const delta = pos - r.startPos;
        const pct = delta / r.total;

        const minPct = 15;
        const deltaPct = pct * 100;
        const newPcts = [...r.startPcts];

        if (deltaPct < 0) {
            const toShrink = -deltaPct;
            let capacity = 0;
            for (let i = 0; i <= r.leftIdx; i++) capacity += r.startPcts[i] - minPct;
            if (toShrink > capacity) return;

            let remaining = toShrink;
            for (let i = r.leftIdx; i >= 0 && remaining > 0; i--) {
                const avail = r.startPcts[i] - minPct;
                const take = Math.min(remaining, avail);
                newPcts[i] = r.startPcts[i] - take;
                remaining -= take;
            }
            newPcts[r.leftIdx + 1] = r.startPcts[r.leftIdx + 1] + toShrink;
        } else if (deltaPct > 0) {
            const toShrink = deltaPct;
            let capacity = 0;
            for (let i = r.leftIdx + 1; i < newPcts.length; i++) capacity += r.startPcts[i] - minPct;
            if (toShrink > capacity) return;

            let remaining = toShrink;
            for (let i = r.leftIdx + 1; i < newPcts.length && remaining > 0; i++) {
                const avail = r.startPcts[i] - minPct;
                const take = Math.min(remaining, avail);
                newPcts[i] = r.startPcts[i] - take;
                remaining -= take;
            }
            newPcts[r.leftIdx] = r.startPcts[r.leftIdx] + toShrink;
        }

        r.children.forEach((ch, i) => {
            ch.style.flex = `1 1 ${newPcts[i]}%`;
        });

        if (r.splitEl._treeNode) {
            r.splitEl._treeNode.sizes = [...newPcts];
        }
    };

    _onResizeUp = () => {
        this._resizing = null;
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", this._onResizeMove);
        document.removeEventListener("mouseup", this._onResizeUp);
    };

    _findTabGroup(panelId) {
        const walk = (n) => {
            if (n.type === "tabs" && n.children.some(c => c.id === panelId)) return n;
            if (n.type === "split") {
                for (const c of n.children) { const r = walk(c); if (r) return r; }
            }
            return null;
        };
        return walk(this.root);
    }

    _cleanupDragPreview() {
        this._previewEl.classList.remove("visible");
        this.container.querySelectorAll(".dock-tab-bar.drag-over").forEach(el => el.classList.remove("drag-over"));
        if (this._dragInfo?.origTab) {
            this._dragInfo.origTab.classList.remove("dock-tab-dragging");
            this._dragInfo.origTab = null;
        }
        if (this._dragInfo?.ghostEl) {
            this._dragInfo.ghostEl.remove();
            this._dragInfo.ghostEl = null;
        }
    }

    _updateDragPreview(target, cx, cy) {
        this.container.querySelectorAll(".dock-tab-bar.drag-over").forEach(el => el.classList.remove("drag-over"));
        this._previewEl.classList.remove("visible");

        if (!target) return;

        if (target.zone === "merge" && target.panelId) {
            const tabBar = this.container.querySelector(`.dock-tabs [data-panel-id="${target.panelId}"]`)?.closest(".dock-tabs")?.querySelector(".dock-tab-bar");
            if (tabBar) tabBar.classList.add("drag-over");
            return;
        }

        if (target.zone === "insert" && target.tabsEl) {
            this._previewEl.classList.add("visible");
            const r = target.tabsEl.getBoundingClientRect();
            const gap = 1;
            const parentSplit = target.tabsEl.parentElement;
            const isH = parentSplit?.classList.contains("dock-split-h");
            if (target.edge === "top" || target.edge === "bottom") {
                let cy;
                if (!isH) {
                    const resizer = target.edge === "bottom"
                        ? target.tabsEl.nextElementSibling
                        : target.tabsEl.previousElementSibling;
                    if (resizer && resizer.classList.contains("dock-resizer")) {
                        const rr = resizer.getBoundingClientRect();
                        cy = (rr.top + rr.bottom) / 2;
                    }
                }
                if (cy == null) cy = target.edge === "bottom" ? r.bottom : r.top;
                this._previewEl.style.left = r.left + "px";
                this._previewEl.style.top = (cy - gap) + "px";
                this._previewEl.style.width = r.width + "px";
                this._previewEl.style.height = (gap * 2) + "px";
            } else {
                let cx;
                if (isH) {
                    const resizer = target.edge === "right"
                        ? target.tabsEl.nextElementSibling
                        : target.tabsEl.previousElementSibling;
                    if (resizer && resizer.classList.contains("dock-resizer")) {
                        const rr = resizer.getBoundingClientRect();
                        cx = (rr.left + rr.right) / 2;
                    }
                }
                if (cx == null) cx = target.edge === "right" ? r.right : r.left;
                this._previewEl.style.left = (cx - gap) + "px";
                this._previewEl.style.top = r.top + "px";
                this._previewEl.style.width = (gap * 2) + "px";
                this._previewEl.style.height = r.height + "px";
            }
        }
    }

    _onDragMove = (e) => {
        if (this._dragInfo?.ghostEl) {
            this._dragInfo.ghostEl.style.left = e.clientX + "px";
            this._dragInfo.ghostEl.style.top = e.clientY + "px";
        }
        const target = this._findDropTarget(e.clientX, e.clientY);
        this._updateDragPreview(target, e.clientX, e.clientY);
    };

    _findDropTarget(cx, cy) {
        const draggedId = this._dragInfo?.panelId;
        const draggedLeafEl = this.container.querySelector(`.dock-leaf[data-panel-id="${draggedId}"]`);
        const draggedTabsEl = draggedLeafEl?.closest(".dock-tabs");

        const tabBars = this.container.querySelectorAll(".dock-tab-bar");
        for (const tabBar of tabBars) {
            const r = tabBar.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                const tabsEl = tabBar.closest(".dock-tabs");
                if (!tabsEl) continue;
                const tabs = tabsEl.querySelectorAll(".dock-tab");
                const panelIds = Array.from(tabs).map(t => t.dataset.panelId);
                if (panelIds.includes(draggedId)) {
                    if (panelIds.length <= 1) return null;
                    continue;
                }
                const targetId = panelIds.find(id => id !== draggedId);
                if (targetId) return { panelId: targetId, zone: "merge" };
            }
        }

        const tabsEls = this.container.querySelectorAll(".dock-tabs");
        let best = null;
        let bestDist = Infinity;
        for (const tabsEl of tabsEls) {
            const leaf = tabsEl.querySelector(".dock-leaf");
            if (!leaf) continue;
            const tabsInGroup = tabsEl.querySelectorAll(".dock-tab").length;
            const hasDraggedTab = tabsEl.querySelector(`.dock-tab[data-panel-id="${draggedId}"]`);
            if (hasDraggedTab && tabsInGroup <= 1) continue;

            const leafEls = Array.from(tabsEl.querySelectorAll(".dock-leaf"));
            const anchorLeaf = leafEls.find(l => l.dataset.panelId !== draggedId);
            const pid = anchorLeaf?.dataset.panelId || leaf.dataset.panelId;
            if (!pid) continue;

            const r = tabsEl.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;

            const inRect = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;

            const parentSplit = tabsEl.parentElement;
            const splitDir = parentSplit?.classList.contains("dock-split-h") ? "h" : "v";
            let extendTop = false, extendBottom = false, extendLeft = false, extendRight = false;

            if (splitDir === "v") {
                extendTop = true;
                extendBottom = true;
                extendLeft = true;
                extendRight = true;
            } else {
                extendLeft = true;
                extendRight = true;
                extendTop = true;
                extendBottom = true;
            }

            const inExtendedTop = extendTop && cy >= r.top - 40 && cy < r.top && cx >= r.left && cx <= r.right;
            const inExtendedBottom = extendBottom && cy > r.bottom && cy <= r.bottom + 40 && cx >= r.left && cx <= r.right;
            const inExtendedLeft = extendLeft && cx >= r.left - 40 && cx < r.left && cy >= r.top && cy <= r.bottom;
            const inExtendedRight = extendRight && cx > r.right && cx <= r.right + 40 && cy >= r.top && cy <= r.bottom;

            if (!inRect && !inExtendedTop && !inExtendedBottom && !inExtendedLeft && !inExtendedRight) continue;

            const relX = (cx - r.left) / r.width;
            const relY = (cy - r.top) / r.height;

            let edge;
            if (inExtendedTop) {
                edge = "top";
            } else if (inExtendedBottom) {
                edge = "bottom";
            } else if (inExtendedLeft) {
                edge = "left";
            } else if (inExtendedRight) {
                edge = "right";
            } else if (relX < 0.33) {
                edge = "left";
            } else if (relX > 0.67) {
                edge = "right";
            } else if (relY < 0.5) {
                edge = "top";
            } else {
                edge = "bottom";
            }

            if (parentSplit && parentSplit.classList.contains("dock-split") && draggedTabsEl) {
                const splitChildren = Array.from(parentSplit.children).filter(
                    ch => !ch.classList.contains("dock-resizer")
                );
                const targetIdx = splitChildren.indexOf(tabsEl);
                const dragIdx = splitChildren.indexOf(draggedTabsEl);
                if (!hasDraggedTab && targetIdx !== -1 && dragIdx !== -1 && targetIdx === dragIdx) continue;

                if (draggedTabsEl.parentElement === parentSplit && !hasDraggedTab) {
                    const parentDir = parentSplit.classList.contains("dock-split-h") ? "h" : "v";
                    const isSameDir = (parentDir === "v" && (edge === "top" || edge === "bottom")) ||
                                      (parentDir === "h" && (edge === "left" || edge === "right"));
                    if (isSameDir) {
                        if (dragIdx === targetIdx + 1 && edge === "bottom") continue;
                        if (dragIdx === targetIdx - 1 && edge === "top") continue;
                        if (dragIdx === targetIdx + 1 && edge === "right") continue;
                        if (dragIdx === targetIdx - 1 && edge === "left") continue;
                    }
                }
            }

            let dist;
            if (edge === "top") dist = cy - r.top;
            else if (edge === "bottom") dist = r.bottom - cy;
            else if (edge === "left") dist = cx - r.left;
            else dist = r.right - cx;
            if (dist < 0) dist = 0;

            if (dist >= bestDist) continue;

            best = { panelId: pid, zone: "insert", edge, tabsEl, dist };
            bestDist = dist;
        }
        return best;
    }

    _findLeafPid(node) {
        if (node.dataset?.panelId) return node.dataset.panelId;
        const leaf = node.querySelector?.(".dock-leaf");
        return leaf?.dataset?.panelId || null;
    }

    _onDragUp = (e) => {
        document.removeEventListener("mousemove", this._onDragMove);
        document.removeEventListener("mouseup", this._onDragUp);
        this._cleanupDragPreview();
        const info = this._dragInfo;
        this._dragInfo = null;
        if (!info) return;
        const draggedId = info.panelId;
        this._dragInfo = { panelId: draggedId };
        const target = this._findDropTarget(e.clientX, e.clientY);
        this._dragInfo = null;
        if (!target || !draggedId) return;
        if (target.zone === "merge" && target.panelId) {
            this._mergeIntoTabs(draggedId, target.panelId);
        } else if (target.zone === "insert" && target.panelId) {
            this._insertAtPanel(draggedId, target.panelId, target.edge);
        }
    };

    _insertAtPanel(draggedId, targetId, zone) {
        const findTarget = (n, parent) => {
            if ((n.type === "leaf" && n.id === targetId) || (n.type === "tabs" && n.children.some(c => c.id === targetId))) {
                return { node: n, parent };
            }
            if (n.type === "split") {
                for (const c of n.children) {
                    const res = findTarget(c, n);
                    if (res) return res;
                }
            }
            if (n.type === "tabs") {
                for (const c of n.children) {
                    const res = findTarget(c, n);
                    if (res) return res;
                }
            }
            return null;
        };
        const targetInfo = findTarget(this.root, null);
        if (!targetInfo || !targetInfo.parent || targetInfo.parent.type !== "split") {
            this._removeLeaf(draggedId);
            const splitNode = this._findBestSplitForInsert(draggedId);
            if (splitNode && splitNode.type === "split") {
                splitNode.children.push(createNode("leaf", { id: draggedId }));
                splitNode.sizes = splitNode.children.map(() => 100 / splitNode.children.length);
            } else if (!this.root) {
                this.root = createNode("leaf", { id: draggedId });
            } else if (this.root.type === "leaf") {
                const newDir = (zone === "left" || zone === "right") ? "h" : "v";
                this.root = createNode("split", { direction: newDir, sizes: [50, 50], children: (zone === "top" || zone === "left")
                    ? [createNode("leaf", { id: draggedId }), this.root]
                    : [this.root, createNode("leaf", { id: draggedId })] });
            } else if (this.root.type === "tabs") {
                const newDir = (zone === "left" || zone === "right") ? "h" : "v";
                this.root = createNode("split", { direction: newDir, sizes: [50, 50], children: (zone === "top" || zone === "left")
                    ? [createNode("leaf", { id: draggedId }), this.root]
                    : [this.root, createNode("leaf", { id: draggedId })] });
            }
            this._rebuild();
            return;
        }
        this._removeLeaf(draggedId);
        const reFound = findTarget(this.root, null);
        if (!reFound || !reFound.parent || reFound.parent.type !== "split") {
            const splitNode = this._findBestSplitForInsert(draggedId);
            if (splitNode && splitNode.type === "split") {
                splitNode.children.push(createNode("leaf", { id: draggedId }));
                splitNode.sizes = splitNode.children.map(() => 100 / splitNode.children.length);
            } else if (this.root && this.root.type === "tabs") {
                const newDir = (zone === "left" || zone === "right") ? "h" : "v";
                this.root = createNode("split", { direction: newDir, sizes: [50, 50], children: (zone === "top" || zone === "left")
                    ? [createNode("leaf", { id: draggedId }), this.root]
                    : [this.root, createNode("leaf", { id: draggedId })] });
            }
            this._rebuild();
            return;
        }
        const { node, parent } = reFound;
        const idx = parent.children.indexOf(node);
        const parentDir = parent.direction || parent.dir;
        const isPerpendicular = ((zone === "left" || zone === "right") && parentDir === "v") ||
                                ((zone === "top" || zone === "bottom") && parentDir === "h");
        if (isPerpendicular) {
            const newDir = (zone === "left" || zone === "right") ? "h" : "v";
            const draggedNode = createNode("leaf", { id: draggedId });
            const children = (zone === "top" || zone === "left")
                ? [draggedNode, node]
                : [node, draggedNode];
            const newSplit = createNode("split", { direction: newDir, sizes: [50, 50], children });
            parent.children[idx] = newSplit;
        } else {
            const insertIdx = (zone === "top" || zone === "left") ? idx : idx + 1;
            parent.children.splice(insertIdx, 0, createNode("leaf", { id: draggedId }));
        }
        parent.sizes = parent.children.map(() => 100 / parent.children.length);
        this._rebuild();
    }

    _mergeIntoTabs(draggedId, targetId) {
        this._removeLeaf(draggedId);
        const findParent = (n, parent) => {
            if (n.type === "leaf" && n.id === targetId) return { node: n, parent, idx: parent?.children.indexOf(n) ?? -1 };
            if (n.type === "tabs") {
                const found = n.children.find(c => c.id === targetId || (c.type === "leaf" && c.id === targetId));
                if (found) return { node: n, parent, idx: parent?.children.indexOf(n) ?? -1 };
            }
            if (n.type === "split") {
                for (const c of n.children) {
                    const res = findParent(c, n);
                    if (res) return res;
                }
            }
            return null;
        };
        const targetInfo = findParent(this.root, null);
        if (!targetInfo) {
            const splitNode = this._findBestSplitForInsert(draggedId);
            if (splitNode && splitNode.type === "split") {
                splitNode.children.push(createNode("leaf", { id: draggedId }));
                splitNode.sizes = splitNode.children.map(() => 100 / splitNode.children.length);
            }
            this._rebuild();
            return;
        }
        const targetNode = targetInfo.node;
        if (targetNode.type === "leaf") {
            const parent = targetInfo.parent;
            const idx = targetInfo.idx;
            const tabsNode = createNode("tabs", { activeIndex: 0, children: [targetNode, createNode("leaf", { id: draggedId })] });
            if (parent) {
                parent.children[idx] = tabsNode;
            } else {
                this.root = tabsNode;
            }
        } else if (targetNode.type === "tabs") {
            targetNode.children.push(createNode("leaf", { id: draggedId }));
        }
        if (this._countLeaves(this.root) <= 1) {
            this.root = findFirstLeaf(this.root);
        }
        this._rebuild();
    }

    _findBestSplitForInsert(draggedId) {
        if (this.root && this.root.type === "split") return this.root;
        return this._findNearestSplit(this.root);
    }

    _findNearestSplit(n) {
        if (!n) return null;
        if (n.type === "split") return n;
        if (n.type === "tabs") {
            for (const c of n.children) {
                const r = this._findNearestSplit(c);
                if (r) return r;
            }
        }
        return null;
    }

    _removeLeaf(id) {
        const walk = (n, parent) => {
            if (n.type === "split") {
                for (let i = n.children.length - 1; i >= 0; i--) {
                    const c = n.children[i];
                    if (c.type === "leaf" && c.id === id) {
                        n.children.splice(i, 1);
                        if (n.sizes && n.sizes.length > n.children.length) {
                            n.sizes.splice(i, 1);
                            const total = n.sizes.reduce((a, b) => a + b, 0);
                            if (total > 0) n.sizes = n.sizes.map(s => s / total * 100);
                        }
                    } else {
                        walk(c, n);
                    }
                }
                if (n.children.length === 1 && parent) {
                    const idx = parent.children.indexOf(n);
                    parent.children[idx] = n.children[0];
                }
                return;
            }
            if (n.type === "tabs") {
                for (let i = n.children.length - 1; i >= 0; i--) {
                    if (n.children[i].id === id) {
                        n.children.splice(i, 1);
                        if (n.activeIndex >= n.children.length)
                            n.activeIndex = Math.max(0, n.children.length - 1);
                        if (n.children.length === 1 && parent) {
                            const idx = parent.children.indexOf(n);
                            parent.children[idx] = n.children[0];
                        }
                        return;
                    }
                }
            }
        };
        walk(this.root, null);
        while (this.root && this.root.type === "split" && this.root.children.length === 1) {
            this.root = this.root.children[0];
        }
        while (this.root && this.root.type === "tabs" && this.root.children.length === 1) {
            this.root = this.root.children[0];
            if (this.root.type !== "leaf") this.root.type = "leaf";
        }
        if (this.root && this.root.type === "tabs" && this.root.children.length === 0) {
            this.root = null;
        }
        if (this.root?.type === "leaf" && this.root.id === id) {
            this.root = null;
        }
    }

    _countLeaves(n) {
        if (n.type === "leaf") return 1;
        if (n.type === "tabs") return n.children.length;
        if (n.type === "split") return n.children.reduce((s, c) => s + this._countLeaves(c), 0);
        return 0;
    }

    _rebuild() {
        this._buildDOM();
    }
}

function findFirstLeaf(n) {
    if (n.type === "leaf") return n;
    if (n.type === "tabs") return n;
    if (n.type === "split") return findFirstLeaf(n.children[0]);
    return n;
}
