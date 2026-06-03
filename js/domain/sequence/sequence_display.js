/**
 * 序列编辑器显示字符（纯函数，无 DOM / 无 CurveManager）。
 */
export function getSequenceDisplayChar(char) {
    const formatAndControlRegex = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
    const spaceRegex = /\p{Z}/u;
    const combiningRegex = /^\p{M}$/u;

    if (formatAndControlRegex.test(char) || (spaceRegex.test(char) && char !== " ")) {
        const cp = char.codePointAt(0);
        const hex = cp.toString(16).toUpperCase();
        if (cp <= 0xffff) return `uni${hex.padStart(4, "0")}`;
        return `u${hex.padStart(5, "0")}`;
    }

    if (combiningRegex.test(char)) return "\u25CC" + char;
    return char;
}
