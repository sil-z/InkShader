// js/core/bezier/tree_store.js — Tree structure storage: group hierarchy, object CRUD, cache
import { TransformEngine } from '../transform_engine.js';
import { DOMAIN_EVENTS } from '../../domain/events/domain_events.js';

/**
 * TreeStore: manages treeItems, rootChildren, groupFlatCache, object transforms/properties.
 * Depends on CurveStore for curve lookup, emits domain events through EventEmitter.
 */
export class TreeStore {
    /** @type {import('./curve_store.js').CurveStore} */
    _curveStore = null;
    /** @type {(name: string, detail?: object) => void} */
    _emitEvent = () => {};

    treeItems = new Map();
    rootChildren = [];
    groupFlatCache = new Map();
    boundsEditSession = null;

    constructor(curveStore, emitEvent = () => {}) {
        this._curveStore = curveStore;
        this._emitEvent = emitEvent;
    }

    setEmitEvent(emitter) {
        this._emitEvent = typeof emitter === 'function' ? emitter : () => {};
    }

    // =========================================================================
    // Basic tree operations
    // =========================================================================

    initTree() {
        this.treeItems.clear();
        this.rootChildren = [];
        this.groupFlatCache.clear();
    }

    getGroupByName(name) {
        for (let item of this.treeItems.values()) {
            if (item.type === 'group' && item.name === name && item.parentId === null && !item.isRef) return item;
        }
        return null;
    }

    ensureUniqueName(baseName, ignoreId = null) {
        let name = baseName.replace(/[^A-Za-z0-9_.-]/g, '_');
        if (name.length === 0) name = 'Object';
        let counter = 1;
        let testName = name;
        while (true) {
            let conflict = false;
            for (let item of this.treeItems.values()) {
                if (item.id === testName && item.id !== ignoreId) {
                    conflict = true; break;
                }
            }
            if (!conflict) return testName;
            testName = `${name}_${counter}`;
            counter++;
        }
    }

    renameItem(oldId, newName) {
        if (oldId === newName) return true;
        if (this.treeItems.has(newName)) return false;

        let item = this.treeItems.get(oldId);
        if (!item) return false;

        this.treeItems.delete(oldId);
        item.id = newName;
        item.name = newName;
        item.is_modified = true;
        if (item.type === 'curve') {
            item.curveId = newName;
            let curve = this._curveStore.curves.find(c => c.id === oldId);
            if (curve) curve.id = newName;
        }
        this.treeItems.set(newName, item);

        if (item.parentId) {
            let parent = this.treeItems.get(item.parentId);
            if (parent) {
                let idx = parent.children.indexOf(oldId);
                if (idx !== -1) parent.children[idx] = newName;
            }
        } else {
            let idx = this.rootChildren.indexOf(oldId);
            if (idx !== -1) this.rootChildren[idx] = newName;
        }

        for (let v of this.treeItems.values()) {
            if (v.parentId === oldId) v.parentId = newName;
            if (v.isRef && v.refId === oldId) v.refId = newName;
        }

        if (item.type === 'group') {
            for (let c of this._curveStore.curves) {
                if (c.groupId === oldId) c.groupId = newName;
            }
        }

        return true;
    }

    deleteTreeItem(id, cascade = true) {
        const item = this.treeItems.get(id);
        if (!item) return;

        if (item.parentId) {
            const parent = this.treeItems.get(item.parentId);
            if (parent) parent.children = parent.children.filter(cid => cid !== id);
        } else {
            this.rootChildren = this.rootChildren.filter(cid => cid !== id);
        }

        if (item.type === 'group' && !item.isRef) {
            [...item.children].forEach(childId => this.deleteTreeItem(childId, cascade));
        } else if (item.type === 'curve' && cascade) {
            const index = this._curveStore.curves.findIndex(c => c.id === item.curveId);
            if (index !== -1) {
                this._curveStore.unregisterCurveDomMarkers(this._curveStore.curves[index]);
                this._curveStore.curves.splice(index, 1);
            }
        }

        this.treeItems.delete(id);
    }

    isDescendant(parentId, targetId, visited = new Set()) {
        if (parentId === targetId) return true;
        if (visited.has(parentId)) return false;
        visited.add(parentId);

        const parent = this.treeItems.get(parentId);
        if (!parent || parent.type !== 'group') return false;

        if (parent.isRef && parent.refId) {
            if (this.isDescendant(parent.refId, targetId, visited)) return true;
        } else {
            for (let childId of parent.children) {
                if (this.isDescendant(childId, targetId, visited)) return true;
            }
        }
        return false;
    }

    getRootGroupId(groupId) {
        let curr = this.treeItems.get(groupId);
        while (curr && curr.parentId) { curr = this.treeItems.get(curr.parentId); }
        return curr ? curr.id : null;
    }

