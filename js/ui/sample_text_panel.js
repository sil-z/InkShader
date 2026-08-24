import { appEventBus } from "../app/event_bus.js";
import { CANVAS_EVENTS } from "../app/canvas_events.js";
import { CanvasDispatcher } from "../app/canvas_dispatcher.js";
import * as EditorModel from "../app/editor_read_facade.js";

/**
 * Sample Text panel — a dock panel component (sibling of object-tree / property-panel /
 * logger-panel). Shows the font's own sample text rendered with the font's actual glyph
 * outlines, advance widths and (optional) kerning, without compiling an OTF.
 *
 * - Text edits are saved to fontSettings.sample_text via the dispatcher on focusout
 *   (same convention as font_popup), so the sample text persists and participates in history.
 * - Font size is the user-set value (px), independent of the panel size; the canvas is sized
 *   to the CONTENT height and the wrap container scrolls vertically when the content is taller.
 * - The canvas WIDTH is at least one full natural line (maxRowWidthPx): a panel narrower than
 *   the line scrolls horizontally instead of wrapping/squeezing the specimen.
 * - Font size / kerning / metric-guides settings persist to localStorage
 *   (key: inkshader_sample_panel_state) and are restored on reload.
 * - Re-renders on STATE_CHANGED / SEQUENCE_CHANGED / COMMAND_COMMITTED.
 */
const STORAGE_KEY = 'inkshader_sample_panel_state';

function loadPanelState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (_) { /* localStorage unavailable */ }
    return null;
}

function savePanelState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* unavailable */ }
}
const TEMPLATE_HTML = `
    <div class="prop_panel_title_wrapper">
        <div class="panel_title" data-i18n="sample.title">Sample Text</div>
    </div>
    <div class="sample-panel-body">
        <textarea class="sample-text-input" id="sample_text_input" rows="2"
            data-i18n-placeholder="sample.placeholder"
            placeholder="Type sample text, \\name\\ for non-character glyphs, Enter for new line"></textarea>
        <div class="sample-options-row">
            <label class="sample-option">
                <input type="checkbox" id="sample_kerning" checked>
                <span data-i18n="sample.kerning">Kerning</span>
            </label>
            <label class="sample-option">
                <input type="checkbox" id="sample_guides" checked>
                <span data-i18n="sample.guides">Metric Guides</span>
            </label>
            <label class="sample-option">
                <span data-i18n="sample.fontSize">Size</span>
                <input type="number" id="sample_font_size" value="48" min="6" max="512" step="1">
            </label>
        </div>
        <div class="sample-canvas-wrap" id="sample_canvas_wrap">
            <canvas class="sample-canvas" id="sample_canvas"></canvas>
        </div>
    </div>
`;

const DEFAULT_FONT_SIZE = 48;

export class SampleTextPanel extends HTMLElement {
    connectedCallback() {
        // One-time DOM setup — survives disconnect/reconnect cycles
        if (!this._domReady) {
            this._domReady = true;
            this.innerHTML = TEMPLATE_HTML;
            this.input = this.querySelector('#sample_text_input');
            this.kerningChk = this.querySelector('#sample_kerning');
            this.guidesChk = this.querySelector('#sample_guides');
            this.fontSizeInput = this.querySelector('#sample_font_size');
            this.wrap = this.querySelector('#sample_canvas_wrap');
            this.canvas = this.querySelector('#sample_canvas');
            this._dpr = 1;

            // Restore persisted panel settings (font size / kerning / guides) on first mount
            const saved = loadPanelState();
            if (saved) {
                if (Number.isFinite(saved.fontSize)) {
                    this.fontSizeInput.value = String(Math.min(512, Math.max(6, Math.round(saved.fontSize))));
                }
                if (typeof saved.kerning === 'boolean') this.kerningChk.checked = saved.kerning;
                if (typeof saved.guides === 'boolean') this.guidesChk.checked = saved.guides;
            }

            // Live preview while typing; persist on focusout (font_popup convention).
            this.input.addEventListener('input', () => this._render(this.input.value));
            this.input.addEventListener('focusout', () => {
                const value = this.input.value;
                CanvasDispatcher.requestSetFontSettings({ sample_text: value }, { recordHistory: true });
            });
            // Option changes persist to localStorage and re-render immediately
            const persistState = () => savePanelState({
                fontSize: Number(this.fontSizeInput.value) > 0 ? Number(this.fontSizeInput.value) : DEFAULT_FONT_SIZE,
                kerning: this.kerningChk.checked,
                guides: this.guidesChk.checked
            });
            this.kerningChk.addEventListener('change', () => { persistState(); this._render(this.input.value); });
            this.guidesChk.addEventListener('change', () => { persistState(); this._render(this.input.value); });
            this.fontSizeInput.addEventListener('change', () => { persistState(); this._render(this.input.value); });

            // Re-render when the PANEL resizes. The wrap div is observed (not the canvas):
            // the canvas height now tracks the CONTENT height, so observing it would loop.
            this._resizeObserver = new ResizeObserver(() => this._render(this.input.value));
            this._resizeObserver.observe(this.wrap);
        }

        // Always re-attach appEventBus listeners (cleaned up in disconnectedCallback)
        this._cleanups = [
            appEventBus.on(CANVAS_EVENTS.STATE_CHANGED, () => this._syncFromModel()),
            appEventBus.on(CANVAS_EVENTS.SEQUENCE_CHANGED, () => this._syncFromModel()),
            appEventBus.on('COMMAND_COMMITTED', () => this._syncFromModel()),
            // Re-render on theme change (colors are read from CSS vars at draw time)
            appEventBus.on(CANVAS_EVENTS.THEME_PARAMS_UPDATED, () => this._render(this.input.value)),
        ];
        this._syncFromModel();
    }

