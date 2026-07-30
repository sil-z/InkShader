// js/ui/glyph_popup.js — Glyph picker popup (Web Component)
//
// Displays the same glyph selection menu as the sequence bar's add menu:
// header with title, name/code/advance form, ASCII character grid, other groups.
// Triggered from the top "Glyphs" menu item.

import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { appEventBus } from "../app/event_bus.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import * as EditorModel from "../app/editor_read_facade.js";
import { getCanvasTheme } from "../canvas/rendering/canvas_theme.js";
import { installEnterBlurHandler, isValidTreeName } from "./input_validation.js";

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

function _mkSvg(d) {
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

export class GlyphPopup extends HTMLElement {
    constructor() {
        super();
        this._visible = false;
        this._menu = null;
        this._previewCanvas = document.createElement("canvas");
        this._previewCanvas.width = 120;
        this._previewCanvas.height = 120;
        this._previewCtx = this._previewCanvas.getContext("2d", { willReadFrequently: true });
        this._offTree = null;
        this._cols = 8;
    }

    connectedCallback() {
        if (this._domReady) return;
        this._domReady = true;
        this.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    disconnectedCallback() {
        this.hide();
    }

    show(anchorEl) {
        if (this._visible) {
            this.hide();
            return;
        }
        this._visible = true;

        const menu = document.createElement("div");
        menu.className = "sequence-add-menu";
        this._menu = menu;
        document.body.appendChild(menu);

        const COLUMN_W = 68;
        const MENU_PAD = 12;
        let cols = 8;
        let menuW = cols * COLUMN_W + MENU_PAD;

        const btnRect = anchorEl.getBoundingClientRect();
        let left = btnRect.left;
        if (left + menuW + 10 > window.innerWidth) {
            left = window.innerWidth - menuW - 10;
        }
        if (left < 10) {
            left = 10;
            const availW = window.innerWidth - left - 10;
            cols = Math.max(4, Math.floor((availW - MENU_PAD) / COLUMN_W));
            menuW = cols * COLUMN_W + MENU_PAD;
        }
        const GAP = 24;
        let top = btnRect.bottom + 4;
        if (top + 280 > window.innerHeight - GAP) {
            top = Math.max(GAP, btnRect.top - 280 - GAP);
        }
        this._cols = cols;
        menu.style.width = `${menuW}px`;
        menu.style.maxHeight = `${Math.max(280, window.innerHeight - top - GAP)}px`;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.addEventListener("mouseenter", () => menu.classList.add("show-scrollbar"));
        menu.addEventListener("mouseleave", () => menu.classList.remove("show-scrollbar"));

        const asciiCharToGroup = new Map();
        const groups = EditorModel.listSequenceMenuGroups();
        for (const g of groups) {
            if (g.charCode != null && typeof g.charCode === "string") {
                if (g.charCode.length > 1) continue;
                const cp = g.charCode.codePointAt(0);
                if (cp >= 32 && cp <= 126) asciiCharToGroup.set(cp, g);
            }
        }
        const nonAsciiGroups = groups.filter((g) => {
            if (g.charCode == null) return true;
            if (typeof g.charCode === "string") {
                if (g.charCode.length > 1) return true;
                const cp = g.charCode.codePointAt(0);
                return cp < 32 || cp > 126;
            }
            return true;
        });

        const refreshSections = () => {
            const charGrid = menu.querySelector(".seq-menu-char-grid");
            if (charGrid) this._refreshCharGrid(charGrid, asciiCharToGroup, cols);
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
                this._renderNoCodeGroups(eg, nonAsciiGroups, cols);
            } else if (eg) {
                eg.remove();
            }
        };

        this._offTree = appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, (e) => {
            if (e?.detail?.action?.type === "TREE_REVISION") {
                asciiCharToGroup.clear();
                const fresh = EditorModel.listSequenceMenuGroups();
                for (const g of fresh) {
                    if (g.charCode != null && typeof g.charCode === "string") {
                        if (g.charCode.length > 1) continue;
                        const cp = g.charCode.codePointAt(0);
                        if (cp >= 32 && cp <= 126) asciiCharToGroup.set(cp, g);
                    }
                }
                nonAsciiGroups.length = 0;
                nonAsciiGroups.push(...fresh.filter((g) => {
                    if (g.charCode == null) return true;
                    if (typeof g.charCode === "string") {
                        if (g.charCode.length > 1) return true;
                        const cp = g.charCode.codePointAt(0);
                        return cp < 32 || cp > 126;
                    }
                    return true;
                }));
                refreshSections();
            }
        });

        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !anchorEl?.contains(e.target)) {
                this.hide();
            }
        };

        // Header
        const header = document.createElement("div");
        header.className = "seq-menu-header";
        const title = document.createElement("span");
        title.className = "seq-menu-title";
        title.textContent = "Add Glyph";
        header.appendChild(title);
        menu.appendChild(header);

        // Form
        const form = document.createElement("div");
        form.className = "seq-menu-form";
        installEnterBlurHandler(form);
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "seq-menu-input";
        nameInput.placeholder = "Name";
        nameInput.title = "Glyph name";
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
            const r2 = EditorModel.appendRawToSequence("", raw, (n) => EditorModel.getGroupByName(n));
            const newText = r2.text;
            const newIdx = r2.newTokenIndex;
            CanvasDispatcher.requestSetSequenceEditorState(
                { text: newText, activeIndices: [newIdx] },
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
        });
        form.appendChild(nameInput);
        form.appendChild(codeInput);
        form.appendChild(advInput);
        form.appendChild(addBtn);
        menu.appendChild(form);

        // Character grid
        const charSection = document.createElement("div");
        charSection.className = "seq-menu-section";
        const charTitle = document.createElement("div");
        charTitle.className = "seq-menu-section-title";
        charTitle.textContent = "Default Characters";
        charSection.appendChild(charTitle);
        const charGrid = document.createElement("div");
        charGrid.className = "seq-menu-grid seq-menu-char-grid";
        this._refreshCharGrid(charGrid, asciiCharToGroup, cols);
        charSection.appendChild(charGrid);
        menu.appendChild(charSection);

        // Other groups
        if (nonAsciiGroups.length > 0) {
            const sec = document.createElement("div");
            sec.className = "seq-menu-section seq-menu-existing-groups";
            const secTitle = document.createElement("div");
            secTitle.className = "seq-menu-section-title";
            secTitle.textContent = "Other Groups";
            sec.appendChild(secTitle);
            this._renderNoCodeGroups(sec, nonAsciiGroups, cols);
            menu.appendChild(sec);
        }

        setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);
    }

    hide() {
        if (this._offTree) {
            this._offTree();
            this._offTree = null;
        }
        if (this._menu) {
            this._menu.remove();
            this._menu = null;
        }
        this._visible = false;
        document.removeEventListener("mousedown", this._closeHandler);
    }

    _refreshCharGrid(charGrid, asciiCharToGroup, cols) {
        charGrid.replaceChildren();
        charGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
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
                const raw = char;
                const r2 = EditorModel.appendRawToSequence("", raw, (n) => EditorModel.getGroupByName(n));
                const newText = r2.text;
                const newIdx = r2.newTokenIndex;
                CanvasDispatcher.requestSetSequenceEditorState(
                    { text: newText, activeIndices: [newIdx] },
                    { recordHistory: true }
                );
                this.hide();
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
                    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
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

    _renderNoCodeGroups(sec, groups, cols) {
        const grid = sec.querySelector(".seq-menu-grid") || (() => {
            const g = document.createElement("div");
            g.className = "seq-menu-grid";
            sec.appendChild(g);
            return g;
        })();
        grid.replaceChildren();
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
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
                const result = EditorModel.removeGroupTokensFromSequence({
                    text: EditorModel.getSequenceText?.() ?? "",
                    activeIndices: EditorModel.getActiveSequenceIndices?.() ?? [],
                    groupId: g.id,
                    charCode: g.charCode,
                    resolveGroupByName: (name) => EditorModel.getGroupByName(name)
                });
                CanvasDispatcher.requestDeleteGroupAndUpdateSequence(
                    g.id,
                    { text: result.text, activeIndices: Array.from(result.activeIndices) },
                    { recordHistory: true }
                );
            });
            item.appendChild(delBtn);
            item.addEventListener("click", () => {
                const isDefault = EditorModel.isDefaultCharGroup(g.id, g.charCode);
                const appendText = isDefault ? g.charCode : `\\${g.name}\\`;
                const r2 = EditorModel.appendRawToSequence("", appendText, (name) => EditorModel.getGroupByName(name));
                CanvasDispatcher.requestSetSequenceEditorState(
                    { text: r2.text, activeIndices: [r2.newTokenIndex] },
                    { recordHistory: true }
                );
                this.hide();
            });
            grid.appendChild(item);
        }
    }
}

customElements.define("glyph-popup", GlyphPopup);