    // =========================================================================
    // Group flattening + cache
    // =========================================================================

    getCurvesForGroup(groupId) {
        if (this.groupFlatCache.has(groupId)) return this.groupFlatCache.get(groupId);

        const flatten = (nodes, currentMatrix, currentRefId, visited = new Set(), currentRefItem = null, parentVis = true, parentLock = false) => {
            let result = [];
            if (!nodes) return result;

            for (let id of nodes) {
                const item = this.treeItems.get(id);
                if (!item) continue;

                let curVis = parentVis && (item.visible !== false);
                let curLock = parentLock || (item.locked === true);

                if (item.type === 'curve') {
                    const c = this._curveStore.curves.find(x => x.id === item.curveId);
                    if (c) {
                        let finalVis = curVis && (c.visible !== false);
                        let finalLock = curLock || (c.locked === true);
                        result.push({
                            curve: c, matrix: currentMatrix, refId: currentRefId, refItem: currentRefItem,
                            effectiveVis: finalVis, effectiveLock: finalLock
                        });
                    }
                } else if (item.type === 'group') {
                    if (visited.has(item.id)) continue;
                    let nextVisited = new Set(visited);
                    nextVisited.add(item.id);

                    if (item.isRef && item.transform) {
                        let nextMatrix = new DOMMatrix(currentMatrix).multiply(item.transform);
                        let passRefItem = currentRefItem !== null ? currentRefItem : item;
                        let passRefId = currentRefId !== null ? currentRefId : item.id;

                        if (!nextVisited.has(item.refId)) {
                            nextVisited.add(item.refId);
                            const sourceGroup = this.treeItems.get(item.refId);
                            if (sourceGroup) {
                                let sub = flatten(sourceGroup.children, nextMatrix, passRefId, nextVisited, passRefItem, curVis, curLock);
                                sub.forEach(s => result.push(s));
                            }
                        }
                    } else {
                        let sub = flatten(item.children, currentMatrix, currentRefId, nextVisited, currentRefItem, curVis, curLock);
                        sub.forEach(s => result.push(s));
                    }
                }
            }
            return result;
        };

        if (!this.treeItems.has(groupId)) return [];
        let flatData = flatten([groupId], new DOMMatrix(), null);
        flatData.reverse();
        this.groupFlatCache.set(groupId, flatData);
        return flatData;
    }

    invalidateGroupCache(targetId) {
        let visited = new Set();
        const self = this;

        function invalidate(id) {
            if (!id || visited.has(id)) return;
            visited.add(id);

            if (self.groupFlatCache.has(id)) self.groupFlatCache.delete(id);

            let item = self.treeItems.get(id);
            if (!item) return;

            if (item.parentId) invalidate(item.parentId);

            for (let [otherId, otherItem] of self.treeItems.entries()) {
                if (otherItem.isRef && otherItem.refId === id) invalidate(otherId);
            }
        }

        invalidate(targetId);
    }

    notifyTreeUpdate() {
        this.groupFlatCache.clear();
        this._emitEvent(DOMAIN_EVENTS.TREE_UPDATED);
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    deleteSingleObject(objectId) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        const treeIdsToDelete = new Set();
        const curveIdsToDelete = new Set();

        const collect = (id) => {
            const target = this.treeItems.get(id);
            if (!target) return;
            if (treeIdsToDelete.has(id)) return;
            treeIdsToDelete.add(id);

            if (target.type === 'curve') {
                curveIdsToDelete.add(target.curveId || target.id);
                return;
            }
            if (target.type === 'group' && !target.isRef) {
                for (const childId of (target.children || [])) {
                    collect(childId);
                }
            }
        };
        collect(objectId);

        this.deleteTreeItem(objectId, true);
        return { treeIdsToDelete, curveIdsToDelete };
    }

    changeSingleObjectGroup(objectId, targetId, mode = 'inside') {
        const moving = this.treeItems.get(objectId);
        const target = this.treeItems.get(targetId);
        if (!moving || !target) return false;
        if (objectId === targetId) return false;
        if (!['inside', 'before', 'after'].includes(mode)) return false;

        if (mode === 'inside' && moving.type === 'group' && !moving.isRef) {
            if (target.type !== 'group' || target.isRef) return false;
            if (this.isDescendant(objectId, targetId)) return false;
            this.pasteGroupRef(objectId, targetId);
            return true;
        }

        let newParentId = null;
        if (mode === 'inside') {
            if (target.type !== 'group' || target.isRef) return false;
            newParentId = targetId;
        } else {
            newParentId = target.parentId || null;
        }

        if (newParentId !== null && this.isDescendant(objectId, newParentId)) return false;
        if (moving.parentId === newParentId && (mode === 'inside' || moving.id === targetId)) return false;

        const oldParentId = moving.parentId || null;
        if (oldParentId) {
            const oldParent = this.treeItems.get(oldParentId);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(cid => cid !== objectId);
                oldParent.is_modified = true;
            }
        } else {
            this.rootChildren = this.rootChildren.filter(cid => cid !== objectId);
        }