    disconnectedCallback() {
        this._cleanups.forEach(fn => fn());
        this._cleanups = [];
        // Do NOT reset _domReady — preserve DOM and text across reconnect
    }

    /** Refresh text from the model (only when the user is not editing) and re-render. */
    _syncFromModel() {
        if (!this._domReady) return;
        const state = EditorModel.getSampleTextPanelState();
        if (document.activeElement !== this.input) {
            this.input.value = state.sampleText;
        }
        this._render(this.input.value);
    }

    _render(text) {
        const wrap = this.wrap;
        const canvas = this.canvas;
        const wrapW = wrap.clientWidth;
        if (wrapW <= 0) return; // width 0 = not laid out yet; min-height takes care of height

        const fontSize = Number(this.fontSizeInput.value) > 0 ? Number(this.fontSizeInput.value) : DEFAULT_FONT_SIZE;
        const state = EditorModel.getSampleTextPanelState();

        // Two-pass measure: pass 1 at wrapW learns the widest natural line (maxRowWidthPx);
        // the canvas width is max(wrapW, that). Pass 2 re-measures at THAT width so rows and
        // contentHeight agree with the DRAW pass — measuring at wrapW but drawing at contentW
        // re-wraps differently, so guides rows and canvas height diverged from the drawn text.
        const base = text ? EditorModel.measureSampleTextPreview(text, {
            kerning: this.kerningChk.checked,
            width: wrapW,
            fontSize
        }) : null;
        const contentW = base && base.maxRowWidthPx > 0
            ? Math.max(wrapW, Math.ceil(base.maxRowWidthPx))
            : wrapW;
        const measured = text && contentW !== wrapW
            ? EditorModel.measureSampleTextPreview(text, {
                kerning: this.kerningChk.checked,
                width: contentW,
                fontSize
            })
            : base;
        const pad = measured?.PAD ?? 10;
        const contentH = measured && measured.contentHeight > 0
            ? Math.ceil(measured.contentHeight)
            : wrap.clientHeight;

        // MIN HEIGHT: the wrap must always show at least ONE full row — collapsing the panel
        // (flex min-height: 0) must not shrink the preview to zero height.
        wrap.style.minHeight = Math.ceil(fontSize) + 2 * pad + 'px';

        const dpr = window.devicePixelRatio || 1;
        const bw = Math.floor(contentW * dpr);
        const bh = Math.floor(contentH * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        canvas.style.width = contentW + 'px';
        canvas.style.height = contentH + 'px';
        this._dpr = dpr;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, contentW, contentH);

        if (!text) return;

        // SUPERSAMPLING: the preview scales 1000-upm curves down to the user-set font
        // size (scale ≈ 0.048 at 48px), so strokes a few model units wide become
        // sub-pixel (< 1px). Single-sample canvas AA paints them as hard on/off
        // staircases. Rendering into an offscreen canvas at SUPERSAMPLE × resolution
        // and downscaling with high-quality smoothing averages the sub-pixel
        // coverage across many source pixels — thin lines come out smooth instead
        // of jagged (the visible canvas backing stays dpr-sized; only the offscreen
        // source is larger).
        const SUPERSAMPLE = 4;
        if (!this._ssCanvas) this._ssCanvas = document.createElement('canvas');
        const sw = Math.max(1, Math.floor(contentW * SUPERSAMPLE));
        const sh = Math.max(1, Math.floor(contentH * SUPERSAMPLE));
        if (this._ssCanvas.width !== sw || this._ssCanvas.height !== sh) {
            this._ssCanvas.width = sw;
            this._ssCanvas.height = sh;
        }
        const sctx = this._ssCanvas.getContext('2d');
        sctx.setTransform(SUPERSAMPLE, 0, 0, SUPERSAMPLE, 0, 0);
        sctx.clearRect(0, 0, contentW, contentH);
        EditorModel.drawSampleTextPreview(sctx, text, {
            kerning: this.kerningChk.checked,
            guides: this.guidesChk.checked,
            ascender: state.ascender,
            descender: state.descender,
            capHeight: state.capHeight,
            xHeight: state.xHeight,
            canvasSizeHeight: state.canvasSizeHeight,
            upm: state.upm,
            width: contentW,
            height: contentH,
            fontSize
        });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this._ssCanvas, 0, 0, contentW, contentH);
    }
}
customElements.define('sample-text-panel', SampleTextPanel);
