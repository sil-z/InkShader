import {
    resolveActiveCanvasTool,
    snapshotIncludesCurve
} from "../../app/editor_interaction_state.js";
import { computeSelectionBounds, createSequenceLayoutFromCurveManager, getSeqIdxForGroupId } from "../../app/selection_geometry.js";
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
        const layout = createSequenceLayoutFromCurveManager(cm);
        return layout ? getSeqIdxForGroupId(layout, groupId, focused) : -1;
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
        const pivotRadius = 5;

        // Mode-specific handles
        if (c.transform_mode === 'rotate_shear') {
            // Rotate handles at corners (circular), shear handles at edges (diamond-shaped hit)
            const rotSize = 7;
            const rotHandles = {
                "rot_tl": { x: minSX, y: minSY },
                "rot_tr": { x: maxSX, y: minSY },
                "rot_bl": { x: minSX, y: maxSY },
                "rot_br": { x: maxSX, y: maxSY }
            };
            const shearSize = 7;
            const shearHandles = {
                "shear_tc": { x: midSX, y: minSY },
                "shear_bc": { x: midSX, y: maxSY },
                "shear_ml": { x: minSX, y: midSY },
                "shear_mr": { x: maxSX, y: midSY }
            };
            for (let key in rotHandles) {
                let h = rotHandles[key];
                if (Math.abs(mouseX - h.x) <= rotSize && Math.abs(mouseY - h.y) <= rotSize) return key;
            }
            for (let key in shearHandles) {
                let h = shearHandles[key];
                if (Math.abs(mouseX - h.x) <= shearSize && Math.abs(mouseY - h.y) <= shearSize) return key;
            }
            // Pivot hit
            const pivot = this._getTransformPivotScreen(c, bounds);
            if (pivot && Math.abs(mouseX - pivot.x) <= pivotRadius && Math.abs(mouseY - pivot.y) <= pivotRadius) {
                return 'pivot';
            }
            return null;
        }

        // Scale mode: 8 square handles (no rot handle)
        const scaleHandles = {
            "tl": { x: minSX, y: minSY }, "tc": { x: midSX, y: minSY }, "tr": { x: maxSX, y: minSY },
            "ml": { x: minSX, y: midSY }, "mr": { x: maxSX, y: midSY },
            "bl": { x: minSX, y: maxSY }, "bc": { x: midSX, y: maxSY }, "br": { x: maxSX, y: maxSY }
        };
        for (let key in scaleHandles) {
            let h = scaleHandles[key];
            if (Math.abs(mouseX - h.x) <= 6 && Math.abs(mouseY - h.y) <= 6) return key;
        }
        return null;
    }

    /**
     * Get the screen position of the transform pivot for hit-testing and rendering.
     * Returns null if bounds are not available.
     */
    _getTransformPivotScreen(c, bounds) {
        if (!bounds) return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        let px, py;
        if (c.transform_center_pivot) {
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cy = (bounds.minY + bounds.maxY) / 2;
            const absX = cx + c.transform_center_pivot.dx;
            const absY = cy + c.transform_center_pivot.dy;
            px = absX * c.scale + offsetX;
            py = absY * c.scale + offsetY;
        } else {
            px = ((bounds.minX + bounds.maxX) / 2) * c.scale + offsetX;
            py = ((bounds.minY + bounds.maxY) / 2) * c.scale + offsetY;
        }
        return { x: px, y: py };
    }

    /** @deprecated Was used for selection-box-edge mode toggle — no longer needed */
    hitTestNode(mouseX, mouseY) {
        const c = this.canvas;
        const tool = resolveActiveCanvasTool(c);
        if (tool === "SELECT" || tool === "MEASURE" || tool === "ELLIPSE") return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const threshold = 6;
        let hits = [];
        const ix = c.getInteractionSnapshot();
        let showHandlesSet = new Set();
        const nodeSelectedCurveIdSet = new Set();
        const curveStore = c.curve_manager.curveStore;

        // Add a node + its neighbors to showHandlesSet (for closed curve / control handle visibility)
        const addToShowHandles = (node, curve) => {
            if (!node) return;
            showHandlesSet.add(node);
            if (node.lastOnCurve) showHandlesSet.add(node.lastOnCurve);
            if (node.nextOnCurve) showHandlesSet.add(node.nextOnCurve);
            if (curve?.closed) {
                if (node === curve.startNode && curve.endNode) showHandlesSet.add(curve.endNode);
                if (node === curve.endNode && curve.startNode) showHandlesSet.add(curve.startNode);
            }
        };
        // Add ALL nodes of a curve to showHandlesSet (for object-selected curves)
        const addAllNodes = (curve) => {
            if (!curve || !curve.startNode) return;
            let cur = curve.startNode;
            while (cur) { addToShowHandles(cur, curve); cur = cur.nextOnCurve; }
        };

        // 1. Object-selected curves: show handles on ALL their nodes
        const selCurveIds = ix.selectedCurveIds || [];
        for (const curveId of selCurveIds) {
            const curve = curveStore.curveById.get(curveId);
            if (curve) addAllNodes(curve);
        }
        // 2. Current drawing curve: show handles on all its nodes
        if (c.current_curve) addAllNodes(c.current_curve);
        // 3. Node-selected markers: show handles on individual nodes + neighbors
        const selMarkers = ix.selectedNodeMarkerIds;
        if (selMarkers && selMarkers.size > 0) {
            for (const marker of selMarkers) {
                const node = curveStore.domMap.get(marker);
                if (!node) continue;
                addToShowHandles(node, node.curve);
                if (node.curve?.id) nodeSelectedCurveIdSet.add(node.curve.id);
            }
        }
        const curveIsNodeSelected = (curve) => curve?.id && nodeSelectedCurveIdSet.has(curve.id);

        // ── Hit test using spatial grid ──
        const grid = c.curve_manager.spatialGrid;
        const worldMouseX = (mouseX - offsetX) / c.scale;
        const worldMouseY = (mouseY - offsetY) / c.scale;
        const worldThreshold = threshold / c.scale;
        if (grid && grid.size > 0 && worldThreshold > 0) {
            const candidates = grid.queryProximity(worldMouseX, worldMouseY, worldThreshold);
            for (const entry of candidates) {
                const { node, curve, refId, seqIdx, matrix, seqOffsetX: entrySeqOff, worldX, worldY } = entry;
                if (!curve || curve.visible === false || curve.locked === true) continue;
                if (tool === "DRAW" && curve !== c.current_curve) continue;

                // Main node hit
                let screenX = worldX * c.scale + offsetX;
                let screenY = worldY * c.scale + offsetY;
                let dist = Math.hypot(mouseX - screenX, mouseY - screenY);
                if (dist < threshold) {
                    let z = node.last_touched || 0;
                    let isSelected = snapshotIncludesCurve(ix, curve) || curveIsNodeSelected(curve);
                    hits.push({ marker: node.main_node, dist, z, seqIndex: seqIdx, matrix, refId, isFromSelectedCurve: isSelected ? 1 : 0 });
                }

                // Control handle hits (only when handles are visible)
                if (showHandlesSet.has(node)) {
                    const checkCtrl = (ctrlNode, ctrlMarker) => {
                        if (!ctrlNode || !ctrlMarker) return;
                        let cwx = ctrlNode.x, cwy = ctrlNode.y;
                        if (matrix) {
                            const x = cwx; const y = cwy;
                            cwx = x * matrix.a + y * matrix.c + matrix.e;
                            cwy = x * matrix.b + y * matrix.d + matrix.f;
                        }
                        cwx += entrySeqOff;
                        let csx = cwx * c.scale + offsetX;
                        let csy = cwy * c.scale + offsetY;
                        let cdist = Math.hypot(mouseX - csx, mouseY - csy);
                        if (cdist < threshold) {
                            let z = node.last_touched || 0;
                            let isSel = snapshotIncludesCurve(ix, curve) || curveIsNodeSelected(curve);
                            hits.push({ marker: ctrlMarker, dist: cdist, z, seqIndex: seqIdx, matrix, refId, isFromSelectedCurve: isSel ? 1 : 0 });
                        }
                    };
                    checkCtrl(node.control1, node.control1?.main_node);
                    checkCtrl(node.control2, node.control2?.main_node);
                }
            }
        }

        // ── Control handle hit test: bypass spatial grid ──
        // The spatial grid only stores ON-curve nodes and queries at threshold/scale (~6 world units).
        // Control handles can be ~30+ units from their parent node, so the parent node is often
        // outside the query radius. Directly check every node in showHandlesSet.
        if (showHandlesSet.size > 0) {
            /** @type {Map<Curve,{seqOffsetX:number,matrix:DOMMatrix,seqIdx:number,refId:?string}>} */
            const ctrlCurveInfo = new Map();
            const sq = c.curve_manager.sequenceTokens || [];

            // Current drawing curve (not yet committed to tree store via commit_curve)
            if (c.current_curve && c.current_curve.groupId) {
                let sidx = -1;
                for (let i = 0; i < sq.length; i++) {
                    if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
                    const t = sq[i];
                    const tg = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                    if (tg === c.current_curve.groupId) { sidx = i; break; }
                }
                if (sidx === -1) {
                    for (let i = 0; i < sq.length; i++) {
                        const t = sq[i];
                        const tg = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                        if (tg === c.current_curve.groupId) { sidx = i; break; }
                    }
                }
                if (sidx !== -1) {
                    ctrlCurveInfo.set(c.current_curve, {
                        seqOffsetX: c.curve_manager.getSeqOffset(sidx),
                        matrix: new DOMMatrix(),
                        seqIdx: sidx,
                        refId: null
                    });
                }
            }

            // Committed curves in active sequences
            for (let i = 0; i < sq.length; i++) {
                if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
                const seqOff = c.curve_manager.getSeqOffset(i);
                const t = sq[i];
                const gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                const cdl = c.curve_manager.getCurvesForGroup(gid);
                for (const cd of cdl) {
                    if (!cd.effectiveVis || cd.effectiveLock) continue;
                    if (!ctrlCurveInfo.has(cd.curve)) {
                        ctrlCurveInfo.set(cd.curve, {
                            seqOffsetX: seqOff,
                            matrix: cd.matrix,
                            seqIdx: i,
                            refId: cd.refId || null
                        });
                    }
                }
            }

            // Check control handles for every node in showHandlesSet
            for (const node of showHandlesSet) {
                if (!node.curve) continue;
                const info = ctrlCurveInfo.get(node.curve);
                if (!info) continue;
                const checkCtrl = (ctrlNode, ctrlMarker) => {
                    if (!ctrlNode || !ctrlMarker) return;
                    let cwx = ctrlNode.x, cwy = ctrlNode.y;
                    if (info.matrix) {
                        const x = cwx; const y = cwy;
                        cwx = x * info.matrix.a + y * info.matrix.c + info.matrix.e;
                        cwy = x * info.matrix.b + y * info.matrix.d + info.matrix.f;
                    }
                    cwx += info.seqOffsetX;
                    const csx = cwx * c.scale + offsetX;
                    const csy = cwy * c.scale + offsetY;
                    const cdist = Math.hypot(mouseX - csx, mouseY - csy);
                    if (cdist < threshold) {
                        const z = node.last_touched || 0;
                        const isSel = snapshotIncludesCurve(ix, node.curve) || curveIsNodeSelected(node.curve);
                        hits.push({ marker: ctrlMarker, dist: cdist, z, seqIndex: info.seqIdx, matrix: info.matrix, refId: info.refId, isFromSelectedCurve: isSel ? 1 : 0 });
                    }
                };
                checkCtrl(node.control1, node.control1?.main_node);
                checkCtrl(node.control2, node.control2?.main_node);
            }
        }

        if (hits.length > 0) {
            hits.sort((a, b) => {
                if (b.isFromSelectedCurve !== a.isFromSelectedCurve) return b.isFromSelectedCurve - a.isFromSelectedCurve;
                if (b.z !== a.z) return b.z - a.z;
                return a.dist - b.dist;
            });
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

        // Viewport bounds in world coordinates (for viewport culling)
        const { width: logicalW, height: logicalH } = c.viewportService.getCanvasUserSpaceSize();
        const hitWorldPad = 20 / c.scale;
        const vpBounds = {
            minX: -offsetX / c.scale - hitWorldPad,
            minY: -offsetY / c.scale - hitWorldPad,
            maxX: (logicalW - offsetX) / c.scale + hitWorldPad,
            maxY: (logicalH - offsetY) / c.scale + hitWorldPad
        };
        const worldMouseX = (mouseX - offsetX) / c.scale;
        const worldMouseY = (mouseY - offsetY) / c.scale;

        // NODE tool: pre-filter candidate curves via spatial grid for O(nearby) bezier hit testing
        let nodeToolCandidateCurves = null;
        if (tool === "NODE") {
            const grid = c.curve_manager.spatialGrid;
            if (grid && grid.size > 0) {
                nodeToolCandidateCurves = new Set();
                const margin = 100; // world units — generous enough to cover bezier midpoint deviation
                const entries = grid.queryProximity(worldMouseX, worldMouseY, margin);
                for (const entry of entries) {
                    if (entry.curve) nodeToolCandidateCurves.add(entry.curve);
                }
            }
        }

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

                // Viewport culling: skip curves whose AABB is entirely outside the viewport
                const curveBounds = curve.getBounds(matrix);
                if (curveBounds) {
                    const cMinX = curveBounds.minX + seqOffsetX;
                    const cMaxX = curveBounds.maxX + seqOffsetX;
                    const cMinY = curveBounds.minY;
                    const cMaxY = curveBounds.maxY;
                    if (cMaxX < vpBounds.minX || cMinX > vpBounds.maxX ||
                        cMaxY < vpBounds.minY || cMinY > vpBounds.maxY) continue;
                }
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
                    if (nodeToolCandidateCurves && !nodeToolCandidateCurves.has(curve)) continue;
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
                        const t = item.transform;
                        const mat = t instanceof DOMMatrix ? t : new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]);
                        const invM = mat.inverse();
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
        if (!hitResult) {
            const rootChildren = c.curve_manager.rootChildren || [];
            for (let j = rootChildren.length - 1; j >= 0; j--) {
                const item = c.curve_manager.treeItems.get(rootChildren[j]);
                if (item && item.type === "image" && item.visible && !item.locked) {
                    const worldX = (mouseX - offsetX) / c.scale;
                    const worldY = (mouseY - offsetY) / c.scale;
                    const t = item.transform;
                    const mat = t instanceof DOMMatrix ? t : new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]);
                    const invM = mat.inverse();
                    const localP = invM.transformPoint({ x: worldX, y: worldY });
                    if (localP.x >= 0 && localP.x <= item.width && localP.y >= 0 && localP.y <= item.height) {
                        hitResult = { curve: null, refId: item.id, seqIndex: -1, matrix: item.transform, isImage: true };
                        break;
                    }
                }
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
        if (!c.guidelines || c.guidelines.length === 0) return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const rad = Math.PI / 180;
        const LINE_HIT = 8;
        const DOT_HIT = 6;
        let bestDot = null, bestDotDist = Infinity;
        let bestLine = null, bestLineDist = Infinity;
        for (const g of c.guidelines) {
            if (g._temp) continue;
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
    hitTestDividerLines(mouseX, mouseY) {
        const c = this.canvas;
        if (c.divider_visible === false) return null;
        const seqTokens = c.curve_manager.sequenceTokens || [];
        const activeIndices = c.curve_manager.activeSequenceIndices;
        if (activeIndices.size === 0) return null;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const HIT_THRESHOLD = 6;
        const { height: logicalH } = c.viewportService.getCanvasUserSpaceSize();
        const topY = 0;
        const bottomY = logicalH;
        let best = null, bestDist = Infinity;
        for (let i = 0; i < seqTokens.length; i++) {
            if (!activeIndices.has(i)) continue;
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let gid = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let group = c.curve_manager.treeItems.get(gid);
            let advance = (group && group.advance !== undefined) ? group.advance : 1000;
            let sx = seqOffsetX * c.scale + offsetX;
            let ex = (seqOffsetX + advance) * c.scale + offsetX;
            let withinY = mouseY >= topY - HIT_THRESHOLD && mouseY <= bottomY + HIT_THRESHOLD;
            if (!withinY) continue;
            let dl = Math.abs(mouseX - sx);
            let dr = Math.abs(mouseX - ex);
            if (dl < HIT_THRESHOLD && dl < bestDist) {
                if (i > 0) {
                    let prevToken = seqTokens[i - 1];
                    let prevGid = prevToken.isChar ? c.curve_manager.getDefaultGroupForChar(prevToken.value) : prevToken.value;
                    bestDist = dl;
                    best = { groupId: prevGid, isRight: true, screenX: sx, seqIndex: i - 1 };
                } else {
                    // Left edge of first glyph — hoverable but not draggable, shows LSB of first glyph
                    bestDist = dl;
                    best = { groupId: gid, screenX: sx, seqIndex: 0, isLeftEdge: true };
                }
            }
            if (dr < HIT_THRESHOLD && dr < bestDist) {
                bestDist = dr;
                best = { groupId: gid, isRight: true, screenX: ex, seqIndex: i };
            }
        }
        return best;
    }
    hitTestMetricGuidelines(mouseX, mouseY) {
        const c = this.canvas;
        const mg = c.metric_guidelines;
        if (!mg || !mg.items) return null;
        const fs = c.fontSettings || {};
        const upm = fs.upm || 1000;
        const fontH = c.canvas_size_height * c.scale;
        const { x: offsetX, y: offsetY } = this.getLogicalOffset();
        const baselineY = offsetY + 0.8 * fontH;
        const metricTypes = [
            { key: 'ascender',   value: fs.ascender ?? 800 },
            { key: 'descender',  value: fs.descender ?? -200 },
            { key: 'x_height',   value: fs.x_height ?? 500 },
            { key: 'cap_height', value: fs.cap_height ?? 700 },
            { key: 'baseline',   value: 0 }
        ];
        const HIT_THRESHOLD = 8;
        const { width: logicalW } = c.viewportService.getCanvasUserSpaceSize();
        let best = null, bestDist = Infinity;
        for (const mt of metricTypes) {
            const item = mg.items[mt.key];
            if (!item || item.visible === false) continue;
            const sy = baselineY - (mt.value / upm) * fontH;
            // Horizontal line from (0, sy) to (logicalW, sy)
            const dx = mouseX - 0;
            const dy = mouseY - sy;
            // Distance from point to horizontal line = absolute vertical distance
            const dist = Math.abs(dy);
            // Check if mouseX is within horizontal range (with padding)
            if (mouseX >= -HIT_THRESHOLD && mouseX <= logicalW + HIT_THRESHOLD && dist < HIT_THRESHOLD && dist < bestDist) {
                bestDist = dist;
                best = mt.key;
            }
        }
        return best;
    }
}
