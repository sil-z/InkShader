import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { getCanvasTheme } from "../canvas/rendering/canvas_theme.js";
import { installEnterBlurHandler, isValidTreeName } from "./input_validation.js";
const TOOLBAR_W = 28;
function _toAfdkoName(str) {
    const parts = [];
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        parts.push("uni" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
    return parts.join("_");
}
const AFDKO_NAMES = {
    32:"space",33:"exclam",34:"quotedbl",35:"numbersign",36:"dollar",37:"percent",
    38:"ampersand",39:"quotesingle",40:"parenleft",41:"parenright",42:"asterisk",
    43:"plus",44:"comma",45:"hyphen",46:"period",47:"slash",
    48:"zero",49:"one",50:"two",51:"three",52:"four",53:"five",54:"six",
    55:"seven",56:"eight",57:"nine",58:"colon",59:"semicolon",60:"less",
    61:"equal",62:"greater",63:"question",64:"at",
    65:"A",66:"B",67:"C",68:"D",69:"E",70:"F",71:"G",72:"H",73:"I",74:"J",
    75:"K",76:"L",77:"M",78:"N",79:"O",80:"P",81:"Q",82:"R",83:"S",84:"T",
    85:"U",86:"V",87:"W",88:"X",89:"Y",90:"Z",
    91:"bracketleft",92:"backslash",93:"bracketright",94:"asciicircum",
    95:"underscore",96:"grave",
    97:"a",98:"b",99:"c",100:"d",101:"e",102:"f",103:"g",104:"h",105:"i",
    106:"j",107:"k",108:"l",109:"m",110:"n",111:"o",112:"p",113:"q",114:"r",
    115:"s",116:"t",117:"u",118:"v",119:"w",120:"x",121:"y",122:"z",
    123:"braceleft",124:"bar",125:"braceright",126:"asciitilde"
};
export class GlyphSequenceBar extends HTMLElement {
    constructor() {
        super();
        this.text = "";
        this.activeIndices = new Set();
        this.activeGroupId = null;
        this._canvas = null;
        this._track = null;
        this._cleanups = [];
        this._textSig = "";
        this._activeSig = "";
        this._selSig = "";
        this._offSig = "";
        this._vpOffSig = 0;
        this._vpScaleSig = 1;
        this._lastWidth = 0;
        this._previewCanvas = document.createElement("canvas");
        this._previewCanvas.width = 120;
        this._previewCanvas.height = 120;
        this._previewCtx = this._previewCanvas.getContext("2d", { willReadFrequently: true });
        this._activeMenu = null;
        this._lastTriggerBtn = null;
        // 指针按下期间的重建保护（见 _render）：按下 -> 松开 -> click 这条
        // 链上任何一个环节把被按下的按钮从 DOM 摘掉，click 就永远不会产生。
        this._pointerDownOnBar = false;
        this._renderPending = false;
        this._renderDeferredAt = 0;
        this._deferredFlushArmed = false;
        this._menuOpenedAt = 0;
    }
    /**
     * 视图签名。onState（状态事件）与 onRender（画布重绘）必须用同一个来源判断
     * “视图是否变了”，否则两者会永久互相认为对方的值是新的：窗口最大化/尺寸变化
     * 时画布 offset 变了而 store 里的 offset 还是旧值，于是之后每一个状态事件都被
     * 判成“变了” -> 每次 mouseup 都整条重建轨道 -> click 被吃掉。
     */
    _viewSig() {
        const c = this._canvas;
        if (!c) return "";
        return `${c.offset?.x ?? 0},${c.scale ?? 1}`;
    }
    connectedCallback() {
        // Ensure DOM is created once (survives dock reconnect)
        if (!this._track) {
            this._canvas = document.querySelector("main-canvas");
            this._track = document.createElement("div");
            this._track.className = "seq-bar-track";
            this._track.addEventListener("click", (e) => this._onTrackClick(e));
            // 记录“指针正按在序列条上”：_render 在此期间只做挂起，绝不重建 DOM。
            // 用 mousedown 而不是 pointerdown：合成输入（测试探针、部分远端输入）
            // 不一定会派发 pointer 事件，而 mousedown 一定会到。
            this._track.addEventListener(
                "mousedown",
                () => {
                    this._pointerDownOnBar = true;
                },
                true
            );
            this.appendChild(this._track);
        }
        // Always re-register listeners (disconnectedCallback cleans them up)
        this._cleanups = [];
        // 松开（含在序列条外松开）后解除保护，并把被挂起的重建补上。
        // 用 document 捕获阶段：按钮上的监听器不影响我们观察松开事件。
        const onDocRelease = () => this._endPointerPress();
        // 窗口失焦（原生拖动切全屏/最大化、Alt+Tab 等）：收不到 mouseup 也必须
        // 解开保护，否则序列条会一直停在“不重建”状态。
        const onBlur = () => this._forceEndPointerPress();
        document.addEventListener("mouseup", onDocRelease, true);
        document.addEventListener("pointercancel", onDocRelease, true);
        window.addEventListener("blur", onBlur);
        this._cleanups.push(() => {
            document.removeEventListener("mouseup", onDocRelease, true);
            document.removeEventListener("pointercancel", onDocRelease, true);
            window.removeEventListener("blur", onBlur);
        });
        const onState = (e) => {
            const s = e?.detail?.afterState;
            if (!s) return;
            const actionType = e?.detail?.action?.type;
            const text = s.sequenceText ?? "";
            const activeKey = JSON.stringify(s.activeSequenceIndices);
            const offKey = this._viewSig();
            // Active-glyph signature: the focused group (activeGroupId) + tree selection.
            // The sequence bar highlight follows the app's "active group" (selection),
            // NOT activeSequenceIndices (a bookkeeping set that grows with every add).
            const selKey = `${s.activeGroupId ?? ""}|${JSON.stringify(s.selectedTreeIds || [])}`;
            // Always re-render for display-affecting actions (lock, vis).
            // For other actions, skip if nothing changed.
            const isDisplayAction = actionType === "TOGGLE_SELECTED_OBJECTS_LOCK" || actionType === "TOGGLE_SELECTED_OBJECTS_DISPLAY";
            if (!isDisplayAction && actionType !== "TREE_REVISION" && text === this._textSig && activeKey === this._activeSig && offKey === this._offSig && selKey === this._selSig) return;
            this._textSig = this.text = text;
            this._activeSig = activeKey;
            this._offSig = offKey;
            this._selSig = selKey;
            this.activeIndices = new Set(s.activeSequenceIndices || []);
            this.activeGroupId = s.activeGroupId ?? null;
            this._render();
        };
        this._cleanups.push(appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, onState));
        const onRender = () => {
            const c = this._canvas;
            if (!c) return;
            const ox = c.offset?.x ?? 0;
            const sc = c.scale;
            // 与 onState 用同一个来源（_viewSig）：两侧取值来源不同会让彼此永远
            // 认为对方的值是新的，从而在每个状态事件上多余地整条重建轨道。
            this._offSig = this._viewSig();
            // Scale change: full re-render to re-evaluate collapse/expand —
            // glyph widths at different zoom levels may fit in or overflow
            // their slots differently.
            if (sc !== this._vpScaleSig) {
                this._vpScaleSig = sc;
                this._vpOffSig = ox;
                this._render();
                return;
            }
            // Offset change (pan/drag): lightweight position update, no DOM
            // rebuild. Full _render() causes visible button flickering when
            // DevTools triggers software compositing.
            if (ox !== this._vpOffSig) {
                this._vpOffSig = ox;
                this._updatePositions();
                return;
            }
            // Re-evaluate collapse/expand when container width changes
            // (divider drag, window resize). The canvasrendered event fires
            // after these resize scenarios complete.
            const cw = this.clientWidth;
            if (cw !== this._lastWidth) {
                this._lastWidth = cw;
                this._render();
            }
        };
        document.addEventListener("canvasrendered", onRender);
        this._cleanups.push(() => document.removeEventListener("canvasrendered", onRender));
        EditorModel.whenEditorStoreReady((st) => {
            this.text = st.sequenceText ?? "";
            this.activeIndices = new Set(st.activeSequenceIndices || []);
            this.activeGroupId = st.activeGroupId ?? null;
            this._textSig = this.text;
            this._activeSig = JSON.stringify(st.activeSequenceIndices);
            this._selSig = `${st.activeGroupId ?? ""}|${JSON.stringify(st.selectedTreeIds || [])}`;
            this._offSig = st.offset ? `${st.offset.x},${st.scale}` : "";
            this._vpScaleSig = st.scale ?? 1;
            this._vpOffSig = st.offset?.x ?? 0;
            requestAnimationFrame(() => this._render());
        });
    }
    disconnectedCallback() {
        this._cleanups.forEach((fn) => fn());
        this._cleanups = [];
    }
    _offX() {
        const c = this._canvas;
        if (!c) return 0;
        return (c.ruler_size ?? 20) + (c.offset?.x ?? 0);
    }
    /**
     * 松开指针：解除“按下期间禁止重建”的保护，并补一次被挂起的重建。
     *
     * 为什么补建要等一拍：浏览器只有在 mousedown 与 mouseup 命中同一祖先时才
     * 合成 click。若我们在 mouseup 的同一条任务里就把轨道 DOM 换掉，浏览器计算
     * click 目标时会发现按下时的按钮已离线，于是 click 根本不派发 —— 按钮的监听器
     * 永远不执行（用户看到的就是“点了没反应”）。所以先等 click 走完（click 紧跟
     * mouseup），再重建；同时用超时兜底，避免没有 click（在别处松开）时永远不恢复。
     */
    _forceEndPointerPress() {
        this._pointerDownOnBar = false;
        if (!this._renderPending) return;
        this._renderPending = false;
        this._render();
    }
    _endPointerPress() {
        if (!this._pointerDownOnBar) return;
        this._pointerDownOnBar = false;
        if (!this._renderPending) return;
        if (this._deferredFlushArmed) return;
        this._deferredFlushArmed = true;
        const flush = () => {
            this._deferredFlushArmed = false;
            if (this._pointerDownOnBar) return; // 又按下去了，继续保持挂起
            if (!this._renderPending) return;
            this._renderPending = false;
            this._render();
        };
        const onDocClick = () => {
            document.removeEventListener("click", onDocClick, true);
            setTimeout(flush, 0);
        };
        document.addEventListener("click", onDocClick, true);
        setTimeout(() => {
            document.removeEventListener("click", onDocClick, true);
            flush();
        }, 200);
    }
    _render() {
        // 指针按下期间绝不重建轨道 DOM：mousedown 命中的按钮如果被摘掉，
        // mouseup/click 都拿不到共同祖先，click 事件根本不会产生 —— 这正是
        // “最大化后点 add glyph 再也点不出菜单”的成因（窗口尺寸变化后每个
        // 状态事件都会触发一次多余重建，而 mouseup 恰好会发一个状态事件）。
        if (this._pointerDownOnBar) {
            this._renderPending = true;
            this._renderDeferredAt = performance.now();
            return;
        }
        // Close any open menu before rebuilding the track — _render() destroys
        // all child elements (including trigger buttons), rendering the existing
        // menu's stale triggerBtn reference unusable for hit-testing.
        if (this._activeMenu) {
            // 例外：本次按下期间刚打开的菜单必须留下。挂起的重建会在 press 之后
            // 补做，若照常关掉，用户看到的就是“菜单一闪即逝”。只解除它与旧触发
            // 按钮的绑定；下一次点击别处仍会正常关闭它。
            const openedDuringDefer = this._menuOpenedAt >= this._renderDeferredAt && this._renderDeferredAt > 0;
            if (openedDuringDefer && this._activeMenu.isConnected) {
                this._keepMenuRebindTrigger = this._activeMenuTriggerKey || null;
                this._lastTriggerBtn = null;
            } else {
                if (this._activeMenu.isConnected) this._activeMenu.remove();
                this._activeMenu = null;
                this._lastTriggerBtn = null;
            }
        }
        const rebindKey = this._keepMenuRebindTrigger;
        this._keepMenuRebindTrigger = null;
        this._renderTrack();
        // 上面保留了菜单时，重建后把菜单重新绑到等价的触发按钮上（同一个 key），
        // 这样“再点一次触发按钮 = 关闭菜单”的语义在重建之后依然成立。
        if (rebindKey && this._track) {
            const btn = this._track.querySelector(`[data-seq-trigger-key="${rebindKey}"]`);
            if (btn) this._lastTriggerBtn = btn;
        }
    }
    _renderTrack() {
        const tr = this._track;
        if (!tr) return;
        tr.textContent = "";
        const c = this._canvas;
        const sc = c?.scale ?? 1;
        const ox = this._offX();
        if (!this.text) {
            tr.appendChild(this._addBtn(TOOLBAR_W + ox));
            return;
        }
        const tokens = EditorModel.parseSequenceText(this.text);
        const nextX = [];
        for (let i = 0; i < tokens.length; i++) {
            const off = c?.curve_manager?.getSeqOffset(i) ?? 0;
            nextX.push(TOOLBAR_W + ox + off * sc);
        }
        let lastEnd = TOOLBAR_W + ox;
        if (tokens.length > 0) {
            const last = tokens[tokens.length - 1];
            const lastOff = c?.curve_manager?.getSeqOffset(tokens.length - 1) ?? 0;
            const lastGid = last.isChar ? EditorModel.getDefaultGroupForChar(last.value) : last.value;
            const lastGi = lastGid ? EditorModel.getTreeItem(lastGid) : null;
            lastEnd += (lastOff + (lastGi?.advance ?? 1000)) * sc;
        }
        const containerW = this.clientWidth;
        const deferred = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            const gid = tok.isChar ? EditorModel.getDefaultGroupForChar(tok.value) : tok.value;
            // Active glyph = the app's currently focused group (tree selection),
            // tracked via activeGroupId. Not activeSequenceIndices.
            const active = gid != null && gid !== "" && gid === this.activeGroupId;
            const sx = nextX[i];
            const nextSx = i + 1 < tokens.length ? nextX[i + 1] : lastEnd;
            const availW = nextSx - sx;
            const gi = gid ? EditorModel.getTreeItem(gid) : null;
            const locked = !!(gi?.locked);
            const hidden = gi?.visible === false;
            const name = gi?.name ?? (tok.display || tok.value);
            const code = gi?.charCode ?? null;
            const codeStr = code != null ? String(code) : "";
            const isMissing = code == null;
            // Each action button: 20px + 2px gap. Buttons: lock, vis, minus, name(20), code(20), plus
            const totMin = 20 + 2 + 20 + 2 + 20 + 2 + 20 + 2 + 20 + 2 + 20;
            const isLast = i === tokens.length - 1;
            const pd = { gid, name, codeStr, isMissing, idx: i, locked, hidden, active, sx, availW };
            // Defer if squeezed between neighbours, or if doesn't fit in the container
            if (availW < 20 || (sx + totMin > containerW && !isLast)) {
                deferred.push(pd);
                continue;
            }
            const pos = document.createElement("div");
            pos.className = "seq-bar-pos" + (pd.active ? " active" : "");
            pos.style.left = `${sx}px`;
            if (deferred.length > 0 && (isLast || availW >= totMin + 44)) {
                const prevItems = [...deferred];
                deferred.length = 0;
                const eb = document.createElement("div");
                eb.className = "seq-bar-ellipsis";
                eb.textContent = prevItems.length > 1 ? String(prevItems.length) : "\u22EF";
                eb.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._showMergedPopup(e, prevItems);
                });
                pos.appendChild(eb);
                if (!isLast) pos.style.maxWidth = `${pd.availW}px`;
                pos.appendChild(this._mkLockBtn(pd.gid));
                pos.appendChild(this._mkVisBtn(pd.gid));
                pos.appendChild(this._mkRemoveBtn(pd.gid, pd.idx));
                const ns = document.createElement("span");
                ns.className = "seq-bar-name";
                ns.textContent = pd.name;
                pos.appendChild(ns);
                if (pd.codeStr) {
                    const cs = document.createElement("span");
                    cs.className = "seq-bar-code";
                    cs.textContent = pd.codeStr;
                    pos.appendChild(cs);
                }
                pos.appendChild(isLast ? this._mkInsertLastBtn(pd.idx) : this._mkInsertBtn(pd.idx));
                pos.addEventListener("click", (e) => { e.stopPropagation(); this._focusInTree(pd.gid); });
            } else if (deferred.length > 0) {
                const all = [...deferred, pd];
                deferred.length = 0;
                const eb = document.createElement("div");
                eb.className = "seq-bar-ellipsis";
                eb.textContent = String(all.length);
                eb.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._showMergedPopup(e, all);
                });
                pos.appendChild(eb);
                pos.addEventListener("click", (e) => e.stopPropagation());
            } else if (isLast || pd.availW >= totMin) {
                if (!isLast) pos.style.maxWidth = `${pd.availW}px`;
                pos.appendChild(this._mkLockBtn(pd.gid));
                pos.appendChild(this._mkVisBtn(pd.gid));
                pos.appendChild(this._mkRemoveBtn(pd.gid, pd.idx));
                const ns = document.createElement("span");
                ns.className = "seq-bar-name";
                ns.textContent = pd.name;
                pos.appendChild(ns);
                if (pd.codeStr) {
                    const cs = document.createElement("span");
                    cs.className = "seq-bar-code";
                    cs.textContent = pd.codeStr;
                    pos.appendChild(cs);
                }
                pos.appendChild(isLast ? this._mkInsertLastBtn(pd.idx) : this._mkInsertBtn(pd.idx));
                pos.addEventListener("click", (e) => { e.stopPropagation(); this._focusInTree(pd.gid); });
            } else {
                const eb = document.createElement("div");
                eb.className = "seq-bar-ellipsis";
                eb.textContent = "\u22EF";
                eb.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._showMergedPopup(e, [pd]);
                });
                pos.appendChild(eb);
                pos.addEventListener("click", (e) => { e.stopPropagation(); this._focusInTree(pd.gid); });
            }
            tr.appendChild(pos);
        }
        if (deferred.length > 0) {
            const firstSx = deferred[0].sx;
            const pos = document.createElement("div");
            pos.className = "seq-bar-pos";
            const eb = document.createElement("div");
            eb.className = "seq-bar-ellipsis";
            eb.textContent = deferred.length > 1 ? String(deferred.length) : "\u22EF";
            eb.addEventListener("click", (e) => {
                e.stopPropagation();
                this._showMergedPopup(e, deferred);
            });
            pos.appendChild(eb);
            // Clamp ellipsis to visible area so overflow-hidden doesn't hide it
            pos.style.left = `${Math.min(firstSx, containerW - 22)}px`;
            tr.appendChild(pos);
        }
    }
    // Lightweight position update when only viewport offset/scale changed
    // (canvas pan/zoom).  Avoids full DOM rebuild in _render() that causes
    // visible flickering when DevTools triggers software compositing.
    _updatePositions() {
        const tr = this._track;
        const c = this._canvas;
        if (!tr || !c || !this.text) {
            // No content or missing context — ensure add button is positioned
            if (tr) {
                const addBtn = tr.querySelector('.seq-bar-add-btn');
                if (addBtn) addBtn.style.left = `${TOOLBAR_W + this._offX()}px`;
            }
            return;
        }
        const sc = c.scale ?? 1;
        const ox = this._offX();
        const tokens = EditorModel.parseSequenceText(this.text);

        const addBtn = tr.querySelector('.seq-bar-add-btn');
        if (addBtn) addBtn.style.left = `${TOOLBAR_W + ox}px`;

        const posEls = tr.querySelectorAll('.seq-bar-pos');
        // If DOM structure doesn't match token count, fall back to full render
        if (posEls.length !== tokens.length) {
            this._render();
            return;
        }
        for (let i = 0; i < posEls.length; i++) {
            const off = c.curve_manager?.getSeqOffset(i) ?? 0;
            posEls[i].style.left = `${TOOLBAR_W + ox + off * sc}px`;
        }
    }

    _showMergedPopup(e, items) {
        const old = document.querySelector(".seq-bar-popup");
        if (old) old.remove();
        const p = document.createElement("div");
        p.className = "seq-bar-popup seq-bar-popup-grid";
        for (const it of items) {
            const rowCells = [];
            rowCells.push(this._mkLockBtn(it.gid));
            rowCells.push(this._mkVisBtn(it.gid));
            rowCells.push(this._mkRemoveBtn(it.gid, it.idx));
            const ns = document.createElement("span");
            ns.className = "seq-bar-name" + (it.active ? " active" : "");
            ns.textContent = it.name;
            rowCells.push(ns);
            const cs = document.createElement("span");
            cs.className = "seq-bar-code" + (it.isMissing ? " seq-bar-code-missing" : "") + (it.active ? " active" : "");
            cs.textContent = it.isMissing ? "" : it.codeStr;
            rowCells.push(cs);
            rowCells.push(this._mkInsertBtn(it.idx));
            if (it.locked) rowCells.forEach((el) => el.classList.add("is-locked"));
            rowCells.forEach((el) => p.appendChild(el));
        }
        document.body.appendChild(p);
        // Live-update lock/vis buttons on state change (deferred to avoid
        // DOM mutation during in-progress event dispatch breaking click handlers)
        const offState = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, () => {
            setTimeout(() => {
                if (!p.isConnected) return;
                const cells = p.children;
                for (let i = 0; i < items.length; i++) {
                    const gid = items[i].gid;
                    if (!gid) continue;
                    const gi = EditorModel.getTreeItem(gid);
                    if (!gi) continue;
                    const baseIdx = i * 6;
                    const locked = !!gi.locked;
                    const isActive = items[i].gid != null && items[i].gid === this.activeGroupId;
                    cells[baseIdx].replaceWith(this._mkLockBtn(gid));
                    cells[baseIdx + 1].replaceWith(this._mkVisBtn(gid));
                    for (let j = 0; j < 6; j++) {
                        cells[baseIdx + j].classList.toggle("is-locked", locked);
                    }
                    // Keep the active-glyph highlight (name/code) in sync
                    cells[baseIdx + 3].classList.toggle("active", isActive);
                    cells[baseIdx + 4].classList.toggle("active", isActive);
                }
            }, 0);
        });
        const r = (e.target.closest(".seq-bar-ellipsis") || e.target).getBoundingClientRect();
        p.style.left = `${r.left}px`;
        p.style.top = `${r.bottom + 4}px`;
        const pr = p.getBoundingClientRect();
        if (pr.right > window.innerWidth) p.style.left = `${window.innerWidth - pr.width - 8}px`;
        if (pr.bottom > window.innerHeight) p.style.top = `${r.top - pr.height - 4}px`;
        const close = (ev) => {
            if (!p.contains(ev.target) && !ev.target.closest(".seq-bar-ellipsis")) {
                p.remove();
                offState();
                document.removeEventListener("mousedown", close);
            }
        };
        setTimeout(() => document.addEventListener("mousedown", close), 0);
    }
    _mkSvg(d) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        const p = document.createElementNS(svgNS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
        return svg;
    }
    _mkRemoveBtn(gid, idx) {
        const b = document.createElement("div");
        b.className = "seq-bar-rm-btn";
        b.appendChild(this._mkSvg("M5 11h14v2H5z"));
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            this._removeFromSeq(gid, idx);
        });
        return b;
    }
    _mkInsertBtn(idx) {
        const b = document.createElement("div");
        b.className = "seq-bar-ins-btn";
        // 稳定标识：挂起的重建补做后，用它把菜单重新绑回等价的触发按钮
        b.dataset.seqTriggerKey = `ins:${idx}`;
        b.appendChild(this._mkSvg("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"));
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const r = b.getBoundingClientRect();
            this._addMenu(r.left, r.bottom + 4, idx + 1, b);
        });
        return b;
    }
    _mkInsertLastBtn(idx) {
        const b = document.createElement("div");
        b.className = "seq-bar-ins-last-btn";
        b.dataset.seqTriggerKey = `ins-last:${idx}`;
        const text = document.createElement("span");
        text.className = "seq-bar-ins-last-label";
        text.textContent = "Click to add glyphs";
        b.appendChild(text);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const r = b.getBoundingClientRect();
            this._addMenu(r.left, r.bottom + 4, idx + 1, b);
        });
        return b;
    }
    _mkLockBtn(gid) {
        const gi = gid ? EditorModel.getTreeItem(gid) : null;
        const locked = !!(gi?.locked);
        const b = document.createElement("div");
        b.className = "seq-bar-action-btn" + (locked ? " is-active" : "");
        b.title = locked ? "Unlock" : "Lock";
        const img = document.createElement("img");
        img.src = locked ? "./assets/icons/lock.svg" : "./assets/icons/unlock.svg";
        b.appendChild(img);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            CanvasDispatcher.requestToggleSelectedObjectsLock([gid], !locked);
        });
        return b;
    }
    _mkVisBtn(gid) {
        const gi = gid ? EditorModel.getTreeItem(gid) : null;
        const hidden = gi?.visible === false;
        const b = document.createElement("div");
        b.className = "seq-bar-action-btn" + (hidden ? " is-active" : "");
        b.title = hidden ? "Show" : "Hide";
        const img = document.createElement("img");
        img.src = hidden ? "./assets/icons/hide.svg" : "./assets/icons/show.svg";
        b.appendChild(img);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            CanvasDispatcher.requestToggleSelectedObjectsDisplay([gid], hidden);
        });
        return b;
    }
    _addBtn(left) {
        const b = document.createElement("div");
        b.className = "seq-bar-add-btn";
        b.dataset.seqTriggerKey = "add";
        b.style.left = `${left}px`;
        const text = document.createElement("span");
        text.className = "seq-bar-add-label";
        text.textContent = "Click to add glyphs";
        b.appendChild(text);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const r = b.getBoundingClientRect();
            this._addMenu(r.left, r.bottom + 4, -1, b);
        });
        return b;
    }
    _focusInTree(gid) {
        if (gid) {
            CanvasDispatcher.requestSetTreeSelection([gid], gid);
        }
    }
    _onTrackClick(e) {
        if (e.defaultPrevented) return;
        const tr = this._track;
        const c = this._canvas;
        if (!tr || !c || !this.text) return;
        if (e.target.closest(".seq-bar-pos") || e.target.closest(".seq-bar-add-btn")) return;
        // The sequence bar is UI and never rotates (only the sheet layer does), so its
        // own rect stays layout-accurate in any view rotation.
        const rect = tr.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const sc = c.scale ?? 1;
        const ox = this._offX();
        const seqX = (clickX - TOOLBAR_W - ox) / sc;
        const tokens = EditorModel.parseSequenceText(this.text);
        let lo = -Infinity;
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            const off = c.curve_manager?.getSeqOffset(i) ?? 0;
            if (seqX < off && seqX >= lo) {
                const prev = tokens[i - 1];
                if (prev) {
                    const gid = prev.isChar ? EditorModel.getDefaultGroupForChar(prev.value) : prev.value;
                    if (gid) { this._focusInTree(gid); return; }
                }
                return;
            }
            const gi = EditorModel.getTreeItem(tok.isChar ? EditorModel.getDefaultGroupForChar(tok.value) : tok.value);
            const adv = gi?.advance ?? 1000;
            if (seqX >= off && seqX < off + adv) {
                const gid = tok.isChar ? EditorModel.getDefaultGroupForChar(tok.value) : tok.value;
                if (gid) { this._focusInTree(gid); return; }
            }
            lo = off + adv;
        }
        if (seqX >= lo && tokens.length > 0) {
            const last = tokens[tokens.length - 1];
            const gid = last.isChar ? EditorModel.getDefaultGroupForChar(last.value) : last.value;
            if (gid) this._focusInTree(gid);
        }
    }
    _removeFromSeq(gid, idx) {
        const gi = gid ? EditorModel.getTreeItem(gid) : null;
        const charCode = gi?.charCode ?? null;
        const r = EditorModel.removeGroupTokensFromSequence({
            text: this.text,
            activeIndices: this.activeIndices,
            groupId: gid,
            charCode,
            index: idx,
            resolveGroupByName: (name) => EditorModel.getGroupByName(name)
        });
        this.text = r.text;
        this.activeIndices = r.activeIndices;
        this._textSig = r.text;
        this._activeSig = JSON.stringify(Array.from(r.activeIndices));
        CanvasDispatcher.requestSetSequenceEditorState(
            { text: r.text, activeIndices: Array.from(r.activeIndices) },
            { recordHistory: true }
        );
        this._render();
        // Close popup since the sequence changed and its content is stale
        const popup = document.querySelector(".seq-bar-popup");
        if (popup) popup.remove();
    }
    _addMenu(x, y, insertAt = -1, triggerBtn = null) {
        // Guard: if activeMenu is stale (removed externally but not nulled), clean up
        if (this._activeMenu && !this._activeMenu.isConnected) {
            this._activeMenu = null;
            this._lastTriggerBtn = null;
        }
        if (this._activeMenu && this._lastTriggerBtn === triggerBtn) {
            this._activeMenu.remove();
            this._activeMenu = null;
            this._lastTriggerBtn = null;
            return;
        }
        if (this._activeMenu) {
            this._activeMenu.remove();
            this._activeMenu = null;
        }
        this._lastTriggerBtn = triggerBtn;
        this._activeMenuTriggerKey = triggerBtn?.dataset?.seqTriggerKey || null;
        this._menuOpenedAt = performance.now();
        const menu = document.createElement("div");
        menu.className = "sequence-add-menu";
        const COLUMN_W = 68;
        const MENU_PAD = 12;
        let cols = 8;
        let menuW = cols * COLUMN_W + MENU_PAD;
        // Width: prefer shifting left; reduce columns only when space is insufficient
        let left = x;
        if (left + menuW + 10 > window.innerWidth) {
            left = window.innerWidth - menuW - 10;
        }
        if (left < 10) {
            left = 10;
            const availW = window.innerWidth - left - 10;
            cols = Math.max(4, Math.floor((availW - MENU_PAD) / COLUMN_W));
            menuW = cols * COLUMN_W + MENU_PAD;
        }
        // Height: extend to page bottom with padding
        const GAP = 24;
        let top = y;
        const maxH = window.innerHeight - top - GAP;
        if (maxH < 280) {
            top = Math.max(GAP, window.innerHeight - 280 - GAP);
        }
        menu.style.width = `${menuW}px`;
        menu.style.maxHeight = `${Math.max(280, window.innerHeight - top - GAP)}px`;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        document.body.appendChild(menu);
        this._activeMenu = menu;
        menu.addEventListener("mouseenter", () => menu.classList.add("show-scrollbar"));
        menu.addEventListener("mouseleave", () => menu.classList.remove("show-scrollbar"));
        const asciiCharToGroup = new Map();
        const groups = EditorModel.listSequenceMenuGroups();
        for (const g of groups) {
            if (g.charCode != null && typeof g.charCode === "string") {
                // Multi-character charCodes are ligatures — don't place in ASCII grid
                if (g.charCode.length > 1) continue;
                const cp = g.charCode.codePointAt(0);
                if (cp >= 32 && cp <= 126) asciiCharToGroup.set(cp, g);
            }
        }
        const nonAsciiGroups = groups.filter((g) => {
            if (g.charCode == null) return true;
            if (typeof g.charCode === "string") {
                // Multi-character charCodes are ligatures — keep in "Other Groups"
                if (g.charCode.length > 1) return true;
                const cp = g.charCode.codePointAt(0);
                return cp < 32 || cp > 126;
            }
            return true;
        });
        const refreshSections = () => {
            const charGrid = menu.querySelector(".seq-menu-char-grid");
            if (charGrid) this._refreshCharGrid(charGrid, asciiCharToGroup, insertAt, cols);
            let eg = menu.querySelector(".seq-menu-existing-groups");
            if (nonAsciiGroups.length > 0) {
                if (!eg) {
                    eg = document.createElement("div");
                    eg.className = "seq-menu-section seq-menu-existing-groups";
                    const secTitle = document.createElement("div");
                    secTitle.className = "seq-menu-section-title";
                    secTitle.textContent = "Other Groups";
                    eg.appendChild(secTitle);
                    menu.appendChild(eg);
                }
                const existingGrid = eg.querySelector(".seq-menu-grid");
                if (existingGrid) existingGrid.remove();
                this._renderNoCodeGroups(eg, insertAt, nonAsciiGroups, cols);
            } else if (eg) {
                eg.remove();
            }
        };
        const offTree = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, (e) => {
            if (e?.detail?.action?.type === "TREE_REVISION") {
                asciiCharToGroup.clear();
                const fresh = EditorModel.listSequenceMenuGroups();
                for (const g of fresh) {
                    if (g.charCode != null && typeof g.charCode === "string") {
                        // Multi-character charCodes are ligatures — don't place in ASCII grid
                        if (g.charCode.length > 1) continue;
                        const cp = g.charCode.codePointAt(0);
                        if (cp >= 32 && cp <= 126) asciiCharToGroup.set(cp, g);
                    }
                }
                const freshNonAscii = fresh.filter((g) => {
                    if (g.charCode == null) return true;
                    if (typeof g.charCode === "string") {
                        // Multi-character charCodes are ligatures — keep in "Other Groups"
                        if (g.charCode.length > 1) return true;
                        const cp = g.charCode.codePointAt(0);
                        return cp < 32 || cp > 126;
                    }
                    return true;
                });
                nonAsciiGroups.length = 0;
                nonAsciiGroups.push(...freshNonAscii);
                refreshSections();
            }
        });
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !triggerBtn?.contains(e.target)) {
                menu.remove();
                document.removeEventListener("mousedown", closeMenu);
                offTree();
                if (this._activeMenu === menu) {
                    this._activeMenu = null;
                    this._lastTriggerBtn = null;
                }
            }
        };
        // No close ("X") button: this menu is closed by clicking outside it or
        // by clicking its trigger again. The X was an unintended leftover from
        // the docked-popup chrome and overlapped the menu's first row.
        const form = document.createElement("div");
        form.className = "seq-menu-form";
        installEnterBlurHandler(form);
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "seq-menu-input";
        nameInput.placeholder = "Name";
        nameInput.title = "Group name";
        const codeInput = document.createElement("input");
        codeInput.type = "text";
        codeInput.className = "seq-menu-input seq-menu-input-short";
        codeInput.placeholder = "Code";
        codeInput.title = "Type a character or Unicode code point (U+XXXX)";
        const advInput = document.createElement("input");
        advInput.type = "number";
        advInput.className = "seq-menu-input seq-menu-input-short";
        advInput.placeholder = "Adv";
        advInput.value = "1000";
        const addBtn = document.createElement("button");
        addBtn.className = "seq-menu-add-btn";
        addBtn.textContent = "Add";
        addBtn.addEventListener("click", () => {
            const nameVal = nameInput.value.trim();
            let codeVal = codeInput.value.trim();
            const advVal = parseInt(advInput.value);
            const finalAdv = isNaN(advVal) ? 1000 : advVal;
            nameInput.classList.remove("seq-menu-input-error");
            codeInput.classList.remove("seq-menu-input-error");
            advInput.classList.remove("seq-menu-input-error");
            let charStr = null;
            if (codeVal) {
                if (codeVal.startsWith("U+") || codeVal.startsWith("u+")) {
                    const cp = parseInt(codeVal.substring(2), 16);
                    if (!isNaN(cp) && cp >= 0 && cp <= 0x10FFFF) charStr = String.fromCodePoint(cp);
                } else if (/^\d+$/.test(codeVal)) {
                    const cp = parseInt(codeVal, 10);
                    if (!isNaN(cp) && cp >= 0 && cp <= 0x10FFFF) charStr = String.fromCodePoint(cp);
                } else {
                    charStr = codeVal;
                }
            }
            let hasError = false;
            if (nameVal && !isValidTreeName(nameVal)) {
                nameInput.classList.add("seq-menu-input-error");
                hasError = true;
            }
            if (nameVal && EditorModel.getGroupByName(nameVal)) {
                nameInput.classList.add("seq-menu-input-error");
                hasError = true;
            }
            if (!charStr && !nameVal) {
                nameInput.classList.add("seq-menu-input-error");
                if (!charStr) codeInput.classList.add("seq-menu-input-error");
                hasError = true;
            }
            if (!isNaN(advVal) && advVal < 0) {
                advInput.classList.add("seq-menu-input-error");
                hasError = true;
            }
            if (hasError) return;
            let raw, groupName;
            if (charStr && charStr.length === 1) {
                const autoName = _toAfdkoName(charStr);
                groupName = nameVal || autoName;
                raw = charStr;
            } else if (charStr && charStr.length > 1) {
                groupName = nameVal || _toAfdkoName(charStr);
                raw = `\\${groupName}\\`;
            } else {
                groupName = nameVal;
                raw = `\\${groupName}\\`;
            }
            let newText, newIdx;
            if (insertAt >= 0) {
                const tokens = EditorModel.parseSequenceText(this.text);
                const prefix = tokens.slice(0, insertAt).map((t) => t.raw).join("");
                const suffix = tokens.slice(insertAt).map((t) => t.raw).join("");
                newText = prefix + raw + suffix;
                newIdx = insertAt;
            } else {
                const r2 = EditorModel.appendRawToSequence(this.text, raw, (n) => EditorModel.getGroupByName(n));
                newText = r2.text;
                newIdx = r2.newTokenIndex;
            }
            this.text = newText;
            this._textSig = newText;
            const na = new Set();
            for (const idx of this.activeIndices) na.add(insertAt >= 0 && idx >= insertAt ? idx + 1 : idx);
            na.add(newIdx);
            this.activeIndices = na;
            this._activeSig = JSON.stringify(Array.from(na));
            CanvasDispatcher.requestSetSequenceEditorState(
                { text: newText, activeIndices: Array.from(na) },
                { recordHistory: true }
            );
            {
                let gid = null;
                if (charStr && charStr.length === 1) {
                    gid = EditorModel.getDefaultGroupForChar(charStr);
                } else {
                    const item = EditorModel.getGroupByName(groupName);
                    gid = item ? item.id : null;
                }
                if (gid) {
                    if (nameVal) {
                        const item = EditorModel.getTreeItem(gid);
                        if (item && item.name !== nameVal) {
                            CanvasDispatcher.requestRenameTreeItem(gid, nameVal);
                        }
                    }
                    if (charStr && charStr.length > 1) {
                        CanvasDispatcher.requestSetGroupCharCode(gid, charStr);
                    }
                    if (finalAdv !== 1000) CanvasDispatcher.requestSetGroupAdvance(gid, finalAdv);
                }
            }
            nameInput.value = "";
            codeInput.value = "";
            advInput.value = "1000";
            this._render();
        });
        form.appendChild(nameInput);
        form.appendChild(codeInput);
        form.appendChild(advInput);
        form.appendChild(addBtn);
        menu.appendChild(form);
        const charSection = document.createElement("div");
        charSection.className = "seq-menu-section";
        const charTitle = document.createElement("div");
        charTitle.className = "seq-menu-section-title";
        charTitle.textContent = "Default Characters";
        charSection.appendChild(charTitle);
        const charGrid = document.createElement("div");
        charGrid.className = "seq-menu-grid seq-menu-char-grid";
        this._refreshCharGrid(charGrid, asciiCharToGroup, insertAt, cols);
        charSection.appendChild(charGrid);
        menu.appendChild(charSection);
        if (nonAsciiGroups.length > 0) {
            const sec = document.createElement("div");
            sec.className = "seq-menu-section seq-menu-existing-groups";
            const secTitle = document.createElement("div");
            secTitle.className = "seq-menu-section-title";
            secTitle.textContent = "Other Groups";
            sec.appendChild(secTitle);
            this._renderNoCodeGroups(sec, insertAt, nonAsciiGroups, cols);
            menu.appendChild(sec);
        }
        setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);
    }
    _refreshCharGrid(charGrid, asciiCharToGroup, insertAt, cols) {
        charGrid.replaceChildren();
        // minmax(0, 1fr) — NOT 1fr: the implicit minimum of a `1fr` track is the
        // item's min-content width. `.seq-menu-name` is `white-space: nowrap`, so a
        // long glyph name made its column wider than 1fr and the whole "Other
        // Groups" grid ran off the right edge of the fixed-width menu instead of
        // wrapping. minmax(0, …) lets the column shrink and the name ellipsize.
        charGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        for (let code = 32; code <= 126; code++) {
            const afdkoName = AFDKO_NAMES[code] || _toAfdkoName(String.fromCodePoint(code));
            const char = String.fromCodePoint(code);
            const existingGroup = asciiCharToGroup.get(code);
            const item = document.createElement("div");
            item.className = "seq-menu-item seq-menu-char-item";
            if (existingGroup) item.classList.add("seq-menu-char-has-group");
            this._previewCtx.clearRect(0, 0, 120, 120);
            if (existingGroup) {
                EditorModel.drawSequenceGroupPreview(this._previewCtx, existingGroup.id);
                const imgData = this._previewCtx.getImageData(0, 0, 120, 120).data;
                let hasContent = false;
                for (let i = 3; i < imgData.length; i += 4) {
                    if (imgData[i] !== 0) { hasContent = true; break; }
                }
                if (!hasContent) {
                    this._previewCtx.clearRect(0, 0, 120, 120);
                    this._previewCtx.save();
                    this._previewCtx.fillStyle = getCanvasTheme().preview_fallback;
                    this._previewCtx.font = "bold 80px sans-serif";
                    this._previewCtx.textAlign = "center";
                    this._previewCtx.textBaseline = "middle";
                    this._previewCtx.fillText(code === 32 ? "\u2423" : char, 60, 60);
                    this._previewCtx.restore();
                }
            } else {
                this._previewCtx.save();
                this._previewCtx.fillStyle = getCanvasTheme().preview_fallback;
                this._previewCtx.font = "bold 80px sans-serif";
                this._previewCtx.textAlign = "center";
                this._previewCtx.textBaseline = "middle";
                this._previewCtx.fillText(code === 32 ? "\u2423" : char, 60, 60);
                this._previewCtx.restore();
            }
            const img = document.createElement("img");
            img.className = "seq-menu-char-preview";
            img.src = this._previewCanvas.toDataURL();
            item.appendChild(img);
            const displayName = existingGroup ? existingGroup.name : afdkoName;
            const nameEl = document.createElement("div");
            nameEl.className = "seq-menu-char-name";
            nameEl.textContent = displayName;
            item.appendChild(nameEl);
            item.title = `${displayName} (${code})`;
            item.addEventListener("click", () => {
                let raw;
                if (existingGroup) {
                    raw = char;
                } else {
                    raw = char;
                }
                let newText, newIdx;
                if (insertAt >= 0) {
                    const tokens = EditorModel.parseSequenceText(this.text);
                    const prefix = tokens.slice(0, insertAt).map((t) => t.raw).join("");
                    const suffix = tokens.slice(insertAt).map((t) => t.raw).join("");
                    newText = prefix + raw + suffix;
                    newIdx = insertAt;
                } else {
                    const r2 = EditorModel.appendRawToSequence(this.text, raw, (n) => EditorModel.getGroupByName(n));
                    newText = r2.text;
                    newIdx = r2.newTokenIndex;
                }
                this.text = newText;
                this._textSig = newText;
                const na = new Set();
                for (const idx of this.activeIndices) na.add(insertAt >= 0 && idx >= insertAt ? idx + 1 : idx);
                na.add(newIdx);
                this.activeIndices = na;
                this._activeSig = JSON.stringify(Array.from(na));
                CanvasDispatcher.requestSetSequenceEditorState(
                    { text: newText, activeIndices: Array.from(na) },
                    { recordHistory: true }
                );
                this._render();
            });
            nameEl.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                const gid = existingGroup ? existingGroup.id : null;
                if (!gid) return;
                const input = document.createElement("input");
                input.type = "text";
                input.className = "seq-menu-rename-input";
                input.value = existingGroup.name;
                nameEl.replaceWith(input);
                input.focus();
                input.select();
                let committed = false;
                const apply = () => {
                    if (committed) return;
                    committed = true;
                    const newName = input.value.trim();
                    if (isValidTreeName(newName) && newName !== existingGroup.name) {
                        const reqDetail = CanvasDispatcher.requestRenameTreeItem(gid, newName);
                        if (reqDetail.result) {
                            nameEl.textContent = newName;
                        }
                    }
                    input.replaceWith(nameEl);
                };
                input.addEventListener("blur", apply);
                input.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter") {
                        ev.preventDefault();
                        input.blur();
                    }
                    if (ev.key === "Escape") {
                        committed = true;
                        nameEl.textContent = existingGroup.name;
                        input.replaceWith(nameEl);
                    }
                });
            });
            charGrid.appendChild(item);
        }
    }
    _renderNoCodeGroups(sec, insertAt, groups, cols) {
        const grid = sec.querySelector(".seq-menu-grid") || (() => {
            const g = document.createElement("div");
            g.className = "seq-menu-grid";
            sec.appendChild(g);
            return g;
        })();
        grid.replaceChildren();
        // minmax(0, 1fr): see _refreshCharGrid — long group names must ellipsize
        // inside their column instead of widening it past the menu edge.
        grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        for (const g of groups) {
            const item = document.createElement("div");
            item.className = "seq-menu-item";
            this._previewCtx.clearRect(0, 0, 120, 120);
            EditorModel.drawSequenceGroupPreview(this._previewCtx, g.id);
            const imgData = this._previewCtx.getImageData(0, 0, 120, 120).data;
            let hasContent = false;
            for (let i = 3; i < imgData.length; i += 4) {
                if (imgData[i] !== 0) { hasContent = true; break; }
            }
            if (!hasContent && g.charCode && g.charCode.length === 1) {
                this._previewCtx.save();
                this._previewCtx.fillStyle = getCanvasTheme().preview_fallback;
                this._previewCtx.font = "bold 80px sans-serif";
                this._previewCtx.textAlign = "center";
                this._previewCtx.textBaseline = "middle";
                this._previewCtx.fillText(g.charCode, 60, 60);
                this._previewCtx.restore();
            }
            const img = document.createElement("img");
            img.className = "seq-menu-preview";
            img.src = this._previewCanvas.toDataURL();
            const ns = document.createElement("div");
            ns.className = "seq-menu-name";
            ns.textContent = g.name;
            item.appendChild(img);
            item.appendChild(ns);
            const delBtn = document.createElement("div");
            delBtn.className = "seq-menu-del-btn";
            const delImg = document.createElement("img");
            delImg.src = new URL("../../assets/icons/delete.svg", import.meta.url).href;
            delBtn.appendChild(delImg);
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const { text, activeIndices } = EditorModel.removeGroupTokensFromSequence({
                    text: this.text,
                    activeIndices: this.activeIndices,
                    groupId: g.id,
                    charCode: g.charCode,
                    resolveGroupByName: (name) => EditorModel.getGroupByName(name)
                });
                this.text = text;
                this.activeIndices = activeIndices;
                this._textSig = text;
                this._activeSig = JSON.stringify(Array.from(activeIndices));
                CanvasDispatcher.requestDeleteGroupAndUpdateSequence(
                    g.id,
                    { text, activeIndices: Array.from(activeIndices) },
                    { recordHistory: true }
                );
                this._render();
            });
            item.appendChild(delBtn);
            item.addEventListener("click", () => {
                const raw = `\\${g.name}\\`;
                let newText, newIdx;
                if (insertAt >= 0) {
                    const tokens = EditorModel.parseSequenceText(this.text);
                    const prefix = tokens.slice(0, insertAt).map((t) => t.raw).join("");
                    const suffix = tokens.slice(insertAt).map((t) => t.raw).join("");
                    newText = prefix + raw + suffix;
                    newIdx = insertAt;
                } else {
                    const r2 = EditorModel.appendRawToSequence(this.text, raw, (n) => EditorModel.getGroupByName(n));
                    newText = r2.text;
                    newIdx = r2.newTokenIndex;
                }
                this.text = newText;
                this._textSig = newText;
                const na = new Set();
                for (const idx of this.activeIndices) na.add(insertAt >= 0 && idx >= insertAt ? idx + 1 : idx);
                na.add(newIdx);
                this.activeIndices = na;
                this._activeSig = JSON.stringify(Array.from(na));
                CanvasDispatcher.requestSetSequenceEditorState(
                    { text: newText, activeIndices: Array.from(na) },
                    { recordHistory: true }
                );
                this._render();
            });
            grid.appendChild(item);
        }
    }
}
customElements.define("glyph-sequence-bar", GlyphSequenceBar);
