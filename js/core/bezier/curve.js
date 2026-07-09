// js/core/bezier/curve.js — Domain geometry (no Canvas / no theme)
import { generateMarker } from './utils.js';
import { CurveNode } from './node.js';
import { CurveStore } from './curve_store.js';
import { refreshCurveBooleanCache } from '../boolean_geometry_cache.js';

export class Curve {
    startNode = null; endNode = null; 
    id; closed = true; 
    stroke_width = 0; 
    smart_stroke = true;  
    smart_stroke_clockwise = false;
    show_skeleton = true; 
    visible = true; 
    locked = false; 
    groupId = null; 
    domMap = new Map();

    constructor({ id }) { this.id = id; }

    _isEffectivelyClosed() {
        return !!(this.closed && this.startNode && this.endNode && this.startNode !== this.endNode);
    }

    invalidateBooleanCache() {
        this._lastHash = null;
    }

    getBounds(matrix = null, options = {}) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (!this.startNode) return null;

        const pt = (x, y) => {
            if (!matrix) return { x, y };
            return { x: x * matrix.a + y * matrix.c + matrix.e, y: x * matrix.b + y * matrix.d + matrix.f };
        };

        let current = this.startNode;
        while(current && current.nextOnCurve && (current !== this.endNode || !this.closed)) {
            let next = current.nextOnCurve;
            let p0 = pt(current.x, current.y);
            let p1 = current.control1 ? pt(current.control1.x, current.control1.y) : p0;
            let p2 = next.control2 ? pt(next.control2.x, next.control2.y) : pt(next.x, next.y);
            let p3 = pt(next.x, next.y);

            let bounds = this.getSegmentBounds(p0, p1, p2, p3);
            minX = Math.min(minX, bounds.minX); minY = Math.min(minY, bounds.minY);
            maxX = Math.max(maxX, bounds.maxX); maxY = Math.max(maxY, bounds.maxY);
            current = next;
        }

        if(this.closed && this.startNode !== this.endNode && this.endNode && this.startNode) {
            let p0 = pt(this.endNode.x, this.endNode.y);
            let p1 = this.endNode.control1 ? pt(this.endNode.control1.x, this.endNode.control1.y) : p0;
            let p2 = this.startNode.control2 ? pt(this.startNode.control2.x, this.startNode.control2.y) : pt(this.startNode.x, this.startNode.y);
            let p3 = pt(this.startNode.x, this.startNode.y);
            let bounds = this.getSegmentBounds(p0, p1, p2, p3);
            minX = Math.min(minX, bounds.minX); minY = Math.min(minY, bounds.minY);
            maxX = Math.max(maxX, bounds.maxX); maxY = Math.max(maxY, bounds.maxY);
        }
        
        if (minX === Infinity) return null;

        const strokeMode = options.strokeMode || 'legacy';
        const includeStroke =
            strokeMode === 'none'
                ? false
                : strokeMode === 'transform'
                    ? (this.smart_stroke === true && this.stroke_width > 0)
                    : (this.stroke_width > 0);

