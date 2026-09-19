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
     *
     * The selected paths' rings — each keeping the direction it was drawn with —
     * are decomposed into their nonzero winding regions (`_windingDecompose`).
     * The result renders EXACTLY as the selected paths did together: overlap
     * between same-direction rings merges, overlap between opposite-direction
     * rings cancels (a hole), and self-intersections melt. A path's own holes
     * survive as reversed inner rings.
     *
     * Paper's unite() is deliberately NOT used across operands: it reorients
     * every operand, so two opposite-direction paths would have their cancelled
     * region filled instead of kept empty. That reorientation is the mechanism
     * behind "union filled the hole" / "union changed the fill".
     */
    executeUnion(InkShaderCurves, targetGroupId) {
        if (!this.paperScope || !InkShaderCurves || InkShaderCurves.length < 2) {
            console.warn("[Boolean] Requires at least 2 selected paths.");
            return false;
        }

        const ringGroups = InkShaderCurves
            .map(curve => this._ringsOfCurve(curve))
            .filter(rings => rings.length > 0);
        if (ringGroups.length === 0) return false;

        let results = [];
        try {
            results = this._resolveUnionPerObject(ringGroups);
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
     * Every ring of ONE curve from its boolean cache, as closed paper Paths with
     * their direction preserved verbatim. The direction is the winding the glyph
     * renders with, so it is never normalized here: union resolves the rings of
     * all selected paths together (see _windingDecompose).
     */
    _ringsOfCurve(curve) {
        const rings = [];
        if (!curve) return rings;
        if (typeof curve.updateBooleanCache === 'function') {
            curve.updateBooleanCache();
        }
        const geometry = curve.cached_boolean_geometry;
        if (!Array.isArray(geometry)) return rings;
        for (const sub of geometry) {
            if (!sub || !sub.segments || sub.segments.length < 2) continue;
            const p = new this.paperScope.Path({ insert: false });
            p.closed = true;
            for (const seg of sub.segments) {
                p.add(new this.paperScope.Segment(
                    new this.paperScope.Point(seg.x, seg.y),
                    new this.paperScope.Point(seg.inX, seg.inY),
                    new this.paperScope.Point(seg.outX, seg.outY)
                ));
            }
            if (p.segments.length >= 2) rings.push(p);
        }
        return rings;
    }

    /**
     * Resolve a path's OWN rings into its clean nonzero outline (flattened paper
     * Paths). Split out from executeUnion so it can be driven directly by tests
     * with synthetic rings.
     */
    _resolveUnion(rings) {
        const decomposed = this._windingDecompose(rings);
        if (!decomposed) return [];
        return this._leaves(decomposed);
    }

    /** Flattened closed Paths of a paper item, WITHOUT removing anything. */
    _leaves(item) {
        const out = [];
        const walk = (it) => {
            if (!it) return;
            if (it instanceof this.paperScope.CompoundPath) {
                for (const child of [...it.children]) walk(child);
            } else if (it instanceof this.paperScope.Path && it.segments && it.segments.length >= 2) {
                out.push(it);
            }
        };
        walk(item);
        return out;
    }

    /**
     * A face with a non-zero winding is a FILLED region. Its boundary may be
     * drawn with a negative orientation (a lobe whose own winding is -1), so
     * normalize it to the canonical filled orientation (outer rings positive,
     * holes negative) before the faces are united with each other.
     */
    _orientedRegion(item) {
        const leaves = this._leaves(item);
        if (leaves.length === 0) return null;
        const total = leaves.reduce((s, p) => s + p.area, 0);
        if (total < 0) {
            for (const p of leaves) { try { p.reverse(); } catch (_) { /* keep as-is */ } }
        }
        return leaves.length === 1 ? leaves[0] : new this.paperScope.CompoundPath({ children: leaves });
    }

    /**
     * The union the editor means: resolve EACH path on its own first (one operand
     * per object — a path's holes ride along as reversed inner rings of its own
     * compound), then unite the resolved paths with each other. `ringGroups` holds
     * one array of rings per selected path.
     */
    _resolveUnionPerObject(ringGroups) {
        const all = [];
        for (const rings of ringGroups || []) {
            if (!rings) continue;
            for (const r of rings) all.push(r);
        }
        return this._resolveUnion(all);
    }

    /**
     * The nonzero decomposition of a set of oriented rings.
     *
     * Goal: a ring set whose nonzero fill equals the nonzero fill of the INPUT
     * rings, each keeping the direction it was drawn with. That is the rendered
     * appearance, so a union must not change it.
     *
     * Paper's unite() cannot do this: it reorients every operand, so an operand's
     * own winding is discarded and opposite-direction overlaps get filled. This
     * routine instead computes the integer winding function w(x) = sum of the
     * rings' windings by an incremental planar subdivision, then emits the union
     * of every face whose winding is non-zero:
     *
     *   faces starts empty. For each simple ring r with sign s:
     *     every existing face is split by r into (face∩r, wind+s) and
     *     (face\r, wind); the part of r not yet covered becomes (wind s).
     *   Faces are pairwise disjoint, so the non-zero ones are simply united.
     *
     * Multiplicity is preserved (three stacked rings give w=3, not 1), which is
     * what makes a hole punched by an opposite-direction ring survive.
     */
    _windingDecompose(rings) {
        const simple = [];
        for (const r of (rings || [])) {
            if (!r || !r.segments || r.segments.length < 2) continue;
            // Always split self-crossings: a ring that crosses itself has a
            // signed area of 0 (its lobes cancel), so it would otherwise be
            // dropped as degenerate before its lobes are separated.
            let parts = [r];
            try {
                const resolved = typeof r.resolveCrossings === 'function'
                    ? r.resolveCrossings()
                    : null;
                if (resolved) parts = this._unpackFragments(resolved);
            } catch (_) { parts = [r]; }
            for (const p of parts) {
                if (p && p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9) {
                    simple.push(p);
                }
            }
        }
        if (simple.length === 0) return null;

        let faces = [];
        for (const ring of simple) {
            const s = ring.area >= 0 ? 1 : -1;
            let uncovered = ring;
            let exhausted = false;
            const kept = [];
            for (const f of faces) {
                if (exhausted) { kept.push(f); continue; }
                const inter = this._safeBool(f.path, uncovered, 'intersect');
                if (inter && Math.abs(inter.area) > 1e-9) {
                    const w = f.wind + s;
                    if (w !== 0) kept.push({ path: inter, wind: w });
                    const rest = this._safeBool(f.path, uncovered, 'subtract');
                    if (rest && Math.abs(rest.area) > 1e-9) kept.push({ path: rest, wind: f.wind });
                    const rem = this._safeBool(uncovered, f.path, 'subtract');
                    if (rem && Math.abs(rem.area) > 1e-9) uncovered = rem;
                    else { uncovered = null; exhausted = true; }
                } else {
                    kept.push(f);
                }
            }
            if (!exhausted && uncovered && Math.abs(uncovered.area) > 1e-9) {
                kept.push({ path: uncovered, wind: s });
            }
            faces = kept;
        }

        const solids = faces
            .filter(f => f.wind !== 0)
            .map(f => this._orientedRegion(f.path))
            .filter(Boolean);
        if (solids.length === 0) return null;
        let acc = solids[0];
        for (let i = 1; i < solids.length; i++) {
            const merged = this._safeBool(acc, solids[i], 'unite');
            if (merged && this._leaves(merged).length > 0) {
                acc = merged;
            } else {
                // Unite can return an empty item for regions that only touch at a
                // point; the faces are already pairwise disjoint, so keeping them
                // as one compound preserves the region exactly.
                acc = new this.paperScope.CompoundPath({
                    children: [...this._leaves(acc), ...this._leaves(solids[i])],
                });
            }
        }

        // Paper's boolean ops can leave zero-area sliver children (two segments,
        // no enclosed region). They bound nothing, so drop them: emitting them
        // would put meaningless curves into the document.
        const cleaned = this._leaves(acc).filter(
            p => p.segments.length >= 2 && Math.abs(p.area) > 1e-6
        );
        if (cleaned.length === 0) return null;
        return cleaned.length === 1
            ? cleaned[0]
            : new this.paperScope.CompoundPath({ children: cleaned });
    }

    _safeBool(a, b, op) {
        try {
            if (op === 'unite') return a.unite(b);
            if (op === 'intersect') return a.intersect(b);
            if (op === 'subtract') return a.subtract(b);
        } catch (_) { /* degenerate geometry: caller treats null as empty */ }
        return null;
    }

    /**
     * Build ONE paper item (Path or CompoundPath) per curve from its boolean
     * cache. Kept for the binary ops (difference / intersection / exclusion),
     * which operate per curve.
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

        // A boolean operation over a selection yields ONE result region, so the
        // operation is folded across the operands, starting from the bottom-most
        // one (first in the glyph's tree order):
        //   intersection A ∩ B ∩ C   exclusion A ⊕ B ⊕ C   difference A \ B \ C
        // Paper's ops do not consume their operands, so each one is reused; the
        // per-operand loop that used to live here emitted one result per operand
        // (identical duplicates for intersect/exclude, and A\B plus B\A instead
        // of "bottom minus top" for difference).
        const ordered = this._inTreeOrder(InkShaderCurves, targetGroupId);
        const operands = this._buildOperands(ordered);
        if (operands.length < 2) return false;

        let current = operands[0];
        try {
            for (let oi = 1; oi < operands.length; oi++) {
                const opClone = operands[oi].clone();
                opClone.rotate(0.0001, opClone.position);
                opClone.translate(new this.paperScope.Point(0.0001, 0.0001));
                const temp = opFn(current, opClone);
                opClone.remove();
                if (!temp) continue;
                if (current && current !== operands[0]) { try { current.remove(); } catch (_) { } }
                current = temp;
            }
        } catch (e) {
            console.warn("[Boolean] Operation failed", e);
        }

        // Drop the operand originals, except the one still used as the result
        // (paper keeps operands alive, so it can happen that no op produced a
        // new item and the first operand IS the result).
        for (const op of operands) {
            if (op !== current) { try { op.remove(); } catch (_) { } }
        }
        if (!current) return false;

        const results = this._unpackFragments(current);
        if (results.length === 0) return false;

        const resultPath = results.length === 1
            ? results[0]
            : new this.paperScope.CompoundPath({ children: results });

        const newInkShaderCurves = this._paperToInkShaderCurves(resultPath, targetGroupId);
        if (resultPath) resultPath.remove();
        for (const curve of ordered) {
            this.cm.remove_curve(curve.id);
        }
        return newInkShaderCurves;
    }

    /**
     * The selected curves reordered to their glyph's tree order (first == bottom).
     * Boolean difference is defined as "bottom minus top", so its base must be
     * the bottom-most path regardless of the order the paths were selected in.
     * Falls back to the given order when tree order is unavailable.
     */
    _inTreeOrder(curves, groupId) {
        try {
            const entries = this.cm && typeof this.cm.getCurvesForGroup === 'function'
                ? this.cm.getCurvesForGroup(groupId) : null;
            if (!Array.isArray(entries) || entries.length === 0) return curves;
            const rank = new Map();
            entries.forEach((e, i) => { if (e && e.curve) rank.set(e.curve.id, i); });
            if (rank.size === 0) return curves;
            return [...curves].sort((a, b) =>
                (rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER) -
                (rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER));
        } catch (_) {
            return curves;
        }
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
