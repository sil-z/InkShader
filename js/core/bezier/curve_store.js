// js/core/bezier/curve_store.js — Geometry storage: curves, nodes, DOM marker mapping
import { Curve } from './curve.js';
import { CurveNode } from './node.js';
import { generateMarker } from './utils.js';

const CONTROL_MODE_FROM_STR = { "corner": 0, "smooth": 1, "symmetric": 2 };

/**
 * CurveStore: manages curve array, domMap global node index, node/curve CRUD.
 * Scope: geometry data only; does not involve tree/sequence/serialization.
 */
export class CurveStore {
    static _instance = null;
    static _activeResolver = null;

    /** Curve array (raw reference) */
    curves = [];
    /** curveId → Curve index for O(1) lookup */
    curveById = new Map();
    /** Set of curves with smart_stroke enabled */
    smartStrokeCurves = new Set();
    /** marker → CurveNode global index */
    domMap = new Map();

    // =========================================================================
    // Singleton + active instance resolution
    // =========================================================================

    static setActiveResolver(resolver) {
        CurveStore._activeResolver = typeof resolver === 'function' ? resolver : null;
    }

    static resolveActive() {
        return CurveStore._activeResolver?.() ?? CurveStore._instance ?? null;
    }

    static getInstance() {
        if (!CurveStore._instance) {
            CurveStore._instance = new CurveStore();
        }
        return CurveStore._instance;
    }

    // =========================================================================
    // Node lookup
    // =========================================================================

    find_curve_by_dom(main_node) {
        const curve = this.domMap.get(main_node)?.curve ?? null;
        if (!curve) return null;
        return this.curveById.has(curve.id) ? curve : null;
    }

    find_node_by_curve(main_node) {
        return this.domMap.get(main_node) ?? null;
    }

    find_node_by_dom(main_node) {
        const store = CurveStore.resolveActive() ?? this;
        return this.domMap.get(main_node) ?? store.domMap.get(main_node) ?? null;
    }

    // =========================================================================
    // DOM Marker registration/unregistration
    // =========================================================================

    unregisterCurveDomMarkers(curve) {
        if (!curve) return;
        let current = curve.startNode;
        while (current) {
            if (current.main_node) {
                curve.domMap.delete(current.main_node);
                this.domMap.delete(current.main_node);
            }
            if (current.control1?.main_node) {
                curve.domMap.delete(current.control1.main_node);
                this.domMap.delete(current.control1.main_node);
            }
            if (current.control2?.main_node) {
                curve.domMap.delete(current.control2.main_node);
                this.domMap.delete(current.control2.main_node);
            }
            current = current.nextOnCurve;
        }
    }

    _registerNodeDomMarkers(curve, node) {
        if (!curve || !node) return;
        if (node.main_node) {
            curve.domMap.set(node.main_node, node);
            this.domMap.set(node.main_node, node);
        }
        if (node.control1?.main_node) {
            curve.domMap.set(node.control1.main_node, node.control1);
            this.domMap.set(node.control1.main_node, node.control1);
        }
        if (node.control2?.main_node) {
            curve.domMap.set(node.control2.main_node, node.control2);
            this.domMap.set(node.control2.main_node, node.control2);
        }
    }

    // =========================================================================
    // Node operations
    // =========================================================================

    adjustControlNode(marker, x, y) {
        let controlNode = this.find_node_by_curve(marker);
        if (!controlNode) return false;

        controlNode.x = x;
        controlNode.y = y;

        if (controlNode.nextOnCurve && typeof controlNode.nextOnCurve.set_both_control === 'function') {
            let mainNode = controlNode.nextOnCurve;
            mainNode.set_both_control(marker, mainNode.control_mode);
        }

        if (controlNode.curve) controlNode.curve._invalidateBounds();
        return true;
    }

    deleteControlNode(marker) {
        let controlNode = this.find_node_by_curve(marker);
        if (!controlNode || controlNode.type !== null) return false;

        let mainNode = controlNode.nextOnCurve;
        if (!mainNode || mainNode.type === null) return false;

        let curve = mainNode.curve;
        if (!curve) return false;

        if (mainNode.control1?.main_node === marker) {
            mainNode.control1 = null;
        } else if (mainNode.control2?.main_node === marker) {
            mainNode.control2 = null;
        } else {
            return false;
        }

        curve.domMap.delete(marker);
        this.domMap.delete(marker);

        if (!mainNode.control1 && !mainNode.control2) {
            mainNode.control_mode = 0;
        } else {
            mainNode.control_mode = 1;
        }

        if (curve) curve._invalidateBounds();
        return true;
    }

    moveSingleNode(marker, x, y, control1 = null, control2 = null) {
        let node = this.find_node_by_curve(marker);
        if (!node || node.type === null) return false;

        let dx = x - node.x;
        let dy = y - node.y;
        node.x = x;
        node.y = y;

        if (control1 && node.control1) {
            node.control1.x = control1.x;
            node.control1.y = control1.y;
        } else if (node.control1) {
            node.control1.x += dx;
            node.control1.y += dy;
        }

        if (control2 && node.control2) {
            node.control2.x = control2.x;
            node.control2.y = control2.y;
        } else if (node.control2) {
            node.control2.x += dx;
            node.control2.y += dy;
        }

        if (node.curve) node.curve._invalidateBounds();
        return true;
    }

