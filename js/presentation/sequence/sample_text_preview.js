import { appendCurveFillPath, curveGeneratesFillArea } from "../../canvas/rendering/curve_renderer.js";

/**
 * Sample text (specimen) preview (presentation layer: may use Canvas API; UI components call only this module).
 *
 * Lays out a token stream (glyph tokens / space tokens / newline tokens, built by the app-layer facade)
 * on a shared baseline using each glyph's advance width plus optional kerning (queried via
 * `curveManager.kerningManager.getKerning`), wraps lines that exceed the canvas width, and renders
 * each glyph's curves with the same transform convention as sequence_group_preview:
 *
 *   model space: baseline = ascender, fontY = ascender - modelY, so the ascender line sits at
 *   model y = 0. The font size is the USER-SET value (px): scale = fontSize / (asc - desc),
 *   independent of the canvas/panel size. A line break shifts the row baseline down by one
 *   (asc - desc) in model units (each row gets its own offsetY). Content taller than the canvas
 *   simply extends below it — the panel wraps the canvas in a scrollable container.
 *
 * Optional metric guides (baseline / ascender / descender / cap height / x height) are drawn
 * per row as dashed lines using the --cvs-guideline theme color.
 *
 * @param {CanvasRenderingContext2D} ctx Preview context (logical coordinate space, dpr transform pre-applied by caller)
 * @param {object} curveManager
 * @param {Array<{type:string, gid?:string, name?:string, advance?:number}>} tokens Token stream:
 *        {type:"glyph", gid, name, advance} renders a glyph; {type:"space", advance} / {type:"unknown", advance}
 *        advance the pen without rendering; {type:"newline"} breaks the line.
 * @param {{kerning?: boolean, guides?: boolean, ascender?: number, descender?: number, capHeight?: number,
 *          xHeight?: number, canvasSizeHeight?: number, width?: number, height?: number,
 *          fontSize?: number}} [options]
 *        `width`/`height` are the logical canvas size (fallback: ctx.canvas.width/height);
 *        `fontSize` is the user-set em size in px (default 48).
 * @returns {{rows: number, contentHeight: number, scale: number, maxRowWidthPx: number}} layout info
 *          (rows incl. wraps, content height in px for the scroll container, em scale,
 *          widest natural-line width in px — the panel uses it as the MIN canvas width so a
 *          single line never wraps; narrower panels scroll horizontally instead).
 */
