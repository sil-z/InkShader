// js/presentation/canvas/tools/transform_tool.js — Transform logic (drag/scale/rotate, shared by Select and Node)
import { TransformEngine } from "../../../core/transform_engine.js";
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";
import {
    resolveCurvesFromSnapshot,
    resolveRefsFromSnapshot
} from "../../../app/editor_interaction_state.js";

/**
 * TransformTool: manages the complete lifecycle of object transforms (initiate -> preview -> finalize).
 * Shared by SelectTool and NodeTool.
 *
 * Supported transforms:
 * - Drag move: translate selected paths/refs in any direction
 * - Scale (8 handles: tl/tr/bl/br/tc/bc/ml/mr): scale around selection geometric center, optional proportional (Shift)
 * - Rotate (rot handle): rotate around selection geometric center, Ctrl locks to 5deg increments
 *
 * Pivot: always uses selection geometric center. No user-draggable pivot handle.
 *
 * Flow: startTransform -> handleMouseMoveTransform* (live preview) -> changeSelectedObjectsTransform (finalize history)
 */
export class TransformTool {
    constructor(canvas, interactionController) {
        this.canvas = canvas;
        this.ic = interactionController;
    }

    startTransform(action, mouseX, mouseY, clientX, clientY) {
        const c = this.canvas;
        c.current_state = 'TRANSFORMING_OBJECTS';
        c.transform_action = action;
        c.transform_start_screen = { x: mouseX, y: mouseY };
        c.transform_anchor_client = { x: clientX, y: clientY };
        c.transform_started_moving = false;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        let startWorldX = (mouseX - offsetX) / c.scale;
        let startWorldY = (mouseY - offsetY) / c.scale;
        c.transform_start_world = { x: startWorldX, y: startWorldY };

        let bounds = c.utils.getSelectionBounds();
        c.transform_start_bounds = bounds ? { ...bounds } : null;
        // Always use geometric center of selection bounds as pivot (no user-draggable pivot)
        c.transform_pivot = (action !== 'drag' && bounds)
            ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
            : null;

        c.transform_snapshot_refs = []; c.transform_snapshot = [];
        const cm = c.curve_manager;
        const ix = c.getInteractionSnapshot();
        let curveContexts = [];
        let seenCurveContexts = new Set();

        const pushCurveContext = (curve, context = {}) => {
            if (!curve) return;
            const localToWorld = context.localToWorld || null;
            const worldToLocal = context.worldToLocal || null;
            const refTx = Number(context.refTx || 0);
            const refTy = Number(context.refTy || 0);
            const seqOff = Number(context.seqOff || 0);
            const previewRefId = context.previewRefId ?? null;
            const key = localToWorld
                ? `${curve.id}|${previewRefId}|${seqOff}|${localToWorld.a},${localToWorld.b},${localToWorld.c},${localToWorld.d},${localToWorld.e},${localToWorld.f}`
                : `${curve.id}|direct|${seqOff}|${refTx}|${refTy}`;
            if (seenCurveContexts.has(key)) return;
            seenCurveContexts.add(key);
            curveContexts.push({ curve, seqOff, refTx, refTy, localToWorld, worldToLocal, previewRefId });
        };

        for (let curve of resolveCurvesFromSnapshot(ix, cm)) {
            let seqIdx = c.utils.getSeqIdxForGroupId(curve.groupId);
            pushCurveContext(curve, { refTx: 0, refTy: 0, seqOff: seqIdx !== -1 ? cm.getSeqOffset(seqIdx) : 0 });
        }

        for (let ref of resolveRefsFromSnapshot(ix, cm)) {
            // All refs (glyph + image) go through snapshotRefs — matrix path.
            // This ensures scale/rotate on refs modifies the transform matrix
            // rather than source curves, matching OpenType composite semantics.
            let parentId = ref.type === 'image'
                ? (ref.parentId || cm.getRootGroupId(ref.id))
                : cm.getRootGroupId(ref.id);
            let seqIdx = c.utils.getSeqIdxForGroupId(parentId);
            let seqOff = seqIdx !== -1 ? cm.getSeqOffset(seqIdx) : 0;
            c.transform_snapshot_refs.push({
                ref: ref,
                startMatrix: new DOMMatrix(ref.transform || new DOMMatrix()),
                seqOff
            });
        }

        for (let info of curveContexts) {
            const curve = info.curve;
            let current = curve.startNode;
            while (current) {
                c.transform_snapshot.push({
                    node: current, seqOff: info.seqOff, refTx: info.refTx, refTy: info.refTy,
                    localToWorld: info.localToWorld || null, worldToLocal: info.worldToLocal || null,
                    main: { x: current.x, y: current.y },
                    c1: current.control1 ? { x: current.control1.x, y: current.control1.y } : null,
                    c2: current.control2 ? { x: current.control2.x, y: current.control2.y } : null
                });
                current = current.nextOnCurve;
            }
        }

        c._pendingTransformCurveContexts = null;
        // Remember which curve instances this drag moves so object-drag node
        // snapping can tell moved nodes from snap targets (paths and refs alike).
        c._transformDragInstanceKeys = this._dragInstanceKeys(curveContexts);
        // Per-drag snap scratch: rebuilt on the first mouse-move of this drag.
        c._snapDragSources = null;
        c.is_dirty = true;
    }

