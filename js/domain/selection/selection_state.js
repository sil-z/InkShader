import { DOMAIN_EVENTS } from "../events/domain_events.js";

/**
 * Editor interaction selection (Task C: physically separated from CurveManager)
 * host is CurveManager; accesses domain tree/curves and event emission through host.
 */
export class SelectionState {
    constructor(host) {
        this.host = host;
        this.selectedTreeIds = new Set();
        this.node_selecting = new Set();
        this.node_selecting_ref_by_marker = new Map();
        this.selected_curves = new Set();
        this.selected_refs = new Set();
        this.focused_seq_idx = -1;
        this.activeGroupId = null;
    }

    addNodeSelection(markers) {
        let changed = false;
        for (let marker of markers) {
            if (!this.node_selecting.has(marker)) {
                this.node_selecting.add(marker);
                changed = true;
            }
        }
        return changed;
    }

    removeNodeSelection(markers) {
        let changed = false;
        for (let marker of markers) {
            if (!this.node_selecting.has(marker)) continue;
            this.node_selecting.delete(marker);
            this.node_selecting_ref_by_marker.delete(marker);
            changed = true;
        }
        return changed;
    }

    clearNodeSelection() {
        if (this.node_selecting.size === 0 && this.node_selecting_ref_by_marker.size === 0) return false;
        this.node_selecting.clear();
        this.node_selecting_ref_by_marker.clear();
        return true;
    }

    setNodeSelectionRefContext(marker, refId = null) {
        if (!marker) return;
        if (refId) this.node_selecting_ref_by_marker.set(marker, refId);
        else this.node_selecting_ref_by_marker.delete(marker);
    }

    getNodeSelectionRefId(marker) {
        return marker ? (this.node_selecting_ref_by_marker.get(marker) ?? null) : null;
    }

    removeNodeSelectionRefContext(markers = []) {
        for (const marker of markers) {
            if (marker) this.node_selecting_ref_by_marker.delete(marker);
        }
    }

    _resolveRefIdForMarker(markers, refContext, index, marker) {
        if (refContext == null || refContext === undefined) return null;
        if (Array.isArray(refContext)) return refContext[index] ?? null;
        if (refContext instanceof Map) return refContext.get(marker) ?? null;
        if (typeof refContext === "string") return index === 0 ? refContext : null;
        return null;
    }

    _bindNodeRefContexts(markers, refContext) {
        if (!markers || markers.length === 0) return;
        markers.forEach((marker, index) => {
            this.setNodeSelectionRefContext(
                marker,
                this._resolveRefIdForMarker(markers, refContext, index, marker)
            );
        });
    }

    replaceNodeSelection(markers, refContext = null) {
        let changed = this.clearNodeSelection();
        if (markers && markers.length > 0) {
            this._bindNodeRefContexts(markers, refContext);
            let added = this.addNodeSelection(markers);
            changed = changed || added;
        }
        return changed;
    }

    changeNodeSelection(strategy = "replace", markers = [], refContext = null) {
        let changed = false;
        switch (strategy) {
            case "replace":
                changed = this.replaceNodeSelection(markers, refContext);
                break;
            case "add":
                this._bindNodeRefContexts(markers, refContext);
                changed = this.addNodeSelection(markers);
                break;
            case "remove":
                changed = this.removeNodeSelection(markers);
                break;
            case "toggle": {
                const toAdd = [];
                const toRemove = [];
                for (let marker of markers) {
                    if (this.node_selecting.has(marker)) toRemove.push(marker);
                    else toAdd.push(marker);
                }
                changed = this.removeNodeSelection(toRemove);
                if (toAdd.length > 0) {
                    this._bindNodeRefContexts(toAdd, refContext);
                    changed = this.addNodeSelection(toAdd) || changed;
                }
                break;
            }
            case "clear":
                changed = this.clearNodeSelection();
                break;
        }
        if (changed) this.syncTreeSelectionFromCanvas();
        return changed;
    }

