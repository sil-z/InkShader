/**
 * Sequence column ↔ group id mapping (pure data, readable from Store snapshot).
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
