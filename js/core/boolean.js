// js/core/boolean.js
import { CurveNode } from "./bezier/node.js";
import { getPaperScope } from "./paper_scope.js";
import { param_set } from "../services/theme.js";

export class BooleanEngine {
    constructor(curveManager) {
        this.cm = curveManager;
        this.paperScope = getPaperScope();
    }

    executeUnion(InkShaderCurves, targetGroupId) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        let allSolidPieces = [];

        for (let curve of InkShaderCurves) {
            if (typeof curve.updateBooleanCache === 'function') {
                curve.updateBooleanCache();
            }

            if (!Array.isArray(curve.cached_boolean_geometry) || curve.cached_boolean_geometry.length === 0) {
                continue;
            }

            for (let sub of curve.cached_boolean_geometry) {
                if (sub.segments.length < 2) continue;

                let p = new this.paperScope.Path();
                p.closed = sub.closed;

                for (let seg of sub.segments) {
                    p.add(new this.paperScope.Segment(
                        new this.paperScope.Point(seg.x, seg.y),
                        new this.paperScope.Point(seg.inX, seg.inY),
                        new this.paperScope.Point(seg.outX, seg.outY)
                    ));
                }
                
                p.reorient(true, true);
                allSolidPieces.push(p);
            }
        }

        if (allSolidPieces.length === 0) return false;

        let resultPath = allSolidPieces[0];
        
        for (let i = 1; i < allSolidPieces.length; i++) {
            let nextPiece = allSolidPieces[i];
            try {
                nextPiece.rotate(0.0001, nextPiece.position);
                nextPiece.translate(new this.paperScope.Point(0.0001, 0.0001));
                
                let temp = resultPath.unite(nextPiece);
                
                resultPath.remove();
                nextPiece.remove();
                resultPath = temp;
                resultPath.reorient(true, true);
            } catch (e) {
                console.warn("[Boolean] Skipping a complex sub-path intersection", e);
                nextPiece.remove();
            }
        }

        let newInkShaderCurves = this._paperToInkShaderCurves(resultPath, targetGroupId);

        if (resultPath) resultPath.remove();
        for (let curve of InkShaderCurves) {
            this.cm.remove_curve(curve.id);
        }

        return newInkShaderCurves;
    }

    _paperToInkShaderCurves(paperItem, targetGroupId) {
        let generatedCurves = [];
        let pathsToProcess = [];

        if (paperItem instanceof this.paperScope.CompoundPath) {
            pathsToProcess = paperItem.children;
        } else if (paperItem instanceof this.paperScope.Path) {
            pathsToProcess = [paperItem];
        } else if (paperItem instanceof this.paperScope.Group) {
            pathsToProcess = paperItem.children.filter(c => c instanceof this.paperScope.Path || c instanceof this.paperScope.CompoundPath);
        }

        if (pathsToProcess.length === 0) return [];

        for (let pPath of pathsToProcess) {
            if (pPath instanceof this.paperScope.CompoundPath) {
                generatedCurves.push(...this._paperToInkShaderCurves(pPath, targetGroupId));
                continue;
            }

            if (!pPath.segments || pPath.segments.length < 2) continue;

            let InkShaderCurve = this.cm.create_temp_curve("a"); 
            InkShaderCurve.closed = pPath.closed;
            InkShaderCurve.stroke_width = 0; 
            InkShaderCurve.fill_color = param_set["1"].boolean_fill;

            let lastCreatedNode = null;

            for (let i = 0; i < pPath.segments.length; i++) {
                let seg = pPath.segments[i];
                let pt = seg.point;
                
                let controlMode = 0; 
                if (!seg.handleIn.isZero() && !seg.handleOut.isZero()) {
                    let vIn = seg.handleIn.normalize();
                    let vOut = seg.handleOut.normalize();
                    if (vIn.add(vOut).length < 0.01) {
                        controlMode = 1; 
                    }
                }

                let uniqueHex = Date.now().toString(36) + "_" + Math.floor(Math.random() * 100000);
                let marker = { id: `m_v_${uniqueHex}`, type: "vertex" };
                
                let node = new CurveNode(marker, "vertex", pt.x, pt.y, null, lastCreatedNode, `n_${uniqueHex}`);
                node.curve = InkShaderCurve;
                node.control_mode = controlMode;

                this.cm.domMap.set(marker, node);

                if (!seg.handleOut.isZero()) {
                    let c1x = pt.x + seg.handleOut.x;
                    let c1y = pt.y + seg.handleOut.y;
                    let c1M = { id: `m_c1_${uniqueHex}`, type: "circle" };
                    node.control1 = new CurveNode(c1M, null, c1x, c1y, node, null, c1M.id);
                    node.control1.curve = InkShaderCurve;
                    this.cm.domMap.set(c1M, node.control1);
                }

                if (!seg.handleIn.isZero()) {
                    let c2x = pt.x + seg.handleIn.x;
                    let c2y = pt.y + seg.handleIn.y;
                    let c2M = { id: `m_c2_${uniqueHex}`, type: "circle" };
                    node.control2 = new CurveNode(c2M, null, c2x, c2y, node, null, c2M.id);
                    node.control2.curve = InkShaderCurve;
                    this.cm.domMap.set(c2M, node.control2);
                }

                if (!InkShaderCurve.startNode) InkShaderCurve.startNode = node;
                if (lastCreatedNode) lastCreatedNode.nextOnCurve = node;

                lastCreatedNode = node;
                
                if (i === pPath.segments.length - 1) {
                    InkShaderCurve.endNode = node;
                }
            }

            this.cm.commit_curve(InkShaderCurve, targetGroupId);
            generatedCurves.push(InkShaderCurve);
        }

        return generatedCurves;
    }
}