    addObjectSelection(curves = [], refs = []) {
        let changed = false;
        for (let curve of curves) {
            if (curve && !this.selected_curves.has(curve)) {
                this.selected_curves.add(curve);
                changed = true;
            }
        }
        for (let ref of refs) {
            if (!ref || !ref.id) continue;
            const exists = Array.from(this.selected_refs).some((r) => r && r.id === ref.id);
            if (!exists) {
                this.selected_refs.add(ref);
                changed = true;
            }
        }
        return changed;
    }

    removeObjectSelection(curves = [], refs = []) {
        let changed = false;
        for (let curve of curves) {
            if (curve && this.selected_curves.has(curve)) {
                this.selected_curves.delete(curve);
                changed = true;
            }
        }
        if (refs.length > 0) {
            const refIds = new Set(refs.filter((r) => r && r.id).map((r) => r.id));
            for (let ref of Array.from(this.selected_refs)) {
                if (ref && refIds.has(ref.id)) {
                    this.selected_refs.delete(ref);
                    changed = true;
                }
            }
        }
        return changed;
    }

    clearObjectSelection() {
        let changed = false;
        if (this.selected_curves.size > 0) {
            this.selected_curves.clear();
            changed = true;
        }
        if (this.selected_refs.size > 0) {
            this.selected_refs.clear();
            changed = true;
        }
        if (this.node_selecting.size > 0 || this.node_selecting_ref_by_marker.size > 0) {
            this.node_selecting.clear();
            this.node_selecting_ref_by_marker.clear();
            changed = true;
        }
        return changed;
    }

    replaceObjectSelection(curves = [], refs = []) {
        let changed = this.clearObjectSelection();
        changed = this.addObjectSelection(curves, refs) || changed;
        return changed;
    }

    updateActiveGroup(groupId) {
        let changed = false;
        if (groupId === null || groupId === undefined) {
            if (this.activeGroupId !== null) {
                this.activeGroupId = null;
                changed = true;
            }
        } else if (this.host.treeItems.has(groupId) && this.activeGroupId !== groupId) {
            this.activeGroupId = groupId;
            changed = true;
        }
        if (changed && this.host._shouldEmitInteractionEvents?.()) {
            this.host._emitEvent(DOMAIN_EVENTS.ACTIVE_GROUP_CHANGED);
        }
        return changed;
    }

    _emitGlobalSelectionUpdated() {
        if (this.host._shouldEmitInteractionEvents?.()) {
            this.host._emitEvent(DOMAIN_EVENTS.SELECTION_CHANGED);
        }
    }

    changeObjectSelection(strategy = "replace", payload = {}) {
        const curves = payload.curves || [];
        const refs = payload.refs || [];
        let changed = false;

        if (this.node_selecting.size > 0 || this.node_selecting_ref_by_marker.size > 0) {
            this.node_selecting.clear();
            this.node_selecting_ref_by_marker.clear();
            changed = true;
        }

        switch (strategy) {
            case "replace":
                changed = this.replaceObjectSelection(curves, refs);
                break;
            case "add":
                changed = this.addObjectSelection(curves, refs);
                break;
            case "remove":
                changed = this.removeObjectSelection(curves, refs);
                break;
            case "toggle": {
                const addCurves = [];
                const removeCurves = [];
                for (let curve of curves) {
                    if (!curve) continue;
                    if (this.selected_curves.has(curve)) removeCurves.push(curve);
                    else addCurves.push(curve);
                }
                const addRefs = [];
                const removeRefs = [];
                for (let ref of refs) {
                    if (!ref || !ref.id) continue;
                    const exists = Array.from(this.selected_refs).some((r) => r && r.id === ref.id);
                    if (exists) removeRefs.push(ref);
                    else addRefs.push(ref);
                }
                changed =
                    this.removeObjectSelection(removeCurves, removeRefs) ||
                    this.addObjectSelection(addCurves, addRefs);
                break;
            }
            case "clear":
                changed = this.clearObjectSelection();
                break;
        }

        if (payload.activeGroupId) {
            changed = this.updateActiveGroup(payload.activeGroupId) || changed;
        }
        if (changed) this.syncTreeSelectionFromCanvas();
        return changed;
    }

