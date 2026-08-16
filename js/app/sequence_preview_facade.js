/**
 * Sequence thumbnail (presentation + CM); for editor_read_facade only, UI must not import presentation.
 */
import { drawSequenceGroupPreview } from "../presentation/sequence/sequence_group_preview.js";
import { drawSampleTextPreview, layoutSampleText } from "../presentation/sequence/sample_text_preview.js";
import { getMainCanvasFromDocument } from "./canvas_access.js";

export function drawSequenceGroupPreviewOnContext(ctx, groupId) {
    if (!ctx || !groupId) return;
    const canvas = getMainCanvasFromDocument();
    const cm = canvas?.curve_manager;
    if (!cm) return;
    const fs = canvas.fontSettings || {};
    // Pass font metrics so the preview pins ascender/descender to the content square
    // (fallback to bbox centering when metrics are absent).
    drawSequenceGroupPreview(ctx, cm, groupId, {
        ascender: fs.ascender,
        descender: fs.descender,
        canvasSizeHeight: canvas.canvas_size_height
    });
}

/**
 * Sample-text (specimen) preview: tokenize the text (characters → default glyph groups,
 * `\name\` references → named groups; spaces/unknown chars become pen advances; `\n` breaks
 * lines), then hand the token stream to the presentation renderer.
 *
 * @param {CanvasRenderingContext2D} ctx Logical-space context (dpr transform pre-applied by caller)
 * @param {string} text Sample text
 * @param {{kerning?: boolean, guides?: boolean, width?: number, height?: number, fontSize?: number}} [options]
 */
export function drawSampleTextPreviewOnContext(ctx, text, options = {}) {
    if (!ctx || !text) return;
    const canvas = getMainCanvasFromDocument();
    const cm = canvas?.curve_manager;
    if (!cm) return;
    const fs = canvas.fontSettings || {};
    const upm = fs.upm || 1000;

    return drawSampleTextPreview(ctx, cm, buildSampleTokens(cm, text, upm), {
        kerning: options.kerning,
        guides: options.guides,
        ascender: fs.ascender,
        descender: fs.descender,
        capHeight: fs.cap_height,
        xHeight: fs.x_height,
        canvasSizeHeight: canvas.canvas_size_height,
        width: options.width,
        height: options.height,
        fontSize: options.fontSize
    });
}

/**
 * Measure-only pass for the sample-text panel: tokenize `text` and run the layout without
 * drawing, so the component can size its canvas/scroll container to the content height.
 *
 * @param {string} text Sample text
 * @param {{kerning?: boolean, width?: number, fontSize?: number}} [options]
 * @returns {{rows: number, contentHeight: number, scale: number} | null}
 */
export function measureSampleTextPreview(text, options = {}) {
    const canvas = getMainCanvasFromDocument();
    const cm = canvas?.curve_manager;
    if (!cm || !text) return null;
    const fs = canvas.fontSettings || {};
    const upm = fs.upm || 1000;

    return layoutSampleText(cm, buildSampleTokens(cm, text, upm), {
        kerning: options.kerning,
        ascender: fs.ascender,
        descender: fs.descender,
        canvasSizeHeight: canvas.canvas_size_height,
        width: options.width,
        fontSize: options.fontSize
    });
}

/**
 * Build the sample-text token stream.
 * Parse rules (left to right):
 * - `\name\` → the WHOLE substring is a glyph reference to the named group
 *   (non-character glyphs like `\test\`). If no group with that name exists,
 *   both backslashes act as isolated backslashes (ignored) and the name
 *   renders as plain characters.
 * - `\\` (two consecutive backslashes) → ONE literal backslash character,
 *   rendered as the font's backslash glyph (takes precedence over `\name\`
 *   because a reference needs a non-empty name).
 * - an ISOLATED backslash (no closing `\`, not part of `\\`) is ignored:
 *   only the backslash itself is dropped, the following chars render normally.
 * - `\n` → newline token
 * - any other character → its default character group (fallback: space-like
 *   or unknown advance)
 */
function buildSampleTokens(cm, text, upm) {
    const tokens = [];
    const chars = Array.from(text);

    // Plain character → glyph token (default group) or conventional blank slot.
    const pushGlyphForChar = (c) => {
        const gid = cm.getDefaultGroupForChar(c);
        if (gid) {
            const item = cm.treeItems.get(gid);
            tokens.push({
                type: 'glyph',
                gid,
                name: item?.name ?? gid,
                advance: item?.advance ?? upm
            });
        } else if (c === ' ' || c === '\t') {
            // No space glyph in the font — reserve a conventional quarter-em space.
            tokens.push({ type: 'space', advance: Math.round(upm * 0.25) });
        } else {
            // Unknown character: reserve a half-em blank slot.
            tokens.push({ type: 'unknown', advance: Math.round(upm * 0.5) });
        }
    };

    let i = 0;
    while (i < chars.length) {
        const ch = chars[i];

        if (ch === '\n') {
            tokens.push({ type: 'newline' });
            i++;
            continue;
        }

        if (ch === '\\') {
            // `\\` (two consecutive backslashes) → ONE literal backslash character,
            // rendered as the font's backslash glyph (takes precedence over `\name\`
            // since a reference needs a NON-EMPTY name).
            if (chars[i + 1] === '\\') {
                pushGlyphForChar('\\');
                i += 2;
                continue;
            }
            // `\name\` → the whole substring is a glyph reference. When no group
            // with that name exists, THIS backslash is isolated: ignored, and the
            // name chars are processed normally on subsequent iterations.
            const end = chars.indexOf('\\', i + 1);
            if (end > i + 1) {
                const name = chars.slice(i + 1, end).join('');
                const item = cm.getGroupByName(name);
                if (item) {
                    const advance = cm.treeItems.get(item.id)?.advance ?? upm;
                    tokens.push({ type: 'glyph', gid: item.id, name, advance });
                    i = end + 1;
                    continue;
                }
            }
            // No closing backslash (or unresolved name): ignore THIS '\' and move on.
            i++;
            continue;
        }

        pushGlyphForChar(ch);
        i++;
    }
    return tokens;
}
