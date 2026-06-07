import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { resolveActiveCanvasTool, snapshotIncludesCurve, snapshotIncludesRef } from "../../app/editor_interaction_state.js";
export class CanvasInputController {
    constructor(canvas) {
        this.canvas = canvas;
    }
    bind() {
        const c = this.canvas;
        const ic = c.interactionController;
        c.addGlobalListener('window', "wheel", (e) => {
            const isHoveringCanvas = e.composedPath().includes(c) || e.composedPath().includes(c.canvas);
            if (!isHoveringCanvas && !e.ctrlKey) return;
            if (e.ctrlKey || e.metaKey) e.preventDefault();
        }, { passive: false });
        c.addGlobalListener('document', 'mousedown', (e) => {
            let path = [];
            if (typeof e.composedPath === 'function') path = e.composedPath();
            else { let currentNode = e.target; while (currentNode) { path.push(currentNode); currentNode = currentNode.parentNode || currentNode.host; } }
            let isTree = false;
            for (let el of path) { if (el.tagName === 'OBJECT-TREE' || (el.classList && el.classList.contains('tree_menu'))) { isTree = true; break; } }
            if (isTree) c.env.setActiveContext('tree');
            else {
                let isCanvas = false;
                for (let el of path) { if (el.tagName === 'MAIN-CANVAS') { isCanvas = true; break; } }
                if (isCanvas) c.env.setActiveContext('canvas');
            }
        }, true);
        c.canvasObj.addEventListener("dblclick", (e) => {
            if (e.button !== 0 || c.getActiveTool() !== "NODE") return;
            if (c.hovered_curve_segment) {
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
                const mouseX = pointer.x; const mouseY = pointer.y;
                const worldX = (mouseX - offsetX) / c.scale; const worldY = (mouseY - offsetY) / c.scale;
                let seg = c.hovered_curve_segment;
                let seqOffsetX = c.curve_manager.getSeqOffset(seg.seqIndex);
                let localX = worldX - seqOffsetX; let localY = worldY;
                if (seg.matrix) {
                    let inv = seg.matrix.inverse(); let pt = inv.transformPoint({x: localX, y: localY});
                    localX = pt.x; localY = pt.y;
                }
                c.commands.insertMainNode(seg, localX, localY);
            }
        });
        c.canvasObj.addEventListener("mousedown", (e) => {
            const tool = resolveActiveCanvasTool(c);
            const activeEl = document.activeElement;
            const isTextInputActive = !!(
                activeEl &&
                (
                    (activeEl.tagName === "INPUT" && activeEl.type !== "checkbox" && activeEl.type !== "radio") ||
                    activeEl.tagName === "TEXTAREA" ||
                    activeEl.isContentEditable
                )
            );
            if (e.button === 1 && isTextInputActive) {
                if (typeof activeEl.blur === 'function') activeEl.blur();
                e.preventDefault();
                return;
            }
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
            const mouseX = pointer.x, mouseY = pointer.y;
            let hitResult = c.utils.hitTestNode(mouseX, mouseY);
            let hitMarker = hitResult ? hitResult.marker : null;
            let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
            let handleHit = tool === 'SELECT' ? c.utils.hitTestTransformHandles(mouseX, mouseY) : null;
            let isCtrlLeftPan = (e.button === 0 && e.ctrlKey && !hitMarker && !hitCurveSegment && !handleHit && tool !== 'MEASURE');
            let isMiddlePan = (e.button === 1);
            if (isMiddlePan || isCtrlLeftPan) {
                e.preventDefault(); c.current_state = 'PANNING';
                c.drag_start = { x: e.clientX, y: e.clientY }; c.offset_start = { x: c.offset.x, y: c.offset.y };
                c.previewData = null; c.is_dirty = true; return;
            }
            if(e.button === 0) {
                if (c.current_state === 'DRAGGING_USER_GUIDE') return;
                if (c.canvasObj.setPointerCapture && Number.isFinite(e.pointerId)) {
                    try {
                        c.canvasObj.setPointerCapture(e.pointerId);
                        c._pointerCaptureId = e.pointerId;
                    } catch (_) { /* ignore */ }
                }
                const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
                const worldX = (mouseX - offsetX) / c.scale, worldY = (mouseY - offsetY) / c.scale;
                const guideHit = c.utils.hitTestUserGuides(mouseX, mouseY);
                if (guideHit) { e.preventDefault(); return; }
                if (tool === 'MEASURE') ic.handleMeasureMouseDown(worldX, worldY);
                else if (tool === 'SELECT') ic.handleSelectMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, e.shiftKey, e.clientX, e.clientY);
                else if (hitMarker && (tool === 'NODE' || tool === 'DRAW')) ic.handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, e.shiftKey, e.ctrlKey);
                else if (tool === 'NODE') ic.handleNodeMissMouseDown(mouseX, mouseY, e.shiftKey);
                else if (tool === 'DRAW') ic.handleDrawMouseDown(mouseX, mouseY, worldX, worldY);
            }
            else if (e.button === 2) {
                if (tool === "DRAW") {
                    if (c.current_curve?.startNode) {
                        if (c.drawToolSettings?.closed) c.current_curve.closed = true;
                        c.commands.finishAddingPathCommand();
                    } else if (c.current_curve) {
                        c.commands.finishAddingPath();
                    }
                    c.current_state = "IDLE";
                    c.closing_path_on_mouseup = false;
                    c.new_curve_handle = null;
                    c.previewData = null;
                    c.dragging_node_marker = null;
                }
                c.is_dirty = true;
            }
        });
        c.addGlobalListener('window', "mousemove", (e) => {
            const tool = resolveActiveCanvasTool(c);
            if (c.current_state !== 'IDLE' && e.buttons === 0) {
                if (typeof c.handleMouseUp === 'function') c.handleMouseUp({ button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey });
                return;
            }
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
            const mouseX = pointer.x, mouseY = pointer.y;
            c.last_mouse_pos_x = e.clientX; c.last_mouse_pos_y = e.clientY;
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            if(!c.mouse_pos_output) c.mouse_pos_output = c.env.queryDOM("#mouse_pos");
            if(c.mouse_pos_output && c.current_state !== 'PANNING') {
                const worldX = (mouseX - offsetX) / c.scale, worldY = (mouseY - offsetY) / c.scale;
                c.mouse_pos_output.textContent = "Mouse Pos " + worldX.toFixed(2) + " " + (c.canvas_size_height - worldY).toFixed(2);
            }
            if (c._rulerIndicatorH && c._rulerIndicatorV && c.painting_area) {
                const pa = c.painting_area.getBoundingClientRect();
                const px = e.clientX - pa.left;
                const py = e.clientY - pa.top;
                const inCanvas = px >= 18 && px <= pa.width && py >= 18 && py <= pa.height;
                c._rulerIndicatorH.style.display = inCanvas ? "block" : "none";
                c._rulerIndicatorH.style.left = `${px - 5}px`;
                c._rulerIndicatorV.style.display = inCanvas ? "block" : "none";
                c._rulerIndicatorV.style.top = `${py - 5}px`;
            }
            if (tool === 'MEASURE' && c.is_measuring) {
                const worldX = (mouseX - offsetX) / c.scale, worldY = (mouseY - offsetY) / c.scale;
                c.measure_end = {x: worldX, y: worldY}; c.is_dirty = true;
            }
            if ((tool === 'SELECT' || tool === 'NODE') && c.is_box_selecting) {
                c.box_select_end = {x: mouseX, y: mouseY}; c.is_dirty = true;
            }
            if (c.current_state === 'TRANSFORMING_OBJECTS') {
                ic.handleMouseMoveTransforming(mouseX, mouseY, e.clientX, e.clientY, e.ctrlKey, e.shiftKey);
                return;
            }
            let hoverStateChanged = false;
            if(c.current_state === 'PANNING' && (e.buttons & 1 || e.buttons & 4)) {
                const dx = e.clientX - c.drag_start.x, dy = e.clientY - c.drag_start.y;
                c.offset = { x: c.offset_start.x + dx, y: c.offset_start.y + dy };
                c.is_dirty = true;
            }
            else if((e.buttons & 1) !== 0 && c.current_state === 'PAINTING_HANDLE') {
                ic.handleMouseMovePaintingHandle(mouseX, mouseY);
            }
            else if((e.buttons & 1) !== 0 && c.current_state === 'DRAGGING_NODE_READY') {
                if(Math.abs(mouseX - c.drag_initial_mouse.x) > 4 || Math.abs(mouseY - c.drag_initial_mouse.y) > 4) {
                    c.current_state = 'DRAGGING_NODE';
                    c.setInteractiveStrokePreviewCurveIds?.(ic.collectInteractiveStrokePreviewCurveIds());
                }
            }
            if(c.current_state === 'DRAGGING_NODE') {
                ic.handleMouseMoveDraggingNode(mouseX, mouseY, e.ctrlKey);
            }
            if (c.current_state === 'IDLE') {
                let hitResult = c.utils.hitTestNode(mouseX, mouseY);
                let hitMarker = hitResult ? hitResult.marker : null; let hitCurveSegment = hitMarker ? null : c.utils.hitTestCurve(mouseX, mouseY);
                if (tool === 'SELECT') hitCurveSegment = null;
                if (c.hovered_node_marker !== hitMarker) { c.hovered_node_marker = hitMarker; hoverStateChanged = true; }
                if (c.hovered_curve_segment !== (hitCurveSegment ? hitCurveSegment.curve : null)) { c.hovered_curve_segment = hitCurveSegment; hoverStateChanged = true; }
                if (hoverStateChanged) c.is_dirty = true;
            }
            if (c.current_state === 'IDLE' && tool === 'SELECT') {
                let handleHit = c.utils.hitTestTransformHandles(mouseX, mouseY);
                if (handleHit === 'tl' || handleHit === 'br') c.canvasObj.style.cursor = 'nwse-resize';
                else if (handleHit === 'tr' || handleHit === 'bl') c.canvasObj.style.cursor = 'nesw-resize';
                else if (handleHit === 'tc' || handleHit === 'bc') c.canvasObj.style.cursor = 'ns-resize';
                else if (handleHit === 'ml' || handleHit === 'mr') c.canvasObj.style.cursor = 'ew-resize';
                else if (handleHit === 'rot') c.canvasObj.style.cursor = 'crosshair';
                else {
                    let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
                    const ix = c.getInteractionSnapshot();
                    const refItem = hitCurveSegment?.refId ? c.curve_manager.treeItems.get(hitCurveSegment.refId) : null;
                    c.canvasObj.style.cursor = (hitCurveSegment && (snapshotIncludesCurve(ix, hitCurveSegment.curve) || snapshotIncludesRef(ix, refItem))) ? 'move' : 'default';
                }
            } else if (c.current_state !== 'TRANSFORMING_OBJECTS' && c.current_state !== 'PANNING' && c.current_state !== 'DRAGGING_NODE') {
                c.canvasObj.style.cursor = 'default';
            }
            if (c.current_state === 'IDLE') {
                c.renderer.update_previewData(mouseX, mouseY); if (c.last_on_curve_node_marker !== null) c.is_dirty = true;
            } else { if (c.previewData !== null) { c.previewData = null; c.is_dirty = true; } }
        });
        c.addGlobalListener(c.canvasObj, "mouseleave", () => {
            if (c._rulerIndicatorH) c._rulerIndicatorH.style.display = "none";
            if (c._rulerIndicatorV) c._rulerIndicatorV.style.display = "none";
            if (!c._draggingUserGuide) {
                c._hoveredUserGuideId = null;
                c.is_dirty = true;
            }
        });
        const startUserGuideDrag = (type, clientX, clientY) => {
            c.current_state = 'DRAGGING_USER_GUIDE';
            const pointer = c.getViewportMousePosition(clientX, clientY);
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            const worldX = (pointer.x - offsetX) / c.scale;
            const worldY = (pointer.y - offsetY) / c.scale;
            c._draggingUserGuide = {
                id: c._nextUserGuideId++,
                type: type,
                x: worldX,
                y: worldY,
                angle: 0,
                _isNew: true,
                _clientX: clientX,
                _clientY: clientY
            };
            c.is_dirty = true;
        };
        if (c.ruler_horizontal) {
            c.ruler_horizontal.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (c.guideline_lock) return;
                e.preventDefault();
                e.stopPropagation();
                startUserGuideDrag("v", e.clientX, e.clientY);
            });
        }
        if (c.ruler_vertical) {
            c.ruler_vertical.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (c.guideline_lock) return;
                e.preventDefault();
                e.stopPropagation();
                startUserGuideDrag("h", e.clientX, e.clientY);
            });
        }
        c.addGlobalListener('window', "mousemove", (e) => {
            if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            c._draggingUserGuide.x = (pointer.x - offsetX) / c.scale;
            c._draggingUserGuide.y = (pointer.y - offsetY) / c.scale;
            c.is_dirty = true;
        });
        c.addGlobalListener('window', "mouseup", (e) => {
            if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
            const guide = c._draggingUserGuide;
            const wasNew = guide._isNew;
            c._draggingUserGuide = null;
            c.current_state = 'IDLE';
            const dx = e.clientX - guide._clientX;
            const dy = e.clientY - guide._clientY;
            if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) {
                if (!wasNew) c.is_dirty = true;
                return;
            }
            const pa = c.painting_area?.getBoundingClientRect();
            if (pa) {
                const toRuler = e.clientY <= pa.top + 18 || e.clientX <= pa.left + 18;
                if (toRuler) {
                    if (!wasNew) {
                        c.user_guidelines = c.user_guidelines.filter(g => g.id !== guide.id);
                    }
                    c.is_dirty = true;
                    return;
                }
            }
            if (wasNew) {
                c.user_guidelines.push(guide);
            }
            c.is_dirty = true;
        });
        c.addGlobalListener(c.canvasObj, "mousemove", (e) => {
            if (c.current_state === 'DRAGGING_USER_GUIDE') return;
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
            const newId = hit ? hit.guide.id : null;
            if (c._hoveredUserGuideId !== newId) {
                c._hoveredUserGuideId = newId;
                c.canvasObj.style.cursor = hit ? (hit.hitType === "dot" ? "move" : "pointer") : "";
                c.is_dirty = true;
            }
        });
        c.addGlobalListener(c.canvasObj, "dblclick", (e) => {
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
            if (!hit) return;
            if (c.guideline_lock) return;
            e.preventDefault();
            e.stopPropagation();
            c._showUserGuideEditDialog(hit.guide, e.clientX, e.clientY);
        });
        c.addGlobalListener(c.canvasObj, "mousedown", (e) => {
            if (e.button !== 0) return;
            if (c.current_state === 'DRAGGING_USER_GUIDE') return;
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
            if (!hit) return;
            if (c.guideline_lock) return;
            e.preventDefault();
            e.stopPropagation();
            c.current_state = 'DRAGGING_USER_GUIDE';
            const guide = hit.guide;
            c._draggingUserGuide = guide;
            guide._isNew = false;
            guide._clientX = e.clientX;
            guide._clientY = e.clientY;
        });
        c._showUserGuideEditDialog = (guide, clientX, clientY) => {
            const old = document.querySelector(".user-guide-edit-overlay");
            if (old) old.remove();
            const overlay = document.createElement("div");
            overlay.className = "user-guide-edit-overlay";
            const dlg = document.createElement("div");
            dlg.className = "user-guide-edit-dialog";
            dlg.style.left = `${clientX}px`;
            dlg.style.top = `${clientY}px`;
            dlg.innerHTML = `<div class="field-row"><label>X</label><input type="number" step="1" value="${guide.x.toFixed(1)}" data-field="x"></div>
                <div class="field-row"><label>Y</label><input type="number" step="1" value="${guide.y.toFixed(1)}" data-field="y"></div>
                <div class="field-row"><label>Angle</label><input type="number" step="1" value="${(guide.angle || 0).toFixed(1)}" data-field="angle"></div>
                <div class="btn-row"><button class="btn-cancel">Cancel</button><button class="btn-ok">OK</button></div>`;
            overlay.appendChild(dlg);
            document.body.appendChild(overlay);
            const rect = dlg.getBoundingClientRect();
            if (rect.right > window.innerWidth) dlg.style.left = `${clientX - rect.width}px`;
            if (rect.bottom > window.innerHeight) dlg.style.top = `${clientY - rect.height}px`;
            const inputs = dlg.querySelectorAll("input");
            inputs[0].focus(); inputs[0].select();
            const apply = () => {
                guide.x = parseFloat(dlg.querySelector('[data-field="x"]').value) || 0;
                guide.y = parseFloat(dlg.querySelector('[data-field="y"]').value) || 0;
                guide.angle = parseFloat(dlg.querySelector('[data-field="angle"]').value) || 0;
                overlay.remove();
                c.is_dirty = true;
            };
            dlg.querySelector(".btn-ok").addEventListener("click", apply);
            dlg.querySelector(".btn-cancel").addEventListener("click", () => overlay.remove());
            overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) overlay.remove(); });
            inputs.forEach(inp => inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") apply(); if (ev.key === "Escape") overlay.remove(); }));
        };
        c.handleMouseUp = (e) => {
            const tool = resolveActiveCanvasTool(c);
            if (c._pointerCaptureId != null && c.canvasObj.releasePointerCapture) {
                try { c.canvasObj.releasePointerCapture(c._pointerCaptureId); } catch (_) { /* ignore */ }
                c._pointerCaptureId = null;
            }
            if (c.current_state === 'PANNING') {
                c.current_state = 'IDLE';
                c.editorStore?.syncViewFromCanvas?.();
                c.history.saveCurrentViewState();
                return;
            }
            if (e.button === 0) {
                if (c.current_state === 'TRANSFORMING_OBJECTS') { ic.handleTransformMouseUp(); return; }
                if (tool === 'MEASURE' && c.is_measuring) { c.is_measuring = false; c.is_dirty = true; return; }
                if (tool === 'SELECT' && c.is_box_selecting) {
                    c.refreshViewportConfig();
                    const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                    ic.handleSelectBoxMouseUp(pointer.x, pointer.y, e.shiftKey); return;
                }
                if (tool === 'NODE' && c.is_box_selecting) {
                    c.refreshViewportConfig();
                    const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                    ic.handleNodeBoxMouseUp(pointer.x, pointer.y, e.shiftKey); return;
                }
                if (c.current_state === 'DRAGGING_NODE' || c.current_state === 'DRAGGING_NODE_READY') { ic.handleNodeDragMouseUp(e); return; }
                if (c.current_state === 'PAINTING_HANDLE') { ic.handlePaintHandleMouseUp(e); return; }
                c.current_state = 'IDLE'; c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
                c.dragging_node_matrix = null; c.dragging_node_refId = null;
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                c.renderer.update_previewData(pointer.x, pointer.y);
                c.notifyPropertiesUpdate(); c.is_dirty = true;
            }
        };
        c.addGlobalListener('window', "mouseup", c.handleMouseUp);
        c.canvasObj.addEventListener("wheel", (e) => {
            e.preventDefault();
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
            const mouseX = pointer.x, mouseY = pointer.y;
            let hitResult = c.utils.hitTestNode(mouseX, mouseY);
            let hitMarker = hitResult ? hitResult.marker : null;
            let hitNode = hitMarker ? c.curve_manager.find_node_by_curve(hitMarker) : null;
            if (hitNode && !e.ctrlKey && !e.altKey && hitNode.type === "vertex") {
                ic.actionSpiralMove(hitNode, e.deltaY < 0); return;
            }
            if(e.ctrlKey || e.altKey) {
                if (c.current_state !== 'PANNING') {
                    const viewport = c.viewportConfig || {};
                    const ruler_w = Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size;
                    const ruler_h = Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size;
                    let logical_x = mouseX - ruler_w - c.offset.x;
                    let logical_y = mouseY - ruler_h - c.offset.y;
                    let isFixedCenter = e.altKey;
                    c.renderer.change_canvas_size(e.deltaY, logical_x, logical_y, isFixedCenter);
                    c.renderer.update_previewData(mouseX, mouseY); c.is_dirty = true;
                }
            }
        }, { passive: false });
        c.addGlobalListener('window', "contextmenu", e => e.preventDefault());
        c.addGlobalListener('window', "keydown", (e) => {
            const tool = resolveActiveCanvasTool(c);
            if (e.ctrlKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) e.preventDefault();
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) { if (e.target.type !== 'checkbox' && e.target.type !== 'radio') return; }
            if (c.is_restoring) { e.preventDefault(); return; }
            if (e.ctrlKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
                e.preventDefault(); const moveStep = 40;
                if (e.code === "ArrowUp") c.offset.y += moveStep; if (e.code === "ArrowDown") c.offset.y -= moveStep;
                if (e.code === "ArrowLeft") c.offset.x += moveStep; if (e.code === "ArrowRight") c.offset.x -= moveStep;
                c.is_dirty = true; c.history.saveCurrentViewState(); return;
            }
            if (e.ctrlKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
                let dy = (e.key === '-' || e.code === 'NumpadSubtract') ? 100 : -100;
                c.renderer.change_canvas_size(dy, 0, 0, false, true); c.is_dirty = true; return;
            }
            if (e.ctrlKey && e.code === "KeyS") { e.preventDefault(); c.io.triggerSave(); return; }
            if (e.ctrlKey && e.shiftKey && e.code === "KeyE") { e.preventDefault(); c.io.exportToUFO(); return; }
            if (e.ctrlKey && e.code === "KeyU") { e.preventDefault(); CanvasDispatcher.requestBooleanUnion(); return; }
            if (e.ctrlKey && (e.code === "KeyZ" || e.key === "z")) {
                e.preventDefault();
                if (e.shiftKey) CanvasDispatcher.requestRedo();
                else if (tool === "DRAW" && c.current_curve) c.commands.undoDrawingStep();
                else CanvasDispatcher.requestUndo();
                return;
            }
            if (e.ctrlKey && (e.code === "KeyY" || e.key === "y")) {
                e.preventDefault();
                CanvasDispatcher.requestRedo();
                return;
            }
            let activeContext = c.env.getActiveContext() || 'canvas';
            const dispatchTreeAction = (action, contextId = null) => { CanvasDispatcher.requestEditorAction(action, contextId); };
            if (activeContext === 'tree') {
                if (e.ctrlKey && e.code === "KeyC") { e.preventDefault(); dispatchTreeAction('copy'); }
                else if (e.ctrlKey && e.code === "KeyV") { e.preventDefault(); dispatchTreeAction('paste', c.getInteractionSnapshot().activeGroupId); }
                else if (e.ctrlKey && e.code === "KeyD") { e.preventDefault(); dispatchTreeAction('duplicate'); }
                else if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); dispatchTreeAction('delete'); }
            } else {
                if (e.ctrlKey && e.code === "KeyC") { e.preventDefault(); dispatchTreeAction('copy'); }
                else if (e.ctrlKey && e.code === "KeyV") { e.preventDefault(); dispatchTreeAction('paste', c.getInteractionSnapshot().activeGroupId); }
                else if (e.ctrlKey && e.code === "KeyD") { e.preventDefault(); dispatchTreeAction('duplicate'); }
                else if (e.code === "Delete" || e.code === "Backspace") {
                    e.preventDefault();
                    if (tool === 'NODE') {
                        c.commands.deleteSelectedNodes();
                    } else if (tool === 'SELECT') {
                        CanvasDispatcher.requestDeleteSelectedObjects();
                    }
                }
            }
        });
    }
}