    /**
     * Instance keys (`curveId|seqIdx|refId`, matching spatial-grid entries) for
     * every curve instance moved by the current drag. Refs contribute every
     * source curve under the dragged ref instance.
     */
    _dragInstanceKeys(curveContexts = []) {
        const c = this.canvas;
        const cm = c.curve_manager;
        const keys = new Set();
        const keyOf = (curveId, seqIdx, refId) =>
            `${curveId}|${seqIdx == null || seqIdx === -1 ? '' : seqIdx}|${refId ?? ''}`;
        for (const info of curveContexts) {
            const cid = info?.curve?.id;
            if (!cid) continue;
            const seqIdx = c.utils.getSeqIdxForGroupId(info.curve.groupId);
            keys.add(keyOf(cid, seqIdx, info.previewRefId ?? ''));
        }
        for (const snap of c.transform_snapshot_refs || []) {
            const ref = snap?.ref;
            if (!ref?.id) continue;
            const sourceGroup = ref.refId;
            if (ref.type === 'image' || !sourceGroup) continue;
            const parentId = ref.parentId || cm.getRootGroupId(ref.id);
            const seqIdx = c.utils.getSeqIdxForGroupId(parentId);
            const groupCurves = cm.getCurvesForGroup?.(sourceGroup) || [];
            for (const cd of groupCurves) {
                const cid = cd?.curve?.id;
                if (cid) keys.add(keyOf(cid, seqIdx, ref.id));
            }
        }
        return keys;
    }

    /**
     * Node snapping for whole-object drags (Edit ▸ Snap Nodes while Dragging Objects).
     * The moved nodes' drag-start world positions come from the spatial grid (it
     * is only rebuilt on gesture end), targets are every node outside the moved
     * instances. Returns the extra (dx, dy) that lands a moved node on a target
     * node (coincident mode) or on its X/Y alignment line (alignment mode).
     */
    computeObjectDragSnapDelta(dx, dy) {
        const c = this.canvas;
        const alignEnabled = c.snap_alignment_enabled !== false;
        const coincidentEnabled = c.snap_coincident_enabled !== false;
        if (!alignEnabled && !coincidentEnabled) return { dx: 0, dy: 0 };
        const grid = c.curve_manager?.spatialGrid;
        if (!grid || typeof grid.forEach !== 'function' || grid.size === 0) return { dx: 0, dy: 0 };
        const movedKeys = c._transformDragInstanceKeys;
        if (!movedKeys || movedKeys.size === 0) return { dx: 0, dy: 0 };

        const threshold = Math.min(5 / c.scale, 250);
        const keyOf = (entry) =>
            `${entry.curve?.id ?? ''}|${entry.seqIdx == null || entry.seqIdx === -1 ? '' : entry.seqIdx}|${entry.refId ?? ''}`;
        // The moved-node list is a property of the DRAG, not of the frame, and the
        // spatial grid is only rebuilt when the gesture ends — so collect it once
        // per drag. Scanning the whole grid here (and building a key string per
        // entry) on every mouse-move is O(all nodes of the font) per frame, which
        // is what made object drags stutter on large projects.
        let sources = c._snapDragSources;
        if (!sources) {
            const moved = [];
            grid.forEach((entry) => {
                if (!entry?.node) return;
                if (!movedKeys.has(keyOf(entry))) return;
                moved.push(entry);
            });
            // Guard: never let snapping cost scale with a huge selection.
            const MAX_SOURCES = 200;
            sources = moved.length > MAX_SOURCES
                ? moved.filter((_, i) => i % Math.ceil(moved.length / MAX_SOURCES) === 0)
                : moved;
            c._snapDragSources = sources;
        }

        let bestDist = Infinity, coincidentAdj = null;
        let bestXDist = Infinity, adjX = 0;
        let bestYDist = Infinity, adjY = 0;
        for (const src of sources) {
            const candX = src.worldX + dx;
            const candY = src.worldY + dy;
            const nearby = grid.queryProximity(candX, candY, threshold + 1);
            for (const t of nearby) {
                if (!t?.node) continue;
                if (movedKeys.has(keyOf(t))) continue;
                const ddx = t.worldX - candX;
                const ddy = t.worldY - candY;
                if (coincidentEnabled) {
                    const d = Math.hypot(ddx, ddy);
                    if (d < threshold && d < bestDist) {
                        bestDist = d;
                        coincidentAdj = { dx: ddx, dy: ddy };
                    }
                }
                if (alignEnabled) {
                    const ax = Math.abs(ddx), ay = Math.abs(ddy);
                    if (ax < threshold && ax < bestXDist) { bestXDist = ax; adjX = ddx; }
                    if (ay < threshold && ay < bestYDist) { bestYDist = ay; adjY = ddy; }
                }
            }
        }
        if (coincidentAdj) return coincidentAdj;
        return { dx: alignEnabled ? adjX : 0, dy: alignEnabled ? adjY : 0 };
    }

