import { TransformEngine } from "../../core/transform_engine.js";
import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { EDITOR_ACTIONS } from "../../domain/actions/editor_actions.js";
import {
    createNodeMarkerIdSet,
    resolveCurvesFromSnapshot,
    resolveMarkerById,
    resolveMarkersFromStore,
    resolveRefsFromSnapshot,
    snapshotIncludesCurve,
    snapshotIncludesNodeMarker,
    snapshotIncludesRef
} from "../../app/editor_interaction_state.js";

export class CanvasInteractionController {
    constructor(canvas) {
        this.canvas = canvas;
    }

    /** 预览 key：curveId::refId（可选）+ curveId（共享几何的所有实例） */
    _pushPreviewKeys(keys, curveId, refId = null) {
        if (!curveId) return;
        if (refId) keys.add(`${curveId}::${refId}`);
        // 引用与源组共享主曲线几何；形变时所有实例均跳过 Paper 布尔重算
        keys.add(curveId);
    }

    _pushCurvesFromGroup(keys, cm, groupId, refInstanceId = null) {
        if (!groupId) return;
        for (const cd of cm.getCurvesForGroup(groupId)) {
            if (!cd.curve?.id) continue;
            this._pushPreviewKeys(keys, cd.curve.id, cd.refId ?? refInstanceId);
        }
    }

    collectInteractiveStrokePreviewCurveIds() {
        const c = this.canvas;
        const cm = c.curve_manager;
        const ix = c.getInteractionSnapshot();
        const nodeRefId = c.editorStore?.getState?.()?._nodeSelectionRefId ?? null;
        const keys = new Set();

        if (c.current_curve?.id) this._pushPreviewKeys(keys, c.current_curve.id, null);

        for (const curve of resolveCurvesFromSnapshot(ix, cm)) {
            this._pushPreviewKeys(keys, curve.id, null);
        }

        for (const ref of resolveRefsFromSnapshot(ix, cm)) {
            if (ref?.type === "curve" && ref.curveId) {
                this._pushPreviewKeys(keys, ref.curveId, ref.id);
                continue;
            }
            if (ref?.isRef && ref.refId) {
                this._pushCurvesFromGroup(keys, cm, ref.refId, ref.id);
            }
        }

        const pushMarker = (marker, refIdOverride = undefined) => {
            const curve = cm.find_curve_by_dom(marker);
            if (!curve?.id) return;
            const refId =
                refIdOverride !== undefined ? refIdOverride : nodeRefId;
            this._pushPreviewKeys(keys, curve.id, refId);
        };

        for (const markerId of ix.selectedNodeMarkerIds) {
            const marker = resolveMarkerById(cm, markerId);
            if (marker) pushMarker(marker);
        }
        if (c.dragging_node_marker) {
            pushMarker(c.dragging_node_marker, c.dragging_node_refId || null);
        }

        return [...keys];
    }

    _previewKeysFromTransformContexts(curveContexts = []) {
        const keys = new Set();
        for (const info of curveContexts) {
            this._pushPreviewKeys(keys, info.curve?.id, info.previewRefId ?? null);
        }
        return keys;
    }

    _requestObjectSelection(strategy, { curves = [], refs = [], curve = null, refId = null } = {}) {
        const curveIds =
            curves.length > 0
                ? curves.map((entry) => entry?.id).filter(Boolean)
                : curve?.id
                  ? [curve.id]
                  : [];
        const refIds =
            refs.length > 0
                ? refs.map((entry) => entry?.id).filter(Boolean)
                : refId
                  ? [refId]
                  : [];
        CanvasDispatcher.requestChangeObjectSelection(strategy, { curveIds, refIds });
    }

    _requestNodeSelection(strategy, markers = [], refId = null) {
        const markerIds = markers
            .map((m) => (m && typeof m === "object" ? m.id : m))
            .filter(Boolean);
        CanvasDispatcher.requestChangeNodeSelection(strategy, { markerIds, refId });
    }

    _setFocusedSequenceIndex(index) {
        const store = this.canvas.editorStore;
        if (!store?.commitInteraction) return;
        const idx = typeof index === "number" ? index : -1;
        store.commitInteraction({
            type: EDITOR_ACTIONS.SET_FOCUSED_SEQUENCE_INDEX,
            payload: { index: idx }
        });
    }

    resetCurveDrawing() {
        const c = this.canvas;
        if (!c.current_curve) return;
        c.commands.finishAddingPathCommand();
    }

