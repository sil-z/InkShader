/**
 * After sequence text changes, inherits "active column" indices via LCS mapping (pure function).
 * @param {Array<{ raw: string }>} oldTokens
 * @param {Array<{ raw: string }>} newTokens
 * @param {Set<number>|Iterable<number>} oldActiveIndices
 * @returns {Set<number>}
 */
export function mapActiveIndicesAfterTokenChange(oldTokens, newTokens, oldActiveIndices) {
    const oldActive = new Set(oldActiveIndices);
    const oldActiveArr = oldTokens.map((_, i) => oldActive.has(i));

    const dp = Array(oldTokens.length + 1)
        .fill(0)
        .map(() => Array(newTokens.length + 1).fill(0));

    for (let i = 1; i <= oldTokens.length; i++) {
        for (let j = 1; j <= newTokens.length; j++) {
            if (oldTokens[i - 1].raw === newTokens[j - 1].raw) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const mapping = Array(newTokens.length).fill(-1);
    let i = oldTokens.length;
    let j = newTokens.length;
    while (i > 0 && j > 0) {
        if (oldTokens[i - 1].raw === newTokens[j - 1].raw) {
            mapping[j - 1] = i - 1;
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    const newActive = new Set();
    for (let k = 0; k < newTokens.length; k++) {
        if (mapping[k] !== -1) {
            if (oldActiveArr[mapping[k]]) newActive.add(k);
        } else {
            newActive.add(k);
        }
    }
    return newActive;
}
