// js/core/boolean.js
import { CurveNode } from "./bezier/node.js";
import { getPaperScope } from "./paper_scope.js";

export class BooleanEngine {
    constructor(curveManager) {
        this.cm = curveManager;
        this.paperScope = getPaperScope();
    }

    executeUnion(AntumbraCurves, targetGroupId) {
        if (!this.paperScope || !AntumbraCurves || AntumbraCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        let allSolidPieces = [];

        for (let curve of AntumbraCurves) {
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

        let newAntumbraCurves = this._paperToAntumbraCurves(resultPath, targetGroupId);

        if (resultPath) resultPath.remove();
        for (let curve of AntumbraCurves) {
            this.cm.remove_curve(curve.id);
        }

        return newAntumbraCurves;
    }

    _paperToAntumbraCurves(paperItem, targetGroupId) {
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
                generatedCurves.push(...this._paperToAntumbraCurves(pPath, targetGroupId));
                continue;
            }

            if (!pPath.segments || pPath.segments.length < 2) continue;

            let AntumbraCurve = this.cm.create_temp_curve("a"); 
            AntumbraCurve.closed = pPath.closed;
            AntumbraCurve.stroke_width = 0; 
            AntumbraCurve.fill_color = "rgba(0,0,0,1)";

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
                node.curve = AntumbraCurve;
                node.control_mode = controlMode;

                this.cm.domMap.set(marker, node);

                if (!seg.handleOut.isZero()) {
                    let c1x = pt.x + seg.handleOut.x;
                    let c1y = pt.y + seg.handleOut.y;
                    let c1M = { id: `m_c1_${uniqueHex}`, type: "circle" };
                    node.control1 = new CurveNode(c1M, null, c1x, c1y, node, null, c1M.id);
                    node.control1.curve = AntumbraCurve;
                    this.cm.domMap.set(c1M, node.control1);
                }

                if (!seg.handleIn.isZero()) {
                    let c2x = pt.x + seg.handleIn.x;
                    let c2y = pt.y + seg.handleIn.y;
                    let c2M = { id: `m_c2_${uniqueHex}`, type: "circle" };
                    node.control2 = new CurveNode(c2M, null, c2x, c2y, node, null, c2M.id);
                    node.control2.curve = AntumbraCurve;
                    this.cm.domMap.set(c2M, node.control2);
                }

                if (!AntumbraCurve.startNode) AntumbraCurve.startNode = node;
                if (lastCreatedNode) lastCreatedNode.nextOnCurve = node;

                lastCreatedNode = node;
                
                if (i === pPath.segments.length - 1) {
                    AntumbraCurve.endNode = node;
                }
            }

            this.cm.commit_curve(AntumbraCurve, targetGroupId);
            generatedCurves.push(AntumbraCurve);
        }

        return generatedCurves;
    }
}