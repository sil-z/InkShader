/**
 * 序列列 ↔ 组 id 映射（纯数据，可读 Store 快照）。
 */

export function createSequenceLayoutFromState({ sequenceTokens = [], activeSequenceIndices = [], charToGroupId = {} } = {}) {
    const activeIndices = new Set(activeSequenceIndices);
    return {
        tokens: sequenceTokens,
        activeIndices,
        resolveTokenGroupId(token) {
            if (!token) return null;
            if (token.isChar) {
                return charToGroupId[token.value] ?? token.groupId ?? null;
            }
            return token.groupId ?? token.value ?? null;
        },
        getSeqOffset() {
            return 0;
        }
    };
}