    handleMouseMovePaintingHandle(mouseX, mouseY) {
        const c = this.canvas;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        let seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
        const worldX = (mouseX - offsetX) / c.scale - seqOffsetX;
        const worldY = (mouseY - offsetY) / c.scale;

        if (!c.last_on_curve_node_marker || !c.current_curve) return;

        if(c.new_curve_handle === null && (Math.abs(mouseX - c.painting_handle_start.x) > 1 || Math.abs(mouseY - c.painting_handle_start.y) > 1)) {
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, 2, true);
            let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!last_node_n?.control1?.main_node || !last_node_n.control2?.main_node) return;
            c.new_curve_handle = last_node_n.control1.main_node;

            let other_x = 2 * last_node_n.x - worldX, other_y = 2 * last_node_n.y - worldY;
            c.curve_manager.adjustControlNode(last_node_n.control1.main_node, worldX, worldY);
            c.curve_manager.adjustControlNode(last_node_n.control2.main_node, other_x, other_y);
            c.is_dirty = true;
        } else if(c.new_curve_handle !== null) {
            let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!last_node_n?.control1?.main_node || !last_node_n.control2?.main_node) return;
            let other_x = 2 * last_node_n.x - worldX, other_y = 2 * last_node_n.y - worldY;

            c.curve_manager.adjustControlNode(last_node_n.control1.main_node, worldX, worldY);
            c.curve_manager.adjustControlNode(last_node_n.control2.main_node, other_x, other_y);
            c.is_dirty = true;
        }
    }

    handleMeasureMouseDown(worldX, worldY) {
        const c = this.canvas;
        c.is_measuring = true;
        c.measure_start = {x: worldX, y: worldY}; c.measure_end = {x: worldX, y: worldY};
        c.is_dirty = true;
    }

    handleSelectMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, isShiftKey, clientX, clientY) {
        const c = this.canvas;
        const ix = c.getInteractionSnapshot();
        if (handleHit) { this.startTransform(handleHit, mouseX, mouseY, clientX, clientY); return; }
        if (hitCurveSegment) {
            if (hitCurveSegment.seqIndex !== undefined) this._setFocusedSequenceIndex(hitCurveSegment.seqIndex);
            if (hitCurveSegment.refId) {
                let refItem = c.curve_manager.treeItems.get(hitCurveSegment.refId);
                if (refItem && snapshotIncludesRef(ix, refItem)) { this.startTransform('drag', mouseX, mouseY, clientX, clientY); return; }
                else if (refItem) {
                    this._requestObjectSelection(isShiftKey ? "add" : "replace", { refs: [refItem] });
                    this.startTransform('drag', mouseX, mouseY, clientX, clientY); return;
                }
            } else if (snapshotIncludesCurve(ix, hitCurveSegment.curve)) {
                this.startTransform('drag', mouseX, mouseY, clientX, clientY); c.is_dirty = true; return;
            } else {
                this._requestObjectSelection(isShiftKey ? "add" : "replace", { curves: [hitCurveSegment.curve] });
                this.startTransform('drag', mouseX, mouseY, clientX, clientY); return;
            }
        }
        if (!isShiftKey) {
            this._requestObjectSelection("clear");
            this._setFocusedSequenceIndex(-1);
        }
        c.is_box_selecting = true; c.box_select_start = {x: mouseX, y: mouseY}; c.box_select_end = {x: mouseX, y: mouseY}; c.is_dirty = true;
    }

    handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, isShiftKey, isCtrlKey) {
        const c = this.canvas;
        if (hitResult.seqIndex !== undefined) this._setFocusedSequenceIndex(hitResult.seqIndex);

        if (c.getActiveTool() === "DRAW" && c.current_curve && hitMarker === c.current_curve.startNode.main_node) {
            c.current_state = 'PAINTING_HANDLE';
            c.painting_handle_start = { x: mouseX, y: mouseY };
            c.closing_path_on_mouseup = true;
            c.renderer.update_previewData(mouseX, mouseY);
            c.is_dirty = true;
            return;
        }

        c.dragging_node_start = { x: mouseX, y: mouseY }; c.current_state = 'DRAGGING_NODE_READY';
        c.dragging_node_marker = hitMarker; c.dragging_node_seq_idx = hitResult.seqIndex;
        c.dragging_node_matrix = hitResult.matrix; c.dragging_node_refId = hitResult.refId;

        if (!c.current_curve) {
            let token = c.curve_manager.sequenceTokens[hitResult.seqIndex];
            if (token) {
                const groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                CanvasDispatcher.requestSetActiveGroup(groupId);
            }
        }

        let dragged_n = c.curve_manager.find_node_by_curve(hitMarker);
        let isMainNode = dragged_n.type !== null;
        let parentMainNode = isMainNode ? dragged_n : (dragged_n.nextOnCurve || dragged_n.lastOnCurve);
        let parentMarker = parentMainNode.main_node;
        parentMainNode.last_touched = Date.now();

        let isAlreadySelected = snapshotIncludesNodeMarker(c.getInteractionSnapshot(), parentMarker);
        const curve = dragged_n.curve || null;
        const refId = hitResult.refId || null;
        c.ctrl_click_added_selection = false;
        if (isMainNode) {
            if (isCtrlKey) {
                if (!isAlreadySelected) {
                    this._requestNodeSelection("toggle", [parentMarker], refId);
                    c.ctrl_click_added_selection = true;
                }
            } else if (isShiftKey) {
                this._requestNodeSelection("add", [parentMarker], refId);
            } else if (!isAlreadySelected) {
                this._requestNodeSelection("replace", [parentMarker], refId);
            } else if (refId) {
                this._requestNodeSelection("replace", [parentMarker], refId);
            }
            c.new_selected_temp = parentMarker;
        }

        c.drag_initial_mouse = { x: mouseX, y: mouseY };
        c.drag_initial_nodes.clear();
        for (const marker of resolveMarkersFromStore(c)) {
            const n = c.curve_manager.find_node_by_curve(marker);
            if (n) {
                c.drag_initial_nodes.set(marker, {
                    x: n.x,
                    y: n.y,
                    c1x: n.control1?.x,
                    c1y: n.control1?.y,
                    c2x: n.control2?.x,
                    c2y: n.control2?.y
                });
            }
        }

        c.drag_initial_target = { x: dragged_n.x, y: dragged_n.y };
        if (dragged_n.type === null) {
            let p = dragged_n.nextOnCurve || dragged_n.lastOnCurve;
            c.drag_initial_target.px = p.x; c.drag_initial_target.py = p.y;
            c.drag_initial_target.angle = Math.atan2(dragged_n.y - p.y, dragged_n.x - p.x);
        }
        c.previewData = null; c.notifyPropertiesUpdate(); c.is_dirty = true;
    }

    handleNodeMissMouseDown(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = true; c.box_select_start = { x: mouseX, y: mouseY }; c.box_select_end = { x: mouseX, y: mouseY };
        if (!isShiftKey) {
            this._requestObjectSelection("clear");
            this._setFocusedSequenceIndex(-1);
        } else {
            this._requestNodeSelection("clear", []);
        }
        c.notifyPropertiesUpdate(); c.is_dirty = true;
    }

    handleDrawMouseDown(mouseX, mouseY, worldX_raw, worldY) {
        const c = this.canvas;
        if (c.curve_manager.activeSequenceIndices.size === 0) return;
        let activeGroupId = c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) return;
        c.commands.syncActiveGroupForDraw(activeGroupId);

        let seqOffsetX;
        if(c.current_curve === null) {
            let seqTokens = c.curve_manager.sequenceTokens;
            let activeIndices = Array.from(c.curve_manager.activeSequenceIndices).sort((a,b)=>a-b);
            let targetSeqIdx = -1;
            for (let idx of activeIndices) {
                let t = seqTokens[idx]; let gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                if (gid === activeGroupId) { targetSeqIdx = idx; break; }
            }
            if (targetSeqIdx === -1) {
                for (let i=0; i < seqTokens.length; i++) {
                    let t = seqTokens[i]; let gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
                    if (gid === activeGroupId) { targetSeqIdx = i; break; }
                }
            }
            seqOffsetX = targetSeqIdx !== -1 ? c.curve_manager.getSeqOffset(targetSeqIdx) : 0;

            if (!c.commands.startAddingPath(activeGroupId, seqOffsetX)) return;
        } else seqOffsetX = c.drawing_seq_offset;

        const worldX = worldX_raw - seqOffsetX;
        c.closing_path_on_mouseup = false;
        c.commands.addMainNode(worldX, worldY);

        c.current_state = 'PAINTING_HANDLE'; c.painting_handle_start = { x: mouseX, y: mouseY };
        if (c.current_curve?.id) {
            c.setInteractiveStrokePreviewCurveIds?.([c.current_curve.id]);
        }
        c.renderer.update_previewData(mouseX, mouseY); c.is_dirty = true;
    }

    handleTransformMouseUp() {
        const c = this.canvas;
        const hasChanged = c.transform_started_moving === true;
        const affectedCurveIds = this.collectInteractiveStrokePreviewCurveIds();
        c.current_state = 'IDLE'; c.transform_action = null;
        c.transform_snapshot = null; c.transform_snapshot_refs = null;
        c.transform_start_bounds = null;
        c.transform_anchor_client = null;
        c.clearInteractiveStrokePreview?.();
        c.flushSmartStrokeBooleanCache?.(affectedCurveIds);
        c.commands.changeSelectedObjectsTransform(hasChanged);
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
        c.transform_start_world = {x: startWorldX, y: startWorldY};

        let bounds = c.utils.getSelectionBounds();
        c.transform_start_bounds = bounds ? { ...bounds } : null;
        if (action !== 'drag' && bounds) {
            if (action === 'tl') c.transform_pivot = {x: bounds.maxX, y: bounds.maxY};
            else if (action === 'tr') c.transform_pivot = {x: bounds.minX, y: bounds.maxY};
            else if (action === 'bl') c.transform_pivot = {x: bounds.maxX, y: bounds.minY};
            else if (action === 'br') c.transform_pivot = {x: bounds.minX, y: bounds.minY};
            else if (action === 'tc') c.transform_pivot = {x: (bounds.minX+bounds.maxX)/2, y: bounds.maxY};
            else if (action === 'bc') c.transform_pivot = {x: (bounds.minX+bounds.maxX)/2, y: bounds.minY};
            else if (action === 'ml') c.transform_pivot = {x: bounds.maxX, y: (bounds.minY+bounds.maxY)/2};
            else if (action === 'mr') c.transform_pivot = {x: bounds.minX, y: (bounds.minY+bounds.maxY)/2};
            else if (action === 'rot') c.transform_pivot = {x: (bounds.minX+bounds.maxX)/2, y: (bounds.minY+bounds.maxY)/2};
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
                        seqOff,
                        localToWorld,
                        worldToLocal,
                        previewRefId: cd.refId ?? ref.id
                    });
                }
            }
        }

        for (let info of curveContexts) {
            const curve = info.curve;
            let current = curve.startNode;
            while(current) {
                c.transform_snapshot.push({
                    node: current, seqOff: info.seqOff, refTx: info.refTx, refTy: info.refTy,
                    localToWorld: info.localToWorld || null,
                    worldToLocal: info.worldToLocal || null,
                    main: {x: current.x, y: current.y},
                    c1: current.control1 ? {x: current.control1.x, y: current.control1.y} : null,
                    c2: current.control2 ? {x: current.control2.x, y: current.control2.y} : null
                });
                current = current.nextOnCurve;
            }
        }

        const previewKeys = new Set([
            ...this.collectInteractiveStrokePreviewCurveIds(),
            ...this._previewKeysFromTransformContexts(curveContexts)
        ]);
        for (const snapRef of c.transform_snapshot_refs) {
            const ref = snapRef?.ref;
            if (ref?.isRef && ref.refId) {
                this._pushCurvesFromGroup(previewKeys, cm, ref.refId, ref.id);
            }
        }
        c.setInteractiveStrokePreviewCurveIds?.([...previewKeys]);
        c.is_dirty = true;
    }

    handleMouseMoveTransforming(mouseX, mouseY, clientX, clientY, isCtrlPressed, isShiftPressed) {
        const c = this.canvas;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        if (!c.transform_started_moving) {
            const movedScreen = Math.hypot(mouseX - c.transform_start_screen.x, mouseY - c.transform_start_screen.y);
            const movedClient = c.transform_anchor_client
                ? Math.hypot(clientX - c.transform_anchor_client.x, clientY - c.transform_anchor_client.y)
                : movedScreen;
            if (movedScreen > 4 || movedClient > 4) {
                c.transform_started_moving = true;
                c.setInteractiveStrokePreviewCurveIds?.(this.collectInteractiveStrokePreviewCurveIds());
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
            }
            c.curve_manager.applyTransformPreview({
                action: 'drag',
                snapshots: c.transform_snapshot,
                snapshotRefs: c.transform_snapshot_refs,
                dx: currentDx,
                dy: currentDy
            });
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
            return;
        }

        let dx = worldX - c.transform_start_world.x;
        let dy = worldY - c.transform_start_world.y;

        if (pivot) {
            let params = {};
            if (action === 'rot') params = TransformEngine.calculateRotationParams(pivot, c.transform_start_world, { x: worldX, y: worldY }, isCtrlPressed);
            else params = TransformEngine.calculateScaleParams(action, pivot, c.transform_start_world, { x: worldX, y: worldY }, (isShiftPressed || isCtrlPressed));
            c.curve_manager.applyTransformPreview({
                action,
                snapshots: c.transform_snapshot,
                snapshotRefs: c.transform_snapshot_refs,
                pivot,
                params
            });

            if (action !== 'rot' && c.transform_start_bounds) {
                const currentBounds = c.utils.getSelectionBounds();
                if (currentBounds) {
                    const corr = this.getScaleAnchorCorrection(action, c.transform_start_bounds, currentBounds);
                    if (corr.dx !== 0 || corr.dy !== 0) {
                        c.curve_manager.translateTransformPreview(
                            corr.dx,
                            corr.dy,
                            c.transform_snapshot,
                            c.transform_snapshot_refs
                        );
                    }
                }
            }
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    getScaleAnchorCorrection(action, startBounds, currentBounds) {
        let dx = 0;
        let dy = 0;

        switch (action) {
            case 'mr': dx = startBounds.minX - currentBounds.minX; break;
            case 'ml': dx = startBounds.maxX - currentBounds.maxX; break;
            case 'bc': dy = startBounds.minY - currentBounds.minY; break;
            case 'tc': dy = startBounds.maxY - currentBounds.maxY; break;
            case 'br':
                dx = startBounds.minX - currentBounds.minX;
                dy = startBounds.minY - currentBounds.minY;
                break;
            case 'bl':
                dx = startBounds.maxX - currentBounds.maxX;
                dy = startBounds.minY - currentBounds.minY;
                break;
            case 'tr':
                dx = startBounds.minX - currentBounds.minX;
                dy = startBounds.maxY - currentBounds.maxY;
                break;
            case 'tl':
                dx = startBounds.maxX - currentBounds.maxX;
                dy = startBounds.maxY - currentBounds.maxY;
                break;
        }

        return { dx, dy };
    }

    handleMouseMoveDraggingNode(mouseX, mouseY, isCtrlPressed) {
        const c = this.canvas;
        const dragging_node_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
        if(!dragging_node_n) return;

        const { local_dx, local_dy } = TransformEngine.calculateLocalDelta(
            mouseX - c.drag_initial_mouse.x, mouseY - c.drag_initial_mouse.y, c.scale, c.dragging_node_matrix
        );

        let raw_x = c.drag_initial_target.x + local_dx;
        let raw_y = c.drag_initial_target.y + local_dy;

        let snapped_x = raw_x;
        let snapped_y = raw_y;
        c.active_guidelines = [];

        let isMainNode = dragging_node_n.type !== null;
        let dragged_seq_offset = c.dragging_node_seq_idx !== -1 ? c.curve_manager.getSeqOffset(c.dragging_node_seq_idx) : 0;

        if (isCtrlPressed) {
            const snapResult = this.calculateAngleSnapping(dragging_node_n, isMainNode, local_dx, local_dy, raw_x, raw_y, dragged_seq_offset);
            snapped_x = snapResult.x; snapped_y = snapResult.y;
        } else {
            const snapResult = this.calculatePointSnapping(dragging_node_n, isMainNode, raw_x, raw_y, dragged_seq_offset);
            snapped_x = snapResult.x; snapped_y = snapResult.y;
        }

        if (isMainNode) {
            let actual_dx = snapped_x - c.drag_initial_target.x;
            let actual_dy = snapped_y - c.drag_initial_target.y;
            const updates = TransformEngine.calculateNodesTranslation(c.drag_initial_nodes, actual_dx, actual_dy);
            c.curve_manager.moveSelectedNodes(updates);
        } else {
            c.curve_manager.adjustControlNode(c.dragging_node_marker, snapped_x, snapped_y);
        }

        c.notifyPropertiesUpdate();
        c.is_dirty = true;
    }

    calculateAngleSnapping(dragging_node_n, isMainNode, local_dx, local_dy, raw_x, raw_y, dragged_seq_offset) {
        const c = this.canvas;
        let snapped_x = raw_x, snapped_y = raw_y;
        if (isMainNode) {
            if (Math.abs(local_dx) > Math.abs(local_dy)) snapped_y = c.drag_initial_target.y;
            else snapped_x = c.drag_initial_target.x;
        } else {
            let parentNode = dragging_node_n.nextOnCurve || dragging_node_n.lastOnCurve;
            let px = parentNode.x, py = parentNode.y;
            let currentAngle = Math.atan2(raw_y - py, raw_x - px);
            let dist = Math.hypot(raw_x - px, raw_y - py);
            let candidateAngles = [];
            candidateAngles.push(Math.round(currentAngle * 180 / Math.PI / 5) * 5 * Math.PI / 180);
            candidateAngles.push(c.drag_initial_target.angle);

            let oppositeControl = parentNode.control1?.main_node === c.dragging_node_marker ? parentNode.control2 : parentNode.control1;
            if (oppositeControl) {
                let oppAng = Math.atan2(oppositeControl.y - py, oppositeControl.x - px);
                candidateAngles.push(oppAng); candidateAngles.push(oppAng + Math.PI);
            }

            let bestAngle = candidateAngles[0]; let minDiff = Infinity;
            for(let ang of candidateAngles) {
                let diff = Math.abs(currentAngle - ang);
                while(diff > Math.PI) diff = Math.abs(diff - 2*Math.PI);
                if(diff < minDiff) { minDiff = diff; bestAngle = ang; }
            }
            snapped_x = px + dist * Math.cos(bestAngle); snapped_y = py + dist * Math.sin(bestAngle);
        }
        return { x: snapped_x, y: snapped_y };
    }

    calculatePointSnapping(dragging_node_n, isMainNode, raw_x, raw_y, dragged_seq_offset) {
        const c = this.canvas;
        let snapped_x = raw_x, snapped_y = raw_y;
        let snapThresholdLogical = 5 / c.scale;
        let targets = [];
        let seqTokens = c.curve_manager.sequenceTokens || [];

        for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

            for(let cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let current = cd.curve.startNode;
                while(current) {
                    const ixDrag = c.getInteractionSnapshot();
                    let isThisNodeMoving =
                        isMainNode && snapshotIncludesNodeMarker(ixDrag, current.main_node);
                    const pt = (x, y) => {
                        let mx = x, my = y;
                        if (cd.matrix) {
                            let new_x = mx * cd.matrix.a + my * cd.matrix.c + cd.matrix.e;
                            let new_y = mx * cd.matrix.b + my * cd.matrix.d + cd.matrix.f;
                            mx = new_x; my = new_y;
                        }
                        return { x: mx + seqOffsetX, y: my };
                    };
                    if ((current.main_node !== c.dragging_node_marker) && !isThisNodeMoving) targets.push(pt(current.x, current.y));
                    current = current.nextOnCurve;
                }
            }
        }

        let bestDist = Infinity, pointMatch = null, xMatch = null, bestXDist = Infinity, yMatch = null, bestYDist = Infinity;
        let world_raw_x = raw_x, world_raw_y = raw_y;

        if (c.dragging_node_matrix) {
            let p = c.dragging_node_matrix.transformPoint({x: raw_x, y: raw_y});
            world_raw_x = p.x; world_raw_y = p.y;
        }
        world_raw_x += dragged_seq_offset;

        for (let t of targets) {
            let dx = Math.abs(world_raw_x - t.x); let dy = Math.abs(world_raw_y - t.y); let d = Math.hypot(dx, dy);
            if (d < snapThresholdLogical && d < bestDist) { bestDist = d; pointMatch = t; }
            if (dx < snapThresholdLogical && dx < bestXDist) { bestXDist = dx; xMatch = t; }
            if (dy < snapThresholdLogical && dy < bestYDist) { bestYDist = dy; yMatch = t; }
        }

        if (pointMatch) {
            let local = pointMatch;
            if (c.dragging_node_matrix) local = c.dragging_node_matrix.inverse().transformPoint({x: pointMatch.x - dragged_seq_offset, y: pointMatch.y});
            else local = {x: pointMatch.x - dragged_seq_offset, y: pointMatch.y};
            snapped_x = local.x; snapped_y = local.y;
        } else {
            if (xMatch) {
                let p = { x: xMatch.x - dragged_seq_offset, y: world_raw_y };
                if (c.dragging_node_matrix) p = c.dragging_node_matrix.inverse().transformPoint(p);
                snapped_x = p.x; snapped_y = p.y; c.active_guidelines.push({ type: 'v', value: xMatch.x });
            }
            if (yMatch) {
                let p = { x: world_raw_x - dragged_seq_offset, y: yMatch.y };
                if (c.dragging_node_matrix) p = c.dragging_node_matrix.inverse().transformPoint(p);
                snapped_x = p.x; snapped_y = p.y; c.active_guidelines.push({ type: 'h', value: yMatch.y });
            }
        }
        return { x: snapped_x, y: snapped_y };
    }

    handleNodeDragMouseUp(e) {
        const c = this.canvas;
        if (c.current_state === 'DRAGGING_NODE') c.active_guidelines = [];

        let isMainNode = false;
        let isStateChangingAction = (c.current_state === 'DRAGGING_NODE');

        if(c.dragging_node_marker) {
            let dragged_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
            if (dragged_n) {
                isMainNode = dragged_n.type !== null;
                let parentMainNode = isMainNode ? dragged_n : (dragged_n.nextOnCurve || dragged_n.lastOnCurve);
                let parentMarker = parentMainNode.main_node;

                if (c.current_state !== "DRAGGING_NODE" && !e.ctrlKey) {
                    this._requestNodeSelection("replace", [parentMarker], c.dragging_node_refId || null);
                } else if (e.ctrlKey && c.current_state !== "DRAGGING_NODE") {
                    if (
                        !c.ctrl_click_added_selection &&
                        snapshotIncludesNodeMarker(c.getInteractionSnapshot(), parentMarker)
                    ) {
                        this._requestNodeSelection("toggle", [parentMarker], c.dragging_node_refId || null);
                    }
                }
            }
            c.new_selected_temp = null;
            c.ctrl_click_added_selection = false;
        }

        if (isStateChangingAction && isMainNode) {
            c.commands.changeSelectedNodesPosition();
            isStateChangingAction = false;
        } else if (isStateChangingAction && !isMainNode && c.dragging_node_marker) {
            let dragged_n = c.curve_manager.find_node_by_curve(c.dragging_node_marker);
            if (dragged_n) {
                c.commands.changeControlNodePosition(c.dragging_node_marker, dragged_n.x, dragged_n.y);
                isStateChangingAction = false;
            }
        }

        c.current_state = 'IDLE'; c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
        c.dragging_node_matrix = null; c.dragging_node_refId = null;

        const affectedCurveIds = this.collectInteractiveStrokePreviewCurveIds();
        c.clearInteractiveStrokePreview?.();
        c.flushSmartStrokeBooleanCache?.(affectedCurveIds);

        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
        c.renderer.update_previewData(pointer.x, pointer.y);
        c.notifyPropertiesUpdate(); c.is_dirty = true;

        if (isStateChangingAction) {
            CanvasDispatcher.requestHistoryCommit("node-drag-fallback", {});
        }
    }

    handlePaintHandleMouseUp(e) {
        const c = this.canvas;
        let last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
        if (last_node_n) {
            const mode = (c.new_curve_handle !== null) ? 1 : 0;
            c.curve_manager.changeSmoothModeOnSingleNode(c.last_on_curve_node_marker, mode);
        }
        c.new_curve_handle = null;
        c.current_state = 'IDLE'; c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
        c.dragging_node_matrix = null; c.dragging_node_refId = null;

        c.refreshViewportConfig();
        const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
        c.renderer.update_previewData(pointer.x, pointer.y);

        const paintCurveId = c.current_curve?.id;
        c.clearInteractiveStrokePreview?.();
        if (paintCurveId) {
            c.flushSmartStrokeBooleanCache?.([paintCurveId]);
        }

        if (c.closing_path_on_mouseup && c.current_curve) {
            c.current_curve.closed = true;
            c.commands.finishAddingPathCommand();
        } else {
            c.notifyPropertiesUpdate();
            c.is_dirty = true;
        }
    }

    handleSelectBoxMouseUp(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = false;
        let dx = mouseX - c.box_select_start.x, dy = mouseY - c.box_select_start.y;

        if (Math.hypot(dx, dy) < 4) {
            let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
            if (hitCurveSegment) {
                if (hitCurveSegment.refId) {
                    let refItem = c.curve_manager.treeItems.get(hitCurveSegment.refId);
                    if (refItem) {
                        this._requestObjectSelection(isShiftKey ? "toggle" : "replace", { refs: [refItem] });
                    }
                } else {
                    this._requestObjectSelection(isShiftKey ? "toggle" : "replace", { curves: [hitCurveSegment.curve] });
                }
            } else if (!isShiftKey) {
                this._requestObjectSelection("clear");
            }
            c.notifyPropertiesUpdate(); c.is_dirty = true;
            return;
        }

        const rect = this.getBoxSelectRectWorld();
        let seqTokens = c.curve_manager.sequenceTokens || [];
        let newlyFocusedSeqIdx = -1;
        let curvesToSelect = [];
        let refsToSelect = [];

        for (let i = 0; i < seqTokens.length; i++) {
            if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i]; let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

            for (let cd of curveDataList) {
                if (!cd.effectiveVis || cd.effectiveLock) continue;
                let bounds = cd.curve.getBounds(cd.matrix);
                if (bounds) {
                    if (bounds.minX + seqOffsetX >= rect.x && bounds.maxX + seqOffsetX <= rect.x + rect.w &&
                        bounds.minY >= rect.y && bounds.maxY <= rect.y + rect.h) {
                        if (cd.refId) {
                            let refItem = c.curve_manager.treeItems.get(cd.refId);
                            if (refItem) refsToSelect.push(refItem);
                        } else curvesToSelect.push(cd.curve);
                        newlyFocusedSeqIdx = i;
                    }
                }
            }
        }
        if (newlyFocusedSeqIdx !== -1) this._setFocusedSequenceIndex(newlyFocusedSeqIdx);

        if (curvesToSelect.length > 0 || refsToSelect.length > 0) {
            this._requestObjectSelection(isShiftKey ? "add" : "replace", { curves: curvesToSelect, refs: refsToSelect });
        } else if (!isShiftKey) {
            this._requestObjectSelection("clear");
        }
        c.notifyPropertiesUpdate(); c.is_dirty = true;
    }

    handleNodeBoxMouseUp(mouseX, mouseY, isShiftKey) {
        const c = this.canvas;
        c.is_box_selecting = false;
        let dx = mouseX - c.box_select_start.x, dy = mouseY - c.box_select_start.y;
        let markersToSelect = [];

        let activeGroupFromBox = null;
        if (Math.hypot(dx, dy) > 4) {
            const rect = this.getBoxSelectRectWorld();
            let seqTokens = c.curve_manager.sequenceTokens || [];

            for (let i = 0; i < seqTokens.length; i++) {
                if (!c.curve_manager.activeSequenceIndices.has(i)) continue;
                let seqOffsetX = c.curve_manager.getSeqOffset(i);
                let token = seqTokens[i]; let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let curveDataList = c.curve_manager.getCurvesForGroup(groupId);

                for (let cd of curveDataList) {
                    if (!cd.effectiveVis || cd.effectiveLock) continue;
                    let current = cd.curve.startNode;
                    while(current) {
                        let mx = current.x, my = current.y;
                        if (cd.matrix) {
                            const x = mx;
                            const y = my;
                            mx = x * cd.matrix.a + y * cd.matrix.c + cd.matrix.e;
                            my = x * cd.matrix.b + y * cd.matrix.d + cd.matrix.f;
                        }
                        let wx = mx + seqOffsetX;
                        if (wx >= rect.x && wx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) {
                            markersToSelect.push({ marker: current.main_node, refId: cd.refId || null });
                            activeGroupFromBox = groupId;
                        }
                        current = current.nextOnCurve;
                    }
                }
            }
            if (activeGroupFromBox) {
                CanvasDispatcher.requestSetActiveGroup(activeGroupFromBox);
            }
            c.notifyPropertiesUpdate(); c.is_dirty = true;
        }

        if (markersToSelect.length > 0) {
            const curves = [];
            const refs = [];
            const seenCurveIds = new Set();
            const seenRefIds = new Set();
            const markers = [];
            const refIds = [];
            for (const entry of markersToSelect) {
                markers.push(entry.marker);
                refIds.push(entry.refId);
            }
            if (!isShiftKey) {
                this._requestNodeSelection("replace", markers, refIds[0] ?? null);
            } else {
                this._requestNodeSelection("add", markers, refIds[0] ?? null);
            }
        } else if (!isShiftKey) {
            this._requestObjectSelection("clear");
        }
        if (Math.hypot(dx, dy) > 4) {
            CanvasDispatcher.requestHistoryCommit("node-box-selection", {});
        }
    }

    actionSpiralMove(anchorNode, isExpanding) {
        const c = this.canvas;
        if (!anchorNode || !anchorNode.curve) return;
        const nodesArray = []; let curr = anchorNode.curve.startNode;
        while (curr) { nodesArray.push(curr); curr = curr.nextOnCurve; }
        const centerIdx = nodesArray.indexOf(anchorNode); const total = nodesArray.length;
        const selecting = createNodeMarkerIdSet(c.getInteractionSnapshot());

        const getIndexByStep = (s) => {
            if (s === 0) return centerIdx;
            const offset = Math.ceil(s / 2); return (s % 2 !== 0) ? (centerIdx + offset) : (centerIdx - offset);
        };

        for (let s = 0; s < total * 2; s++) {
            const idx = getIndexByStep(s);
            if (idx >= 0 && idx < total) {
                const marker = nodesArray[idx].main_node;
                if (isExpanding) {
                    if (!selecting.has(marker.id)) {
                        this._requestNodeSelection("add", [marker]);
                        CanvasDispatcher.requestHistoryCommit("spiral-move-expand", {}); return;
                    }
                } else {
                    if (selecting.has(marker.id)) {
                        this._requestNodeSelection("toggle", [marker]);
                        CanvasDispatcher.requestHistoryCommit("spiral-move-shrink", {}); return;
                    }
                }
            }
        }
    }

    getBoxSelectRectWorld() {
        const c = this.canvas;
        if (!c.box_select_start || !c.box_select_end) return { x: 0, y: 0, w: 0, h: 0 };
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const startWorldX = (c.box_select_start.x - offsetX) / c.scale;
        const startWorldY = (c.box_select_start.y - offsetY) / c.scale;
        const endWorldX = (c.box_select_end.x - offsetX) / c.scale;
        const endWorldY = (c.box_select_end.y - offsetY) / c.scale;
        return {
            x: Math.min(startWorldX, endWorldX), y: Math.min(startWorldY, endWorldY),
            w: Math.abs(endWorldX - startWorldX), h: Math.abs(endWorldY - startWorldY)
        };
    }
}
