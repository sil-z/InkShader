/**
 * Sequence "add group" menu candidates (pure data DTO, no DOM / no CurveManager).
 * @param {Map<string, object>} treeItems
 */
export function listRootGroupsForSequenceMenu(treeItems) {
    if (!treeItems?.size) return [];
    const groups = [];
    for (const [, item] of treeItems) {
        if (
            item.type === "group" &&
            item.parentId === null &&
            !item.isRef
        ) {
            groups.push({
                id: item.id,
                name: item.name,
                charCode: item.charCode ?? null,
                advance: item.advance ?? 1000,
                locked: item.locked === true
            });
        }
    }
    groups.sort((a, b) => {
        const aIsGlyph = a.charCode != null;
        const bIsGlyph = b.charCode != null;
        if (aIsGlyph !== bIsGlyph) return aIsGlyph ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return groups;
}
