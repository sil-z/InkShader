/**
 * 序列「添加组」菜单候选（纯数据 DTO，无 DOM / 无 CurveManager）。
 * @param {Map<string, object>} treeItems
 */
export function listRootGroupsForSequenceMenu(treeItems) {
    if (!treeItems?.size) return [];
    const groups = [];
    for (const [, item] of treeItems) {
        if (
            item.type === "group" &&
            item.parentId === null &&
            !item.isRef &&
            (item.children.length > 0 || item.is_modified)
        ) {
            groups.push({
                id: item.id,
                name: item.name,
                charCode: item.charCode ?? null,
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
