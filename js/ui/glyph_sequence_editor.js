// js/glyph_sequence_editor.js — DOM/events; domain logic domain; preview presentation
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import * as EditorModel from "../app/editor_read_facade.js";

const TEMPLATE_HTML = `
    <div class="glyph-sequence-wrapper" tabindex="0" title="Click to edit text, press Enter to finish">
        <div class="glyph-sequence-static"></div>
        <input class="glyph-sequence-input" type="text" data-i18n-placeholder="seq.placeholder" placeholder="Type characters here..." />
        <div class="glyph-seq-add-btn" data-i18n-tip="seq.add_tip" data-tip="Add created group" title="">
            <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </div>
    </div>
`;

export class GlyphSequenceEditor extends HTMLElement {
    constructor() {
        super();
        this.text = "";
        this.activeIndices = new Set([0, 1, 2, 3]);
        this.globalEventTrackers = [];

        this.previewCanvas = document.createElement("canvas");
        this.previewCanvas.width = 120;
        this.previewCanvas.height = 120;
        this.previewCtx = this.previewCanvas.getContext("2d", { willReadFrequently: true });
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

        this.wrapper = this.querySelector(".glyph-sequence-wrapper");
        this.input = this.querySelector(".glyph-sequence-input");
        this.staticDiv = this.querySelector(".glyph-sequence-static");
        this.addBtn = this.querySelector(".glyph-seq-add-btn");

        this.input.value = this.text;

        this.wrapper.addEventListener("click", (e) => {
            if (e.target.closest(".glyph-seq-col")) return;
            if (e.target.closest(".glyph-seq-add-btn")) return;
            this.enterEditMode();
        });

        this.addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const btnRect = this.addBtn.getBoundingClientRect();
            this.showAddMenu(btnRect.right + 8, btnRect.top);
        });

        this.input.addEventListener("blur", () => this.exitEditMode());
        this.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.input.blur();
                return;
            }
            e.stopPropagation();
        });

        this.staticDiv.addEventListener(
            "wheel",
            (e) => {
                if (e.deltaY !== 0) {
                    e.preventDefault();
                    this.staticDiv.scrollLeft += e.deltaY * 0.5;
                }
            },
            { passive: false }
        );

        this.staticDiv.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.enterEditMode();
        });

        this.addGlobalListener(window, CANVAS_EVENTS.STATE_CHANGED, (e) => this.handleStoreStateChanged(e));

        EditorModel.whenEditorStoreReady((st) => {
            if (typeof st.sequenceText === "string" && Array.isArray(st.activeSequenceIndices)) {
                this.text = st.sequenceText;
                this.activeIndices = new Set(st.activeSequenceIndices);
            }
            this.input.value = this.text;
            this.renderStatic();
        });
    }

    disconnectedCallback() {
        this.globalEventTrackers.forEach((cleanup) => cleanup());
        this.globalEventTrackers = [];
    }

    handleStoreStateChanged(e) {
        if (this.wrapper?.classList.contains("editing")) return;
        const nextState = e?.detail?.afterState;
        if (!nextState || typeof nextState !== "object") return;
        if (typeof nextState.sequenceText !== "string" || !Array.isArray(nextState.activeSequenceIndices)) {
            return;
        }

        const sameText = this.text === nextState.sequenceText;
        const sameActive =
            this.activeIndices.size === nextState.activeSequenceIndices.length &&
            nextState.activeSequenceIndices.every((idx) => this.activeIndices.has(idx));
        if (sameText && sameActive) return;

        this.text = nextState.sequenceText;
        this.input.value = this.text;
        this.activeIndices = new Set(nextState.activeSequenceIndices);
        this.renderStatic();
    }

    enterEditMode() {
        if (this.wrapper.classList.contains("editing")) return;
        this.wrapper.classList.add("editing");
        this.input.value = this.text;
        this.input.focus();
    }

    exitEditMode() {
        this.wrapper.classList.remove("editing");
        if (this.text === this.input.value) return;

        const oldTokens = EditorModel.parseSequenceText(this.text);
        const newText = this.input.value;
        const newTokens = EditorModel.parseSequenceText(newText);
        this.activeIndices = EditorModel.mapActiveIndicesAfterTokenChange(
            oldTokens,
            newTokens,
            this.activeIndices
        );
        this.text = newText;

        CanvasDispatcher.requestSetSequenceEditorState(
            {
                text: this.text,
                activeIndices: Array.from(this.activeIndices)
            },
            { recordHistory: true }
        );
        this.renderStatic();
    }

    _toggleColumnActiveIndex(colIndex) {
        const next = new Set(this.activeIndices);
        if (next.has(colIndex)) next.delete(colIndex);
        else next.add(colIndex);
        this.activeIndices = next;
        this.renderStatic();
        CanvasDispatcher.requestSetSequenceEditorState({ activeIndices: Array.from(next) }, { recordHistory: false });
    }

    renderStatic() {
        const t = (k, defaultStr) => (window.I18n ? window.I18n.t(k) : defaultStr);
        if (this.text.length === 0) {
            this.staticDiv.replaceChildren();
            const hint = document.createElement("div");
            hint.className = "glyph-sequence-empty-hint";
            hint.textContent = t("seq.empty", "Click to type...");
            this.staticDiv.appendChild(hint);
            return;
        }

        const tokens = EditorModel.parseSequenceText(this.text);
        const existingCols = Array.from(this.staticDiv.querySelectorAll(".glyph-seq-col"));
        const emptyHint = this.staticDiv.querySelector(".glyph-sequence-empty-hint");
        if (emptyHint) emptyHint.remove();

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            let isActive = this.activeIndices.has(i);
            const groupId = token.isChar ? EditorModel.getDefaultGroupForChar(token.value) : token.value;
            const groupItem = groupId ? EditorModel.getTreeItem(groupId) : null;
            const isLocked = !!(groupItem && groupItem.locked === true);
            if (isLocked) isActive = false;
            const charText = token.display !== undefined ? token.display : token.isChar ? token.value : token.name;

            let col;
            if (i < existingCols.length) {
                col = existingCols[i];
            } else {
                col = document.createElement("div");
                const charDiv = document.createElement("div");
                charDiv.className = "glyph-seq-char";
                col.appendChild(charDiv);

                col.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const idx = Array.from(this.staticDiv.children).indexOf(col);
                    if (col.classList.contains("locked")) return;
                    this._toggleColumnActiveIndex(idx);
                });
                this.staticDiv.appendChild(col);
            }

            const expectedClass =
                "glyph-seq-col" + (isActive ? " active" : "") + (isLocked ? " locked" : "");
            if (col.className !== expectedClass) col.className = expectedClass;

            const charDiv = col.querySelector(".glyph-seq-char");
            if (charDiv.textContent !== charText) charDiv.textContent = charText;
        }

        while (this.staticDiv.children.length > tokens.length) {
            this.staticDiv.lastChild.remove();
        }
    }

    showAddMenu(x, y) {
        let existing = document.querySelector(".sequence-add-menu");
        if (existing) existing.remove();

        const menu = document.createElement("div");
        menu.className = "sequence-add-menu";
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        document.body.appendChild(menu);

        const renderMenu = () => {
            menu.replaceChildren();
            const t = (k, defaultStr) => (window.I18n ? window.I18n.t(k) : defaultStr);
            const groups = EditorModel.listSequenceMenuGroups();

            if (groups.length === 0) {
                const empty = document.createElement("div");
                empty.className = "seq-menu-empty";
                empty.textContent = t("seq.no_obj", "No created objects yet");
                menu.appendChild(empty);
                return;
            }

            for (const g of groups) {
                const item = document.createElement("div");
                item.className = "seq-menu-item";

                this.previewCtx.clearRect(0, 0, 120, 120);
                EditorModel.drawSequenceGroupPreview(this.previewCtx, g.id);

                const img = document.createElement("img");
                img.className = "seq-menu-preview";
                img.src = this.previewCanvas.toDataURL();

                const nameSpan = document.createElement("div");
                nameSpan.className = "seq-menu-name";
                nameSpan.textContent = g.name;
                item.appendChild(img);
                item.appendChild(nameSpan);

                if (g.charCode !== null) {
                    const charSpan = document.createElement("div");
                    charSpan.className = "seq-menu-char";
                    charSpan.textContent = g.charCode;
                    item.appendChild(charSpan);
                }

                const deleteBtn = document.createElement("button");
                deleteBtn.className = "seq-menu-delete-btn";
                deleteBtn.title = t("tree.menu.delete", "Delete");
                const delImg = document.createElement("img");
                delImg.src = new URL("../../assets/icons/delete.svg", import.meta.url).href;
                delImg.alt = "Delete";
                deleteBtn.appendChild(delImg);

                deleteBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const { text, activeIndices } = EditorModel.removeGroupTokensFromSequence({
                        text: this.text,
                        activeIndices: this.activeIndices,
                        groupId: g.id,
                        charCode: g.charCode,
                        resolveGroupByName: (name) => EditorModel.getGroupByName(name)
                    });
                    this.text = text;
                    this.input.value = text;
                    this.activeIndices = activeIndices;
                    CanvasDispatcher.requestDeleteGroupAndUpdateSequence(
                        g.id,
                        { text, activeIndices: Array.from(activeIndices) },
                        { recordHistory: true }
                    );
                    this.renderStatic();
                });

                item.appendChild(deleteBtn);

                item.addEventListener("click", () => {
                    const isDefault = EditorModel.isDefaultCharGroup(g.id, g.charCode);
                    const appendText = isDefault ? g.charCode : `\\${g.name}\\`;
                    const { text, newTokenIndex } = EditorModel.appendRawToSequence(this.text, appendText, (name) =>
                        EditorModel.getGroupByName(name)
                    );
                    this.text = text;
                    this.input.value = text;
                    const nextActive = new Set(this.activeIndices);
                    nextActive.add(newTokenIndex);
                    CanvasDispatcher.requestSetSequenceEditorState(
                        { text, activeIndices: Array.from(nextActive) },
                        { recordHistory: true }
                    );
                    this.renderStatic();
                });

                menu.appendChild(item);
            }

            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = `${window.innerHeight - rect.height - 10}px`;
            }
        };

        renderMenu();

        const offTreeUpdated = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, (e) => {
            if (e?.detail?.action?.type === "TREE_REVISION") renderMenu();
        });

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("mousedown", closeMenu);
                offTreeUpdated();
            }
        };
        setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);
    }
}
customElements.define("glyph-sequence-editor", GlyphSequenceEditor);
