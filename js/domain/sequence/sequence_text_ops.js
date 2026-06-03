import { parseSequenceTokens } from "./sequence_tokenizer.js";

/**
 * 从序列文本中移除匹配某组的 token，并重建 active 索引。
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
    resolveGroupByName = () => null
}) {
    const tokens = parseSequenceTokens(text, { resolveGroupByName });
    let newText = "";
    const newActive = new Set();
    let currentIndex = 0;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        let isMatch = false;
        if (t.isChar && charCode != null && t.value === charCode) isMatch = true;
        if (!t.isChar && groupId != null && t.value === groupId) isMatch = true;

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
