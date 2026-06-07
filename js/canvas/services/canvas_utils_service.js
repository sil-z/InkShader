import {
    resolveActiveCanvasTool,
    shouldIncludeCurrentDrawingCurve,
    snapshotIncludesCurve,
    snapshotIncludesNodeMarker
} from "../../app/editor_interaction_state.js";
import { computeSelectionBounds, getSeqIdxForGroupId } from "../../app/selection_geometry.js";
import { appendCurveOutlinePath, curveGeneratesFillArea } from "../rendering/curve_renderer.js";
import { createDeviceViewportTransform } from "../rendering/viewport_transform.js";
import { emitCubicBezierSegments } from "../../core/bezier/path_emitter.js";
export class CanvasUtilsService {
    constructor(canvas) {
        this.canvas = canvas;
    }
    getLogicalOffset() {
        const c = this.canvas;
        const r = c.ruler_size;
        return { x: r + c.offset.x, y: r + c.offset.y };
    }
    getSeqIdxForGroupId(groupId) {
        const cm = this.canvas.curve_manager;
        const ix = this.canvas.getInteractionSnapshot();
        const focused = typeof ix.focusedSeqIdx === "number" && ix.focusedSeqIdx >= 0 ? ix.focusedSeqIdx : -1;
        return getSeqIdxForGroupId(cm, groupId, focused);
    }
    getSelectionBounds(mode = "transform") {
        const c = this.canvas;
        return computeSelectionBounds(c.curve_manager, c.getInteractionSnapshot(), mode);
    }
    getCanvasDrawDpr() {
        const c = this.canvas;
        return c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio() || 1;
    }
    hitTestTransformHandles(mouseX, mouseY) {
        const c = this.canvas;
        let bounds = this.getSelectionBounds();
        if (!bounds) return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        let minSX = bounds.minX * c.scale + offsetX; let minSY = bounds.minY * c.scale + offsetY;
        let maxSX = bounds.maxX * c.scale + offsetX; let maxSY = bounds.maxY * c.scale + offsetY;
        let midSX = (minSX + maxSX) / 2; let midSY = (minSY + maxSY) / 2;
        const handles = {
            "tl": { x: minSX, y: minSY }, "tc": { x: midSX, y: minSY }, "tr": { x: maxSX, y: minSY },
            "ml": { x: minSX, y: midSY }, "mr": { x: maxSX, y: midSY },
            "bl": { x: minSX, y: maxSY }, "bc": { x: midSX, y: maxSY }, "br": { x: maxSX, y: maxSY },
            "rot": { x: midSX, y: minSY - 25 }
        };
        for (let key in handles) {
            let h = handles[key];
            if (Math.abs(mouseX - h.x) <= 6 && Math.abs(mouseY - h.y) <= 6) return key;
        }
        return null;
    }
    hitTestNode(mouseX, mouseY) {
        const c = this.canvas;
        const tool = resolveActiveCanvasTool(c);
        if (tool === "SELECT" || tool === "MEASURE") return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const threshold = 6;
        let hits = [];
        let seqTokens = c.curve_manager.sequenceTokens || [];
        let activeIndices = c.curve_manager.activeSequenceIndices;
        const ix = c.getInteractionSnapshot();
        let showHandlesSet = new Set();
        for (let i = 0; i < seqTokens.length; i++) {
            if (!activeIndices.has(i)) continue;
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) {
                    curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false });
                }
            }
            for (let cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let isCurveSelected = snapshotIncludesCurve(ix, cd.curve) || cd.curve === c.current_curve;
                let current = cd.curve.startNode;
                while (current) {
                    if (snapshotIncludesNodeMarker(ix, current.main_node) || isCurveSelected) {
                        showHandlesSet.add(current);
                        if (current.lastOnCurve) showHandlesSet.add(current.lastOnCurve);
                        if (current.nextOnCurve) showHandlesSet.add(current.nextOnCurve);
                        if (cd.curve.closed) {
                            if (current === cd.curve.startNode && cd.curve.endNode) showHandlesSet.add(cd.curve.endNode);
                            if (current === cd.curve.endNode && cd.curve.startNode) showHandlesSet.add(cd.curve.startNode);
                        }
                    }
                    current = current.nextOnCurve;
                }
            }
        }
        const checkHit = (node, marker, seqIdx, matrix, refId) => {
            if (!node) return;
            let seqOffsetX = c.curve_manager.getSeqOffset(seqIdx);
            let mx = node.x, my = node.y;
            if (matrix) {
                mx = node.x * matrix.a + node.y * matrix.c + matrix.e;
                my = node.x * matrix.b + node.y * matrix.d + matrix.f;
            }
            let screenX = (mx + seqOffsetX) * c.scale + offsetX;
            let screenY = my * c.scale + offsetY;
            let dist = Math.hypot(mouseX - screenX, mouseY - screenY);
            if (dist < threshold) {
                let parentNode = node.type !== null ? node : (node.nextOnCurve || node.lastOnCurve);
                let z = parentNode.last_touched || 0;
                hits.push({ marker, dist, z, seqIndex: seqIdx, matrix, refId });
            }
        };
        for (let i = 0; i < seqTokens.length; i++) {
            if (!activeIndices.has(i)) continue;
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) {
                    curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null });
                }
            }
            for (let j = curveDataList.length - 1; j >= 0; j--) {
                let cd = curveDataList[j];
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                if (tool === "DRAW" && cd.curve !== c.current_curve) continue;
                let current = cd.curve.startNode;
                while (current) {
                    let showHandles = showHandlesSet.has(current);
                    if (showHandles && current.control1) {
                        checkHit(current.control1, current.control1.main_node, i, cd.matrix, cd.refId);
                    }
                    if (showHandles && current.control2) {
                        checkHit(current.control2, current.control2.main_node, i, cd.matrix, cd.refId);
                    }
                    checkHit(current, current.main_node, i, cd.matrix, cd.refId);
                    current = current.nextOnCurve;
                }
            }
        }
        if (hits.length > 0) {
            hits.sort((a, b) => { if (b.z !== a.z) return b.z - a.z; return a.dist - b.dist; });
            return { marker: hits[0].marker, seqIndex: hits[0].seqIndex, matrix: hits[0].matrix, refId: hits[0].refId };
        }
        return null;
    }
    hitTestCurve(mouseX, mouseY) {
        const c = this.canvas;
        const tool = resolveActiveCanvasTool(c);
        if (tool === "DRAW" || tool === "MEASURE") return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const dpr = this.getCanvasDrawDpr();
        const dScale = c.scale * dpr;
        const dOffsetX = offsetX * dpr;
        const dOffsetY = offsetY * dpr;
        const dMouseX = mouseX * dpr;
        const dMouseY = mouseY * dpr;
        c.ctx.save();
        c.ctx.setTransform(1, 0, 0, 1, 0, 0);
        let hitResult = null;
        let seqTokens = c.curve_manager.sequenceTokens || [];
        for (let i = seqTokens.length - 1; i >= 0; i--) {
            if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let group = c.curve_manager.treeItems.get(groupId);
            if (!group) continue;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            for (let j = curveDataList.length - 1; j >= 0; j--) {
                let cd = curveDataList[j];
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let curve = cd.curve; let matrix = cd.matrix;
                if (!curve.startNode) continue;
                const pt = (x, y) => {
                    let mx = x, my = y;
                    if (matrix) { mx = x * matrix.a + y * matrix.c + matrix.e; my = x * matrix.b + y * matrix.d + matrix.f; }
                    return {
                        x: ((mx + seqOffsetX) * c.scale + offsetX) * dpr,
                        y: (my * c.scale + offsetY) * dpr
                    };
                };
                let hitLineWidth = Math.max(14, (curve.stroke_width || 0) * dScale + 14);
                if (tool === "SELECT") {
                    let isHit = false;
                    const viewport = { scale: dScale, offsetX: dOffsetX, offsetY: dOffsetY, seqOffsetX, matrix };
                    const mapDevice = createDeviceViewportTransform(viewport, dpr);
                    if (curveGeneratesFillArea(curve)) {
                        c.ctx.beginPath();
                        appendCurveOutlinePath(c.ctx, curve, viewport, { pass: "all" });
                        if (c.ctx.isPointInPath(dMouseX, dMouseY, "nonzero")) isHit = true;
                    }
                    if (!isHit) {
                        c.ctx.beginPath();
                        if (curveGeneratesFillArea(curve)) {
                            appendCurveOutlinePath(c.ctx, curve, viewport, { pass: "all" });
                        } else {
                            emitCubicBezierSegments(c.ctx, curve.getSkeletonBezierSegments(), mapDevice);
                        }
                        c.ctx.lineWidth = hitLineWidth;
                        if (c.ctx.isPointInStroke(dMouseX, dMouseY)) isHit = true;
                    }
                    if (isHit) {
                        hitResult = { curve: curve, startNode: curve.startNode, nextNode: curve.startNode.nextOnCurve, seqIndex: i, refId: cd.refId, matrix: cd.matrix };
                        break;
                    }
                } else if (tool === "NODE") {
                    let current = curve.startNode;
                    while (current && current.nextOnCurve && (current !== curve.endNode || !curve.closed)) {
                        let next = current.nextOnCurve;
                        c.ctx.beginPath(); let startP = pt(current.x, current.y); c.ctx.moveTo(startP.x, startP.y);
                        let cp1 = pt(current.control1?.x ?? current.x, current.control1?.y ?? current.y);
                        let cp2 = pt(next.control2?.x ?? next.x, next.control2?.y ?? next.y);
                        let endP = pt(next.x, next.y);
                        c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endP.x, endP.y);
                        c.ctx.lineWidth = hitLineWidth;
                        if (c.ctx.isPointInStroke(dMouseX, dMouseY)) {
                            hitResult = { curve: curve, startNode: current, nextNode: next, seqIndex: i, refId: cd.refId, matrix: cd.matrix };
                            break;
                        }
                        current = next;
                    }
                    if (!hitResult && curve.closed && curve.startNode !== curve.endNode && curve.endNode && curve.startNode) {
                        c.ctx.beginPath(); let startP = pt(curve.endNode.x, curve.endNode.y); c.ctx.moveTo(startP.x, startP.y);
                        let cp1 = pt(curve.endNode.control1?.x ?? curve.endNode.x, curve.endNode.control1?.y ?? curve.endNode.y);
                        let cp2 = pt(curve.startNode.control2?.x ?? curve.startNode.x, curve.startNode.control2?.y ?? curve.startNode.y);
                        let endP = pt(curve.startNode.x, curve.startNode.y);
                        c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endP.x, endP.y);
                        c.ctx.lineWidth = hitLineWidth;
                        if (c.ctx.isPointInStroke(dMouseX, dMouseY)) {
                            hitResult = { curve: curve, startNode: curve.endNode, nextNode: curve.startNode, seqIndex: i, refId: cd.refId, matrix: cd.matrix };
                        }
                    }
                }
                if (hitResult) break;
            }
            if (hitResult) break;
        }
        if (!hitResult) {
            for (let i = seqTokens.length - 1; i >= 0; i--) {
                if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
                let seqOffsetX = c.curve_manager.getSeqOffset(i);
                let token = seqTokens[i];
                let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let group = c.curve_manager.treeItems.get(groupId);
                if (!group) continue;
                const childrenIds = group.children || [];
                for (let j = childrenIds.length - 1; j >= 0; j--) {
                    const item = c.curve_manager.treeItems.get(childrenIds[j]);
                    if (item && item.type === "image" && item.visible && !item.locked) {
                        const worldX = (mouseX - offsetX) / c.scale - seqOffsetX;
                        const worldY = (mouseY - offsetY) / c.scale;
                        const invM = item.transform.inverse();
                        const localP = invM.transformPoint({ x: worldX, y: worldY });
                        if (localP.x >= 0 && localP.x <= item.width && localP.y >= 0 && localP.y <= item.height) {
                            hitResult = { curve: null, refId: item.id, seqIndex: i, matrix: item.transform, isImage: true };
                            break;
                        }
                    }
                }
                if (hitResult) break;
            }
        }
        c.ctx.restore();
        return hitResult ? hitResult : null;
    }
    getClosestTOnSegment(n1, n2, wx, wy, seqOffsetX = 0) {
        const c = this.canvas;
        let p0 = { x: n1.x + seqOffsetX, y: n1.y };
        let p1 = n1.control1 ? { x: n1.control1.x + seqOffsetX, y: n1.control1.y } : p0;
        let p2 = n2.control2 ? { x: n2.control2.x + seqOffsetX, y: n2.control2.y } : { x: n2.x + seqOffsetX, y: n2.y };
        let p3 = { x: n2.x + seqOffsetX, y: n2.y };
        let min_dist = Infinity; let best_t = 0.5;
        for (let i = 0; i <= 200; i++) {
            let t = i / 200; let mt = 1 - t;
            let bx = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
            let by = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
            let dist = Math.hypot(bx - wx, by - wy);
            if (dist < min_dist) { min_dist = dist; best_t = t; }
        }
        return Math.max(0.01, Math.min(0.99, best_t));
    }
    hitTestUserGuides(mouseX, mouseY) {
        const c = this.canvas;
        if (!c.user_guidelines || c.user_guidelines.length === 0) return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const rad = Math.PI / 180;
        const LINE_HIT = 8;
        const DOT_HIT = 6;
        let bestDot = null, bestDotDist = Infinity;
        let bestLine = null, bestLineDist = Infinity;
        for (const g of c.user_guidelines) {
            const sx = g.x * c.scale + offsetX;
            const sy = g.y * c.scale + offsetY;
            const dotDist = Math.hypot(mouseX - sx, mouseY - sy);
            if (dotDist < DOT_HIT && dotDist < bestDotDist) {
                bestDotDist = dotDist;
                bestDot = g;
            }
            const a = (g.angle || 0) * rad;
            const sinA = Math.sin(a), cosA = Math.cos(a);
            const mx = (mouseX - offsetX) / c.scale;
            const my = (mouseY - offsetY) / c.scale;
            const dist = Math.abs(sinA * (mx - g.x) + cosA * (my - g.y));
            if (dist < LINE_HIT / c.scale && dist < bestLineDist) {
                bestLineDist = dist;
                bestLine = g;
            }
        }
        if (bestDot) return { guide: bestDot, hitType: "dot" };
        if (bestLine) return { guide: bestLine, hitType: "line" };
        return null;
    }
}
