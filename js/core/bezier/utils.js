let markerSequence = 0;

/**
 * Generate a process-unique marker ID.
 *
 * A timestamp + 0..9999 random suffix collides frequently when Break Path creates
 * thousands of markers in one millisecond. Marker IDs are selection and spatial-index
 * identities, so a collision makes one of the nodes effectively unreachable.
 */
export function generateMarker(type) {
    markerSequence += 1;
    const uuid = globalThis.crypto?.randomUUID?.();
    const uniquePart = uuid ||
        `${Date.now().toString(36)}_${markerSequence.toString(36)}_${Math.random().toString(36).slice(2)}`;
    return {
        id: `m_${type}_${uniquePart}`,
        type
    };
}