import {
    hasObjectSelection,
    resolveCurvesFromSnapshot,
    resolveRefsFromSnapshot
} from "./interaction_snapshot_query.js";

/**
 * @param {object} layout
 * @param {Array} layout.tokens
 * @param {Set<number>} layout.activeIndices
 * @param {(token: object) => string|null} layout.resolveTokenGroupId
 * @param {(seqIdx: number) => number} layout.getSeqOffset
 */
export function getSeqIdxForGroupId(layout, groupId, focusedSeqIdx = -1) {
    if (!layout?.tokens?.length || !groupId) return -1;
    const { tokens, activeIndices, resolveTokenGroupId } = layout;

    if (focusedSeqIdx !== undefined && focusedSeqIdx !== -1 && focusedSeqIdx < tokens.length) {
        const gid = resolveTokenGroupId(tokens[focusedSeqIdx]);
        if (groupId === gid && activeIndices.has(focusedSeqIdx)) return focusedSeqIdx;
    }

    for (let i = 0; i < tokens.length; i++) {
        const gid = resolveTokenGroupId(tokens[i]);
        if (groupId === gid && activeIndices.has(i)) return i;
    }

    for (let i = 0; i < tokens.length; i++) {
        const gid = resolveTokenGroupId(tokens[i]);
        if (groupId === gid) return i;
    }
    return -1;
}

export function createSequenceLayoutFromCurveManager(cm) {
    if (!cm) return null;
    return {
        tokens: cm.sequenceTokens || [],
        activeIndices: cm.activeSequenceIndices || new Set(),
        resolveTokenGroupId(token) {
            return token.isChar ? cm.getDefaultGroupForChar(token.value) : token.value;
        },
        getSeqOffset(seqIdx) {
            return cm.getSeqOffset(seqIdx);
        }
    };
}

export function computeSelectionBounds(cm, interactionSnapshot, mode = "transform") {
    if (!cm || !interactionSnapshot || !hasObjectSelection(interactionSnapshot)) return null;

    const layout = createSequenceLayoutFromCurveManager(cm);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const useGeometry = mode === "geometry";
    const focusedSeqIdx =
        typeof interactionSnapshot.focusedSeqIdx === "number"
            ? interactionSnapshot.focusedSeqIdx
            : -1;

    for (const curve of resolveCurvesFromSnapshot(interactionSnapshot, cm)) {
        if (curve.visible === false || curve.locked === true) continue;
        const seqIdx = getSeqIdxForGroupId(layout, curve.groupId, focusedSeqIdx);
        if (seqIdx !== -1 && !layout.activeIndices.has(seqIdx)) continue;
        const bounds = useGeometry ? curve.getGeometryBounds(null) : curve.getTransformBounds(null);
        if (!bounds) continue;
        const seqOff = seqIdx !== -1 ? layout.getSeqOffset(seqIdx) : 0;
        minX = Math.min(minX, bounds.minX + seqOff);
        maxX = Math.max(maxX, bounds.maxX + seqOff);
        minY = Math.min(minY, bounds.minY);
        maxY = Math.max(maxY, bounds.maxY);
    }

    for (const ref of resolveRefsFromSnapshot(interactionSnapshot, cm)) {
        if (!ref.isRef && ref.type !== "image") continue;
        if (ref.visible === false || ref.locked === true) continue;

        const refGroupId =
            ref.type === "image"
                ? ref.parentId || cm.getRootGroupId(ref.id)
                : cm.getRootGroupId(ref.id);
        const seqIdx = getSeqIdxForGroupId(layout, refGroupId, focusedSeqIdx);
        if (seqIdx !== -1 && !layout.activeIndices.has(seqIdx)) continue;
        const seqOff = seqIdx !== -1 ? layout.getSeqOffset(seqIdx) : 0;

        if (ref.type === "image") {
            const points = [
                { x: 0, y: 0 },
                { x: ref.width, y: 0 },
                { x: 0, y: ref.height },
                { x: ref.width, y: ref.height }
            ];
            for (const p of points) {
                const tx = p.x * ref.transform.a + p.y * ref.transform.c + ref.transform.e + seqOff;
                const ty = p.x * ref.transform.b + p.y * ref.transform.d + ref.transform.f;
                minX = Math.min(minX, tx);
                maxX = Math.max(maxX, tx);
                minY = Math.min(minY, ty);
                maxY = Math.max(maxY, ty);
            }
        } else {
            const cdList = cm.getCurvesForGroup(ref.id);
            for (const cd of cdList) {
                if (cd.curve.visible === false || cd.curve.locked === true) continue;
                const bounds = useGeometry
                    ? cd.curve.getGeometryBounds(cd.matrix)
                    : cd.curve.getTransformBounds(cd.matrix);
                if (!bounds) continue;
                minX = Math.min(minX, bounds.minX + seqOff);
                maxX = Math.max(maxX, bounds.maxX + seqOff);
                minY = Math.min(minY, bounds.minY);
                maxY = Math.max(maxY, bounds.maxY);
            }
        }
    }

    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
}
