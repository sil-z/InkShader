import { getSequenceDisplayChar } from "./sequence_display.js";

/**
 * 将序列文本解析为 token（纯函数）。
 * @param {string} text
 * @param {{ resolveGroupByName?: (name: string) => { id: string } | null, getDisplayChar?: (char: string) => string }} [options]
 */
export function parseSequenceTokens(text, options = {}) {
    const resolveGroupByName = options.resolveGroupByName || (() => null);
    const getDisplayChar = options.getDisplayChar || getSequenceDisplayChar;

    const tokens = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] === "\\") {
            const end = text.indexOf("\\", i + 1);
            if (end === i + 1) {
                tokens.push({ isChar: true, value: "\\", raw: "\\\\", display: "\\" });
                i = end + 1;
                continue;
            }
            if (end !== -1) {
                const name = text.substring(i + 1, end);
                const group = resolveGroupByName(name);
                tokens.push({
                    isChar: false,
                    value: group ? group.id : null,
                    name,
                    raw: text.substring(i, end + 1),
                    display: name
                });
                i = end + 1;
                continue;
            }
        }

        const htmlEntMatch = text.substring(i).match(/^&#(x?[0-9a-fA-F]+);/);
        if (htmlEntMatch) {
            const codeStr = htmlEntMatch[1];
            const code = codeStr.startsWith("x")
                ? parseInt(codeStr.substring(1), 16)
                : parseInt(codeStr, 10);
            const char = String.fromCodePoint(code);
            tokens.push({
                isChar: true,
                value: char,
                raw: htmlEntMatch[0],
                display: getDisplayChar(char)
            });
            i += htmlEntMatch[0].length;
            continue;
        }

        const codePoint = text.codePointAt(i);
        const char = String.fromCodePoint(codePoint);
        tokens.push({
            isChar: true,
            value: char,
            raw: char,
            display: getDisplayChar(char)
        });
        i += char.length;
    }
    return tokens;
}
