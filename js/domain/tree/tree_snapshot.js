/**
 * 对象树只读快照（纯数据，供 Store / UI 读模型，无 DOM）。
 */

function serializeDomMatrix(matrix) {
    if (!matrix) return null;
    return {
        a: matrix.a ?? 1,
        b: matrix.b ?? 0,
        c: matrix.c ?? 0,
        d: matrix.d ?? 1,
        e: matrix.e ?? 0,
        f: matrix.f ?? 0
    };
}

export function buildTreeSnapshot(curveManager) {
    if (!curveManager) {
        return { rootChildren: [], items: {}, charToGroupId: {} };
    }

    const items = {};
    for (const [id, item] of curveManager.treeItems) {
        const dto = {
            id: item.id,
            type: item.type,
            name: item.name,
            parentId: item.parentId ?? null,
            children: Array.isArray(item.children) ? [...item.children] : [],
            curveId: item.curveId ?? null,
            isRef: !!item.isRef,
            refId: item.refId ?? null,
            charCode: item.charCode ?? null,
            collapsed: !!item.collapsed,
            locked: item.locked === true,
            visible: item.visible !== false,
            hidden_by_sequence: !!item.hidden_by_sequence,
            is_modified: !!item.is_modified
        };
        if (item.type === "curve" && item.curveId) {
            const curve = curveManager.curves.find((c) => c.id === item.curveId);
            if (curve) {
                dto.curveVisible = curve.visible !== false;
                dto.curveLocked = curve.locked === true;
                dto.locked = dto.locked || dto.curveLocked;
                dto.visible = dto.visible && dto.curveVisible;
            }
        }
        if (item.type === "group" && !item.isRef && item.advance !== undefined) {
            dto.advance = item.advance;
        }
        if (item.isRef && item.transform) {
            dto.transform = serializeDomMatrix(item.transform);
        }
        if (item.type === "image") {
            dto.width = item.width;
            dto.height = item.height;
            if (item.transform) dto.transform = serializeDomMatrix(item.transform);
        }
        items[id] = dto;
    }

    const charToGroupId = {};
    for (const [ch, gid] of curveManager.defaultGlyphs || []) {
        charToGroupId[ch] = gid;
    }

    return {
        rootChildren: [...(curveManager.rootChildren || [])],
        items,
        charToGroupId
    };
}

export function getTreeItemFromSnapshot(snapshot, id) {
    if (!snapshot?.items || id == null) return null;
    return snapshot.items[id] ?? null;
}

export function isDescendantInTreeSnapshot(snapshot, ancestorId, descendantId) {
    if (!snapshot?.items || !ancestorId || !descendantId) return false;
    let current = descendantId;
    const items = snapshot.items;
    while (current) {
        const item = items[current];
        if (!item) return false;
        if (item.parentId === ancestorId) return true;
        if (item.parentId == null) return false;
        current = item.parentId;
    }
    return false;
}

/** @param {ReturnType<typeof buildTreeSnapshot>} snapshot */
export function treeItemsMapFromSnapshot(snapshot) {
    if (!snapshot?.items) return null;
    return new Map(Object.entries(snapshot.items));
}