    previewKeysFromTransformContexts(curveContexts = []) {
        const keys = new Set();
        for (const info of curveContexts) {
            if (info.curve?.id) {
                keys.add(info.curve.id);
                if (info.previewRefId) keys.add(`${info.curve.id}::${info.previewRefId}`);
            }
        }
        return keys;
    }

    handleMouseMove(mouseX, mouseY, clientX, clientY, isCtrlPressed, isShiftPressed) {
        const c = this.canvas;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        if (!c.transform_started_moving) {
            const movedScreen = Math.hypot(mouseX - c.transform_start_screen.x, mouseY - c.transform_start_screen.y);
            const movedClient = c.transform_anchor_client
                ? Math.hypot(clientX - c.transform_anchor_client.x, clientY - c.transform_anchor_client.y)
                : movedScreen;
            if (movedScreen > 4 || movedClient > 4) {
                c.transform_started_moving = true;
                c.setInteractiveStrokePreviewCurveIds?.(this.ic.collectInteractiveStrokePreviewCurveIds());
            } else return;
        }

        let worldX = (mouseX - offsetX) / c.scale;
        let worldY = (mouseY - offsetY) / c.scale;
        let action = c.transform_action;
        let pivot = c.transform_pivot;

        if (action === 'drag') {
            const anchor = c.transform_anchor_client || c.transform_start_screen;
            let currentDx = (clientX - anchor.x) / c.scale;
            let currentDy = (clientY - anchor.y) / c.scale;
            if (isCtrlPressed) {
                if (Math.abs(currentDx) > Math.abs(currentDy)) currentDy = 0; else currentDx = 0;
            } else if (c.snap_nodes_enabled !== false) {
                // Node-level snapping of the dragged object(s): adjust the drag
                // delta so a node of the moved object lands on another node (or
                // on its X/Y alignment line).
                const adj = this.computeObjectDragSnapDelta(currentDx, currentDy);
                currentDx += adj.dx;
                currentDy += adj.dy;
            }
            c.curve_manager.applyTransformPreview({
                action: 'drag', snapshots: c.transform_snapshot,
                snapshotRefs: c.transform_snapshot_refs, dx: currentDx, dy: currentDy
            });
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
            return;
        }

        if (pivot) {
            let params = {};
            const isRotateAction = action === 'rot' || action === 'rot_tl' || action === 'rot_tr' || action === 'rot_bl' || action === 'rot_br';
            const isShearAction = action === 'shear_tc' || action === 'shear_bc' || action === 'shear_ml' || action === 'shear_mr';

            if (isRotateAction) {
                params = TransformEngine.calculateRotationParams(pivot, c.transform_start_world, { x: worldX, y: worldY }, isCtrlPressed);
            } else if (isShearAction) {
                const bounds = c.utils.getSelectionBounds();
                params = TransformEngine.calculateShearParams(action, pivot, c.transform_start_world, { x: worldX, y: worldY }, bounds || c.transform_start_bounds);
            } else {
                params = TransformEngine.calculateScaleParams(action, pivot, c.transform_start_world, { x: worldX, y: worldY }, (isShiftPressed || isCtrlPressed));
                // Clamp scale to prevent degenerate matrices (zero → invisible, extreme → NaN)
                if (Number.isFinite(params.sx)) params.sx = Math.max(0.01, Math.min(params.sx, 100));
                if (Number.isFinite(params.sy)) params.sy = Math.max(0.01, Math.min(params.sy, 100));
            }

            c.curve_manager.applyTransformPreview({
                action, snapshots: c.transform_snapshot,
                snapshotRefs: c.transform_snapshot_refs, pivot, params
            });

            // Scale anchor correction (not needed for rotate and shear)
            if (!isRotateAction && !isShearAction && c.transform_start_bounds) {
                const currentBounds = c.utils.getSelectionBounds();
                if (currentBounds) {
                    const corr = this.getScaleAnchorCorrection(action, c.transform_start_bounds, currentBounds, params);
                    if (corr.dx !== 0 || corr.dy !== 0) {
                        c.curve_manager.translateTransformPreview(
                            corr.dx, corr.dy, c.transform_snapshot, c.transform_snapshot_refs
                        );
                    }
                }
            }
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    /**
     * Calculate anchor edge correction after a scale transform.
     * When a flip occurs (scale factor < 0 on an axis), the bounds edges invert:
     * the original anchor edge maps to the OPPOSITE bound after the flip.
     * This method detects flips from the scale params and selects the correct
     * bounds edge for the correction.
     *
     * @param {string} action - Handle identifier ('mr', 'ml', 'bc', 'tc', 'br', 'bl', 'tr', 'tl')
     * @param {object} startBounds - Bounds at transform start
     * @param {object} currentBounds - Bounds after current scale
     * @param {object} [params] - Scale params { sx, sy }. When absent, assumes no flip.
     * @returns {{ dx: number, dy: number }} Translation correction to keep anchor fixed
     */
    getScaleAnchorCorrection(action, startBounds, currentBounds, params) {
        let dx = 0, dy = 0;
        // Detect flip on each axis: when scale goes negative, bounds invert.
        const sxFlip = params && params.sx < 0;
        const syFlip = params && params.sy < 0;

        switch (action) {
            case 'mr':
                // Pivot at left edge (startBounds.minX). After flip, anchor is at currentBounds.maxX.
                dx = sxFlip
                    ? startBounds.minX - currentBounds.maxX
                    : startBounds.minX - currentBounds.minX;
                break;
            case 'ml':
                // Pivot at right edge (startBounds.maxX). After flip, anchor is at currentBounds.minX.
                dx = sxFlip
                    ? startBounds.maxX - currentBounds.minX
                    : startBounds.maxX - currentBounds.maxX;
                break;
            case 'bc':
                // Pivot at top edge (startBounds.minY). After flip, anchor is at currentBounds.maxY.
                dy = syFlip
                    ? startBounds.minY - currentBounds.maxY
                    : startBounds.minY - currentBounds.minY;
                break;
            case 'tc':
                // Pivot at bottom edge (startBounds.maxY). After flip, anchor is at currentBounds.minY.
                dy = syFlip
                    ? startBounds.maxY - currentBounds.minY
                    : startBounds.maxY - currentBounds.maxY;
                break;
            case 'br':
                dx = sxFlip
                    ? startBounds.minX - currentBounds.maxX
                    : startBounds.minX - currentBounds.minX;
                dy = syFlip
                    ? startBounds.minY - currentBounds.maxY
                    : startBounds.minY - currentBounds.minY;
                break;
            case 'bl':
                dx = sxFlip
                    ? startBounds.maxX - currentBounds.minX
                    : startBounds.maxX - currentBounds.maxX;
                dy = syFlip
                    ? startBounds.minY - currentBounds.maxY
                    : startBounds.minY - currentBounds.minY;
                break;
            case 'tr':
                dx = sxFlip
                    ? startBounds.minX - currentBounds.maxX
                    : startBounds.minX - currentBounds.minX;
                dy = syFlip
                    ? startBounds.maxY - currentBounds.minY
                    : startBounds.maxY - currentBounds.maxY;
                break;
            case 'tl':
                dx = sxFlip
                    ? startBounds.maxX - currentBounds.minX
                    : startBounds.maxX - currentBounds.maxX;
                dy = syFlip
                    ? startBounds.maxY - currentBounds.minY
                    : startBounds.maxY - currentBounds.maxY;
                break;
        }
        return { dx, dy };
    }

    handleMouseUp() {
        const c = this.canvas;
        const action = c.transform_action;
        const hasChanged = c.transform_started_moving === true;
        const affectedCurveIds = this.ic.collectInteractiveStrokePreviewCurveIds();

        // Mode toggle on click (no drag) for already-selected objects
        if (c.pending_mode_toggle && !hasChanged) {
            c.transform_mode = c.transform_mode === 'scale' ? 'rotate_shear' : 'scale';
            c.is_dirty = true;
        }
        c.pending_mode_toggle = false;

        c.current_state = 'IDLE'; c.transform_action = null;
        c.transform_snapshot = null; c.transform_snapshot_refs = null;
        c.transform_start_bounds = null; c.transform_anchor_client = null;
        c._transformDragInstanceKeys = null;
        c._snapDragSources = null;
        c.clearInteractiveStrokePreview?.();
        // Click-to-select (no drag) must not invalidate smart-expand boolean cache —
        // that forced a multi-second Paper rebuild on the next paint.
        if (hasChanged) {
            c.flushSmartStrokeBooleanCache?.(affectedCurveIds);
        }
        c.commands.changeSelectedObjectsTransform(hasChanged);
    }
}