export function drawSampleTextPreview(ctx, curveManager, tokens, options = {}) {
    const layout = layoutSampleText(curveManager, tokens, options);
    if (!layout || !ctx) return { rows: 0, contentHeight: 0, scale: 0, maxRowWidthPx: 0 };
    const { rows, scale, PAD, baseOffsetY, maxX } = layout;
    const height = options.height ?? ctx.canvas.height;
    const asc = options.ascender;
    const canvasH = options.canvasSizeHeight;

    // ── Metric guides (dashed, behind the glyphs) ──
    if (options.guides !== false) {
        const rootStyle = getComputedStyle(document.documentElement);
        const guideStyle = rootStyle.getPropertyValue('--cvs-guideline').trim() || 'rgba(249, 115, 22, 0.8)';
        const fontYToPixel = (row, fontY) => baseOffsetY + (asc - fontY + row * layout.lineH) * scale;
        const guideFontYs = [
            { fontY: asc, key: 'ascender' },
            { fontY: 0, key: 'baseline' },
            { fontY: options.descender, key: 'descender' }
        ];
        if (Number.isFinite(options.capHeight)) guideFontYs.push({ fontY: options.capHeight, key: 'cap' });
        if (Number.isFinite(options.xHeight)) guideFontYs.push({ fontY: options.xHeight, key: 'xHeight' });

        ctx.save();
        ctx.strokeStyle = guideStyle;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        for (let row = 0; row < rows; row++) {
            for (const g of guideFontYs) {
                const y = fontYToPixel(row, g.fontY);
                if (y < 0 || y > height) continue;
                ctx.beginPath();
                ctx.moveTo(PAD, y);
                ctx.lineTo(widthOf(ctx, options) - PAD, y);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // ── Glyph rendering (fresh layout pass: pen starts at row 0 / x 0) ──
    const drawLayout = layoutSampleText(curveManager, tokens, options);
    const fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--cvs-path-fill').trim()) || '#111';

    const rowOffsetY = (r) => baseOffsetY + r * layout.lineH * scale;

    const drawGlyph = (gid, gx, r) => {
        const curves = curveManager.getCurvesForGroup(gid) || [];
        const viewport = { scale, offsetX: PAD, offsetY: rowOffsetY(r), seqOffsetX: gx, matrix: null };
        ctx.save();
        ctx.fillStyle = fillStyle;
        ctx.beginPath();
        let hasFill = false;
        for (const cd of curves) {
            const curve = cd.curve;
            if (!curve?.startNode || !curveGeneratesFillArea(curve)) continue;
            appendCurveFillPath(ctx, curve, { ...viewport, matrix: cd.matrix });
            hasFill = true;
        }
        if (hasFill) ctx.fill("nonzero");
        ctx.restore();
    };

    for (const token of tokens) {
        if (token.type === 'newline') {
            drawLayout.pen.row++;
            drawLayout.pen.x = 0;
            drawLayout.pen.prevGlyph = null;
            continue;
        }
        if (token.type === 'glyph') {
            const k = (options.kerning !== false && drawLayout.pen.prevGlyph)
                ? (curveManager.kerningManager.getKerning(drawLayout.pen.prevGlyph.name, token.name) || 0)
                : 0;
            const nextX = drawLayout.pen.x + k + (token.advance || 0);
            if (nextX > maxX && drawLayout.pen.x > 0) {
                drawLayout.pen.row++;
                drawLayout.pen.x = 0;
                drawLayout.pen.prevGlyph = null;
            } else {
                drawLayout.pen.x += k;
            }
            drawGlyph(token.gid, drawLayout.pen.x, drawLayout.pen.row);
            drawLayout.pen.x += (token.advance || 0);
            drawLayout.pen.prevGlyph = token;
        } else {
            // Space / unknown glyph: advance the pen without rendering; kerning chain resets.
            drawLayout.pen.x += (token.advance || 0);
            drawLayout.pen.prevGlyph = null;
        }
    }

    return { rows, contentHeight: layout.contentHeight, scale };
}

function widthOf(ctx, options) {
    return options.width ?? ctx.canvas.width;
}

/**
 * Pure layout pass (no rendering): computes the em scale, wrap decisions and content height.
 * Shared by the panel (to size the scroll container) and the draw pass.
 *
 * The returned `pen` is PRISTINE ({x:0, row:0, prevGlyph:null}): the row-counting walk uses
 * a private pen, so a draw pass can hand the layout's pen to its own walk starting at 0.
 *
 * @returns {{rows: number, contentHeight: number, scale: number, PAD: number, baseOffsetY: number,
 *            maxX: number, lineH: number, maxRowWidthPx: number,
 *            pen: {x: number, row: number, prevGlyph: object|null}}} | null
 */
export function layoutSampleText(curveManager, tokens, options = {}) {
    if (!curveManager || !Array.isArray(tokens) || tokens.length === 0) return null;

    const asc = options.ascender;
    const desc = options.descender;
    const canvasH = options.canvasSizeHeight;
    const width = options.width ?? 240;

    const hasMetrics = Number.isFinite(asc) && Number.isFinite(desc) && asc > desc
        && Number.isFinite(canvasH) && canvasH > 0 && width > 0;
    if (!hasMetrics) return null;

    const fontSize = Number.isFinite(options.fontSize) && options.fontSize > 0 ? options.fontSize : 48;
    const PAD = 10;
    const lineH = asc - desc;
    const scale = fontSize / lineH;
    const maxX = (width - PAD) / scale; // wrap threshold in MODEL units (scaled to px at draw time)
    const baseOffsetY = PAD;

    const layout = {
        rows: 1,
        contentHeight: lineH * scale + PAD * 2,
        scale,
        PAD,
        baseOffsetY,
        maxX,
        lineH,
        maxRowWidthPx: 0,
        pen: { x: 0, row: 0, prevGlyph: null }
    };
    // Walk once with a PRIVATE pen to count rows (wraps + explicit newlines) so the content
    // height is known. layout.pen above stays pristine for the caller's own draw walk.
    // A TRAILING newline token does NOT start a new row: nothing follows it, so "AB\n" is
    // still one row (the textarea simply ends on an empty line) - guides and content
    // height must not claim a phantom row.
    let rows = 1;
    let penX = 0;
    let prevGlyph = null;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'newline') {
            if (i < tokens.length - 1) rows++;
            // A newline RESETS the pen: the next line starts at x=0 with no kerning
            // chain. Without this, a line that filled most of the canvas pushed the
            // following line's first glyph over the wrap threshold → phantom wrapped
            // rows (guides + content height claimed more rows than the draw pass
            // renders — "metric guides one row too many" on multi-line text).
            penX = 0;
            prevGlyph = null;
            continue;
        }
        if (token.type === 'glyph') {
            const k = (options.kerning !== false && prevGlyph)
                ? (curveManager.kerningManager.getKerning(prevGlyph.name, token.name) || 0)
                : 0;
            const nextX = penX + k + (token.advance || 0);
            if (nextX > maxX && penX > 0) {
                rows++;
                penX = 0;
                prevGlyph = null;
            } else {
                penX += k;
            }
            penX += (token.advance || 0);
            prevGlyph = token;
        } else {
            penX += (token.advance || 0);
            prevGlyph = null;
        }
    }

    layout.rows = rows;
    layout.contentHeight = rows * lineH * scale + PAD * 2;

    // Widest NATURAL line (\n-delimited, kerning applied, NO width wraps) in model units.
    // The panel sizes the canvas to max(wrapW, this*scale + 2*PAD), so a single line always
    // fits un-wrapped — a too-narrow panel scrolls horizontally instead of squeezing the line.
    let maxRowModel = 0;
    let rowW = 0;
    let rPrev = null;
    for (const token of tokens) {
        if (token.type === 'newline') {
            maxRowModel = Math.max(maxRowModel, rowW);
            rowW = 0;
            rPrev = null;
        } else if (token.type === 'glyph') {
            if (options.kerning !== false && rPrev) rowW += (curveManager.kerningManager.getKerning(rPrev.name, token.name) || 0);
            rowW += (token.advance || 0);
            rPrev = token;
        } else {
            rowW += (token.advance || 0);
            rPrev = null;
        }
    }
    layout.maxRowWidthPx = Math.max(maxRowModel, rowW) * scale + PAD * 2;

    return layout;
}
