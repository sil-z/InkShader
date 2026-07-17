// js/core/boolean.js
import { CurveNode } from "./bezier/node.js";
import { generateMarker } from "./bezier/utils.js";
import { getPaperScope } from "./paper_scope.js";
import { param_set } from "../services/theme.js";

export class BooleanEngine {
    constructor(curveManager) {
        this.cm = curveManager;
        this.paperScope = getPaperScope();
    }

    // ── Fragment helpers ──────────────────────────────────────────────────────

    /**
     * Unpack a Paper.js CompoundPath into individual Path fragments.
     * - CompoundPath → extract its valid children (each becomes standalone).
     * - Path → return as single-element array.
     * - null/invalid → empty array.
     * Degenerate children (segments < 2) are removed and not returned.
     */
    _unpackFragments(paperItem) {
        if (!paperItem) return [];
        if (paperItem instanceof this.paperScope.CompoundPath) {
            const out = [];
            for (const child of paperItem.children) {
                if (!(child instanceof this.paperScope.Path) || child.segments.length < 2) {
                    child.remove();
                    continue;
                }
                out.push(child);
            }
            return out;
        }
        if (paperItem instanceof this.paperScope.Path && paperItem.segments.length >= 2) {
            return [paperItem];
        }
        return [];
    }

    /**
     * Reorient a Paper.js Path to clockwise winding, safely (no-op on null).
     */
    _reorientCW(p) {
        if (p && typeof p.reorient === 'function') {
            try { p.reorient(true, true); } catch (_) {}
        }
    }

    executeUnion(InkShaderCurves, targetGroupId) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        const { basePieces, operandPieces } = this._buildPaperPaths(InkShaderCurves);
        if (basePieces.length === 0 || operandPieces.length === 0) return false;

        let results = [];
        for (const base of basePieces) {
            try {
                let current = base;
                for (const op of operandPieces) {
                    const opClone = op.clone();
                    opClone.rotate(0.0001, opClone.position);
                    opClone.translate(new this.paperScope.Point(0.0001, 0.0001));
                    const temp = current.unite(opClone);
                    current.remove();
                    opClone.remove();
                    current = temp;
                }
                if (!current) continue;
                const flat = this._unpackFragments(current);
                for (const p of flat) results.push(p);
                if (current && flat.length > 0 && current !== flat[0]) current.remove();
            } catch (e) {
                console.warn("[Boolean] Union fragment failed", e);
            }
        }

        for (const op of operandPieces) op.remove();

        if (results.length === 0) return false;

        let resultPath;
        if (results.length === 1) {
            resultPath = results[0];
        } else {
            resultPath = new this.paperScope.CompoundPath({ children: results });
        }

        let newInkShaderCurves = this._paperToInkShaderCurves(resultPath, targetGroupId);
        if (resultPath) resultPath.remove();
        for (let curve of InkShaderCurves) {
            this.cm.remove_curve(curve.id);
        }
        return newInkShaderCurves;
    }

    _buildPaperPaths(InkShaderCurves) {
        // Returns [basePieces, operandPieces] where basePieces are the sub-pieces
        // of the first curve and operandPieces are sub-pieces of all remaining curves.
        let basePieces = [];
        let operandPieces = [];
        for (let i = 0; i < InkShaderCurves.length; i++) {
            const curve = InkShaderCurves[i];
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
                (i === 0 ? basePieces : operandPieces).push(p);
            }
        }
        return { basePieces, operandPieces };
    }

    _executeBinaryOp(InkShaderCurves, targetGroupId, opFn) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        const { basePieces, operandPieces } = this._buildPaperPaths(InkShaderCurves);
        if (basePieces.length === 0 || operandPieces.length === 0) return false;

        // For each base sub-piece, apply opFn against all operand sub-pieces.
        let results = [];
        for (const base of basePieces) {
            try {
                let current = base;
                for (const op of operandPieces) {
                    // Clone operand for each base fragment — avoid double-remove
                    // when multiple base fragments share the same operand.
                    const opClone = op.clone();
                    opClone.rotate(0.0001, opClone.position);
                    opClone.translate(new this.paperScope.Point(0.0001, 0.0001));
                    const temp = opFn(current, opClone);
                    current.remove();
                    opClone.remove();
                    current = temp;
                }
                if (!current) continue;
                const flat = this._unpackFragments(current);
                for (const p of flat) results.push(p);
                if (current && flat.length > 0 && current !== flat[0]) current.remove();
            } catch (e) {
                console.warn("[Boolean] Fragment op failed", e);
            }
        }

        // Clean up operand originals
        for (const op of operandPieces) op.remove();

        if (results.length === 0) return false;

        let resultPath;
        if (results.length === 1) {
            resultPath = results[0];
        } else {
            resultPath = new this.paperScope.CompoundPath({ children: results });
        }

        let newInkShaderCurves = this._paperToInkShaderCurves(resultPath, targetGroupId);
        if (resultPath) resultPath.remove();
        for (let curve of InkShaderCurves) {
            this.cm.remove_curve(curve.id);
        }
        return newInkShaderCurves;
    }

    executeIntersection(InkShaderCurves, targetGroupId) {
        return this._executeBinaryOp(InkShaderCurves, targetGroupId, (a, b) => a.intersect(b));
    }

    executeDifference(InkShaderCurves, targetGroupId) {
        return this._executeBinaryOp(InkShaderCurves, targetGroupId, (a, b) => a.subtract(b));
    }

    executeExclusion(InkShaderCurves, targetGroupId) {
        return this._executeBinaryOp(InkShaderCurves, targetGroupId, (a, b) => a.exclude(b));
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

                const marker = generateMarker("vertex");
                
                let node = new CurveNode(marker, "vertex", pt.x, pt.y, null, lastCreatedNode, `n_${marker.id}`);
                node.curve = InkShaderCurve;
                node.control_mode = controlMode;

                this.cm.domMap.set(marker, node);

                if (!seg.handleOut.isZero()) {
                    let c1x = pt.x + seg.handleOut.x;
                    let c1y = pt.y + seg.handleOut.y;
                    const c1M = generateMarker("circle");
                    node.control1 = new CurveNode(c1M, null, c1x, c1y, node, null, c1M.id);
                    node.control1.curve = InkShaderCurve;
                    this.cm.domMap.set(c1M, node.control1);
                }

                if (!seg.handleIn.isZero()) {
                    let c2x = pt.x + seg.handleIn.x;
                    let c2y = pt.y + seg.handleIn.y;
                    const c2M = generateMarker("circle");
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