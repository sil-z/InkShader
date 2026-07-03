const PANEL_DEFS = {
    canvas: { label: "Canvas", compSelector: ".canvas-wrap" },
    objects: { label: "Objects", compSelector: "object-tree" },
    properties: { label: "Properties", compSelector: ".property_panel" },
    console: { label: "Console", compSelector: "logger-panel" }
};

function createNode(type, data = {}) {
    return { type, ...data };
}

const STORAGE_KEY = 'inkshader_dock_layout_v2';

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
        this._floatedPanels = new Map();
        this._floatGroups = new Map();
        this._panelToGroup = new Map();
        this._floatGroupCounter = 0;
        this._floatZCounter = 1000;
        this._restoring = false;
    }

    initialize(panelIds) {
        this._componentRefs = {};
        for (const [id, def] of Object.entries(PANEL_DEFS)) {
            this._componentRefs[id] = document.querySelector(def.compSelector);
        }
        if (this._restoreFromStorage()) return;
        const canvasIdx = panelIds.indexOf("canvas");
        if (canvasIdx >= 0 && panelIds.length > 1) {
            const otherIds = panelIds.filter(id => id !== "canvas");
            // H-split: canvas on the left (75%), other panels stacked vertically on the right (25%)
            this.root = createNode("split", {
                direction: "h",
                children: [
                    createNode("leaf", { id: "canvas" }),
                    createNode("split", {
                        direction: "v",
                        children: otherIds.map(id => createNode("leaf", { id })),
                        sizes: otherIds.map(() => 100 / otherIds.length)
                    })
                ],
                sizes: [75, 25]
            });
        } else {
            this.root = createNode("split", {
                direction: "v",
                children: panelIds.map(id => createNode("leaf", { id, component: null })),
                sizes: panelIds.map(() => 100 / panelIds.length)
            });
        }
        this._buildDOM();
        this._saveStateToStorage();
    }

    serialize() {
        if (!this.root) return null;
        const walk = (n) => {
            if (!n) return null;
            if (n.type === "leaf") return { type: "leaf", id: n.id };
            if (n.type === "tabs") return { type: "tabs", activeIndex: n.activeIndex, children: n.children.map(c => walk(c)).filter(Boolean) };
            if (n.type === "split") return { type: "split", direction: n.direction, sizes: n.sizes, children: n.children.map(c => walk(c)).filter(Boolean) };
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

    _saveStateToStorage() {
        if (this._restoring) return;
        if (!this.root) return;
        try {
            const floatState = Array.from(this._floatedPanels.entries()).map(([pid, info]) => {
                const groupId = this._panelToGroup.get(pid);
                const floatEl = info.floatEl;
                return {
                    panelId: pid,
                    groupId,
                    left: floatEl.style.left,
                    top: floatEl.style.top,
                    width: floatEl.style.width,
                    height: floatEl.style.height,
                };
            });
            const data = {
                tree: this.serialize(),
                floats: floatState,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // localStorage unavailable
        }
    }

    _restoreFromStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data || !data.tree) return false;
            // Migration: rename panel ID 'terminal' → 'console' in stored layouts
            {
                const migrateId = (node) => {
                    if (!node) return;
                    if (node.type === 'leaf' && node.id === 'terminal') node.id = 'console';
                    if (node.children) node.children.forEach(migrateId);
                };
                migrateId(data.tree);
            }
            if (Array.isArray(data.floats)) {
                data.floats = data.floats.map(f => ({
                    ...f,
                    panelId: f.panelId === 'terminal' ? 'console' : f.panelId
                }));
            }
            this._restoring = true;
            // Assign tree root BEFORE building DOM so all tree operations work
            this.root = data.tree;
            this._buildDOM();
            if (Array.isArray(data.floats)) {
                data.floats.forEach((f) => {
                    const comp = this._componentRefs?.[f.panelId];
                    if (!comp) return;
                    this._floatedPanels.delete(f.panelId);
                    this._floatPanel(f.panelId, {
                        left: parseInt(f.left) || 100,
                        top: parseInt(f.top) || 100,
                    });
                    const floatEl = this._floatedPanels.get(f.panelId)?.floatEl;
                    if (floatEl) {
                        // Override position set by _floatPanel() — that method applies
                        // a -180/-30 offset for drag UX which is wrong during restore.
                        if (f.left) floatEl.style.left = f.left;
                        if (f.top) floatEl.style.top = f.top;
                        if (f.width) floatEl.style.width = f.width;
                        if (f.height) floatEl.style.height = f.height;
                        // Clamp restored position so the tab bar stays within the viewport.
                        const curLeft = parseFloat(floatEl.style.left) || 100;
                        const curTop = parseFloat(floatEl.style.top) || 100;
                        const clamped = this._clampFloatPosition(floatEl, curLeft, curTop);
                        floatEl.style.left = clamped.left + 'px';
                        floatEl.style.top = clamped.top + 'px';
                    }
                });
            }
            // Rebuild DOM to remove empty dock leaves left by float restoration
            this._buildDOM();
            this._restoring = false;
            return true;
        } catch (e) {
            this._restoring = false;
            return false;
        }
    }

    _buildDOM() {
        this.container.textContent = "";
        if (!this.root) return;
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
        el._treeNode = n;
        // Skip tab bar when the only child is the canvas panel (avoids extra "Canvas" tab above canvas content)
        const skipTabBar = n.children.length === 1 && n.children[0].id === "canvas";
        if (!skipTabBar) {
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
        }
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

    _floatPanel(panelId, pos) {
        if (this._floatedPanels.has(panelId)) return;
        const comp = this._componentRefs?.[panelId];
        if (!comp) return;
        const def = PANEL_DEFS[panelId];
        if (!def) return;
        if (this._dragInfo) {
            this._cleanupDragPreview();
            this._dragInfo = null;
        }

        const origLeaf = this.container.querySelector(`.dock-leaf[data-panel-id="${panelId}"]`);
        let left = 100, top = 100, width = 360, height = 240;
        if (pos) {
            left = pos.left - 180;
            top = pos.top - 30;
        } else if (origLeaf) {
            const r = origLeaf.getBoundingClientRect();
            left = r.left; top = r.top; width = r.width; height = r.height;
        }

        this._removeLeaf(panelId);

        const groupId = "float-" + (++this._floatGroupCounter);
        const floatEl = document.createElement("div");
        floatEl.className = "dock-float-window";
        floatEl.style.left = left + "px";
        floatEl.style.top = top + "px";
        floatEl.style.width = width + "px";
        floatEl.style.height = height + "px";
        floatEl.dataset.panelId = panelId;
        floatEl.dataset.floatGroup = groupId;

        const tabBar = document.createElement("div");
        tabBar.className = "dock-tab-bar";

        const initialTab = document.createElement("span");
        initialTab.className = "dock-tab active";
        initialTab.textContent = def.label;
        initialTab.dataset.panelId = panelId;
        initialTab.addEventListener("click", () => this._activateFloatTab(groupId, 0));
        tabBar.appendChild(initialTab);
        floatEl.appendChild(tabBar);

        const body = document.createElement("div");
        body.className = "dock-float-body";
        floatEl.appendChild(body);

        body.appendChild(comp);

        const minW = 120, minH = 60;
        const resizeEdges = ["n","s","e","w","ne","nw","se","sw"];
        resizeEdges.forEach(edge => {
            const h = document.createElement("div");
            h.className = "dock-float-resize handle-" + edge;
            h.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._bringToFront(floatEl);
                const sx = e.clientX, sy = e.clientY;
                const sr = floatEl.getBoundingClientRect();
                const onMove = (ev) => {
                    const dx = ev.clientX - sx, dy = ev.clientY - sy;
                    let l = sr.left, t = sr.top, w = sr.width, h = sr.height;
                    if (edge.includes("e")) w = sr.width + dx;
                    if (edge.includes("w")) { w = sr.width - dx; l = sr.left + dx; }
                    if (edge.includes("s")) h = sr.height + dy;
                    if (edge.includes("n")) { h = sr.height - dy; t = sr.top + dy; }
                    if (w < minW) { if (edge.includes("w")) l = sr.left + sr.width - minW; w = minW; }
                    if (h < minH) { if (edge.includes("n")) t = sr.top + sr.height - minH; h = minH; }
                    if (t < 0) { h = Math.max(minH, h + t); t = 0; }
                    if (l < -(w - 40)) { l = -(w - 40); w = Math.max(minW, w); }
                    floatEl.style.left = l + "px";
                    floatEl.style.top = t + "px";
                    floatEl.style.width = w + "px";
                    floatEl.style.height = h + "px";
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    this._saveStateToStorage();
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });
            floatEl.appendChild(h);
        });

        tabBar.addEventListener("mousedown", (e) => {
            const tab = e.target.closest(".dock-tab");
            if (tab) {
                const pid = tab.dataset.panelId;
                const activePid = floatEl.dataset.panelId;
                if (pid !== activePid) {
                    const gid = floatEl.dataset.floatGroup;
                    const tabBarEl = floatEl.querySelector(".dock-tab-bar");
                    const tabs = tabBarEl ? Array.from(tabBarEl.querySelectorAll(".dock-tab")) : [];
                    const idx = tabs.indexOf(tab);
                    if (idx >= 0) this._activateFloatTab(gid, idx);
                }
                const gid = floatEl.dataset.floatGroup;
                const group = this._floatGroups.get(gid);
                if (group && group.panelIds.length > 1) {
                    // Multi-tab float: dragging a tab detaches it from the group.
                    this._startFloatTabDrag(e, floatEl, pid);
                } else {
                    // Single tab: drag moves the whole window.
                    this._startFloatLabelDrag(e, floatEl, false);
                }
                return;
            }
            e.preventDefault();
            this._bringToFront(floatEl);
            const sx = e.clientX, sy = e.clientY;
            const sl = parseFloat(floatEl.style.left), st = parseFloat(floatEl.style.top);
            const onMove = (ev) => {
                let nl = sl + ev.clientX - sx;
                let nt = st + ev.clientY - sy;
                const clamped = this._clampFloatPosition(floatEl, nl, nt);
                floatEl.style.left = clamped.left + "px";
                floatEl.style.top = clamped.top + "px";
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                this._saveStateToStorage();
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        floatEl.addEventListener("mousedown", () => this._bringToFront(floatEl));

        document.body.appendChild(floatEl);

        this._floatGroups.set(groupId, { floatEl, panelIds: [panelId] });
        this._panelToGroup.set(panelId, groupId);
        this._floatedPanels.set(panelId, { floatEl, comp });
        this._bringToFront(floatEl);
        if (!this._restoring) this._rebuild();
    }

    _startFloatLabelDrag(e, floatEl, bypassThreshold = false) {
        e.preventDefault();
        this._bringToFront(floatEl);
        const panelId = floatEl.dataset.panelId;
        const sx = e.clientX, sy = e.clientY;
        const sl = parseFloat(floatEl.style.left) || 0;
        const st = parseFloat(floatEl.style.top) || 0;

        const onMove = (ev2) => {
            let nl = sl + ev2.clientX - sx;
            let nt = st + ev2.clientY - sy;
            const clamped = this._clampFloatPosition(floatEl, nl, nt);
            floatEl.style.left = clamped.left + "px";
            floatEl.style.top = clamped.top + "px";

            this._dragInfo = { panelId };
            const target = this._findFloatDropTarget(ev2.clientX, ev2.clientY, floatEl) ||
                           this._findDropTarget(ev2.clientX, ev2.clientY);
            this._dragInfo = null;
            this._updateDragPreview(target, ev2.clientX, ev2.clientY);
        };

        const onUp = (ev2) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            this._cleanupDragPreview();

            this._dragInfo = { panelId };
            const target = this._findFloatDropTarget(ev2.clientX, ev2.clientY, floatEl) ||
                           this._findDropTarget(ev2.clientX, ev2.clientY);
            this._dragInfo = null;

            if (target) {
                if (target.zone === "float-merge" && target.groupId) {
                    this._addPanelToFloat(target.groupId, panelId);
                } else if (target.zone === "empty-dock") {
                    // Dock is empty; add this panel back as the root.
                    this._removePanelFromFloat(panelId);
                    this.root = createNode("leaf", { id: panelId });
                    this._rebuild();
                } else {
                    this._removePanelFromFloat(panelId);
                    if (target.zone === "merge" && target.panelId) {
                        this._mergeIntoTabs(panelId, target.panelId);
                    } else if (target.zone === "insert" && target.panelId) {
                        this._insertAtPanel(panelId, target.panelId, target.edge);
                    }
                }
            } else {
                // Dropped in empty space — save the new float position.
                this._saveStateToStorage();
            }
        };

        if (bypassThreshold) {
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
            onMove(e);
        } else {
            function onCancel() {
                document.removeEventListener("mousemove", onThreshold);
                document.removeEventListener("mouseup", onCancel);
            }

            const onThreshold = (ev) => {
                if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
                document.removeEventListener("mousemove", onThreshold);
                document.removeEventListener("mouseup", onCancel);

                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                onMove(ev);
            };

            document.addEventListener("mousemove", onThreshold);
            document.addEventListener("mouseup", onCancel);
        }
    }

    _startFloatTabDrag(e, floatEl, tabPanelId) {
        e.preventDefault();
        this._bringToFront(floatEl);
        const sx = e.clientX, sy = e.clientY;

        // Capture cursor position within the CLICKED TAB, not the tab bar or float.
        // This is essential: when dragging a non-first tab, the new float will have
        // the tab as its only child (at the left edge of the tab bar), so the offset
        // must be relative to the tab element itself, not the tab bar or window.
        const clickedTab = e.target.closest('.dock-tab');
        const tabRect = clickedTab ? clickedTab.getBoundingClientRect() : null;
        const fwRect = floatEl.getBoundingClientRect();
        const origTabBar = floatEl.querySelector('.dock-tab-bar');
        const floatCs = getComputedStyle(floatEl);
        const floatBorder = parseFloat(floatCs.borderLeftWidth) || 0;
        const tabBarCs = origTabBar ? getComputedStyle(origTabBar) : null;
        const padLeft = tabBarCs ? parseFloat(tabBarCs.paddingLeft) || 0 : 0;
        const padTop = tabBarCs ? parseFloat(tabBarCs.paddingTop) || 0 : 0;

        const onThreshold = (ev) => {
            if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
            document.removeEventListener("mousemove", onThreshold);
            document.removeEventListener("mouseup", onCancel);

            // Detach this panel into its own float window.
            this._removePanelFromFloat(tabPanelId);
            this._floatPanel(tabPanelId, { left: ev.clientX, top: ev.clientY });

            const newGroup = Array.from(this._floatGroups.values()).find(g => g.panelIds.includes(tabPanelId));
            if (newGroup) {
                // Position the new float so the cursor stays at the same position
                // within the dragged tab.  In the new float the tab is the first
                // (only) child, so it starts at floatBorder + tabBarPadLeft from
                // the float window's left edge.
                const nf = newGroup.floatEl;
                if (tabRect) {
                    const tabOffX = sx - tabRect.left;
                    const tabOffY = sy - tabRect.top;
                    nf.style.left = (ev.clientX - tabOffX - floatBorder - padLeft) + "px";
                    nf.style.top = (ev.clientY - tabOffY - floatBorder - padTop) + "px";
                } else {
                    nf.style.left = (ev.clientX - sx + fwRect.left) + "px";
                    nf.style.top = (ev.clientY - sy + fwRect.top) + "px";
                }
                this._startFloatLabelDrag(ev, nf, true);
            }
        };

        const onCancel = () => {
            document.removeEventListener("mousemove", onThreshold);
            document.removeEventListener("mouseup", onCancel);
        };

        document.addEventListener("mousemove", onThreshold);
        document.addEventListener("mouseup", onCancel);
    }

    _unfloatPanel(panelId) {
        const groupId = this._panelToGroup.get(panelId);
        if (!groupId) {
            // Panel is in dock tree, just rebuild
            this._rebuild();
            return;
        }
        const group = this._floatGroups.get(groupId);
        if (!group) return;
        group.panelIds = group.panelIds.filter(pid => pid !== panelId);
        this._panelToGroup.delete(panelId);
        this._floatedPanels.delete(panelId);
        if (group.panelIds.length === 0) {
            group.floatEl.remove();
            this._floatGroups.delete(groupId);
        } else {
            this._updateFloatTabBar(groupId);
            if ((group._activeIndex || 0) >= group.panelIds.length) {
                this._activateFloatTab(groupId, group.panelIds.length - 1);
            }
        }
        if (!this.root) {
            this.root = createNode("leaf", { id: panelId });
        } else if (this.root.type === "leaf" || this.root.type === "tabs") {
            this.root = createNode("split", { direction: "v", sizes: [50, 50], children: [this.root, createNode("leaf", { id: panelId })] });
        } else if (this.root.type === "split") {
            this.root.children.push(createNode("leaf", { id: panelId }));
            this.root.sizes = this.root.children.map(() => 100 / this.root.children.length);
        }
        this._rebuild();
    }

    _removePanelFromFloat(panelId) {
        const groupId = this._panelToGroup.get(panelId);
        if (!groupId) return;
        const group = this._floatGroups.get(groupId);
        if (!group) return;
        group.panelIds = group.panelIds.filter(pid => pid !== panelId);
        this._panelToGroup.delete(panelId);
        this._floatedPanels.delete(panelId);
        if (group.panelIds.length === 0) {
            group.floatEl.remove();
            this._floatGroups.delete(groupId);
        } else {
            this._updateFloatTabBar(groupId);
            if ((group._activeIndex || 0) >= group.panelIds.length) {
                this._activateFloatTab(groupId, group.panelIds.length - 1);
            }
        }
        this._saveStateToStorage();
    }

    _unfloatGroup(groupId) {
        const group = this._floatGroups.get(groupId);
        if (!group) return;
        this._floatGroups.delete(groupId);
        group.floatEl.remove();

        const panelIds = [...group.panelIds];
        for (const pid of panelIds) {
            this._panelToGroup.delete(pid);
            this._floatedPanels.delete(pid);
        }

        const addNode = (node) => {
            if (!this.root) {
                this.root = node;
            } else if (this.root.type === "leaf" || this.root.type === "tabs") {
                this.root = createNode("split", { direction: "v", sizes: [50, 50], children: [this.root, node] });
            } else if (this.root.type === "split") {
                this.root.children.push(node);
                this.root.sizes = this.root.children.map(() => 100 / this.root.children.length);
            }
        };

        if (panelIds.length === 1) {
            addNode(createNode("leaf", { id: panelIds[0] }));
        } else {
            addNode(createNode("tabs", { activeIndex: 0, children: panelIds.map(id => createNode("leaf", { id })) }));
        }
        this._rebuild();
    }

    _addPanelToFloat(targetGroupId, panelId) {
        if (this._panelToGroup.get(panelId) === targetGroupId) return;

        const comp = this._componentRefs?.[panelId];
        if (!comp) return;

        const oldGroupId = this._panelToGroup.get(panelId);
        if (oldGroupId) {
            const oldGroup = this._floatGroups.get(oldGroupId);
            if (oldGroup) {
                oldGroup.panelIds = oldGroup.panelIds.filter(pid => pid !== panelId);
                this._floatedPanels.delete(panelId);
                this._panelToGroup.delete(panelId);
                if (oldGroup.panelIds.length === 0) {
                    oldGroup.floatEl.remove();
                    this._floatGroups.delete(oldGroupId);
                } else {
                    this._updateFloatTabBar(oldGroupId);
                }
            }
        } else {
            this._removeLeaf(panelId);
            this._floatedPanels.delete(panelId);
        }

        const targetGroup = this._floatGroups.get(targetGroupId);
        if (!targetGroup) return;

        targetGroup.panelIds.push(panelId);
        this._panelToGroup.set(panelId, targetGroupId);
        this._floatedPanels.set(panelId, { floatEl: targetGroup.floatEl, comp });

        this._updateFloatTabBar(targetGroupId);
        this._activateFloatTab(targetGroupId, targetGroup.panelIds.length - 1);
        if (!oldGroupId) {
            this._rebuild();
        } else {
            this._saveStateToStorage();
        }
    }

    _updateFloatTabBar(groupId) {
        const group = this._floatGroups.get(groupId);
        if (!group) return;
        const floatEl = group.floatEl;
        const tabBar = floatEl.querySelector(".dock-tab-bar");
        if (!tabBar) return;

        tabBar.querySelectorAll(".dock-tab").forEach(t => t.remove());

        group.panelIds.forEach((pid, i) => {
            const tab = document.createElement("span");
            tab.className = "dock-tab";
            tab.textContent = PANEL_DEFS[pid]?.label || pid;
            tab.dataset.panelId = pid;
            tab.addEventListener("click", () => this._activateFloatTab(groupId, i));
            tabBar.appendChild(tab);
        });

        const activeIdx = group._activeIndex || 0;
        tabBar.querySelectorAll(".dock-tab").forEach((t, i) => t.classList.toggle("active", i === activeIdx));
    }

    _activateFloatTab(groupId, idx) {
        const group = this._floatGroups.get(groupId);
        if (!group) return;
        group._activeIndex = idx;
        const floatEl = group.floatEl;

        const tabBar = floatEl.querySelector(".dock-tab-bar");
        if (tabBar) {
            tabBar.querySelectorAll(".dock-tab").forEach((t, i) => t.classList.toggle("active", i === idx));
        }

        const pid = group.panelIds[idx];
        floatEl.dataset.panelId = pid;

        const body = floatEl.querySelector(".dock-float-body");
        if (body) {
            const comp = this._componentRefs?.[pid];
            if (comp && !body.contains(comp)) {
                body.textContent = "";
                body.appendChild(comp);
            }
        }
    }

    _findFloatDropTarget(cx, cy, currentFloatEl) {
        const floatWindows = document.querySelectorAll(".dock-float-window");
        for (const fw of floatWindows) {
            if (currentFloatEl && fw === currentFloatEl) continue;
            if (fw.classList.contains("dock-float-window")) {
                const tabBar = fw.querySelector(".dock-tab-bar");
                if (!tabBar) continue;
                const r = tabBar.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                    const gid = fw.dataset.floatGroup;
                    if (gid) return { groupId: gid, zone: "float-merge" };
                }
            }
        }
        return null;
    }

    _getTabBarHeight(floatEl) {
        const tabBar = floatEl.querySelector('.dock-tab-bar');
        return tabBar ? tabBar.offsetHeight : 30;
    }

    _clampFloatPosition(floatEl, left, top) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const fw = parseFloat(floatEl.style.width) || floatEl.offsetWidth;
        const tabH = this._getTabBarHeight(floatEl);
        // Keep the tab bar (draggable area) fully within the viewport.
        // Body content below the tab bar is allowed to extend off-screen at the bottom.
        top = Math.max(0, Math.min(top, vh - tabH));
        // Keep at least 200px of the window visible horizontally so the tab bar is reachable.
        left = Math.max(-(fw - 200), Math.min(left, vw - 200));
        return { left, top };
    }

    _bringToFront(floatEl) {
        this._floatZCounter++;
        floatEl.style.zIndex = this._floatZCounter;
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
            startTime: Date.now(),
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
        if (Date.now() - info.startTime < 200) return;
        document.removeEventListener('mousemove', this._onPanelDragThreshold);
        document.removeEventListener('mouseup', this._onPanelDragCancel);

        const panelId = info.panelId;
        const startX = info.startMouseX;
        const startY = info.startMouseY;
        const handleRect = info.handle?.getBoundingClientRect();
        // Capture tab bar rect BEFORE _floatPanel rebuilds the DOM.
        const isTabHandle = !!(info.handle && info.handle.closest('.dock-tab'));
        let tabBarRect, tabRect;
        if (isTabHandle) {
            const tab = info.handle.closest('.dock-tab');
            if (tab) tabRect = tab.getBoundingClientRect();
            const tabBar = info.handle.closest('.dock-tab-bar');
            if (tabBar) tabBarRect = tabBar.getBoundingClientRect();
        }
        this._dragInfo = null;

        this._floatPanel(panelId, { left: e.clientX, top: e.clientY });

        const floatGroup = Array.from(this._floatGroups.values()).find(g => g.panelIds.includes(panelId));
        if (floatGroup) {
            const floatEl = floatGroup.floatEl;
            if (handleRect && info.handle) {
                if (!isTabHandle) {
                    // Non-tab handles (e.g. title bar inside the panel body):
                    // keep the cursor at the same relative position within the handle.
                    // The handle was inside the dock content; in the new float it sits
                    // inside .dock-float-body which starts below the tab bar + border.
                    const offsetX = startX - handleRect.left;
                    const offsetY = startY - handleRect.top;
                    const fCs = getComputedStyle(floatEl);
                    const fBorder = parseFloat(fCs.borderLeftWidth) || 0;
                    const tabBarH = this._getTabBarHeight(floatEl);
                    floatEl.style.left = (e.clientX - offsetX - fBorder) + "px";
                    floatEl.style.top = (e.clientY - offsetY - fBorder - tabBarH) + "px";
                } else if (tabRect) {
                    // Tab handle: offset relative to the CLICKED TAB, so cursor stays
                    // at the same position within the tab regardless of its index.
                    // The new float has the tab as its only child, starting at
                    // (floatBorder + tabBarPadLeft) from the window edge.
                    const offsetX = startX - tabRect.left;
                    const offsetY = startY - tabRect.top;
                    const fCs = getComputedStyle(floatEl);
                    const fBorder = parseFloat(fCs.borderLeftWidth) || 0;
                    const tBar = floatEl.querySelector('.dock-tab-bar');
                    const tCs = tBar ? getComputedStyle(tBar) : null;
                    const pL = tCs ? parseFloat(tCs.paddingLeft) || 0 : 0;
                    const pT = tCs ? parseFloat(tCs.paddingTop) || 0 : 0;
                    floatEl.style.left = (e.clientX - offsetX - fBorder - pL) + "px";
                    floatEl.style.top = (e.clientY - offsetY - fBorder - pT) + "px";
                } else if (tabBarRect) {
                    // Fallback: offset relative to the dock tab bar.
                    const offsetX = startX - tabBarRect.left;
                    const offsetY = startY - tabBarRect.top;
                    floatEl.style.left = (e.clientX - offsetX) + "px";
                    floatEl.style.top = (e.clientY - offsetY) + "px";
                }
            }
            this._startFloatLabelDrag(e, floatEl, true);
        }
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
        // Do not inject a drag strip into .canvas-wrap — it disrupts the glyph-sequence-bar layout
        if (comp.classList?.contains('canvas-wrap')) return null;
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
        if (tabsEl._treeNode) tabsEl._treeNode.activeIndex = idx;
        const activeLeaf = leaves[idx];
        if (activeLeaf) {
            const pid = activeLeaf.dataset.panelId;
            const comp = this._componentRefs?.[pid];
            const content = activeLeaf.querySelector(".dock-content");
            if (comp && content && !content.contains(comp)) {
                content.appendChild(comp);
            }
        }
        this._saveStateToStorage();
    }

    _startResize(e, resizer) {
        e.preventDefault();
        const splitEl = resizer.parentElement;
        if (!splitEl || !splitEl.classList.contains("dock-split")) return;
        const direction = splitEl.classList.contains("dock-split-h") ? "h" : "v";
        const children = Array.from(splitEl.children).filter(ch => !ch.classList.contains("dock-resizer"));
        // Find which two child nodes correspond to the current drag bar
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
        document.body.classList.add(direction === "h" ? 'is-resizing-h' : 'is-resizing-v');
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
        document.body.classList.remove('is-resizing-h', 'is-resizing-v');
        document.removeEventListener("mousemove", this._onResizeMove);
        document.removeEventListener("mouseup", this._onResizeUp);
        this._saveStateToStorage();
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

    /**
     * Walk up from tabsEl to find the true seam (resizer midpoint) for the given edge.
     * Handles nested splits: e.g. a panel inside a V-split that is itself inside an H-split
     * needs to find the H-split's resizer when edge="left"/"right".
     *
     * @param {Element} tabsEl - The .dock-tabs element being targeted
     * @param {string} edge - "top"|"bottom"|"left"|"right"
     * @returns {number} The viewport coordinate of the seam (x for left/right, y for top/bottom)
     */
    _calcSeam(tabsEl, edge) {
        const wantH = (edge === "left" || edge === "right");
        const wantNext = (edge === "right" || edge === "bottom");

        let el = tabsEl;
        while (el.parentElement) {
            const parent = el.parentElement;
            if (parent.classList.contains("dock-split")) {
                const isHDir = parent.classList.contains("dock-split-h");
                if (wantH === isHDir) {
                    const sibling = wantNext ? el.nextElementSibling : el.previousElementSibling;
                    if (sibling && sibling.classList.contains("dock-resizer")) {
                        const sr = sibling.getBoundingClientRect();
                        return wantH ? (sr.left + sr.right) / 2 : (sr.top + sr.bottom) / 2;
                    }
                    const er = el.getBoundingClientRect();
                    return wantH ? (wantNext ? er.right : er.left) : (wantNext ? er.bottom : er.top);
                }
            }
            el = parent;
        }

        const r = tabsEl.getBoundingClientRect();
        return wantH ? (wantNext ? r.right : r.left) : (wantNext ? r.bottom : r.top);
    }

    _cleanupDragPreview() {
        this._previewEl.classList.remove("visible", "dock-preview-merge", "dock-preview-insert");
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
        if (!target) {
            this._previewEl.classList.remove("visible", "dock-preview-merge", "dock-preview-insert");
            return;
        }
        this._previewEl.classList.remove("visible", "dock-preview-merge", "dock-preview-insert");
        this._previewEl.style.zIndex = "";

        if (target.zone === "float-merge" && target.groupId) {
            const fw = document.querySelector(`.dock-float-window[data-float-group="${target.groupId}"]`);
            if (fw) {
                const tabBar = fw.querySelector(".dock-tab-bar");
                if (tabBar) {
                    const r = tabBar.getBoundingClientRect();
                    this._previewEl.classList.add("dock-preview-merge");
                    this._previewEl.style.left = r.left + "px";
                    this._previewEl.style.top = r.top + "px";
                    this._previewEl.style.width = r.width + "px";
                    this._previewEl.style.height = r.height + "px";
                    const fwZ = parseInt(fw.style.zIndex) || 1000;
                    this._previewEl.style.zIndex = (fwZ + 1).toString();
                    this._previewEl.classList.add("visible");
                }
            }
            return;
        }

        if (target.zone === "empty-dock") {
            const cr = this.container.getBoundingClientRect();
            const PREVIEW_THICKNESS = 4;
            this._previewEl.classList.add("dock-preview-insert");
            this._previewEl.style.left = (cr.left - PREVIEW_THICKNESS / 2) + "px";
            this._previewEl.style.top = cr.top + "px";
            this._previewEl.style.width = PREVIEW_THICKNESS + "px";
            this._previewEl.style.height = cr.height + "px";
            this._previewEl.classList.add("visible");
            return;
        }

        if (target.zone === "merge" && target.panelId) {
            const tabsEl = this.container.querySelector(`.dock-tabs [data-panel-id="${target.panelId}"]`)?.closest(".dock-tabs");
            if (tabsEl) {
                const tabBar = tabsEl.querySelector(".dock-tab-bar");
                if (tabBar) {
                    const r = tabBar.getBoundingClientRect();
                    this._previewEl.classList.add("dock-preview-merge");
                    this._previewEl.style.left = r.left + "px";
                    this._previewEl.style.top = r.top + "px";
                    this._previewEl.style.width = r.width + "px";
                    this._previewEl.style.height = r.height + "px";
                    this._previewEl.classList.add("visible");
                }
            }
            return;
        }

        if (target.zone === "insert" && target.tabsEl) {
            const PREVIEW_THICKNESS = 4;
            const half = PREVIEW_THICKNESS / 2;
            const r = target.tabsEl.getBoundingClientRect();
            const seam = this._calcSeam(target.tabsEl, target.edge);
            this._previewEl.classList.add("dock-preview-insert");
            this._previewEl.classList.add("visible");

            if (target.edge === "top" || target.edge === "bottom") {
                const left = r.left;
                const top = seam - half;
                const width = r.width;
                const height = PREVIEW_THICKNESS;
                this._previewEl.style.left = left + "px";
                this._previewEl.style.top = top + "px";
                this._previewEl.style.width = width + "px";
                this._previewEl.style.height = height + "px";
            } else {
                const left = seam - half;
                const top = r.top;
                const width = PREVIEW_THICKNESS;
                const height = r.height;
                this._previewEl.style.left = left + "px";
                this._previewEl.style.top = top + "px";
                this._previewEl.style.width = width + "px";
                this._previewEl.style.height = height + "px";
            }
        }
    }

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
        // Fallback: if the dock container is empty (all panels floated), allow dropping
        // anywhere over the container to re-dock the dragged panel.
        const hasDockChildren = this.container.querySelector('.dock-tabs, .dock-leaf, .dock-split');
        if (!hasDockChildren) {
            const cr = this.container.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0 &&
                cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom) {
                return { panelId: draggedId, zone: "empty-dock" };
            }
        }
        return best;
    }

    _findLeafPid(node) {
        if (node.dataset?.panelId) return node.dataset.panelId;
        const leaf = node.querySelector?.(".dock-leaf");
        return leaf?.dataset?.panelId || null;
    }

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
        if (!this.root) return;
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
                        if (i === n.activeIndex) {
                            // Removed tab was active: go to previous tab
                            n.activeIndex = Math.max(0, i - 1);
                        } else if (n.activeIndex >= n.children.length) {
                            n.activeIndex = n.children.length - 1;
                        }
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
        this._saveStateToStorage();
    }
}

function findFirstLeaf(n) {
    if (n.type === "leaf") return n;
    if (n.type === "tabs") return n;
    if (n.type === "split") return findFirstLeaf(n.children[0]);
    return n;
}