        if (mode === 'inside') {
            if (!target.children) target.children = [];
            target.children.push(objectId);
            target.is_modified = true;
        } else {
            const siblings = newParentId ? (this.treeItems.get(newParentId)?.children || []) : this.rootChildren;
            const targetIndex = siblings.indexOf(targetId);
            if (targetIndex === -1) siblings.push(objectId);
            else if (mode === 'before') siblings.splice(targetIndex, 0, objectId);
            else siblings.splice(targetIndex + 1, 0, objectId);
        }

        moving.parentId = newParentId;

        if (moving.type === 'curve') {
            const curve = this._curveStore.curves.find(c => c.id === moving.curveId);
            if (curve) curve.groupId = newParentId;
        }

        return true;
    }

    setSingleObjectProperties(objectId, props = {}) {
        const item = this.treeItems.get(objectId);
        if (!item || !props || typeof props !== 'object') return false;

        let changed = false;

        if (item.type === 'curve') {
            const curve = this._curveStore.curves.find(c => c.id === item.curveId);
            if (!curve) return false;

            const directProps = ['stroke_width', 'closed', 'smart_stroke', 'show_skeleton', 'smart_stroke_clockwise', 'visible', 'locked'];
            for (const key of directProps) {
                if (Object.prototype.hasOwnProperty.call(props, key) && curve[key] !== props[key]) {
                    curve[key] = props[key];
                    changed = true;
                }
            }

            if (props.reverse_direction === true) {
                if (curve.getSkeletonVertices().length >= 2 && curve.reverseSkeletonDirection()) {
                    changed = true;
                }
            }

            if (props.toggle_smart_winding === true && curve.smart_stroke === true) {
                curve.smart_stroke_clockwise = !(curve.smart_stroke_clockwise !== false);
                changed = true;
            }

            if (changed) {
                curve.cached_boolean_geometry = null;
                curve._lastHash = null;
            }
            return changed;
        }

        if (item.type === 'group' && item.isRef) {
            const hasTx = Object.prototype.hasOwnProperty.call(props, 'ref_tx');
            const hasTy = Object.prototype.hasOwnProperty.call(props, 'ref_ty');
            if (!hasTx && !hasTy) return false;

            const oldTx = item.transform?.e || 0;
            const oldTy = item.transform?.f || 0;
            const newTx = hasTx ? Number(props.ref_tx) : oldTx;
            const newTy = hasTy ? Number(props.ref_ty) : oldTy;
            if (Number.isFinite(newTx) && Number.isFinite(newTy) && (newTx !== oldTx || newTy !== oldTy)) {
                item.transform = new DOMMatrix().translate(newTx, newTy);
                changed = true;
            }
            return changed;
        }

        return false;
    }

    toggleSingleObjectLock(objectId, locked = undefined) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        if (item.type === 'curve') {
            const curve = this._curveStore.curves.find(c => c.id === item.curveId);
            if (!curve) return false;
            const current = curve.locked === true;
            const target = typeof locked === 'boolean' ? locked : !current;
            if (current === target) return false;
            curve.locked = target;
            item.locked = target;
            return true;
        }

        const current = item.locked === true;
        const target = typeof locked === 'boolean' ? locked : !current;
        if (current === target) return false;
        item.locked = target;
        return true;
    }

    toggleSingleObjectDisplay(objectId, visible = undefined) {
        const item = this.treeItems.get(objectId);
        if (!item) return false;

        if (item.type === 'curve') {
            const curve = this._curveStore.curves.find(c => c.id === item.curveId);
            if (!curve) return false;
            const current = curve.visible !== false;
            const target = typeof visible === 'boolean' ? visible : !current;
            if (current === target) return false;
            curve.visible = target;
            item.visible = target;
            return true;
        }

        const current = item.visible !== false;
        const target = typeof visible === 'boolean' ? visible : !current;
        if (current === target) return false;
        item.visible = target;
        return true;
    }

    // =========================================================================
    // Transform preview
    // =========================================================================

    applyTransformPreview(payload = {}, sequenceCtx = {}) {
        const action = payload.action;
        const snapshots = payload.snapshots || [];
        const snapshotRefs = payload.snapshotRefs || [];
        const dx = Number(payload.dx || 0);
        const dy = Number(payload.dy || 0);
        const pivot = payload.pivot || null;
        const params = payload.params || null;

        let changed = false;

        if (action === 'drag') {
            for (const snap of snapshotRefs) {
                if (!snap || !snap.ref || !snap.startMatrix) continue;
                snap.ref.transform = new DOMMatrix().translate(dx, dy).multiply(snap.startMatrix);
                if (snap.ref.id) this.invalidateGroupCache(snap.ref.id);
                changed = true;
            }

            for (const snap of snapshots) {
                if (!snap || !snap.node) continue;
                const offX = snap.refTx || 0;
                const offY = snap.refTy || 0;

                snap.node.x = snap.main.x + dx - offX;
                snap.node.y = snap.main.y + dy - offY;

                if (snap.node.control1 && snap.c1) {
                    snap.node.control1.x = snap.c1.x + dx - offX;
                    snap.node.control1.y = snap.c1.y + dy - offY;
                }
                if (snap.node.control2 && snap.c2) {
                    snap.node.control2.x = snap.c2.x + dx - offX;
                    snap.node.control2.y = snap.c2.y + dy - offY;
                }
                changed = true;
            }
            return changed;
        }

        if (!pivot || !params) return false;

        for (const snap of snapshotRefs) {
            if (!snap || !snap.ref || !snap.startMatrix) continue;
            if (snap.ref.type !== 'image') continue;
            const seqOff = Number(snap.seqOff || 0);

            let m = new DOMMatrix();
            if (action === 'rot') m = m.translate(pivot.x, pivot.y).rotate(params.angleDeg).translate(-pivot.x, -pivot.y);
            else m = m.translate(pivot.x, pivot.y).scale(params.sx, params.sy).translate(-pivot.x, -pivot.y);

            const globalStart = new DOMMatrix().translate(seqOff, 0).multiply(snap.startMatrix);
            const globalEnd = m.multiply(globalStart);
            snap.ref.transform = new DOMMatrix().translate(-seqOff, 0).multiply(globalEnd);
            changed = true;
        }

        for (const snap of snapshots) {
            if (!snap || !snap.node) continue;
            const nm = TransformEngine.applyTransformationToPoint(snap.main, snap, action, pivot, params);
            snap.node.x = nm.x;
            snap.node.y = nm.y;

            if (snap.node.control1 && snap.c1) {
                const nc = TransformEngine.applyTransformationToPoint(snap.c1, snap, action, pivot, params);
                snap.node.control1.x = nc.x;
                snap.node.control1.y = nc.y;
            }
            if (snap.node.control2 && snap.c2) {
                const nc = TransformEngine.applyTransformationToPoint(snap.c2, snap, action, pivot, params);
                snap.node.control2.x = nc.x;
                snap.node.control2.y = nc.y;
            }
            changed = true;
        }

        return changed;
    }

    translateTransformPreview(dx = 0, dy = 0, snapshots = [], snapshotRefs = []) {
        if ((dx === 0 && dy === 0) || (!snapshots?.length && !snapshotRefs?.length)) return false;
        let changed = false;

        for (const snap of snapshots) {
            if (!snap || !snap.node) continue;
            snap.node.x += dx;
            snap.node.y += dy;
            if (snap.node.control1) { snap.node.control1.x += dx; snap.node.control1.y += dy; }
            if (snap.node.control2) { snap.node.control2.x += dx; snap.node.control2.y += dy; }
            changed = true;
        }

        for (const snap of snapshotRefs) {
            if (!snap || !snap.ref) continue;
            const base = snap.ref.transform ? new DOMMatrix(snap.ref.transform) : new DOMMatrix();
            snap.ref.transform = new DOMMatrix().translate(dx, dy).multiply(base);
            changed = true;
        }

        return changed;
    }

    // =========================================================================
    // Bounds editing
    // =========================================================================

    _getBoundsSelectionSignature(selectedCurves, selectedRefs) {
        const curveIds = Array.from(selectedCurves)
            .filter(c => c && c.id).map(c => c.id).sort().join('|');
        const refIds = Array.from(selectedRefs)
            .filter(r => r && r.id).map(r => r.id).sort().join('|');
        return `c:${curveIds};r:${refIds}`;
    }

    _createBoundsEditSnapshot(selectedCurves, selectedRefs) {
        const nodeSnapshots = [];
        for (const curve of selectedCurves) {
            if (!curve || curve.visible === false || curve.locked === true) continue;
            let current = curve.startNode;
            while (current) {
                nodeSnapshots.push({
                    node: current, x: current.x, y: current.y,
                    c1x: current.control1 ? current.control1.x : null,
                    c1y: current.control1 ? current.control1.y : null,
                    c2x: current.control2 ? current.control2.x : null,
                    c2y: current.control2 ? current.control2.y : null
                });
                current = current.nextOnCurve;
            }
        }

        const refSnapshots = [];
        for (const ref of selectedRefs) {
            if (!ref || ref.visible === false || ref.locked === true) continue;
            refSnapshots.push({ ref, matrix: ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix() });
        }

        return { nodeSnapshots, refSnapshots };
    }

    _restoreBoundsEditSnapshot(session) {
        if (!session || !session.snapshot) return;
        for (const snap of session.snapshot.nodeSnapshots) {
            if (!snap || !snap.node) continue;
            snap.node.x = snap.x; snap.node.y = snap.y;
            if (snap.node.control1) { snap.node.control1.x = snap.c1x; snap.node.control1.y = snap.c1y; }
            if (snap.node.control2) { snap.node.control2.x = snap.c2x; snap.node.control2.y = snap.c2y; }
        }
        for (const snap of session.snapshot.refSnapshots) {
            if (!snap || !snap.ref) continue;
            snap.ref.transform = new DOMMatrix(snap.matrix);
        }
    }

    _clearBoundsEditSession() {
        this.boundsEditSession = null;
    }

    changeSelectedObjectsBounds(prop, val, bounds, geometryBounds, options, selectionCtx = {}) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) return false;
        if (!bounds) return false;

        const { selectedCurves, selectedRefs, getSeqIdxForGroupId, getSeqOffset } = selectionCtx;

        const useSession = options.useBoundsSession === true;
        const selectionSignature = this._getBoundsSelectionSignature(selectedCurves, selectedRefs);
        if (useSession) {
            if (!this.boundsEditSession || this.boundsEditSession.signature !== selectionSignature) {
                this.boundsEditSession = {
                    signature: selectionSignature, bounds: { ...bounds },
                    geometryBounds: geometryBounds ? { ...geometryBounds } : null,
                    snapshot: this._createBoundsEditSnapshot(selectedCurves, selectedRefs)
                };
            }
            this._restoreBoundsEditSnapshot(this.boundsEditSession);
            bounds = this.boundsEditSession.bounds;
            geometryBounds = this.boundsEditSession.geometryBounds;
        } else {
            this._clearBoundsEditSession();
        }

        const oldW = bounds.maxX - bounds.minX;
        const oldH = bounds.maxY - bounds.minY;
        const geomMinX = geometryBounds ? geometryBounds.minX : bounds.minX;
        const geomMinY = geometryBounds ? geometryBounds.minY : bounds.minY;
        const geomW = geometryBounds ? (geometryBounds.maxX - geometryBounds.minX) : oldW;
        const geomH = geometryBounds ? (geometryBounds.maxY - geometryBounds.minY) : oldH;

        const dx = prop === 'x' ? numericVal - bounds.minX : 0;
        const dy = prop === 'y' ? numericVal - bounds.minY : 0;
        let sx = 1, sy = 1;
        let scaleOriginX = bounds.minX, scaleOriginY = bounds.minY;

        if (prop === 'w') {
            const paddingW = Math.max(0, oldW - geomW);
            const targetGeomW = Math.max(0, numericVal - paddingW);
            sx = geomW !== 0 ? targetGeomW / geomW : 1;
            scaleOriginX = geomMinX;
        } else if (prop === 'h') {
            const paddingH = Math.max(0, oldH - geomH);
            const targetGeomH = Math.max(0, numericVal - paddingH);
            sy = geomH !== 0 ? targetGeomH / geomH : 1;
            scaleOriginY = geomMinY;
        }

        let changed = false;
        const affectedGroups = new Set();
        const affectedRefs = new Set();

        for (let curve of selectedCurves) {
            if (!curve || curve.visible === false || curve.locked === true) continue;
            const seqIdx = getSeqIdxForGroupId(curve.groupId);
            if (seqIdx !== -1 && !selectionCtx.activeSequenceIndices?.has(seqIdx)) continue;
            const seqOff = seqIdx !== -1 ? getSeqOffset(seqIdx) : 0;

            let current = curve.startNode;
            while (current) {
                const gX = current.x + seqOff;
                const gY = current.y;
                const newX = scaleOriginX + (gX - scaleOriginX) * sx + dx - seqOff;
                const newY = scaleOriginY + (gY - scaleOriginY) * sy + dy;
                if (current.x !== newX || current.y !== newY) {
                    current.x = newX; current.y = newY; changed = true;
                }
                if (current.control1) {
                    const gC1x = current.control1.x + seqOff;
                    const c1x = scaleOriginX + (gC1x - scaleOriginX) * sx + dx - seqOff;
                    const c1y = scaleOriginY + (current.control1.y - scaleOriginY) * sy + dy;
                    if (current.control1.x !== c1x || current.control1.y !== c1y) {
                        current.control1.x = c1x; current.control1.y = c1y; changed = true;
                    }
                }
                if (current.control2) {
                    const gC2x = current.control2.x + seqOff;
                    const c2x = scaleOriginX + (gC2x - scaleOriginX) * sx + dx - seqOff;
                    const c2y = scaleOriginY + (current.control2.y - scaleOriginY) * sy + dy;
                    if (current.control2.x !== c2x || current.control2.y !== c2y) {
                        current.control2.x = c2x; current.control2.y = c2y; changed = true;
                    }
                }
                current = current.nextOnCurve;
            }
            if (curve.groupId) affectedGroups.add(curve.groupId);
        }

        for (let ref of selectedRefs) {
            if (!ref || ref.visible === false || ref.locked === true) continue;
            const refRootId = this.getRootGroupId(ref.id);
            const refSeqIdx = getSeqIdxForGroupId(refRootId);
            const refSeqOff = refSeqIdx !== -1 ? getSeqOffset(refSeqIdx) : 0;
            const baseTransform = ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix();

            const worldTransform = new DOMMatrix()
                .translate(scaleOriginX + dx, scaleOriginY + dy)
                .scale(sx, sy)
                .translate(-scaleOriginX, -scaleOriginY);

            const globalStart = new DOMMatrix().translate(refSeqOff, 0).multiply(baseTransform);
            const globalEnd = worldTransform.multiply(globalStart);
            const localEnd = new DOMMatrix().translate(-refSeqOff, 0).multiply(globalEnd);

            const hasDiff = baseTransform.a !== localEnd.a || baseTransform.b !== localEnd.b ||
                baseTransform.c !== localEnd.c || baseTransform.d !== localEnd.d ||
                baseTransform.e !== localEnd.e || baseTransform.f !== localEnd.f;

            if (hasDiff) {
                ref.transform = localEnd;
                changed = true;
                if (ref.id) affectedRefs.add(ref.id);
            }
        }

        if (changed && (prop === 'w' || prop === 'h')) {
            const computeSelectionTransformBounds = () => {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let curve of selectedCurves) {
                    if (!curve || curve.visible === false || curve.locked === true) continue;
                    const seqIdx = getSeqIdxForGroupId(curve.groupId);
                    if (seqIdx !== -1 && !selectionCtx.activeSequenceIndices?.has(seqIdx)) continue;
                    const seqOff = seqIdx !== -1 ? getSeqOffset(seqIdx) : 0;
                    const b = curve.getTransformBounds(null);
                    if (!b) continue;
                    minX = Math.min(minX, b.minX + seqOff); maxX = Math.max(maxX, b.maxX + seqOff);
                    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
                }
                for (let ref of selectedRefs) {
                    if (!ref || ref.visible === false || ref.locked === true) continue;
                    const refRootId = this.getRootGroupId(ref.id);
                    const refSeqIdx = getSeqIdxForGroupId(refRootId);
                    if (refSeqIdx !== -1 && !selectionCtx.activeSequenceIndices?.has(refSeqIdx)) continue;
                    const refSeqOff = refSeqIdx !== -1 ? getSeqOffset(refSeqIdx) : 0;
                    const cdList = this.getCurvesForGroup(ref.id);
                    for (let cd of cdList) {
                        if (!cd || !cd.curve || cd.curve.visible === false || cd.curve.locked === true) continue;
                        const b = cd.curve.getTransformBounds(cd.matrix);
                        if (!b) continue;
                        minX = Math.min(minX, b.minX + refSeqOff); maxX = Math.max(maxX, b.maxX + refSeqOff);
                        minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
                    }
                }
                if (minX === Infinity) return null;
                return { minX, minY, maxX, maxY };
            };

            const updatedBounds = computeSelectionTransformBounds();
            if (updatedBounds) {
                const corrDx = bounds.minX - updatedBounds.minX;
                const corrDy = bounds.minY - updatedBounds.minY;
                if (corrDx !== 0 || corrDy !== 0) {
                    for (let curve of selectedCurves) {
                        if (!curve || curve.visible === false || curve.locked === true) continue;
                        const seqIdx = getSeqIdxForGroupId(curve.groupId);
                        if (seqIdx !== -1 && !selectionCtx.activeSequenceIndices?.has(seqIdx)) continue;
                        const seqOff = seqIdx !== -1 ? getSeqOffset(seqIdx) : 0;
                        let current = curve.startNode;
                        while (current) {
                            current.x += corrDx; current.y += corrDy;
                            if (current.control1) { current.control1.x += corrDx; current.control1.y += corrDy; }
                            if (current.control2) { current.control2.x += corrDx; current.control2.y += corrDy; }
                            current = current.nextOnCurve;
                        }
                        if (curve.groupId) affectedGroups.add(curve.groupId);
                    }
                    for (let ref of selectedRefs) {
                        if (!ref || ref.visible === false || ref.locked === true) continue;
                        const refRootId = this.getRootGroupId(ref.id);
                        const refSeqIdx = getSeqIdxForGroupId(refRootId);
                        const refSeqOff = refSeqIdx !== -1 ? getSeqOffset(refSeqIdx) : 0;
                        const baseTransform = ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix();
                        const worldTransform = new DOMMatrix().translate(corrDx, corrDy);
                        const globalStart = new DOMMatrix().translate(refSeqOff, 0).multiply(baseTransform);
                        const globalEnd = worldTransform.multiply(globalStart);
                        const localEnd = new DOMMatrix().translate(-refSeqOff, 0).multiply(globalEnd);
                        const hasDiff = baseTransform.a !== localEnd.a || baseTransform.b !== localEnd.b ||
                            baseTransform.c !== localEnd.c || baseTransform.d !== localEnd.d ||
                            baseTransform.e !== localEnd.e || baseTransform.f !== localEnd.f;
                        if (hasDiff) { ref.transform = localEnd; if (ref.id) affectedRefs.add(ref.id); }
                    }
                }
            }
        }

        if (changed) {
            for (let gid of affectedGroups) this.invalidateGroupCache(gid);
            for (let rid of affectedRefs) this.invalidateGroupCache(rid);
        }
        if (useSession && options.commitBoundsSession === true) {
            this._clearBoundsEditSession();
        }
        return changed;
    }

    // =========================================================================
    // References / clones / unlink
    // =========================================================================

    pasteGroupRef(sourceGroupId, targetGroupId, transform = null) {
        let parent = this.treeItems.get(targetGroupId);
        if (!parent || parent.type !== 'group' || parent.isRef) {
            return null;
        }

        if (this.isDescendant(sourceGroupId, parent.id)) return null;

        const source = this.treeItems.get(sourceGroupId);
        if (!source) return null;

        const uniqueRefName = this.ensureUniqueName(source.name + "_Ref");

        this.treeItems.set(uniqueRefName, {
            id: uniqueRefName, type: 'group', name: uniqueRefName, charCode: null,
            parentId: parent.id, children: [], isRef: true, refId: source.id, collapsed: false,
            transform: transform ? new DOMMatrix(transform) : new DOMMatrix(),
            advance: 1000
        });
        parent.children.push(uniqueRefName);
        parent.is_modified = true;
        return uniqueRefName;
    }

    _duplicateGroupTree(sourceGroupId, targetParentId, cloneCurveFn) {
        const sourceGroup = this.treeItems.get(sourceGroupId);
        if (!sourceGroup || sourceGroup.type !== 'group' || sourceGroup.isRef) return null;

        const newName = this.ensureUniqueName(sourceGroup.name + "_Copy");
        this.treeItems.set(newName, {
            id: newName, type: 'group', name: newName, charCode: null,
            parentId: targetParentId, children: [], isRef: false, refId: null, collapsed: false,
            advance: sourceGroup.advance !== undefined ? sourceGroup.advance : 1000
        });

        const targetParent = this.treeItems.get(targetParentId);
        if (targetParent && targetParent.type === 'group' && !targetParent.isRef) {
            targetParent.children.push(newName);
        } else {
            this.rootChildren.push(newName);
        }

        for (const childId of [...(sourceGroup.children || [])]) {
            const child = this.treeItems.get(childId);
            if (!child) continue;
            if (child.type === 'curve') {
                const childCurve = this._curveStore.curves.find(c => c.id === child.curveId);
                if (childCurve && cloneCurveFn) cloneCurveFn(childCurve, newName);
            } else if (child.type === 'group') {
                if (child.isRef) {
                    this.pasteGroupRef(child.refId, newName, child.transform);
                } else {
                    this._duplicateGroupTree(child.id, newName, cloneCurveFn);
                }
            }
        }

        return newName;
    }

    duplicateGroupDeep(groupId, targetParentId, cloneCurveFn) {
        const sourceGroup = this.treeItems.get(groupId);
        if (!sourceGroup) return null;

        if (sourceGroup.isRef) {
            const refId = this.pasteGroupRef(sourceGroup.refId, targetParentId, sourceGroup.transform);
            if (!refId) return null;
            return { id: refId, sequenceChanged: false };
        }

        const newName = this._duplicateGroupTree(groupId, targetParentId, cloneCurveFn);
        if (!newName) return null;

        return { id: newName, sequenceChanged: false };
    }

    unlinkReferenceDeep(refId, cloneCurveFn) {
        const refItem = this.treeItems.get(refId);
        if (!refItem || !refItem.isRef) return false;
        const sourceItem = this.treeItems.get(refItem.refId);
        if (!sourceItem) return false;

        const transform = refItem.transform;
        const targetParentId = refItem.parentId;

        const cloneAndTransform = (sourceId, parentId, currentMatrix) => {
            const source = this.treeItems.get(sourceId);
            if (!source) return;

            if (source.type === 'curve') {
                const curve = this._curveStore.curves.find(c => c.id === source.curveId);
                if (!curve || !cloneCurveFn) return;
                const newCurve = cloneCurveFn(curve, parentId);
                if (!newCurve) return;
                let current = newCurve.startNode;
                while (current) {
                    const pt = (x, y) => ({
                        x: x * currentMatrix.a + y * currentMatrix.c + currentMatrix.e,
                        y: x * currentMatrix.b + y * currentMatrix.d + currentMatrix.f
                    });
                    let p = pt(current.x, current.y);
                    current.x = p.x; current.y = p.y;
                    if (current.control1) { let cp = pt(current.control1.x, current.control1.y); current.control1.x = cp.x; current.control1.y = cp.y; }
                    if (current.control2) { let cp = pt(current.control2.x, current.control2.y); current.control2.x = cp.x; current.control2.y = cp.y; }
                    current = current.nextOnCurve;
                }
            } else if (source.type === 'group') {
                if (source.isRef) {
                    let nextMatrix = new DOMMatrix(currentMatrix).multiply(source.transform);
                    this.pasteGroupRef(source.refId, parentId, nextMatrix);
                } else if (source.children) {
                    source.children.forEach(c => cloneAndTransform(c, parentId, currentMatrix));
                }
            }
        };

        if (sourceItem.children) sourceItem.children.forEach(c => cloneAndTransform(c, targetParentId, transform));
        this.deleteTreeItem(refId);
        return true;
    }

    // =========================================================================
    // Image import
    // =========================================================================

    importImageToCurrentGroup(imgObj, fileName, activeGroupId) {
        if (!imgObj) return null;
        const targetGroupId = activeGroupId || null;
        const id = `img_${Date.now()}`;
        const imageData = {
            id, type: 'image', name: this.ensureUniqueName(fileName),
            image: imgObj, transform: new DOMMatrix().translate(0, 0),
            width: imgObj.width, height: imgObj.height,
            parentId: targetGroupId, visible: true, locked: false
        };

        this.treeItems.set(id, imageData);
        if (targetGroupId) {
            const group = this.treeItems.get(targetGroupId);
            if (group) group.children.push(id);
        } else {
            this.rootChildren.push(id);
        }
        return id;
    }

    restoreSessionImages(sessionImages = []) {
        if (!Array.isArray(sessionImages) || sessionImages.length === 0) return false;
        let changed = false;
        for (const raw of sessionImages) {
            if (!raw || !raw.id) continue;
            const img = { ...raw };
            // Preserve the live HTML Image element reference from the existing
            // treeItems entry. History cloning destroys it (structuredClone
            // throws on DOM elements, JSON fallback yields {}), which would
            // cause ctx.drawImage() to throw and freeze the render loop.
            const existing = this.treeItems.get(raw.id);
            if (existing && existing.image && typeof HTMLImageElement !== 'undefined' && existing.image instanceof HTMLImageElement) {
                img.image = existing.image;
            }
            this.treeItems.set(img.id, img);
            const parent = this.treeItems.get(img.parentId);
            if (parent && !parent.children.includes(img.id)) parent.children.push(img.id);
            if (!img.parentId && !this.rootChildren.includes(img.id)) this.rootChildren.push(img.id);
            changed = true;
        }
        return changed;
    }

    // =========================================================================
    // Apply tree child order
    // =========================================================================

    applyTreeChildOrder(groupId, nameOrder) {
        if (!Array.isArray(nameOrder) || nameOrder.length === 0) return;

        let children;
        if (groupId === null || groupId === undefined) {
            children = this.rootChildren;
        } else {
            const group = this.treeItems.get(groupId);
            if (!group || !Array.isArray(group.children)) return;
            children = group.children;
        }

        const ordered = [];
        const used = new Set();

        const matchesName = (item, name) => {
            if (!item || name == null) return false;
            if (item.name === name || item.id === name) return true;
            if (item.type === "curve" && item.curveId === name) return true;
            if (item.type === "group" && item.isRef && (item.refId === name || item.name === name)) return true;
            return false;
        };

        for (const name of nameOrder) {
            for (const cid of children) {
                if (used.has(cid)) continue;
                const item = this.treeItems.get(cid);
                if (matchesName(item, name)) {
                    ordered.push(cid);
                    used.add(cid);
                    break;
                }
            }
        }
        for (const cid of children) {
            if (!used.has(cid)) ordered.push(cid);
        }

        if (groupId === null || groupId === undefined) {
            this.rootChildren = ordered;
        } else {
            this.treeItems.get(groupId).children = ordered;
        }
    }
}
