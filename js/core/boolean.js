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
     * Union semantics (per the editor's data model):
     *  - Each selected curve's boolean cache (fill ∪ expanded stroke, already
     *    united into clean rings by refreshCurveBooleanCache, outer ring
     *    oriented by the curve's smart expand direction, holes as separate
     *    reversed rings) is ONE paper operand.
     *  - Paper.js unite() reorients each OPERAND independently but preserves
     *    the internal winding relationships of a compound operand (verified:
     *    unite(compound-donut, disjoint square) keeps [outer, −hole, square]),
     *    so passing each curve as a single compound operand is what makes
     *    holes survive. Splitting a curve's rings into separate operands is
     *    exactly what made the old union fill every hole.
     *  - The result's outer contour directions follow paper's reorient
     *    (root rings CW under nonzero) — consistent with plain-path union
     *    behaviour the boolean engine has always had.
     */
    executeUnion(InkShaderCurves, targetGroupId) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        const operands = this._buildOperands(InkShaderCurves);
        if (operands.length === 0) return false;

        let results = [];
        try {
            let current = operands[0];
            for (let i = 1; i < operands.length; i++) {
                const op = operands[i];
                try {
                    const opClone = op.clone();
                    // epsilon nudge keeps paper from merging coincident boundary
                    // segments of exactly-touching operands into shared seams
                    opClone.rotate(0.0001, opClone.position);
                    opClone.translate(new this.paperScope.Point(0.0001, 0.0001));
                    const temp = current.unite(opClone);
                    opClone.remove();
                    if (!temp) { op.remove(); continue; }
                    try { current.remove(); } catch (_) { }
                    current = temp;
                } catch (e) {
                    console.warn("[Boolean] Union step failed for an operand", e);
                    op.remove();
                }
            }
            const flat = this._unpackFragments(current);
            for (const p of flat) results.push(p);
            if (current && flat.length > 0 && current !== flat[0]) current.remove();
        } catch (e) {
            console.warn("[Boolean] Union failed", e);
            return false;
        }

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

    /**
     * Build ONE paper item (Path or CompoundPath) per curve from its boolean
     * cache. The cache already contains the curve's unioned region (fill ∪
     * stroke) as clean rings, so the compound operand carries correct hole
     * winding into paper's boolean preprocessing.
     */
    _buildOperands(InkShaderCurves) {
        const operands = [];
        for (const curve of InkShaderCurves) {
            if (typeof curve.updateBooleanCache === 'function') {
                curve.updateBooleanCache();
            }
            if (!Array.isArray(curve.cached_boolean_geometry) || curve.cached_boolean_geometry.length === 0) {
                continue;
            }
            const subPaths = [];
            for (const sub of curve.cached_boolean_geometry) {
                if (sub.segments.length < 2) continue;
                const p = new this.paperScope.Path();
                p.closed = sub.closed;
                for (const seg of sub.segments) {
                    p.add(new this.paperScope.Segment(
                        new this.paperScope.Point(seg.x, seg.y),
                        new this.paperScope.Point(seg.inX, seg.inY),
                        new this.paperScope.Point(seg.outX, seg.outY)
                    ));
                }
                subPaths.push(p);
            }
            if (subPaths.length === 0) continue;
            operands.push(subPaths.length === 1
                ? subPaths[0]
                : new this.paperScope.CompoundPath({ children: subPaths }));
        }
        return operands;
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

    _executeBinaryOp(InkShaderCurves, targetGroupId, opFn) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        const operands = this._buildOperands(InkShaderCurves);
        if (operands.length < 2) return false;

        // For each base operand, apply opFn against all other operands.
        let results = [];
        for (let bi = 0; bi < operands.length; bi++) {
            const base = operands[bi];
            try {
                let current = base;
                for (let oi = 0; oi < operands.length; oi++) {
                    if (oi === bi) continue;
                    const opClone = operands[oi].clone();
                    opClone.rotate(0.0001, opClone.position);
                    opClone.translate(new this.paperScope.Point(0.0001, 0.0001));
                    const temp = opFn(current, opClone);
                    opClone.remove();
                    if (!temp) continue;
                    if (current !== base) { try { current.remove(); } catch (_) { } }
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

        // Clean up operand originals (base pieces may have been consumed by
        // unite/subtract — remove() is a no-op on removed items).
        for (const op of operands) { try { op.remove(); } catch (_) { } }

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
}