    moveSelectedNodes(updates) {
        if (!updates || updates.length === 0) return false;

        let changed = false;
        let affectedGroups = new Set();

        for (const update of updates) {
            let node = this.find_node_by_curve(update.marker);
            if (!node || node.type === null) continue;

            let dx = update.x - node.x;
            let dy = update.y - node.y;
            node.x = update.x;
            node.y = update.y;

            if (update.control1 && node.control1) {
                node.control1.x = update.control1.x;
                node.control1.y = update.control1.y;
            } else if (node.control1) {
                node.control1.x += dx;
                node.control1.y += dy;
            }

            if (update.control2 && node.control2) {
                node.control2.x = update.control2.x;
                node.control2.y = update.control2.y;
            } else if (node.control2) {
                node.control2.x += dx;
                node.control2.y += dy;
            }

            changed = true;
            if (node.curve && node.curve.groupId) {
                affectedGroups.add(node.curve.groupId);
                node.curve._invalidateBounds();
            }
        }

        return { changed, affectedGroups };
    }

    changeSmoothModeOnSingleNode(marker, mode, forceCreateHandles = false) {
        let node = this.find_node_by_curve(marker);
        if (!node || node.type === null) return false;
        if (node.control_mode === mode && !forceCreateHandles) return false;

        node.applyMode(mode, this);
        if (forceCreateHandles) {
            if (!node.control1) {
                let c1M = generateMarker("circle");
                let c1Node = new CurveNode(c1M, null, node.x, node.y, node, null, String(c1M.id));
                c1Node.curve = node.curve;
                node.control1 = c1Node;
                this.domMap.set(c1M, c1Node);
                if (node.curve) node.curve.domMap.set(c1M, c1Node);
            }
            if (!node.control2) {
                let c2M = generateMarker("circle");
                let c2Node = new CurveNode(c2M, null, node.x, node.y, node, null, String(c2M.id));
                c2Node.curve = node.curve;
                node.control2 = c2Node;
                this.domMap.set(c2M, c2Node);
                if (node.curve) node.curve.domMap.set(c2M, c2Node);
            }
        }
        node.control_mode = mode;
        if (node.curve) node.curve._invalidateBounds();
        return true;
    }

    deleteSingleNode(marker) {
        let node = this.find_node_by_curve(marker);
        if (!node || !node.curve) return false;

        let curve = node.curve;
        let prevNode = node.lastOnCurve;
        let nextNode = node.nextOnCurve;

        // Closed curve: wrap around to the opposite end — for closed curves
        // startNode.lastOnCurve is null and endNode.nextOnCurve is null, so
        // without wrapping one adjacent node misses its symmetric→smooth
        // degradation when deleting startNode or endNode.
        if (curve.closed) {
            if (!prevNode && node === curve.startNode) prevNode = curve.endNode;
            if (!nextNode && node === curve.endNode) nextNode = curve.startNode;
        }

        if (prevNode && prevNode.control_mode === 2) prevNode.control_mode = 1;
        if (nextNode && nextNode.control_mode === 2) nextNode.control_mode = 1;

        curve.remove_node_by_dom(marker);

        this.domMap.delete(marker);
        if (node.control1) this.domMap.delete(node.control1.main_node);
        if (node.control2) this.domMap.delete(node.control2.main_node);

        curve._invalidateBounds();
        return { curve, isEmpty: !curve.startNode };
    }

    updateNodeProperty(marker, propId, numVal) {
        let node = this.find_node_by_curve(marker);
        if (!node) return false;

        if (propId === 'prop_x') {
            let dx = numVal - node.x; node.x = numVal;
            if (node.control1) node.control1.x += dx;
            if (node.control2) node.control2.x += dx;
        }
        else if (propId === 'prop_y') {
            let dy = numVal - node.y; node.y = numVal;
            if (node.control1) node.control1.y += dy;
            if (node.control2) node.control2.y += dy;
        }
        else if (node.control1 && propId.startsWith('prop_in_')) {
            if (propId === 'prop_in_x') node.control1.x = numVal;
            if (propId === 'prop_in_y') node.control1.y = numVal;
            if (propId === 'prop_in_a') {
                const dist = Math.hypot(node.control1.x - node.x, node.control1.y - node.y);
                node.control1.x = node.x + dist * Math.cos(numVal * Math.PI / 180);
                node.control1.y = node.y + dist * Math.sin(numVal * Math.PI / 180);
            }
            if (propId.includes('in_')) node.set_both_control(node.control1.main_node, node.control_mode);
        }
        else if (node.control2 && propId.startsWith('prop_out_')) {
            if (propId === 'prop_out_x') node.control2.x = numVal;
            if (propId === 'prop_out_y') node.control2.y = numVal;
            if (propId === 'prop_out_a') {
                const dist = Math.hypot(node.control2.x - node.x, node.control2.y - node.y);
                node.control2.x = node.x + dist * Math.cos(numVal * Math.PI / 180);
                node.control2.y = node.y + dist * Math.sin(numVal * Math.PI / 180);
            }
            if (propId.includes('out_')) node.set_both_control(node.control2.main_node, node.control_mode);
        }

        let curve = this.find_curve_by_dom(marker);
        if (curve) curve._invalidateBounds();
        return { curve };
    }