        let expandD = includeStroke ? this.stroke_width / 2 : 0;
        if (matrix && expandD > 0) { let scaleAvg = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b); expandD *= scaleAvg; }
        return { minX: minX - expandD, minY: minY - expandD, maxX: maxX + expandD, maxY: maxY + expandD };
    }

    // Bounds used by transform/property panel:
    // only smart_stroke paths include stroke width in W/H; normal stroke is visual-only, not part of geometry scale bounds.
    getTransformBounds(matrix = null) {
        return this.getBounds(matrix, { strokeMode: 'transform' });
    }

    getGeometryBounds(matrix = null) {
        return this.getBounds(matrix, { strokeMode: 'none' });
    }

    getSegmentBounds(p0, p1, p2, p3) {
        let minX = Math.min(p0.x, p3.x), maxX = Math.max(p0.x, p3.x);
        let minY = Math.min(p0.y, p3.y), maxY = Math.max(p0.y, p3.y);
        const getRoots = (p0, p1, p2, p3) => {
            let a = 3 * (-p0 + 3*p1 - 3*p2 + p3); let b = 6 * (p0 - 2*p1 + p2); let c = 3 * (p1 - p0);
            let roots = [];
            if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) roots.push(-c / b); } 
            else {
                let det = b*b - 4*a*c;
                if (det >= 0) { roots.push((-b + Math.sqrt(det)) / (2*a)); roots.push((-b - Math.sqrt(det)) / (2*a)); }
            }
            return roots.filter(t => t > 0 && t < 1);
        };
        let rootsX = getRoots(p0.x, p1.x, p2.x, p3.x); let rootsY = getRoots(p0.y, p1.y, p2.y, p3.y);
        const evalBezier = (t, p0, p1, p2, p3) => { let mt = 1-t; return mt*mt*mt*p0 + 3*mt*mt*t*p1 + 3*mt*t*t*p2 + t*t*t*p3; };
        for(let t of rootsX) { let x = evalBezier(t, p0.x, p1.x, p2.x, p3.x); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
        for(let t of rootsY) { let y = evalBezier(t, p0.y, p1.y, p2.y, p3.y); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        return {minX, minY, maxX, maxY};
    }

    _ownerManager() {
        return CurveStore.resolveActive() ?? CurveStore.getInstance();
    }

    destroy() {
        let manager = this._ownerManager();
        let current = this.startNode;
        while(current) {
            if (current.main_node) manager.domMap.delete(current.main_node);
            if (current.control1?.main_node) manager.domMap.delete(current.control1.main_node);
            if (current.control2?.main_node) manager.domMap.delete(current.control2.main_node);
            current = current.nextOnCurve;
        }
        manager.remove_curve(this.id);
    }

    add_node(main_node, type, x, y, nextOnCurve, lastOnCurve, node_id) {
        if(type === null) { 
            if(nextOnCurve === null) return null;
            const node = new CurveNode(main_node, type, x, y, nextOnCurve, null, node_id);
            node.curve = this; 
            if(nextOnCurve.control1 === null) nextOnCurve.control1 = node; else nextOnCurve.control2 = node;
            this.domMap.set(node.main_node, node); return node;
        } else {
            let last = lastOnCurve; let end_flag = false;
            if (!last && this.startNode) { end_flag = true; last = this.endNode; }
            if(lastOnCurve?.nextOnCurve === null) end_flag = true;
            const node = new CurveNode(main_node, type, x, y, null, last, node_id);
            node.curve = this; 
            if (last) { 
                node.nextOnCurve = last.nextOnCurve; last.nextOnCurve = node;
                if (node.nextOnCurve) node.nextOnCurve.lastOnCurve = node;
            } else { this.startNode = node; }
            this.domMap.set(node.main_node, node);
            if(end_flag) this.endNode = node;
            return node;
        }
    }

    insertNodeAt(startNode, t, manager) {
        let isClosingSegment = false;
        let nextNode = startNode.nextOnCurve;
        
        if (!nextNode && this.closed && this.endNode === startNode) { nextNode = this.startNode; isClosingSegment = true; }
        if (!nextNode) return null;

        let p0 = { x: startNode.x, y: startNode.y };
        let p1 = startNode.control1 ? { x: startNode.control1.x, y: startNode.control1.y } : p0;
        let p2 = nextNode.control2 ? { x: nextNode.control2.x, y: nextNode.control2.y } : { x: nextNode.x, y: nextNode.y };
        let p3 = { x: nextNode.x, y: nextNode.y };

        let mt = 1 - t;
        let p01 = { x: mt * p0.x + t * p1.x, y: mt * p0.y + t * p1.y };
        let p12 = { x: mt * p1.x + t * p2.x, y: mt * p1.y + t * p2.y };
        let p23 = { x: mt * p2.x + t * p3.x, y: mt * p2.y + t * p3.y };
        let p012 = { x: mt * p01.x + t * p12.x, y: mt * p01.y + t * p12.y };
        let p123 = { x: mt * p12.x + t * p23.x, y: mt * p12.y + t * p23.y };
        let p0123 = { x: mt * p012.x + t * p123.x, y: mt * p012.y + t * p123.y };

        let newMainMarker = generateMarker("vertex");
        let newMain = new CurveNode(newMainMarker, "vertex", p0123.x, p0123.y, isClosingSegment ? null : nextNode, startNode, newMainMarker.id);
        newMain.curve = this; newMain.control_mode = 1; 
        
        if (isClosingSegment) { startNode.nextOnCurve = newMain; this.endNode = newMain; } 
        else { startNode.nextOnCurve = newMain; nextNode.lastOnCurve = newMain; }

        this.domMap.set(newMainMarker, newMain); manager.domMap.set(newMainMarker, newMain);

        let c2Marker = generateMarker("circle");
        let c2 = new CurveNode(c2Marker, null, p012.x, p012.y, newMain, null, c2Marker.id);
        c2.curve = this; newMain.control2 = c2; 
        this.domMap.set(c2Marker, c2); manager.domMap.set(c2Marker, c2);

        let c1Marker = generateMarker("circle");
        let c1 = new CurveNode(c1Marker, null, p123.x, p123.y, newMain, null, c1Marker.id);
        c1.curve = this; newMain.control1 = c1; 
        this.domMap.set(c1Marker, c1); manager.domMap.set(c1Marker, c1);

        if (startNode.control1) { startNode.control1.x = p01.x; startNode.control1.y = p01.y; } 
        else {
            let sc1Marker = generateMarker("circle");
            let sc1 = new CurveNode(sc1Marker, null, p01.x, p01.y, startNode, null, sc1Marker.id);
            sc1.curve = this; startNode.control1 = sc1; 
            this.domMap.set(sc1Marker, sc1); manager.domMap.set(sc1Marker, sc1);
        }

        if (nextNode.control2) { nextNode.control2.x = p23.x; nextNode.control2.y = p23.y; } 
        else {
            let nc2Marker = generateMarker("circle");
            let nc2 = new CurveNode(nc2Marker, null, p23.x, p23.y, nextNode, null, nc2Marker.id);
            nc2.curve = this; nextNode.control2 = nc2; 
            this.domMap.set(nc2Marker, nc2); manager.domMap.set(nc2Marker, nc2);
        }
        return newMainMarker;
    }

    find_node_by_dom(main_node) { return this.domMap.get(main_node) ?? null; }

    remove_node_by_dom(main_node) {
        const manager = this._ownerManager();
        const nodeToRemove = this.domMap.get(main_node) || manager.domMap.get(main_node);
        if (!nodeToRemove || nodeToRemove.type === null) return false;

        const prev = nodeToRemove.lastOnCurve;
        const next = nodeToRemove.nextOnCurve;

        let logicalPrev = prev;
        let logicalNext = next;
        
        if (this.closed) {
            if (!logicalPrev && nodeToRemove === this.startNode) logicalPrev = this.endNode;
            if (!logicalNext && nodeToRemove === this.endNode) logicalNext = this.startNode;
        }
        
        if (logicalPrev === nodeToRemove) logicalPrev = null;
        if (logicalNext === nodeToRemove) logicalNext = null;

        if (logicalPrev && logicalNext && logicalPrev !== logicalNext) {
            let d1 = 0, d2 = 0;
            if (nodeToRemove.control2) d1 = Math.hypot(nodeToRemove.x - nodeToRemove.control2.x, nodeToRemove.y - nodeToRemove.control2.y);
            if (nodeToRemove.control1) d2 = Math.hypot(nodeToRemove.control1.x - nodeToRemove.x, nodeToRemove.control1.y - nodeToRemove.y);
            
            let t = 0.5;
            if (d1 + d2 > 1e-5) t = d1 / (d1 + d2); 
            else {
                let chord1 = Math.hypot(nodeToRemove.x - logicalPrev.x, nodeToRemove.y - logicalPrev.y);
                let chord2 = Math.hypot(logicalNext.x - nodeToRemove.x, logicalNext.y - nodeToRemove.y);
                if (chord1 + chord2 > 1e-5) t = chord1 / (chord1 + chord2);
            }
            t = Math.max(0.01, Math.min(0.99, t)); 

            let dx1 = nodeToRemove.x - logicalPrev.x, dy1 = nodeToRemove.y - logicalPrev.y;
            let dx2 = logicalNext.x - nodeToRemove.x, dy2 = logicalNext.y - nodeToRemove.y;
            let l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);

            let mt = 1 - t;
            let b1 = 3 * mt * mt * t; let b2 = 3 * mt * t * t;
            let b0_plus_b1 = mt * mt * (1 + 2 * t); let b2_plus_b3 = t * t * (3 - 2 * t);

            let ex = nodeToRemove.x - b0_plus_b1 * logicalPrev.x - b2_plus_b3 * logicalNext.x;
            let ey = nodeToRemove.y - b0_plus_b1 * logicalPrev.y - b2_plus_b3 * logicalNext.y;

            let originalLen1 = logicalPrev.control1 ? Math.hypot(logicalPrev.control1.x - logicalPrev.x, logicalPrev.control1.y - logicalPrev.y) : 0;
            let originalLen2 = logicalNext.control2 ? Math.hypot(logicalNext.control2.x - logicalNext.x, logicalNext.control2.y - logicalNext.y) : 0;

            let v1x = logicalPrev.control1 ? logicalPrev.control1.x - logicalPrev.x : dx1;
            let v1y = logicalPrev.control1 ? logicalPrev.control1.y - logicalPrev.y : dy1;
            let len1 = Math.hypot(v1x, v1y);
            if (len1 > 1e-5) { v1x /= len1; v1y /= len1; } else { v1x = dx1 / l1; v1y = dy1 / l1; }

            let v2x = logicalNext.control2 ? logicalNext.control2.x - logicalNext.x : -dx2;
            let v2y = logicalNext.control2 ? logicalNext.control2.y - logicalNext.y : -dy2;
            let len2 = Math.hypot(v2x, v2y);
            if (len2 > 1e-5) { v2x /= len2; v2y /= len2; } else { v2x = -dx2 / l2; v2y = -dy2 / l2; }

            let a1x = b1 * v1x, a1y = b1 * v1y;
            let a2x = b2 * v2x, a2y = b2 * v2y;
            let det = a1x * a2y - a1y * a2x;

            let handleLen1 = 0, handleLen2 = 0;
            if (Math.abs(det) > 1e-5) {
                handleLen1 = (ex * a2y - ey * a2x) / det;
                handleLen2 = (a1x * ey - a1y * ex) / det;
            }

            let maxDist = l1 + l2;
            if (Math.abs(det) <= 1e-5 || handleLen1 <= 0 || handleLen2 <= 0 || isNaN(handleLen1) || isNaN(handleLen2) || handleLen1 > maxDist * 5 || handleLen2 > maxDist * 5) {
                handleLen1 = logicalPrev.control1 ? originalLen1 / t : l1 * 0.33;
                handleLen2 = logicalNext.control2 ? originalLen2 / mt : l2 * 0.33;
            }

            if (handleLen1 > 1e-3) {
                if (!logicalPrev.control1) {
                    let mId = `c1_${Date.now().toString(36)}_${Math.floor(Math.random()*1000)}`;
                    let marker = { id: mId, type: "circle" };
                    logicalPrev.control1 = new CurveNode(marker, null, logicalPrev.x, logicalPrev.y, logicalPrev, null, mId);
                    logicalPrev.control1.curve = this;
                    this.domMap.set(marker, logicalPrev.control1); manager.domMap.set(marker, logicalPrev.control1);
                }
                logicalPrev.control1.x = logicalPrev.x + handleLen1 * v1x;
                logicalPrev.control1.y = logicalPrev.y + handleLen1 * v1y;
                if (logicalPrev.control_mode === 1 || logicalPrev.control_mode === 2) logicalPrev.set_both_control(logicalPrev.control1.main_node, logicalPrev.control_mode);
            } else if (logicalPrev.control1) {
                logicalPrev.control1.x = logicalPrev.x; logicalPrev.control1.y = logicalPrev.y;
            }

            if (handleLen2 > 1e-3) {
                if (!logicalNext.control2) {
                    let mId = `c2_${Date.now().toString(36)}_${Math.floor(Math.random()*1000)}`;
                    let marker = { id: mId, type: "circle" };
                    logicalNext.control2 = new CurveNode(marker, null, logicalNext.x, logicalNext.y, logicalNext, null, mId);
                    logicalNext.control2.curve = this;
                    this.domMap.set(marker, logicalNext.control2); manager.domMap.set(marker, logicalNext.control2);
                }
                logicalNext.control2.x = logicalNext.x + handleLen2 * v2x;
                logicalNext.control2.y = logicalNext.y + handleLen2 * v2y;
                if (logicalNext.control_mode === 1 || logicalNext.control_mode === 2) logicalNext.set_both_control(logicalNext.control2.main_node, logicalNext.control_mode);
            } else if (logicalNext.control2) {
                logicalNext.control2.x = logicalNext.x; logicalNext.control2.y = logicalNext.y;
            }
        }

        if (nodeToRemove.main_node) { this.domMap.delete(nodeToRemove.main_node); manager.domMap.delete(nodeToRemove.main_node); }
        if (nodeToRemove.control1?.main_node) { this.domMap.delete(nodeToRemove.control1.main_node); manager.domMap.delete(nodeToRemove.control1.main_node); }
        if (nodeToRemove.control2?.main_node) { this.domMap.delete(nodeToRemove.control2.main_node); manager.domMap.delete(nodeToRemove.control2.main_node); }

        if (prev) { prev.nextOnCurve = next; }
        if (next) { next.lastOnCurve = prev; }
        if (nodeToRemove === this.startNode) { this.startNode = next; }
        if (nodeToRemove === this.endNode) { this.endNode = prev; }

        if (this.startNode === null) manager.remove_curve(this.id);
        else if (this.groupId) manager.invalidateGroupCache(this.groupId);
        else manager.notifyModelUpdate();
        
        return this;
    }

    /** Skeleton Bezier segments (model coordinates, rendered by presentation layer after transform) */
    getSkeletonBezierSegments() {
        if (!this.startNode) return [];
        const segments = [];
        const pushSeg = (a, b) => {
            segments.push({
                p0: { x: a.x, y: a.y },
                p1: { x: a.control1?.x ?? a.x, y: a.control1?.y ?? a.y },
                p2: { x: b.control2?.x ?? b.x, y: b.control2?.y ?? b.y },
                p3: { x: b.x, y: b.y }
            });
        };
        let current = this.startNode;
        while (current && current.nextOnCurve && (current !== this.endNode || !this.closed)) {
            pushSeg(current, current.nextOnCurve);
            current = current.nextOnCurve;
        }
        if (this.closed && this.startNode !== this.endNode && this.endNode && this.startNode) {
            pushSeg(this.endNode, this.startNode);
        }
        return segments;
    }

    /**
     * Smart stroke expanded outline (offset Bezier list in model coordinates)
     * @param {number} halfWidth half-width (model units; rendered using stroke_width * scale / 2)
     */
    computeExpandedStrokeOutline(halfWidth) {
        const absD = halfWidth;
        let segments = [];

        let current = this.startNode;
        while (current && current.nextOnCurve && (current !== this.endNode || !this.closed)) {
            const next = current.nextOnCurve;
            segments.push({
                p0: { x: current.x, y: current.y },
                p1: { x: current.control1?.x ?? current.x, y: current.control1?.y ?? current.y },
                p2: { x: next.control2?.x ?? next.x, y: next.control2?.y ?? next.y },
                p3: { x: next.x, y: next.y }
            });
            current = next;
        }
        if (this.closed && this.startNode !== this.endNode && this.endNode && this.startNode) {
            segments.push({
                p0: { x: this.endNode.x, y: this.endNode.y },
                p1: { x: this.endNode.control1?.x ?? this.endNode.x, y: this.endNode.control1?.y ?? this.endNode.y },
                p2: { x: this.startNode.control2?.x ?? this.startNode.x, y: this.startNode.control2?.y ?? this.startNode.y },
                p3: { x: this.startNode.x, y: this.startNode.y }
            });
        }

        if (segments.length === 0) return null;

        const generateOffsetPaths = (d, options = {}) => {
            const config = {
                baseErrorTolerance: options.baseErrorTolerance ?? 0.05, 
                sharpBendThreshold: options.sharpBendThreshold ?? -0.85,
                swallowtailGiveUpRatio: options.swallowtailGiveUpRatio ?? 0.7,
                maxSubdivisionDepth: options.maxSubdivisionDepth ?? 5
            };

            const getInflectionPoints = (p0, p1, p2, p3) => {
                let ax = p3.x - 3*p2.x + 3*p1.x - p0.x; let ay = p3.y - 3*p2.y + 3*p1.y - p0.y;
                let bx = 3*p2.x - 6*p1.x + 3*p0.x; let by = 3*p2.y - 6*p1.y + 3*p0.y;
                let cx = 3*p1.x - 3*p0.x; let cy = 3*p1.y - 3*p0.y;

                let v1 = ax * by - ay * bx; let v2 = cx * ay - cy * ax; let v3 = cx * by - cy * bx; 
                let A = -3 * v1; let B = 3 * v2; let C = v3;

                let roots = [];
                if (Math.abs(A) < 1e-7) {
                    if (Math.abs(B) > 1e-7) {
                        let t = -C / B;
                        if (t > 0.05 && t < 0.95) roots.push(t); 
                    }
                } else {
                    let det = B * B - 4 * A * C;
                    if (det >= 0) {
                        let sqrtDet = Math.sqrt(det);
                        let t1 = (-B + sqrtDet) / (2 * A); let t2 = (-B - sqrtDet) / (2 * A);
                        if (t1 > 0.05 && t1 < 0.95) roots.push(t1);
                        if (t2 > 0.05 && t2 < 0.95) roots.push(t2);
                    }
                }
                return roots.sort((a, b) => a - b);
            };

            let offsetSegments = [];
            
            const evalBezier = (t, p0, p1, p2, p3) => {
                let mt = 1 - t;
                return {
                    x: mt*mt*mt*p0.x + 3*mt*mt*t*p1.x + 3*mt*t*t*p2.x + t*t*t*p3.x,
                    y: mt*mt*mt*p0.y + 3*mt*mt*t*p1.y + 3*mt*t*t*p2.y + t*t*t*p3.y
                };
            };

            const getDerivative = (t, p0, p1, p2, p3) => {
                let mt = 1 - t;
                return {
                    x: 3*mt*mt*(p1.x - p0.x) + 6*mt*t*(p2.x - p1.x) + 3*t*t*(p3.x - p2.x),
                    y: 3*mt*mt*(p1.y - p0.y) + 6*mt*t*(p2.y - p1.y) + 3*t*t*(p3.y - p2.y)
                };
            };

            const getSecondDerivative = (t, p0, p1, p2, p3) => {
                let mt = 1 - t;
                return {
                    x: 6*mt*(p2.x - 2*p1.x + p0.x) + 6*t*(p3.x - 2*p2.x + p1.x),
                    y: 6*mt*(p2.y - 2*p1.y + p0.y) + 6*t*(p3.y - 2*p2.y + p1.y)
                };
            };

            const getNormal = (t, p0, p1, p2, p3) => {
                let d1 = getDerivative(t, p0, p1, p2, p3);
                let len = Math.hypot(d1.x, d1.y);
                if (len < 1e-5) return null;
                return { x: -d1.y / len, y: d1.x / len };
            };

            const getCurvature = (t, p0, p1, p2, p3) => {
                let d1 = getDerivative(t, p0, p1, p2, p3);
                let d2 = getSecondDerivative(t, p0, p1, p2, p3);
                let denominator = Math.pow(d1.x*d1.x + d1.y*d1.y, 1.5);
                if (denominator < 1e-7) return 0; 
                return (d1.x * d2.y - d1.y * d2.x) / denominator;
            };

            const trueOffsetPoint = (t, p0, p1, p2, p3, dist) => {
                const n = getNormal(t, p0, p1, p2, p3);
                if (!n) return null;
                const pt = evalBezier(t, p0, p1, p2, p3);
                return { x: pt.x + dist * n.x, y: pt.y + dist * n.y };
            };

            const offsetTangent = (t, p0, p1, p2, p3, dist) => {
                const eps = 0.03;
                const t0 = Math.max(0, t - eps);
                const t1 = Math.min(1, t + eps);
                const o0 = trueOffsetPoint(t0, p0, p1, p2, p3, dist);
                const o1 = trueOffsetPoint(t1, p0, p1, p2, p3, dist);
                if (!o0 || !o1) return null;
                const dx = o1.x - o0.x;
                const dy = o1.y - o0.y;
                const len = Math.hypot(dx, dy);
                return len > 1e-10 ? { x: dx / len, y: dy / len } : null;
            };

            const splitBezier = (t, p0, p1, p2, p3) => {
                let mt = 1 - t;
                let p01 = {x: p0.x*mt + p1.x*t, y: p0.y*mt + p1.y*t};
                let p12 = {x: p1.x*mt + p2.x*t, y: p1.y*mt + p2.y*t};
                let p23 = {x: p2.x*mt + p3.x*t, y: p2.y*mt + p3.y*t};
                let p012 = {x: p01.x*mt + p12.x*t, y: p01.y*mt + p12.y*t};
                let p123 = {x: p12.x*mt + p23.x*t, y: p12.y*mt + p23.y*t};
                let p0123 = {x: p012.x*mt + p123.x*t, y: p012.y*mt + p123.y*t};
                return [
                    {p0: p0, p1: p01, p2: p012, p3: p0123},
                    {p0: p0123, p1: p123, p2: p23, p3: p3}
                ];
            };

            let safeSegments = [];
            for (let seg of segments) {
                let inflections = getInflectionPoints(seg.p0, seg.p1, seg.p2, seg.p3);
                if (inflections.length === 0) {
                    safeSegments.push(seg);
                } else {
                    let currentSeg = seg;
                    let last_t = 0;
                    for (let t of inflections) {
                        let relative_t = (t - last_t) / (1 - last_t);
                        let parts = splitBezier(relative_t, currentSeg.p0, currentSeg.p1, currentSeg.p2, currentSeg.p3);
                        safeSegments.push({p0: parts[0].p0, p1: parts[0].p1, p2: parts[0].p2, p3: parts[0].p3});
                        currentSeg = {p0: parts[1].p0, p1: parts[1].p1, p2: parts[1].p2, p3: parts[1].p3};
                        last_t = t;
                    }
                    safeSegments.push(currentSeg);
                }
            }

            for (let seg of safeSegments) {
                let segmentResults = [];
                
                const subdivideAndOffset = (p0, p1, p2, p3, depth) => {
                    let n0 = getNormal(0, p0, p1, p2, p3) || { x: 0, y: 1 };
                    const endHandleDegenerate = Math.hypot(p2.x - p3.x, p2.y - p3.y) < 1e-5;
                    let n3 = getNormal(1, p0, p1, p2, p3);
                    if (!n3 || endHandleDegenerate) {
                        n3 = getNormal(0.95, p0, p1, p2, p3)
                            || getNormal(0.9, p0, p1, p2, p3)
                            || { x: n0.x, y: n0.y };
                    }

                    let k0 = getCurvature(0, p0, p1, p2, p3);
                    let k3 = getCurvature(1, p0, p1, p2, p3);
                    let radius0 = Math.abs(k0) > 1e-5 ? 1 / Math.abs(k0) : Infinity;
                    let radius3 = Math.abs(k3) > 1e-5 ? 1 / Math.abs(k3) : Infinity;
                    
                    let chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
                    
                    let isInside0 = (k0 * d > 0);
                    let isInside3 = (k3 * d > 0);

                    if (depth > 0 && chordLen < Math.abs(d) * config.swallowtailGiveUpRatio) {
                        if ((isInside0 && Math.abs(d) >= radius0) || (isInside3 && Math.abs(d) >= radius3)) {
                            segmentResults.push({ 
                                p0: { x: p0.x + d*n0.x, y: p0.y + d*n0.y }, 
                                p1: { x: p0.x + d*n0.x, y: p0.y + d*n0.y }, 
                                p2: { x: p3.x + d*n3.x, y: p3.y + d*n3.y }, 
                                p3: { x: p3.x + d*n3.x, y: p3.y + d*n3.y } 
                            });
                            return;
                        }
                    }

                    let q0 = { x: p0.x + d * n0.x, y: p0.y + d * n0.y };
                    let q3 = { x: p3.x + d * n3.x, y: p3.y + d * n3.y };
                    let offsetChord = Math.hypot(q3.x - q0.x, q3.y - q0.y);

                    let v0 = { x: p1.x - p0.x, y: p1.y - p0.y };
                    let v1 = { x: p2.x - p3.x, y: p2.y - p3.y }; 
                    
                    if (Math.hypot(v0.x, v0.y) < 1e-5) v0 = { x: p2.x - p0.x, y: p2.y - p0.y };
                    if (Math.hypot(v1.x, v1.y) < 1e-5) v1 = { x: p1.x - p3.x, y: p1.y - p3.y };

                    let n_mid = getNormal(0.5, p0, p1, p2, p3);
                    let q1, q2;

                    if (n_mid) {
                        let true_mid_orig = evalBezier(0.5, p0, p1, p2, p3);
                        let M_true = { x: true_mid_orig.x + d * n_mid.x, y: true_mid_orig.y + d * n_mid.y };

                        let targetX = (M_true.x - 0.125*q0.x - 0.125*q3.x - 0.375*q0.x - 0.375*q3.x) / 0.375;
                        let targetY = (M_true.y - 0.125*q0.y - 0.125*q3.y - 0.375*q0.y - 0.375*q3.y) / 0.375;
                        
                        // Solve 2×2 linear system for per-handle scale factors s₀, s₁:
                        //   B(0.5) = 0.5·q₀ + 0.5·q₃ + 0.375·(v₀·s₀ + v₁·s₁) = M_true
                        //   ⇒  v₀·s₀ + v₁·s₁ = target   (x and y components → 2 eqns)
                        // Cramer's rule:
                        //   s₀ = det(target, v₁) / det(v₀, v₁)
                        //   s₁ = det(v₀, target) / det(v₀, v₁)
                        let det = v0.x * v1.y - v0.y * v1.x;
                        let s0, s1;

                        if (Math.abs(det) > 1e-10) {
                            s0 = (targetX * v1.y - targetY * v1.x) / det;
                            s1 = (v0.x * targetY - v0.y * targetX) / det;
                            s0 = Math.max(0.01, Math.min(50, s0));
                            s1 = Math.max(0.01, Math.min(50, s1));
                        } else {
                            // Near-parallel handles — fall back to single scale factor
                            let V_sum_sq = (v0.x+v1.x)*(v0.x+v1.x) + (v0.y+v1.y)*(v0.y+v1.y);
                            if (V_sum_sq > 1e-5) {
                                let s = (targetX * (v0.x+v1.x) + targetY * (v0.y+v1.y)) / V_sum_sq;
                                s0 = s1 = Math.max(0.01, Math.min(50, s));
                            } else {
                                let oldChord = chordLen; 
                                let newChord = Math.hypot(q3.x - q0.x, q3.y - q0.y);
                                s0 = s1 = oldChord > 1e-5 ? newChord / oldChord : 1;
                            }
                        }

                        q1 = { x: q0.x + v0.x * s0, y: q0.y + v0.y * s0 };
                        q2 = { x: q3.x + v1.x * s1, y: q3.y + v1.y * s1 };
                    } else {
                        // Normal at midpoint undefined (P'(t) ≈ 0 at tight bend).
                        // Skip midpoint matching — the error-check below will force
                        // subdivision, and each half will have well-defined normals.
                        let s = Math.max(0.01, Math.min(50, 1));
                        q1 = { x: q0.x + v0.x * s, y: q0.y + v0.y * s };
                        q2 = { x: q3.x + v1.x * s, y: q3.y + v1.y * s };
                    }

                    // Tight outer-convex sub-pieces: skeleton-locked scaling collapses
                    // handles. Retarget along sampled offset tangents (bounded, no LS fit).
                    {
                        const kMid = getCurvature(0.5, p0, p1, p2, p3);
                        const radiusMid = Math.abs(kMid) > 1e-5 ? 1 / Math.abs(kMid) : Infinity;
                        const isOuterConvex = kMid * d < 0;
                        const segLen = Math.hypot(q3.x - q0.x, q3.y - q0.y);
                        const h0len = Math.hypot(q1.x - q0.x, q1.y - q0.y);
                        const h3len = Math.hypot(q2.x - q3.x, q2.y - q3.y);
                        const minHandleRatio = segLen > 1e-6 ? Math.min(h0len, h3len) / segLen : 1;
                        const handleTooShort = segLen > 1e-6 && (h0len < segLen * 0.28 || h3len < segLen * 0.28);
                        if (depth > 0 && isOuterConvex && radiusMid < Math.abs(d) && (minHandleRatio < 0.25 || handleTooShort)) {
                            const minHandle = segLen / 3;
                            const tan0 = offsetTangent(0, p0, p1, p2, p3, d);
                            const tan1 = offsetTangent(1, p0, p1, p2, p3, d);
                            if (tan0 && tan1) {
                                if (h0len < segLen * 0.28) {
                                    q1 = { x: q0.x + tan0.x * minHandle, y: q0.y + tan0.y * minHandle };
                                }
                                if (h3len < segLen * 0.28) {
                                    q2 = { x: q3.x - tan1.x * minHandle, y: q3.y - tan1.y * minHandle };
                                }
                            }
                        }
                    }

                    let shouldSubdivide = false;
                    let splitT = 0.5; 
                    
                    if (depth < config.maxSubdivisionDepth) {
                        let samples = [0.25, 0.5, 0.75];
                        let maxError = 0; let maxErrorT = 0.5;

                        for (let st of samples) {
                            let n_st = getNormal(st, p0, p1, p2, p3);
                            if (!n_st) {
                                // Normal undefined at this sample (derivative ≈ 0 at
                                // tight bend). Force subdivision — each sub-segment
                                // will have well-defined normals.
                                shouldSubdivide = true;
                                splitT = st;
                                break;
                            }
                            let orig_st = evalBezier(st, p0, p1, p2, p3);
                            let true_offset_st = { x: orig_st.x + d * n_st.x, y: orig_st.y + d * n_st.y };
                            let cand_st = evalBezier(st, q0, q1, q2, q3);
                            let err = Math.hypot(true_offset_st.x - cand_st.x, true_offset_st.y - cand_st.y);
                            if (err > maxError) { maxError = err; maxErrorT = st; }
                        }

                        if (!shouldSubdivide) {
                            let thicknessScale = Math.max(1.0, Math.abs(d));
                            let dynamicTolerance = config.baseErrorTolerance * thicknessScale;
                            if (maxError > dynamicTolerance) { shouldSubdivide = true; splitT = maxErrorT; }
                        }

                        let dot = n0.x * n3.x + n0.y * n3.y;
                        if (dot < config.sharpBendThreshold) { shouldSubdivide = true; splitT = 0.5; }
                    }

                    if (shouldSubdivide) {
                        let subCurves = splitBezier(splitT, p0, p1, p2, p3);
                        subdivideAndOffset(subCurves[0].p0, subCurves[0].p1, subCurves[0].p2, subCurves[0].p3, depth + 1);
                        subdivideAndOffset(subCurves[1].p0, subCurves[1].p1, subCurves[1].p2, subCurves[1].p3, depth + 1);
                    } else {
                        segmentResults.push({ p0: q0, p1: q1, p2: q2, p3: q3 });
                    }
                };
                
                subdivideAndOffset(seg.p0, seg.p1, seg.p2, seg.p3, 0);
                offsetSegments.push(segmentResults);
            }
            return offsetSegments;
        };

        const forwardPaths = generateOffsetPaths(absD);
        const backwardPaths = generateOffsetPaths(-absD);
        const ringClosed = this.closed && this.startNode !== this.endNode;

        const outline = { closed: ringClosed, forwardPaths, backwardPaths };
        if (!ringClosed && segments.length > 0 && this.endNode) {
            const lastSk = segments[segments.length - 1];
            const eps = 1e-5;
            const endHandleAtNode = Math.hypot(
                lastSk.p2.x - lastSk.p3.x, lastSk.p2.y - lastSk.p3.y
            ) < eps;
            if (endHandleAtNode) {
                const mt = 0.95;
                const dx = 3 * mt * mt * (lastSk.p1.x - lastSk.p0.x)
                    + 6 * mt * (1 - mt) * (lastSk.p2.x - lastSk.p1.x)
                    + 3 * (1 - mt) * (1 - mt) * (lastSk.p3.x - lastSk.p2.x);
                const dy = 3 * mt * mt * (lastSk.p1.y - lastSk.p0.y)
                    + 6 * mt * (1 - mt) * (lastSk.p2.y - lastSk.p1.y)
                    + 3 * (1 - mt) * (1 - mt) * (lastSk.p3.y - lastSk.p2.y);
                const len = Math.hypot(dx, dy);
                if (len > 1e-8) {
                    const nx = -dy / len;
                    const ny = dx / len;
                    const P = lastSk.p3;
                    const plus = { x: P.x + absD * nx, y: P.y + absD * ny };
                    const minus = { x: P.x - absD * nx, y: P.y - absD * ny };
                    const trimTail = (groups, cap) => {
                        if (!groups?.length) return;
                        const g = groups[groups.length - 1];
                        const trimDist = Math.max(1e-3, absD * 0.5);
                        while (g.length > 1) {
                            const tail = g[g.length - 1];
                            if (Math.hypot(tail.p3.x - cap.x, tail.p3.y - cap.y) < trimDist) g.pop();
                            else break;
                        }
                        const anchor = g.length > 1 ? { ...g[g.length - 2].p3 } : { ...g[0].p0 };
                        const tail = g[g.length - 1];
                        tail.p0 = anchor;
                        tail.p1 = anchor;
                        tail.p2 = { ...cap };
                        tail.p3 = { ...cap };
                        tail.isLineCap = true;
                    };
                    trimTail(forwardPaths, plus);
                    trimTail(backwardPaths, minus);
                    outline.openCuspCaps = { endPlus: plus, endMinus: minus };
                }
            }
        }

        return outline;
    }

    getSkeletonVertices() {
        if (!this.startNode) return [];
        let pts = [];
        let curr = this.startNode;
        let visited = new Set();
        while (curr && !visited.has(curr)) {
            visited.add(curr);
            pts.push(curr);
            if (!this.closed && curr === this.endNode) break;
            curr = curr.nextOnCurve;
            if (this.closed && curr === this.startNode) break;
        }
        return pts;
    }

    /**
     * Determine direction (cw/ccw) via Green's theorem (signed area).
     * Integrates x·dy − y·dx over every cubic Bézier segment exactly using
     * 3-point Gauss–Legendre quadrature (exact for degree‑5 integrand).
     *
     * For open paths the implicit closing edge is a straight line from the
     * end node back to the start node — its contribution is added analytically.
     *
     * In screen coordinates (y‑down): positive area → CW, negative → CCW.
     */
    getSkeletonWinding() {
        const segments = this.getSkeletonBezierSegments();
        if (segments.length === 0) return 'ccw'; // degenerate → default

        // 3‑point Gauss–Legendre on [0,1] — exact for polynomials up to degree 5.
        // The cubic Bézier integrand Bx·By' − By·Bx' is degree ≤ 5, so this is exact.
        const GL3 = [
            { t: 0.1127016653792583, w: 0.2777777777777778 },
            { t: 0.5,               w: 0.4444444444444444 },
            { t: 0.8872983346207417, w: 0.2777777777777778 }
        ];

        // Evaluate the integrand x·dy − y·dx of a cubic Bézier at parameter t
        const integrand = (p0, p1, p2, p3, t) => {
            const mt = 1 - t;
            // Bernstein basis (cubic)
            const b0 = mt * mt * mt;
            const b1 = 3 * mt * mt * t;
            const b2 = 3 * mt * t * t;
            const b3 = t * t * t;
            // Derivative Bernstein basis (3·(1−t)², 6·(1−t)·t, 3·t²)
            const db0 = 3 * mt * mt;
            const db1 = 6 * mt * t;
            const db2 = 3 * t * t;

            const Bx  = b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x;
            const By  = b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y;
            const dBx = db0 * (p1.x - p0.x) + db1 * (p2.x - p1.x) + db2 * (p3.x - p2.x);
            const dBy = db0 * (p1.y - p0.y) + db1 * (p2.y - p1.y) + db2 * (p3.y - p2.y);

            return Bx * dBy - By * dBx;
        };

        let sum = 0;
        for (const seg of segments) {
            for (const g of GL3) {
                sum += g.w * integrand(seg.p0, seg.p1, seg.p2, seg.p3, g.t);
            }
        }

        // For open paths, add the implicit straight‑line closing edge
        if (!this.closed && this.startNode && this.endNode && this.startNode !== this.endNode) {
            sum += this.endNode.x * this.startNode.y - this.endNode.y * this.startNode.x;
        }

        return sum > 0 ? 'cw' : 'ccw';
    }

    reverseSkeletonDirection() {
        let nodes = this.getSkeletonVertices();
        if (nodes.length < 2) return false;

        for (let n of nodes) {
            let tmp = n.control1;
            n.control1 = n.control2;
            n.control2 = tmp;
        }

        nodes.reverse();
        for (let i = 0; i < nodes.length; i++) {
            nodes[i].nextOnCurve = i < nodes.length - 1 ? nodes[i + 1] : null;
            nodes[i].lastOnCurve = i > 0 ? nodes[i - 1] : null;
        }

        this.startNode = nodes[0];
        this.endNode = nodes[nodes.length - 1];
        this.cached_boolean_geometry = null;
        this._lastHash = null;
        return true;
    }

    getGeometryHash() {
        let str = `${this.stroke_width}_${this.closed}_${this.smart_stroke}_${this.smart_stroke_clockwise}_`;
        let curr = this.startNode;
        while(curr) {
            str += `${curr.x},${curr.y},`;
            if(curr.control1) str += `${curr.control1.x},${curr.control1.y},`;
            if(curr.control2) str += `${curr.control2.x},${curr.control2.y},`;
            if (curr === this.endNode && !this.closed) break;
            curr = curr.nextOnCurve;
            if (this.closed && curr === this.startNode) break;
        }
        return str;
    }

    updateBooleanCache() {
        refreshCurveBooleanCache(this);
    }
}
