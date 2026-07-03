import { parseSequenceTokens } from "./sequence_tokenizer.js";

/**
 * Removes tokens matching a group from sequence text, and rebuilds active indices.
 * @param {object} options
 * @param {string} options.text
 * @param {Set<number>} options.activeIndices
 * @param {string|null} options.groupId
 * @param {string|null} options.charCode
 * @param {(name: string) => object|null} [options.resolveGroupByName]
 */
export function removeGroupTokensFromSequence({
    text,
    activeIndices,
    groupId,
    charCode,
    resolveGroupByName = () => null,
    /** If >= 0, only remove the token at this specific index instead of matching by groupId/charCode */
    index = -1
}) {
    const tokens = parseSequenceTokens(text, { resolveGroupByName });
    let newText = "";
    const newActive = new Set();
    let currentIndex = 0;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        let isMatch = false;
        if (index >= 0) {
            if (i === index) isMatch = true;
        } else {
            if (t.isChar && charCode != null && t.value === charCode) isMatch = true;
            if (!t.isChar && groupId != null && t.value === groupId) isMatch = true;
        }

        if (!isMatch) {
            newText += t.raw;
            if (activeIndices.has(i)) newActive.add(currentIndex);
            currentIndex++;
        }
    }

    return { text: newText, activeIndices: newActive, tokens: parseSequenceTokens(newText, { resolveGroupByName }) };
}

/**
 * @param {string} text
 * @param {string} appendRaw
 * @param {(name: string) => object|null} [resolveGroupByName]
 */
export function appendRawToSequence(text, appendRaw, resolveGroupByName = () => null) {
    const nextText = text + appendRaw;
    const tokens = parseSequenceTokens(nextText, { resolveGroupByName });
    return { text: nextText, tokens, newTokenIndex: tokens.length - 1 };
}