    // =========================================================================
    // Curve CRUD
    // =========================================================================

    createCurve(id) {
        return new Curve({ id });
    }

    add_node_by_curve(main_node, type, x, y, nextOnCurve, lastOnCurve, this_curve, node_id) {
        let next_node = nextOnCurve !== null ? this_curve.find_node_by_dom(nextOnCurve) : null;
        let last_node = lastOnCurve !== null ? this_curve.find_node_by_dom(lastOnCurve) : null;
        const node = this_curve.add_node(main_node, type, x, y, next_node, last_node, node_id);
        if (node) {
            this.domMap.set(main_node, node);
            this_curve._invalidateBounds();
        }
        return node;
    }

    commit_curve(curve, parentId) {
        this.curves.push(curve);
        this.curveById.set(curve.id, curve);
        if (curve.smart_stroke) this.smartStrokeCurves.add(curve);
    }

    remove_curve(id) {
        const curve = this.curveById.get(id);
        if (curve) {
            this.curveById.delete(id);
            this.smartStrokeCurves.delete(curve);
            const index = this.curves.indexOf(curve);
            if (index !== -1) this.curves.splice(index, 1);
            return true;
        }
        return false;
    }

    rollbackLastPathNode(curve) {
        if (!curve || !curve.endNode) return false;
        let node = curve.endNode;
        if (node.type === null) return false;

        const prev = node.lastOnCurve;

        if (node.control1?.main_node) {
            curve.domMap.delete(node.control1.main_node);
            this.domMap.delete(node.control1.main_node);
        }
        if (node.control2?.main_node) {
            curve.domMap.delete(node.control2.main_node);
            this.domMap.delete(node.control2.main_node);
        }
        if (node.main_node) {
            curve.domMap.delete(node.main_node);
            this.domMap.delete(node.main_node);
        }

        if (prev) {
            prev.nextOnCurve = null;
            curve.endNode = prev;
        } else {
            curve.startNode = null;
            curve.endNode = null;
        }

        curve._invalidateBounds();
        return true;
    }

    get_curves() {
        return this.curves;
    }

    // =========================================================================
    // Snapshot deserialization helper (rebuild nodes from JSON)
    // =========================================================================

    /** Update smartStrokeCurves set when a curve's smart_stroke property changes */
    updateSmartStrokeStatus(curve) {
        if (curve.smart_stroke) {
            this.smartStrokeCurves.add(curve);
        } else {
            this.smartStrokeCurves.delete(curve);
        }
    }

    reconstructCurveFromSnapshotData(curveId, pData, groupId) {
        const curve = new Curve({ id: curveId });
        curve.closed = pData.closed;
        curve.stroke_width = pData.stroke_width;
        curve.smart_stroke = pData.smart_stroke !== undefined ? pData.smart_stroke : true;
        curve.smart_stroke_clockwise = pData.smart_stroke_clockwise !== undefined ? pData.smart_stroke_clockwise : false;
        curve.show_skeleton = pData.show_skeleton !== undefined ? pData.show_skeleton : true;
        curve.visible = pData.visible !== undefined ? pData.visible : true;
        curve.locked = pData.locked !== undefined ? pData.locked : false;
        curve.groupId = groupId;

        const vertices = pData.vertices || [];
        let lastCreatedNode = null;

        for (let idx = 0; idx < vertices.length; idx++) {
            const vData = vertices[idx];
            const marker = generateMarker("vertex");
            const nId = `n_${marker.id}`;
            const node = new CurveNode(marker, "vertex", vData.x, vData.y, null, lastCreatedNode, nId);
            node.curve = curve;
            const rawMode = vData.control_mode;
            node.control_mode = typeof rawMode === "string"
                ? CONTROL_MODE_FROM_STR[rawMode] ?? 0
                : rawMode !== undefined ? rawMode : 0;

            if (vData.control_1) {
                const m1 = generateMarker("circle");
                node.control1 = new CurveNode(m1, null, vData.control_1.x, vData.control_1.y, node, null, m1.id);
                node.control1.curve = curve;
            }
            if (vData.control_2) {
                const m2 = generateMarker("circle");
                node.control2 = new CurveNode(m2, null, vData.control_2.x, vData.control_2.y, node, null, m2.id);
                node.control2.curve = curve;
            }

            if (!curve.startNode) curve.startNode = node;
            if (lastCreatedNode) lastCreatedNode.nextOnCurve = node;

            this._registerNodeDomMarkers(curve, node);
            lastCreatedNode = node;
            if (idx === 0) { /* start is already set above */ }
        }
        // Last node in the array is the endNode
        if (lastCreatedNode) curve.endNode = lastCreatedNode;

        this.curves.push(curve);
        this.curveById.set(curve.id, curve);
        if (curve.smart_stroke) this.smartStrokeCurves.add(curve);
        return curve;
    }
}