    setTreeSelection(idsArray) {
        this.selectedTreeIds = new Set(idsArray);
        this.node_selecting.clear();
        this.node_selecting_ref_by_marker.clear();
        this.selected_curves.clear();
        this.selected_refs.clear();

        let lastGroup = null;
        for (const id of idsArray) {
            const item = this.host.treeItems.get(id);
            if (item && item.type === "curve") {
                const curve = this.host.curveById.get(item.curveId);
                if (curve) this.selected_curves.add(curve);
            } else if (item && item.type === "group") {
                lastGroup = item.isRef ? item.parentId : id;
                if (item.isRef) this.selected_refs.add(item);
            } else if (item && item.type === "image") {
                this.selected_refs.add(item);
                lastGroup = item.parentId || id;
            }
        }
        if (lastGroup) this.activeGroupId = lastGroup;
        this._emitGlobalSelectionUpdated();
    }

    _resolveTreeIdForCurve(curve) {
        if (!curve) return null;
        if (this.host.treeItems.has(curve.id)) return curve.id;
        for (const [id, item] of this.host.treeItems) {
            if (item.type === "curve" && item.curveId === curve.id) return id;
        }
        return null;
    }

    syncTreeSelectionFromCanvas() {
        this.selectedTreeIds.clear();
        let lastGroupId = null;
        const resolvedCurveTreeIds = new Map();

        const addCurveTreeId = (curve) => {
            if (!curve) return;
            let treeId = resolvedCurveTreeIds.get(curve.id);
            if (treeId === undefined) {
                treeId = this._resolveTreeIdForCurve(curve);
                resolvedCurveTreeIds.set(curve.id, treeId ?? null);
            }
            if (treeId) {
                this.selectedTreeIds.add(treeId);
                lastGroupId = curve.groupId;
            }
        };

        for (let c of this.selected_curves) addCurveTreeId(c);
        for (let r of this.selected_refs) {
            if (this.host.treeItems.has(r.id)) {
                this.selectedTreeIds.add(r.id);
                lastGroupId = r.parentId;
            }
        }
        for (const marker of this.node_selecting) {
            const refId = this.getNodeSelectionRefId(marker);
            if (refId) {
                if (this.host.treeItems.has(refId)) {
                    this.selectedTreeIds.add(refId);
                    const refItem = this.host.treeItems.get(refId);
                    if (refItem?.parentId) lastGroupId = refItem.parentId;
                }
                continue;
            }
            addCurveTreeId(this.host.find_curve_by_dom(marker));
        }
        if (lastGroupId) this.activeGroupId = lastGroupId;
        this._emitGlobalSelectionUpdated();
    }

    clearAllSelection() {
        this.selectedTreeIds.clear();
        this.node_selecting.clear();
        this.node_selecting_ref_by_marker.clear();
        this.selected_curves.clear();
        this.selected_refs.clear();
        this.focused_seq_idx = -1;
    }

    validateSelection() {
        let selectionChanged = false;
        const host = this.host;

        const checkInvalid = (groupId) => {
            let rootId = host.getRootGroupId(groupId);
            let rootItem = host.treeItems.get(rootId);
            if (rootItem && rootItem.hidden_by_sequence) return true;

            let curr = host.treeItems.get(groupId);
            while (curr) {
                if (curr.visible === false || curr.locked === true) return true;
                curr = curr.parentId ? host.treeItems.get(curr.parentId) : null;
            }
            return false;
        };

        for (let ref of this.selected_refs) {
            if (checkInvalid(ref.id) || ref.visible === false || ref.locked === true) {
                this.selected_refs.delete(ref);
                selectionChanged = true;
            }
        }
        for (let curve of this.selected_curves) {
            if (checkInvalid(curve.groupId) || curve.visible === false || curve.locked === true) {
                this.selected_curves.delete(curve);
                selectionChanged = true;
            }
        }

        const invalidMarkers = [];
        for (let marker of this.node_selecting) {
            let curve = host.find_curve_by_dom(marker);
            if (curve && (checkInvalid(curve.groupId) || curve.visible === false || curve.locked === true)) {
                invalidMarkers.push(marker);
            }
        }
        if (invalidMarkers.length > 0) {
            this.removeNodeSelection(invalidMarkers);
            selectionChanged = true;
        }

        return selectionChanged;
    }
}
