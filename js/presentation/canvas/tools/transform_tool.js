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
 * - Scale (8 handles: tl/tr/bl/br/tc/bc/ml/mr): scale around pivot point, optional proportional (Shift)
 * - Rotate (rot handle): rotate around pivot point, Ctrl locks to 5deg increments
 *
 * Flow: startTransform -> handleMouseMoveTransform* (live preview) -> changeSelectedObjectsTransform (finalize history)
 */
export class TransformTool {
    constructor(canvas, interactionController) {
        this.canvas = canvas;
        this.ic = interactionController;
    }

    /**
     * Resolve the effective pivot point for rotation/shear transforms.
     * Uses custom pivot if set, otherwise falls back to bounds center.
     */
    _resolvePivot(c, bounds) {
        if (c.transform_center_pivot) {
            return { x: c.transform_center_pivot.x, y: c.transform_center_pivot.y };
        }
        if (bounds) {
            return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        }
        return null;
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

        // Pivot drag: just record state, no snapshot needed
        if (action === 'pivot') {
            c.transform_start_bounds = null;
            c.transform_snapshot = null;
            c.transform_snapshot_refs = null;
            c.transform_pivot = null;
            return;
        }

        let bounds = c.utils.getSelectionBounds();
        c.transform_start_bounds = bounds ? { ...bounds } : null;
        if (action !== 'drag' && bounds) {
            if (action === 'tl') c.transform_pivot = { x: bounds.maxX, y: bounds.maxY };
            else if (action === 'tr') c.transform_pivot = { x: bounds.minX, y: bounds.maxY };
            else if (action === 'bl') c.transform_pivot = { x: bounds.maxX, y: bounds.minY };
            else if (action === 'br') c.transform_pivot = { x: bounds.minX, y: bounds.minY };
            else if (action === 'tc') c.transform_pivot = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY };
            else if (action === 'bc') c.transform_pivot = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY };
            else if (action === 'ml') c.transform_pivot = { x: bounds.maxX, y: (bounds.minY + bounds.maxY) / 2 };
            else if (action === 'mr') c.transform_pivot = { x: bounds.minX, y: (bounds.minY + bounds.maxY) / 2 };
            // Rotate handles (rotate_shear mode) and shear handles use custom pivot
            else if (action === 'rot_tl' || action === 'rot_tr' || action === 'rot_bl' || action === 'rot_br' ||
                     action === 'shear_tc' || action === 'shear_bc' || action === 'shear_ml' || action === 'shear_mr') {
                c.transform_pivot = this._resolvePivot(c, bounds);
            }
        } else { c.transform_pivot = null; }

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
            if (action === 'drag' || ref.type === 'image') {
                let seqIdx = c.utils.getSeqIdxForGroupId(ref.type === 'image' ? (ref.parentId || cm.getRootGroupId(ref.id)) : cm.getRootGroupId(ref.id));
                let seqOff = seqIdx !== -1 ? cm.getSeqOffset(seqIdx) : 0;
                c.transform_snapshot_refs.push({ ref: ref, startMatrix: new DOMMatrix(ref.transform), seqOff });
            } else {
                let seqIdx = c.utils.getSeqIdxForGroupId(cm.getRootGroupId(ref.id));
                let seqOff = seqIdx !== -1 ? cm.getSeqOffset(seqIdx) : 0;
                let masterCurves = cm.getCurvesForGroup(ref.refId);
                const refMatrix = ref.transform ? new DOMMatrix(ref.transform) : new DOMMatrix();
                for (let cd of masterCurves) {
                    const localMatrix = cd.matrix ? new DOMMatrix(cd.matrix) : new DOMMatrix();
                    const localToRef = new DOMMatrix(refMatrix).multiply(localMatrix);
                    const localToWorld = new DOMMatrix().translate(seqOff, 0).multiply(localToRef);
                    let worldToLocal = null;
                    try { worldToLocal = localToWorld.inverse(); } catch (_) { continue; }
                    pushCurveContext(cd.curve, {
                        seqOff, localToWorld, worldToLocal, previewRefId: cd.refId ?? ref.id
                    });
                }
            }
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

        const previewKeys = new Set([
            ...this.ic.collectInteractiveStrokePreviewCurveIds(),
            ...this.previewKeysFromTransformContexts(curveContexts)
        ]);
        for (const snapRef of c.transform_snapshot_refs) {
            const ref = snapRef?.ref;
            if (ref?.isRef && ref.refId) {
                this.ic._pushCurvesFromGroup(previewKeys, cm, ref.refId, ref.id);
            }
        }
        c.setInteractiveStrokePreviewCurveIds?.([...previewKeys]);
        c.is_dirty = true;
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

        // Pivot drag: move the custom pivot point
        if (action === 'pivot') {
            c.transform_center_pivot = { x: worldX, y: worldY };
            c.is_dirty = true;
            return;
        }

        if (action === 'drag') {
            const anchor = c.transform_anchor_client || c.transform_start_screen;
            let currentDx = (clientX - anchor.x) / c.scale;
            let currentDy = (clientY - anchor.y) / c.scale;
            if (isCtrlPressed) {
                if (Math.abs(currentDx) > Math.abs(currentDy)) currentDy = 0; else currentDx = 0;
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

        // Pivot drag: no history commit, just update state
        if (action === 'pivot') {
            c.current_state = 'IDLE';
            c.transform_action = null;
            c.transform_snapshot = null;
            c.transform_snapshot_refs = null;
            c.transform_start_bounds = null;
            c.transform_anchor_client = null;
            c.clearInteractiveStrokePreview?.();
            c.is_dirty = true;
            return;
        }

        c.current_state = 'IDLE'; c.transform_action = null;
        c.transform_snapshot = null; c.transform_snapshot_refs = null;
        c.transform_start_bounds = null; c.transform_anchor_client = null;
        c.clearInteractiveStrokePreview?.();
        c.flushSmartStrokeBooleanCache?.(affectedCurveIds);
        c.commands.changeSelectedObjectsTransform(hasChanged);
    }
}
