/**
 * 曲线布尔熔合几何缓存（Paper.js）；无 DOM、无 Canvas 呈现 API。
 */
import { getPaperScope } from "./paper_scope.js";
import {
    emitCubicBezierSegments,
    emitExpandedStrokeOutline
} from "./bezier/path_emitter.js";

class LocalRecorder {
    constructor() {
        this.paths = [];
        this.curr = null;
    }
    moveTo(x, y) {
        this.curr = [];
        this.paths.push(this.curr);
        this.curr.push({ t: "M", x, y });
    }
    lineTo(x, y) {
        if (this.curr) this.curr.push({ t: "L", x, y });
    }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
        if (this.curr) this.curr.push({ t: "C", c1x, c1y, c2x, c2y, x, y });
    }
    closePath() {
        if (this.curr) this.curr.push({ t: "Z" });
    }
}

function buildPaperPaths(pScope, recorder) {
    const pathList = [];
    for (const sub of recorder.paths) {
        if (sub.length === 0) continue;
        const p = new pScope.Path();
        for (const cmd of sub) {
            if (cmd.t === "M") p.moveTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "L") p.lineTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "C") {
                p.cubicCurveTo(
                    new pScope.Point(cmd.c1x, cmd.c1y),
                    new pScope.Point(cmd.c2x, cmd.c2y),
                    new pScope.Point(cmd.x, cmd.y)
                );
            } else if (cmd.t === "Z") p.closed = true;
        }
        for (const seg of p.segments) {
            if (seg.handleIn && seg.handleIn.length < 0.001) seg.handleIn.set(0, 0);
            if (seg.handleOut && seg.handleOut.length < 0.001) seg.handleOut.set(0, 0);
        }
        pathList.push(p);
    }
    return pathList;
}

/** 根据曲线当前几何刷新 cached_boolean_geometry */
export function refreshCurveBooleanCache(curve) {
    const pScope = getPaperScope();
    if (!pScope || !curve?.startNode) {
        curve.cached_boolean_geometry = null;
        return;
    }

    const identity = (x, y) => ({ x, y });
    const allSolidPieces = [];
    const hasFillArea = curve.closed && curve.startNode !== curve.endNode;

    if (hasFillArea) {
        const fillRec = new LocalRecorder();
        emitCubicBezierSegments(fillRec, curve.getSkeletonBezierSegments(), identity, {
            close: curve.closed && curve.startNode !== curve.endNode
        });
        allSolidPieces.push(...buildPaperPaths(pScope, fillRec));
    }

    if (curve.smart_stroke && curve.stroke_width > 0) {
        const outline = curve.computeExpandedStrokeOutline(curve.stroke_width / 2);
        if (outline) {
            const strokeRec = new LocalRecorder();
            emitExpandedStrokeOutline(strokeRec, outline, identity);
            allSolidPieces.push(...buildPaperPaths(pScope, strokeRec));
        }
    }

    if (allSolidPieces.length === 0) {
        curve.cached_boolean_geometry = null;
        return;
    }

    let resultPath = allSolidPieces[0];
    for (let i = 1; i < allSolidPieces.length; i++) {
        const nextPiece = allSolidPieces[i];
        try {
            nextPiece.rotate(0.0001, nextPiece.position);
            nextPiece.translate(new pScope.Point(0.0001, 0.0001));
            const temp = resultPath.unite(nextPiece);
            resultPath.remove();
            nextPiece.remove();
            resultPath = temp;
        } catch (e) {
            console.warn("Boolean melting step failed for a sub-path", e);
            nextPiece.remove();
        }
    }

    if (curve.smart_stroke && curve.stroke_width > 0 && resultPath && typeof resultPath.reorient === "function") {
        try {
            resultPath.reorient(true, curve.smart_stroke_clockwise);
        } catch (e) {
            console.warn("Smart-stroke winding reorient failed", e);
        }
    }

    curve.cached_boolean_geometry = [];
    const paths = resultPath instanceof pScope.CompoundPath ? resultPath.children : [resultPath];
    for (const p of paths) {
        if (!(p instanceof pScope.Path) || p.segments.length < 2) continue;
        const subGeom = [];
        for (const seg of p.segments) {
            subGeom.push({
                x: seg.point.x,
                y: seg.point.y,
                inX: seg.handleIn.x,
                inY: seg.handleIn.y,
                outX: seg.handleOut.x,
                outY: seg.handleOut.y
            });
        }
        curve.cached_boolean_geometry.push({ closed: p.closed, segments: subGeom });
    }

    if (curve.cached_boolean_geometry.length === 0) {
        curve.cached_boolean_geometry = null;
    }

    if (resultPath) resultPath.remove();
}
