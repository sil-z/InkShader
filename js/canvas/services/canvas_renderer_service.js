import { getCanvasTheme } from "../rendering/canvas_theme.js";
import {
    shouldIncludeCurrentDrawingCurve,
    snapshotIncludesCurve,
    snapshotIncludesNodeMarker
} from "../../app/editor_interaction_state.js";
import {
    appendCurveFillPath,
    shouldBatchFillCurve,
    usePreviewSkeletonForBatchFill,
    drawCurveStroke,
    isCurveStrokePreview
} from "../rendering/curve_renderer.js";
import { drawCurveNode } from "../rendering/node_renderer.js";
export class CanvasRendererService {
    constructor(canvas) {
        this.canvas = canvas;
    }
    renderCanvas() {
        const c = this.canvas;
        if (!c.ctx) return;
        const dpr = c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio();
        const { width: logicalW, height: logicalH } = c.viewportService.getCanvasUserSpaceSize();
        c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (logicalW > 0 && logicalH > 0) {
            c.ctx.clearRect(0, 0, logicalW, logicalH);
        }
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const ix = c.getInteractionSnapshot();
        let seqTokens = c.curve_manager.sequenceTokens || [];
        let activeIndices = c.curve_manager.activeSequenceIndices;
        const p = getCanvasTheme();
        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let group = c.curve_manager.treeItems.get(groupId);
            let advance = (group && group.advance !== undefined) ? group.advance : 1000;
            let sx = seqOffsetX * c.scale + offsetX;
            let sy = offsetY;
            let sw = advance * c.scale;
            let sh = c.canvas_size_height * c.scale;
            c.ctx.fillStyle = p.body_bg_color;
            c.ctx.fillRect(sx, sy, sw, sh);
        }
        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let group = c.curve_manager.treeItems.get(groupId);
            let charCode = group?.charCode;
            if (charCode != null) {
                let displayChar;
                if (typeof charCode === "string") {
                    displayChar = charCode;
                } else if (typeof charCode === "number" && Number.isFinite(charCode) && charCode > 0) {
                    try { displayChar = String.fromCodePoint(charCode); } catch (_) { displayChar = null; }
                }
                if (displayChar) {
                    let advance = (group && group.advance !== undefined) ? group.advance : 1000;
                    let fontH = c.canvas_size_height * c.scale;
                    let cx = (seqOffsetX + advance / 2) * c.scale + offsetX;
                    let baselineY = offsetY + 0.8 * fontH;
                    c.ctx.save();
                    c.ctx.font = `${fontH}px sans-serif`;
                    c.ctx.textAlign = "center";
                    c.ctx.textBaseline = "alphabetic";
                    c.ctx.fillStyle = "rgba(160,160,160,0.3)";
                    c.ctx.fillText(displayChar, cx, baselineY);
                    c.ctx.restore();
                }
            }
        }
        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            const childrenIds = c.curve_manager.treeItems.get(groupId)?.children || [];
            childrenIds.forEach((id) => {
                const item = c.curve_manager.treeItems.get(id);
                if (item && item.type === "image" && item.visible) {
                    c.ctx.save();
                    c.ctx.translate(offsetX + seqOffsetX * c.scale, offsetY);
                    c.ctx.scale(c.scale, c.scale);
                    const m = item.transform;
                    c.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                    c.ctx.drawImage(item.image, 0, 0);
                    c.ctx.restore();
                }
            });
        }
        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false });
            }
            c.ctx.beginPath();
            let hasFill = false;
            for (const cd of curveDataList) {
                if (!cd.effectiveVis) continue;
                if (cd.curve?.startNode) {
                    const refId = cd.refId ?? null;
                    const strokePreview = isCurveStrokePreview(c, cd.curve.id, refId);
                    if (!shouldBatchFillCurve(cd.curve, { strokePreview })) continue;
                    const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                    appendCurveFillPath(c.ctx, cd.curve, viewport, {
                        refId,
                        strokePreview: usePreviewSkeletonForBatchFill(cd.curve, { strokePreview })
                    });
                    hasFill = true;
                }
            }
            if (hasFill) { c.ctx.fillStyle = p.path_fill_color; c.ctx.fill("nonzero"); }
        }
        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false });
            }
            for (const cd of curveDataList) {
                if (!cd.effectiveVis) continue;
                if (cd.curve?.startNode) {
                    const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                    const refId = cd.refId ?? null;
                    drawCurveStroke(c.ctx, cd.curve, viewport, p, {
                        renderMode: "stroke",
                        refId,
                        strokePreview: isCurveStrokePreview(c, cd.curve.id, refId)
                    });
                }
            }
            if (c.hovered_curve_segment && c.getActiveTool() !== "SELECT" && c.hovered_curve_segment.seqIndex === i) {
                const seg = c.hovered_curve_segment;
                for (const cd of curveDataList) {
                    if (seg.curve === cd.curve && seg.refId === cd.refId) {
                        const current = seg.startNode; const next = seg.nextNode;
                        if (!current || !next) continue;
                        const pt = (x, y) => {
                            let mx = x, my = y;
                            if (cd.matrix) { mx = x * cd.matrix.a + y * cd.matrix.c + cd.matrix.e; my = x * cd.matrix.b + y * cd.matrix.d + cd.matrix.f; }
                            return { x: (mx + seqOffsetX) * c.scale + offsetX, y: my * c.scale + offsetY };
                        };
                        c.ctx.save(); c.ctx.beginPath();
                        let p0 = pt(current.x, current.y); c.ctx.moveTo(p0.x, p0.y);
                        let cp1 = pt(current.control1?.x ?? current.x, current.control1?.y ?? current.y);
                        let cp2 = pt(next.control2?.x ?? next.x, next.control2?.y ?? next.y);
                        let endP = pt(next.x, next.y);
                        c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endP.x, endP.y);
                        c.ctx.lineWidth = 3; c.ctx.strokeStyle = p.hovered_curve_stroke_color; c.ctx.stroke(); c.ctx.restore();
                    }
                }
            }
        }
        if (c.previewData && c.last_on_curve_node_marker) {
            const pd = c.previewData;
            c.ctx.beginPath(); c.ctx.moveTo(pd.p0_x, pd.p0_y); c.ctx.bezierCurveTo(pd.p1_x, pd.p1_y, pd.p2_x, pd.p2_y, pd.p3_x, pd.p3_y);
            c.ctx.strokeStyle = p.preview_color; c.ctx.lineWidth = 0.5; c.ctx.stroke();
            let curve = c.curve_manager.find_curve_by_dom(c.last_on_curve_node_marker) || c.current_curve;
            let closedBySetting = c.drawToolSettings?.closed === true;
            if (pd._p2_x !== undefined && curve && (curve.closed || closedBySetting)) {
                c.ctx.beginPath(); c.ctx.moveTo(pd.p0_x, pd.p0_y); c.ctx.bezierCurveTo(pd.p1_x, pd.p1_y, pd._p2_x, pd._p2_y, pd._p3_x, pd._p3_y);
                c.ctx.strokeStyle = p.preview_color; c.ctx.lineWidth = 0.5; c.ctx.stroke();
            }
        }
        // Ellipse drag preview
        if (c._ellipseWorldStartX !== undefined && c._ellipseWorldEndX !== undefined) {
            this._drawEllipsePreview(c, p);
        }
        {
            const rad = Math.PI / 180;
            const allGuides = c.user_guidelines ? [...c.user_guidelines] : [];
            if (c._draggingUserGuide && !allGuides.find(g => g.id === c._draggingUserGuide.id)) {
                allGuides.push(c._draggingUserGuide);
            }
            if (allGuides.length > 0) {
                const lockActive = !!c.guideline_lock;
                for (const g of allGuides) {
                    const screenX = g.x * c.scale + offsetX;
                    const screenY = g.y * c.scale + offsetY;
                    const a = (g.angle || 0) * rad;
                    const cosA = Math.cos(a), sinA = Math.sin(a);
                    const extend = 20000;
                    const isHovered = !lockActive && c._hoveredUserGuideId === g.id;
                    const isDragging = !lockActive && c._draggingUserGuide && c._draggingUserGuide.id === g.id;
                    let strokeColor, fillColor;
                    if (isDragging) {
                        strokeColor = "rgba(250, 204, 21, 0.7)";
                        fillColor = "rgba(250, 204, 21, 0.5)";
                    } else if (isHovered) {
                        strokeColor = "rgba(250, 204, 21, 0.8)";
                        fillColor = "rgba(250, 204, 21, 0.6)";
                    } else {
                        strokeColor = "rgba(2, 132, 199, 0.6)";
                        fillColor = "rgba(2, 132, 199, 0.4)";
                    }
                    c.ctx.save();
                    c.ctx.strokeStyle = strokeColor;
                    c.ctx.lineWidth = 1;
                    c.ctx.setLineDash([4, 4]);
                    c.ctx.beginPath();
                    c.ctx.moveTo(screenX - extend * cosA, screenY + extend * sinA);
                    c.ctx.lineTo(screenX + extend * cosA, screenY - extend * sinA);
                    c.ctx.stroke();
                    c.ctx.setLineDash([]);
                    c.ctx.fillStyle = fillColor;
                    c.ctx.beginPath();
                    c.ctx.arc(screenX, screenY, 2.5, 0, Math.PI * 2);
                    c.ctx.fill();
                    c.ctx.restore();
                }
            }
        }
        if (c.active_guidelines && c.active_guidelines.length > 0) {
            c.ctx.save(); c.ctx.strokeStyle = p.guideline_color; c.ctx.lineWidth = 1; c.ctx.setLineDash([4, 4]); c.ctx.beginPath();
            for (let g of c.active_guidelines) {
                if (g.type === "v") { let sx = g.value * c.scale + offsetX; c.ctx.moveTo(sx, 0); c.ctx.lineTo(sx, logicalH); }
                else if (g.type === "h") { let sy = g.value * c.scale + offsetY; c.ctx.moveTo(0, sy); c.ctx.lineTo(logicalW, sy); }
            }
            c.ctx.stroke(); c.ctx.restore();
        }
        if (c.getActiveTool() === "SELECT") {
            let bounds = c.utils.getSelectionBounds();
            if (bounds) {
                let minSX = bounds.minX * c.scale + offsetX; let minSY = bounds.minY * c.scale + offsetY;
                let maxSX = bounds.maxX * c.scale + offsetX; let maxSY = bounds.maxY * c.scale + offsetY;
                let pad = 1.5; minSX -= pad; minSY -= pad; maxSX += pad; maxSY += pad;
                let w = maxSX - minSX; let h = maxSY - minSY;
                let midSX = minSX + w / 2; let midSY = minSY + h / 2;
                c.ctx.save(); c.ctx.strokeStyle = p.select_box_stroke; c.ctx.lineWidth = 1; c.ctx.setLineDash([]); c.ctx.strokeRect(minSX, minSY, w, h);
                const drawHandle = (x, y, isRot = false) => {
                    c.ctx.fillStyle = p.select_handle_fill; c.ctx.strokeStyle = p.select_handle_stroke; c.ctx.lineWidth = 1; c.ctx.beginPath();
                    if (isRot) { c.ctx.arc(x, y, 4, 0, Math.PI * 2); } else { c.ctx.rect(x - 3, y - 3, 6, 6); }
                    c.ctx.fill(); c.ctx.stroke();
                };
                drawHandle(minSX, minSY); drawHandle(midSX, minSY); drawHandle(maxSX, minSY);
                drawHandle(minSX, midSY); drawHandle(maxSX, midSY);
                drawHandle(minSX, maxSY); drawHandle(midSX, maxSY); drawHandle(maxSX, maxSY);
                c.ctx.beginPath(); c.ctx.moveTo(midSX, minSY); c.ctx.lineTo(midSX, minSY - 20); c.ctx.stroke(); drawHandle(midSX, minSY - 20, true);
                c.ctx.restore();
            }
        }
        if ((c.getActiveTool() === "SELECT" || c.getActiveTool() === "NODE") && c.is_box_selecting && c.box_select_start && c.box_select_end) {
            c.ctx.save(); c.ctx.strokeStyle = p.marquee_stroke; c.ctx.fillStyle = p.marquee_fill; c.ctx.lineWidth = 1; c.ctx.setLineDash([4, 4]);
            let x = Math.min(c.box_select_start.x, c.box_select_end.x); let y = Math.min(c.box_select_start.y, c.box_select_end.y);
            let w = Math.abs(c.box_select_start.x - c.box_select_end.x); let h = Math.abs(c.box_select_start.y - c.box_select_end.y);
            c.ctx.fillRect(x, y, w, h); c.ctx.strokeRect(x, y, w, h); c.ctx.restore();
        }
        // ── Render persistent rulers ──
        for (const ruler of (c.rulers || [])) {
            this._drawRuler(c, ruler, offsetX, offsetY, p);
        }
        // ── Render current measure drag ──
        if (c.getActiveTool() === "MEASURE" && c.measure_start && c.measure_end) {
            let sx = c.measure_start.x * c.scale + offsetX; let sy = c.measure_start.y * c.scale + offsetY;
            let ex = c.measure_end.x * c.scale + offsetX; let ey = c.measure_end.y * c.scale + offsetY;
            c.ctx.save(); c.ctx.strokeStyle = p.measure_color; c.ctx.lineWidth = 1;
            c.ctx.setLineDash([3, 3]);
            c.ctx.beginPath(); c.ctx.moveTo(sx, sy); c.ctx.lineTo(ex, ey); c.ctx.stroke();
            c.ctx.setLineDash([]);
            c.ctx.fillStyle = p.measure_color; c.ctx.beginPath(); c.ctx.arc(sx, sy, 3, 0, Math.PI * 2); c.ctx.fill();
            c.ctx.beginPath(); c.ctx.arc(ex, ey, 3, 0, Math.PI * 2); c.ctx.fill();
            let dx = c.measure_end.x - c.measure_start.x; let dy = c.measure_end.y - c.measure_start.y;
            let length = Math.hypot(dx, dy); let angleRad = Math.atan2(-dy, dx); let angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
            let text = `L: ${length.toFixed(1)}, A: ${angleDeg}°`; c.ctx.font = "12px sans-serif";
            let midX = (sx + ex) / 2, midY = (sy + ey) / 2;
            c.ctx.fillStyle = p.measure_color; c.ctx.fillText(text, midX + 5, midY - 3); c.ctx.restore();
        }
        let showHandlesSet = new Set();
        for (let i = 0; i < seqTokens.length; i++) {
            if (!activeIndices.has(i)) continue;
            let token = seqTokens[i]; let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false });
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
        let unselectedNodeRenders = []; let selectedNodeRenders = [];
        if (c.curve_manager.activeSequenceIndices.size > 0) {
            c.ctx.save(); c.ctx.strokeStyle = p.canvas_divider; c.ctx.setLineDash([4, 4]); c.ctx.lineWidth = 1; c.ctx.beginPath();
            let hoveredScreenX = null;
            for (let i = 0; i < seqTokens.length; i++) {
                if (!activeIndices.has(i)) continue;
                let seqOffsetX = c.curve_manager.getSeqOffset(i); let sx = seqOffsetX * c.scale + offsetX;
                c.ctx.moveTo(sx, 0); c.ctx.lineTo(sx, logicalH);
                let token = seqTokens[i]; let gid = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let group = c.curve_manager.treeItems.get(gid); let advance = (group && group.advance !== undefined) ? group.advance : 1000;
                let ex = (seqOffsetX + advance) * c.scale + offsetX;
                let rightId = gid + "-" + i + "-r";
                let isHov = !c.guideline_lock && (c._hoveredDividerId === rightId || (c._draggingDivider && c._draggingDivider.dividerId === rightId));
                if (isHov) {
                    hoveredScreenX = ex;
                } else {
                    c.ctx.moveTo(ex, 0); c.ctx.lineTo(ex, logicalH);
                }
            }
            c.ctx.stroke(); c.ctx.restore();
            if (hoveredScreenX !== null) {
                c.ctx.save(); c.ctx.strokeStyle = "rgba(250, 204, 21, 0.8)"; c.ctx.setLineDash([4, 4]); c.ctx.lineWidth = 1;
                c.ctx.beginPath(); c.ctx.moveTo(hoveredScreenX, 0); c.ctx.lineTo(hoveredScreenX, logicalH); c.ctx.stroke(); c.ctx.restore();
            }
        }
        for (let i = 0; i < seqTokens.length; i++) {
            if (!activeIndices.has(i)) continue;
            let seqOffsetX = c.curve_manager.getSeqOffset(i); let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);
            if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                if (!curveDataList.find((cd) => cd.curve === c.current_curve)) curveDataList.push({ curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false });
            }
            for (const cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                if (c.getActiveTool() === "SELECT" || c.getActiveTool() === "MEASURE" || c.getActiveTool() === "ELLIPSE") continue;
                if (c.getActiveTool() === "DRAW" && cd.curve !== c.current_curve) continue;
                let start_node = cd.curve.startNode;
                while (start_node !== null) {
                    let isSelected = snapshotIncludesNodeMarker(ix, start_node.main_node);
                    let showHandles = showHandlesSet.has(start_node);
                    let hoverStates = { main: c.hovered_node_marker === start_node.main_node, c1: start_node.control1 && c.hovered_node_marker === start_node.control1.main_node, c2: start_node.control2 && c.hovered_node_marker === start_node.control2.main_node };
                    let nodeToDraw = start_node; let z = start_node.last_touched || 0;
                    const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                    let drawFn = () => {
                        c.ctx.save();
                        drawCurveNode(c.ctx, nodeToDraw, viewport, p, { isSelected, hoverStates, showHandles });
                        c.ctx.restore();
                    };
                    if (isSelected) { selectedNodeRenders.push({ fn: drawFn, z: z }); } else { unselectedNodeRenders.push({ fn: drawFn, z: z }); }
                    start_node = start_node.nextOnCurve;
                }
            }
        }
        unselectedNodeRenders.sort((a, b) => a.z - b.z).forEach((item) => item.fn());
        selectedNodeRenders.sort((a, b) => a.z - b.z).forEach((item) => item.fn());
    }
    update_previewData(mouseX, mouseY) {
        const c = this.canvas;
        if (c.last_on_curve_node_marker !== null) {
            let lastNode = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!lastNode) return;
            let seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            let p0_x = mouseX, p0_y = mouseY; let p1_x = p0_x, p1_y = p0_y;
            let p3_x = (lastNode.x + seqOffsetX) * c.scale + offsetX; let p3_y = lastNode.y * c.scale + offsetY;
            let p2_x = ((lastNode.control1?.x ?? lastNode.x) + seqOffsetX) * c.scale + offsetX; let p2_y = (lastNode.control1?.y ?? lastNode.y) * c.scale + offsetY;
            let curve = c.curve_manager.find_curve_by_dom(c.last_on_curve_node_marker) || c.current_curve;
            let previewObj = { p0_x, p0_y, p1_x, p1_y, p2_x, p2_y, p3_x, p3_y };
            if (curve && curve.startNode) {
                previewObj._p3_x = (curve.startNode.x + seqOffsetX) * c.scale + offsetX; previewObj._p3_y = curve.startNode.y * c.scale + offsetY;
                previewObj._p2_x = ((curve.startNode.control2?.x ?? curve.startNode.x) + seqOffsetX) * c.scale + offsetX; previewObj._p2_y = (curve.startNode.control2?.y ?? curve.startNode.y) * c.scale + offsetY;
            }
            c.previewData = previewObj;
        } else {
            c.previewData = null;
        }
    }
    getStepAndPrecision(scale) {
        const c = this.canvas;
        const roughStep = 50 / scale;
        const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
        let step = steps[0];
        for (const s of steps) { if (s >= roughStep) { step = s; break; } }
        let precision = 0; if (step < 1) { precision = Math.ceil(-Math.log10(step)); }
        return { step, precision };
    }
    update_ruler() { this.update_ruler_horizontal(); this.update_ruler_vertical(); }
    update_ruler_horizontal() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const w = Number.isFinite(viewport.viewportWidth) ? viewport.viewportWidth : 0;
        const h = Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size;
        if (w <= 0 || h <= 0) return;
        c.ruler_horizontal.replaceChildren();
        const svg = c.env.createSVGElement("svg");
        svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
        svg.classList.add("svg-ruler-overlay");
        const { step, precision } = this.getStepAndPrecision(c.scale);
        const origin = c.offset.x;
        const theme = getCanvasTheme();
        const textColor = theme.ruler_text_color;
        const lineColor = theme.ruler_line_color;
        let start_i = Math.floor(-10 * origin / (c.scale * step)) - 10;
        let end_i = Math.ceil(10 * (w - origin) / (c.scale * step)) + 10;
        for (let i = start_i; i <= end_i; i++) {
            let j = i / 10; const x = origin + j * c.scale * step;
            if (x < -c.scale * step || x > w + c.scale * step) continue;
            const line = c.env.createSVGElement("line");
            line.setAttribute("x1", String(x)); line.setAttribute("y1", String(h)); line.setAttribute("x2", String(x));
            if (i % 10 === 0) {
                line.setAttribute("y2", "0");
                const text = c.env.createSVGElement("text"); text.textContent = `${(j * step).toFixed(precision)}`;
                text.setAttribute("x", String(x + 5)); text.setAttribute("y", String(h / 3)); text.setAttribute("font-size", "10px"); text.setAttribute("fill", textColor); text.setAttribute("text-anchor", "right"); text.setAttribute("dominant-baseline", "middle");
                svg.appendChild(text);
            } else if (i % 2 === 0) { line.setAttribute("y2", String(h / 2)); } else { line.setAttribute("y2", String(h / 4 * 3)); }
            line.setAttribute("stroke", lineColor); line.setAttribute("stroke-width", "1"); svg.appendChild(line);
        }
        c.ruler_horizontal.appendChild(svg);
    }
    update_ruler_vertical() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const w = Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size;
        const h = Number.isFinite(viewport.viewportHeight) ? viewport.viewportHeight : 0;
        if (w <= 0 || h <= 0) return;
        c.ruler_vertical.replaceChildren();
        const svg = c.env.createSVGElement("svg");
        svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
        svg.classList.add("svg-ruler-overlay");
        const { step, precision } = this.getStepAndPrecision(c.scale);
        const bottomOrigin = c.offset.y + c.canvas_size_height * c.scale;
        const theme = getCanvasTheme();
        const textColor = theme.ruler_text_color;
        const lineColor = theme.ruler_line_color;
        let start_i = Math.floor(10 * (bottomOrigin - h) / (c.scale * step)) - 10;
        let end_i = Math.ceil(10 * bottomOrigin / (c.scale * step)) + 10;
        for (let i = start_i; i <= end_i; i++) {
            let j = i / 10; const y = bottomOrigin - j * c.scale * step;
            if (y < -c.scale * step || y > h + c.scale * step) continue;
            const line = c.env.createSVGElement("line");
            line.setAttribute("y1", String(y)); line.setAttribute("x1", String(w)); line.setAttribute("y2", String(y));
            if (i % 10 === 0) {
                line.setAttribute("x2", "0");
                const cx = w / 3; const cy = y - 5;
                const text = c.env.createSVGElement("text"); text.textContent = `${(j * step).toFixed(precision)}`;
                text.setAttribute("x", String(cx)); text.setAttribute("y", String(cy)); text.setAttribute("font-size", "10px"); text.setAttribute("fill", textColor); text.setAttribute("text-anchor", "right"); text.setAttribute("dominant-baseline", "middle"); text.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
                svg.appendChild(text);
            } else if (i % 2 === 0) { line.setAttribute("x2", String(w / 2)); } else { line.setAttribute("x2", String(w / 4 * 3)); }
            line.setAttribute("stroke", lineColor); line.setAttribute("stroke-width", "1"); svg.appendChild(line);
        }
        c.ruler_vertical.appendChild(svg);
    }
    update_canvas() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const left = (Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size) + c.offset.x;
        const top = (Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size) + c.offset.y;
        let w;
        const tokens = c.curve_manager?.sequenceTokens || [];
        if (tokens.length > 0) {
            const lastIdx = tokens.length - 1;
            const lastOff = c.curve_manager.getSeqOffset(lastIdx);
            const lastToken = tokens[lastIdx];
            const lastGid = lastToken.isChar ? c.curve_manager.getDefaultGroupForChar(lastToken.value) : lastToken.value;
            const lastGroup = c.curve_manager.treeItems.get(lastGid);
            const lastAdv = (lastGroup && lastGroup.advance !== undefined) ? lastGroup.advance : 1000;
            w = lastOff + lastAdv;
        } else {
            w = c.canvas_size_width;
        }
        c.main_canvas.style.transform = `translate(${left}px, ${top}px)`;
        c.main_canvas.style.width = `${w * c.scale}px`;
        c.main_canvas.style.height = `${c.canvas_size_height * c.scale}px`;
    }
    change_canvas_size(dy, x, y, fixed, viewportCenter = false) {
        const c = this.canvas;
        if (viewportCenter) {
            const viewport = c.viewportConfig || {};
            const rect = {
                width: Number.isFinite(viewport.viewportWidth) ? viewport.viewportWidth : 0,
                height: Number.isFinite(viewport.viewportHeight) ? viewport.viewportHeight : 0
            };
            const ruler_w = Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size;
            const ruler_h = Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size;
            x = (rect.width / 2) - ruler_w - c.offset.x;
            y = (rect.height / 2) - ruler_h - c.offset.y;
        } else if (fixed) {
            x = c.canvas_size_width / 2 * c.scale; y = c.canvas_size_height / 2 * c.scale;
        }
        // Geometric zoom via zoomTicks: scale = scaleBase * factor^zoomTicks
        const oldTicks = c.zoomTicks;
        c.zoomTicks += dy < 0 ? 1 : -1;
        let new_scale = c.zoomTicksToScale(c.zoomTicks);
        // If clamping hit the boundary, revert zoomTicks
        if (new_scale === c.scale && c.zoomTicks !== oldTicks) {
            c.zoomTicks = oldTicks;
            return;
        }
        const x_new = x / c.scale * new_scale; const y_new = y / c.scale * new_scale;
        c.scale = new_scale;
        c.offset = { x: (c.offset.x + x - x_new), y: (c.offset.y + y - y_new) };
        c.editorStore?.syncViewFromCanvas?.();
        c.history.saveCurrentViewState();
    }
    _drawRuler(c, ruler, offsetX, offsetY, p) {
        if (!ruler || ruler.x1 === undefined) return;
        let sx = ruler.x1 * c.scale + offsetX; let sy = ruler.y1 * c.scale + offsetY;
        let ex = ruler.x2 * c.scale + offsetX; let ey = ruler.y2 * c.scale + offsetY;
        let isLineHovered = c._hoveredRulerId === ruler.id;
        const ep = c._hoveredRulerEndpoint;
        let isStartHovered = ep?.rulerId === ruler.id && ep?.endpoint === 'start';
        let isEndHovered = ep?.rulerId === ruler.id && ep?.endpoint === 'end';
        let lineColor = isLineHovered ? "#facc15" : p.measure_color;
        let lineWidth = isLineHovered ? 2 : 1;
        c.ctx.save();
        c.ctx.strokeStyle = lineColor; c.ctx.lineWidth = lineWidth;
        c.ctx.beginPath(); c.ctx.moveTo(sx, sy); c.ctx.lineTo(ex, ey); c.ctx.stroke();
        let startColor = isStartHovered ? "#facc15" : p.measure_color;
        let endColor = isEndHovered ? "#facc15" : p.measure_color;
        c.ctx.fillStyle = startColor; c.ctx.beginPath(); c.ctx.arc(sx, sy, 4, 0, Math.PI * 2); c.ctx.fill();
        c.ctx.fillStyle = endColor; c.ctx.beginPath(); c.ctx.arc(ex, ey, 4, 0, Math.PI * 2); c.ctx.fill();
        let dx = ruler.x2 - ruler.x1; let dy = ruler.y2 - ruler.y1;
        let length = Math.hypot(dx, dy); let angleRad = Math.atan2(-dy, dx); let angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
        let text = `L: ${length.toFixed(1)}, A: ${angleDeg}°`; c.ctx.font = "12px sans-serif";
        let midX = (sx + ex) / 2, midY = (sy + ey) / 2;
        c.ctx.fillStyle = p.measure_color; c.ctx.fillText(text, midX + 5, midY - 3);
        c.ctx.restore();
    }

    _drawEllipsePreview(c, p) {
        const rawSx = c._ellipseWorldStartX, rawSy = c._ellipseWorldStartY;
        const rawEx = c._ellipseWorldEndX, rawEy = c._ellipseWorldEndY;
        if (rawSx === undefined || rawEx === undefined) return;

        // Collect all sequence offsets for the active group's instances
        const offsets = this._getGroupSeqOffsets(c);
        if (!offsets || offsets.length === 0) return;
        const masterOff = offsets[0];

        for (const instOff of offsets) {
            const dx = instOff - masterOff;
            this._drawOneEllipseAt(c, p,
                (rawSx + dx) * c.scale,
                rawSy * c.scale,
                (rawEx + dx) * c.scale,
                rawEy * c.scale);
        }
    }

    _getGroupSeqOffsets(c) {
        const activeGroupId = c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) return null;
        const seqTokens = c.curve_manager.sequenceTokens || [];
        const offsets = [];
        let foundActive = false;
        for (let i = 0; i < seqTokens.length; i++) {
            const t = seqTokens[i];
            const gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
            if (gid === activeGroupId) {
                const off = c.curve_manager.getSeqOffset(i);
                offsets.push(off);
                if (c.curve_manager.activeSequenceIndices?.has(i) && !foundActive) {
                    foundActive = true;
                    // Swap so the active instance is first (master)
                    if (offsets.length > 1) {
                        const tmp = offsets[0];
                        offsets[0] = off;
                        offsets[offsets.length - 1] = tmp;
                    }
                }
            }
        }
        return offsets;
    }

    _drawOneEllipseAt(c, p, sx, sy, ex, ey) {
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        sx += offsetX; sy += offsetY; ex += offsetX; ey += offsetY;

        const minSX = Math.min(sx, ex), minSY = Math.min(sy, ey);
        const maxSX = Math.max(sx, ex), maxSY = Math.max(sy, ey);
        const pad = 1.5;

        // Selection-style bounding rectangle (solid, no handles)
        c.ctx.save();
        c.ctx.strokeStyle = p.select_box_stroke;
        c.ctx.lineWidth = 1;
        c.ctx.setLineDash([]);
        c.ctx.strokeRect(minSX - pad, minSY - pad, maxSX - minSX + pad * 2, maxSY - minSY + pad * 2);
        c.ctx.restore();

        // Ellipse dimensions
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        let rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
        if (c._ellipseIsCtrl) { const r = Math.max(rx, ry); rx = ry = r; }
        if (rx < 0.5 || ry < 0.5) return;

        const k = 0.5522847498;
        const kx = k * rx, ky = k * ry;

        // control1 = outgoing from current node; control2 = incoming to next node
        const nodes = [
            { x: cx + rx, y: cy,     c1x: cx + rx, c1y: cy + ky, c2x: cx + rx, c2y: cy - ky },
            { x: cx,      y: cy + ry, c1x: cx - kx, c1y: cy + ry, c2x: cx + kx, c2y: cy + ry },
            { x: cx - rx, y: cy,     c1x: cx - rx, c1y: cy - ky, c2x: cx - rx, c2y: cy + ky },
            { x: cx,      y: cy - ry, c1x: cx + kx, c1y: cy - ry, c2x: cx - kx, c2y: cy - ry }
        ];

        // Draw filled ellipse (same as final result)
        c.ctx.save();
        c.ctx.beginPath();
        c.ctx.moveTo(nodes[0].x, nodes[0].y);
        for (let i = 0; i < 4; i++) {
            const n0 = nodes[i];
            const n1 = nodes[(i + 1) % 4];
            c.ctx.bezierCurveTo(n0.c1x, n0.c1y, n1.c2x, n1.c2y, n1.x, n1.y);
        }
        c.ctx.closePath();
        c.ctx.fillStyle = p.path_fill_color;
        c.ctx.fill("nonzero");
        c.ctx.strokeStyle = p.path_stroke_color;
        c.ctx.lineWidth = 1;
        c.ctx.stroke();
        c.ctx.restore();
    }
}
