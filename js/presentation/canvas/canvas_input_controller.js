import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { resolveActiveCanvasTool, snapshotIncludesCurve, snapshotIncludesRef } from "../../app/editor_interaction_state.js";
/**
 * CanvasInputController: binds DOM events to canvas interaction layer.
 *
 * Keyboard shortcuts (handled at canvas level):
 * - Delete / Backspace: delete selected objects (SELECT tool) or selected nodes (NODE tool) | canvas / tree
 * - Ctrl+Z: undo; during DRAW draw reverts last main node | global
 * - Ctrl+Shift+Z / Ctrl+Y: redo | global
 * - Ctrl+C: copy selected objects | canvas / tree
 * - Ctrl+V: paste to active group | canvas / tree
 * - Ctrl+D: duplicate selected objects | canvas / tree
 * - Ctrl+S: save file | global
 * - Ctrl+Shift+E: export UFO | global
 * - Ctrl+U: boolean union | global
 * - Ctrl+= / Ctrl+-: adjust canvas size (change_canvas_size) | global
 * - Escape: cancel current operation | global
 *
 * Mouse coordinate display:
 * Top-right of canvas shows world coordinates: "Mouse Pos {x} {y}"
 * (y = canvas_size_height - worldY, i.e. positive upward)
 */
export class CanvasInputController {
    constructor(canvas) {
        this.canvas = canvas;
    }
    bind() {
        const c = this.canvas;
        const ic = c.interactionController;
        // Direct addEventListener listeners (on canvasObj, rulers) survive disconnect.
        // Only register them once; addGlobalListener listeners are re-registered every
        // call since disconnectedCallback cleans up globalEventTrackers.
        if (c._inputControllerCanvasBound) {
            // Re-register only the global listeners that disconnectedCallback cleaned up
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
                    c._rulerIndicatorH.classList.toggle('is-visible', inCanvas);
                    c._rulerIndicatorH.style.left = `${px - 5}px`;
                    c._rulerIndicatorV.classList.toggle('is-visible', inCanvas);
                    c._rulerIndicatorV.style.top = `${py - 5}px`;
                }
                if (tool === 'MEASURE') ic.handleMeasureMouseMove(mouseX, mouseY);
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
                else if((e.buttons & 1) !== 0 && c.current_state === 'DRAGGING_ELLIPSE') {
                    const ewX = (mouseX - offsetX) / c.scale, ewY = (mouseY - offsetY) / c.scale;
                    ic.handleEllipseMouseMove(mouseX, mouseY, ewX, ewY, e.ctrlKey);
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
                    if (handleHit === 'tl' || handleHit === 'br') c.canvasObj.dataset.cursor = 'nwse-resize';
                    else if (handleHit === 'tr' || handleHit === 'bl') c.canvasObj.dataset.cursor = 'nesw-resize';
                    else if (handleHit === 'tc' || handleHit === 'bc') c.canvasObj.dataset.cursor = 'ns-resize';
                    else if (handleHit === 'ml' || handleHit === 'mr') c.canvasObj.dataset.cursor = 'ew-resize';
                    else if (handleHit === 'rot_tl' || handleHit === 'rot_br') c.canvasObj.dataset.cursor = 'crosshair';
                    else if (handleHit === 'rot_tr' || handleHit === 'rot_bl') c.canvasObj.dataset.cursor = 'crosshair';
                    else if (handleHit === 'shear_tc' || handleHit === 'shear_bc') c.canvasObj.dataset.cursor = 'ew-resize';
                    else if (handleHit === 'shear_ml' || handleHit === 'shear_mr') c.canvasObj.dataset.cursor = 'ns-resize';
                    else if (handleHit === 'pivot') c.canvasObj.dataset.cursor = 'move';
                    else if (c._hoveredUserGuideId !== null) {
                        // Guide hover overrides curve/object hit but not handles
                    } else {
                        let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
                        const ix = c.getInteractionSnapshot();
                        const refItem = hitCurveSegment?.refId ? c.curve_manager.treeItems.get(hitCurveSegment.refId) : null;
                        c.canvasObj.dataset.cursor = (hitCurveSegment && (snapshotIncludesCurve(ix, hitCurveSegment.curve) || snapshotIncludesRef(ix, refItem))) ? 'move' : 'default';
                    }
                } else if (c._hoveredUserGuideId !== null) {
                    // Guide hover for non-SELECT tools
                } else if (c.current_state !== 'TRANSFORMING_OBJECTS' && c.current_state !== 'PANNING' && c.current_state !== 'DRAGGING_NODE' && c.current_state !== 'DRAGGING_USER_GUIDE' && c.current_state !== 'DRAGGING_DIVIDER') {
                    if (c.getActiveTool() !== 'DRAW' && c.getActiveTool() !== 'ELLIPSE') {
                        const divHit = c.utils.hitTestDividerLines(mouseX, mouseY);
                        c.canvasObj.dataset.cursor = divHit ? "ew-resize" : "default";
                    } else {
                        c.canvasObj.dataset.cursor = "crosshair";
                    }
                }
                if (c.current_state === 'IDLE') {
                    c.renderer.update_previewData(mouseX, mouseY); if (c.last_on_curve_node_marker !== null) c.is_dirty = true;
                } else { if (c.previewData !== null) { c.previewData = null; c.is_dirty = true; } }
            });
            c.addGlobalListener(c.canvasObj, "mouseleave", () => {
                if (c._rulerIndicatorH) c._rulerIndicatorH.classList.remove('is-visible');
                if (c._rulerIndicatorV) c._rulerIndicatorV.classList.remove('is-visible');
                if (!c._draggingUserGuide) {
                    c._hoveredUserGuideId = null;
                    c.is_dirty = true;
                }
                if (!c._draggingDivider) {
                    c._hoveredDividerId = null;
                    c.is_dirty = true;
                }
                if (c._hoveredRulerId !== null || c._hoveredRulerEndpoint !== null) {
                    c._hoveredRulerId = null;
                    c._hoveredRulerEndpoint = null;
                    c.is_dirty = true;
                }
            });
            c.addGlobalListener('window', "mousemove", (e) => {
                if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
                const guide = c._draggingUserGuide;
                if (!guide._dragStarted) {
                    if (Math.abs(e.clientX - guide._clientX) <= 4 && Math.abs(e.clientY - guide._clientY) <= 4) return;
                    guide._dragStarted = true;
                }
                c.canvasObj.dataset.cursor = guide.type === 'v' ? 'ew-resize' : 'ns-resize';
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
                const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
                guide.x = (pointer.x - offsetX) / c.scale;
                guide.y = (pointer.y - offsetY) / c.scale;
                c.is_dirty = true;
            });
            c.addGlobalListener('window', "mousemove", (e) => {
                if (c.current_state !== 'DRAGGING_DIVIDER' || !c._draggingDivider) return;
                const div = c._draggingDivider;
                if (!div._dragStarted) {
                    if (Math.abs(e.clientX - div._clientX) <= 4 && Math.abs(e.clientY - div._clientY) <= 4) return;
                    div._dragStarted = true;
                }
                c.canvasObj.dataset.cursor = 'ew-resize';
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
                const dx = pointer.x - div.startScreenX;
                const newAdvance = Math.max(0, div.startAdvance + dx / c.scale);
                const group = c.curve_manager.treeItems.get(div.groupId);
                if (group) {
                    group.advance = newAdvance;
                    group.is_modified = true;
                    c.curve_manager.calculateSequenceOffsets();
                }
                c.is_dirty = true;
            });
            c.addGlobalListener('window', "mouseup", (e) => {
                if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
                const guide = c._draggingUserGuide;
                const wasNew = guide._isNew;
                const origX = guide._origX;
                const origY = guide._origY;
                const dragStarted = !!guide._dragStarted;
                c._draggingUserGuide = null;
                c.current_state = 'IDLE';
                if (!dragStarted) {
                    if (!wasNew && origX != null) { guide.x = origX; guide.y = origY; }
                    c.is_dirty = true;
                    return;
                }
                const pa = c.painting_area?.getBoundingClientRect();
                if (pa) {
                    const toRuler = e.clientY <= pa.top + 18 || e.clientX <= pa.left + 18;
                    if (toRuler) {
                        if (!wasNew) {
                            c.user_guidelines = c.user_guidelines.filter(g => g.id !== guide.id);
                            CanvasDispatcher.requestHistoryCommit("deleteUserGuideline", { id: guide.id });
                        }
                        c.is_dirty = true;
                        return;
                    }
                }
                if (wasNew) {
                    c.user_guidelines.push(guide);
                    CanvasDispatcher.requestHistoryCommit("createUserGuideline", { id: guide.id });
                } else {
                    CanvasDispatcher.requestHistoryCommit("moveUserGuideline", { id: guide.id });
                }
                c.is_dirty = true;
            });
            c.addGlobalListener('window', "mouseup", (e) => {
                if (c.current_state !== 'DRAGGING_DIVIDER' || !c._draggingDivider) return;
                const div = c._draggingDivider;
                c._draggingDivider = null;
                c.current_state = 'IDLE';
                const group = c.curve_manager.treeItems.get(div.groupId);
                if (!div._dragStarted) {
                    if (group) {
                        group.advance = div.startAdvance;
                        group.is_modified = true;
                        c.curve_manager.calculateSequenceOffsets();
                    }
                    c.is_dirty = true;
                    return;
                }
                if (group) {
                    const currentAdv = group.advance;
                    group.advance = div.startAdvance;
                    CanvasDispatcher.requestSetGroupAdvance(div.groupId, currentAdv, { recordHistory: true });
                } else {
                    c.is_dirty = true;
                }
            });
            c.addGlobalListener(c.canvasObj, "mousemove", (e) => {
                if (c.current_state === 'DRAGGING_USER_GUIDE' || c.current_state === 'DRAGGING_DIVIDER') return;
                if (c.current_state === 'TRANSFORMING_OBJECTS' || c.current_state === 'PANNING' || c.current_state === 'DRAGGING_NODE') return;
                if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') {
                    if (c._hoveredUserGuideId !== null || c._hoveredDividerId !== null) {
                        c._hoveredUserGuideId = null;
                        c._hoveredDividerId = null;
                        c.is_dirty = true;
                    }
                    return;
                }
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                if (c.guideline_lock) {
                    if (c._hoveredUserGuideId !== null) {
                        c._hoveredUserGuideId = null;
                        c.is_dirty = true;
                    }
                } else {
                    const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
                    const newId = hit ? hit.guide.id : null;
                    if (c._hoveredUserGuideId !== newId) {
                        c._hoveredUserGuideId = newId;
                        c.canvasObj.dataset.cursor = hit ? (hit.guide.type === 'v' ? 'ew-resize' : 'ns-resize') : "default";
                        c.is_dirty = true;
                    }
                }
                const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
                const divId = divHit ? divHit.groupId + "-" + divHit.seqIndex + "-r" : null;
                if (c._hoveredDividerId !== divId) {
                    c._hoveredDividerId = divId;
                    c.is_dirty = true;
                }
                if (c.getActiveTool() === "MEASURE") {
                    const epHit = c._hitTestRulerEndpoint(pointer.x, pointer.y);
                    const prevEpRulerId = c._hoveredRulerEndpoint?.rulerId;
                    const prevEp = c._hoveredRulerEndpoint?.endpoint;
                    const newEpRulerId = epHit ? epHit.ruler.id : null;
                    const newEp = epHit ? epHit.endpoint : null;
                    if (newEpRulerId !== prevEpRulerId || newEp !== prevEp) {
                        c._hoveredRulerEndpoint = epHit ? { rulerId: epHit.ruler.id, endpoint: epHit.endpoint } : null;
                        c.is_dirty = true;
                    }
                    const rulerHit = !epHit ? c._hitTestRulerLine(pointer.x, pointer.y) : null;
                    const prevRulerId = c._hoveredRulerId;
                    c._hoveredRulerId = rulerHit ? rulerHit.id : null;
                    if (c._hoveredRulerId !== prevRulerId) c.is_dirty = true;
                } else if (c._hoveredRulerId !== null || c._hoveredRulerEndpoint !== null) {
                    c._hoveredRulerId = null;
                    c._hoveredRulerEndpoint = null;
                    c.is_dirty = true;
                }
            });
            c.addGlobalListener(c.canvasObj, "dblclick", (e) => {
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                if (c.getActiveTool() === "MEASURE") {
                    const rulerHit = c._hitTestRulerLine(pointer.x, pointer.y);
                    if (rulerHit) {
                        e.preventDefault();
                        e.stopPropagation();
                        c._showRulerEditDialog(rulerHit, e.clientX, e.clientY);
                        return;
                    }
                }
                const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
                if (hit) {
                    if (c.guideline_lock) return;
                    if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') return;
                    e.preventDefault();
                    e.stopPropagation();
                    c._showUserGuideEditDialog(hit.guide, e.clientX, e.clientY);
                    return;
                }
                const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
                if (divHit) {
                    if (c.guideline_lock) return;
                    if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') return;
                    const group = c.curve_manager.treeItems.get(divHit.groupId);
                    if (group && group.locked) return;
                    e.preventDefault();
                    e.stopPropagation();
                    c._showDividerEditDialog(divHit.groupId, e.clientX, e.clientY);
                }
            });
            c.addGlobalListener(c.canvasObj, "mousedown", (e) => {
                if (e.button !== 0) return;
                if (c.current_state === 'DRAGGING_USER_GUIDE' || c.current_state === 'DRAGGING_DIVIDER') return;
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
                // Node/curve hits take priority over guideline/divider drag
                const tool = c.getActiveTool();
                const hitMarker = c.utils.hitTestNode(pointer.x, pointer.y)?.marker ?? null;
                const hitCurveSegment = tool === 'SELECT' ? c.utils.hitTestCurve(pointer.x, pointer.y) : null;
                const hasInteractiveHit = (tool === 'NODE' && hitMarker) || (tool === 'SELECT' && hitCurveSegment);
                const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
                if (hit) {
                    if (c.guideline_lock) return;
                    if (tool === 'DRAW' || tool === 'ELLIPSE') return;
                    if (hasInteractiveHit) return;
                    e.preventDefault();
                    e.stopPropagation();
                    c.current_state = 'DRAGGING_USER_GUIDE';
                    const guide = hit.guide;
                    c._draggingUserGuide = guide;
                    guide._isNew = false;
                    guide._dragStarted = false;
                    guide._origX = guide.x;
                    guide._origY = guide.y;
                    guide._clientX = e.clientX;
                    guide._clientY = e.clientY;
                    return;
                }
                const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
                if (divHit) {
                    if (c.guideline_lock) return;
                    if (tool === 'DRAW' || tool === 'ELLIPSE') return;
                    if (hasInteractiveHit) return;
                    const group = c.curve_manager.treeItems.get(divHit.groupId);
                    if (group && group.locked) return;
                    e.preventDefault();
                    e.stopPropagation();
                    c.current_state = 'DRAGGING_DIVIDER';
                    c._draggingDivider = {
                        groupId: divHit.groupId,
                        dividerId: divHit.groupId + "-" + divHit.seqIndex + "-r",
                        startScreenX: divHit.screenX,
                        startAdvance: group ? group.advance : 1000,
                        _clientX: e.clientX,
                        _clientY: e.clientY,
                        _dragStarted: false
                    };
                    return;
                }
            });
            c.addGlobalListener(c.canvasObj, "contextmenu", (e) => {
                if (c.getActiveTool() === "MEASURE") {
                    const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                    const rulerHit = c._hitTestRulerLine(pointer.x, pointer.y);
                    if (rulerHit) {
                        e.preventDefault();
                        e.stopPropagation();
                        c.rulers = c.rulers.filter(r => r.id !== rulerHit.id);
                        c.is_dirty = true;
                    }
                }
            });
            c.addGlobalListener('window', "mouseup", c.handleMouseUp);
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
            return;
        }

        // First-time binding — register ALL listeners (direct + global)
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
            if (c.current_state === 'DRAGGING_DIVIDER') return;
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
                // Don't return — fall through to panning handler below
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
                c.canvasObj.dataset.cursor = 'move';
                c.drag_start = { x: e.clientX, y: e.clientY }; c.offset_start = { x: c.offset.x, y: c.offset.y };
                c.previewData = null; c.is_dirty = true; return;
            }
            if(e.button === 0) {
                if (c.current_state === 'DRAGGING_USER_GUIDE' || c.current_state === 'DRAGGING_DIVIDER') return;
                if (c.canvasObj.setPointerCapture && Number.isFinite(e.pointerId)) {
                    try {
                        c.canvasObj.setPointerCapture(e.pointerId);
                        c._pointerCaptureId = e.pointerId;
                    } catch (_) { /* ignore */ }
                }
                const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
                const worldX = (mouseX - offsetX) / c.scale, worldY = (mouseY - offsetY) / c.scale;
                // Node/curve/handle hits take priority over guideline/divider drag
                const hasInteractiveHit = (tool === 'NODE' && hitMarker) || (tool === 'SELECT' && (handleHit || hitCurveSegment));
                const guideHit = c.utils.hitTestUserGuides(mouseX, mouseY);
                if (guideHit && !c.guideline_lock && tool !== 'DRAW' && tool !== 'ELLIPSE' && !hasInteractiveHit) { e.preventDefault(); return; }
                const divHit = c.utils.hitTestDividerLines(mouseX, mouseY);
                if (divHit && !c.guideline_lock && tool !== 'DRAW' && tool !== 'ELLIPSE' && !hasInteractiveHit) { e.preventDefault(); return; }
                if (tool === 'MEASURE') ic.handleMeasureMouseDown(worldX, worldY);
                else if (tool === 'SELECT') {
                    if (handleHit) e.stopImmediatePropagation();
                    ic.handleSelectMouseDown(mouseX, mouseY, handleHit, hitCurveSegment, e.shiftKey, e.clientX, e.clientY);
                }
                else if (hitMarker && (tool === 'NODE' || tool === 'DRAW')) ic.handleNodeHitMouseDown(mouseX, mouseY, hitResult, hitMarker, e.shiftKey, e.ctrlKey);
                else if (tool === 'NODE') ic.handleNodeMissMouseDown(mouseX, mouseY, e.shiftKey);
                else if (tool === 'DRAW') ic.handleDrawMouseDown(mouseX, mouseY, worldX, worldY);
                else if (tool === 'ELLIPSE') ic.handleEllipseMouseDown(mouseX, mouseY, worldX, worldY, e.ctrlKey);
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
                } else if (tool === "NODE" && hitMarker) {
                    let hitNode = c.curve_manager.find_node_by_curve(hitMarker);
                    if (hitNode && hitNode.type === null) {
                        c._pendingDeleteControlMarker = hitMarker;
                        c._pendingDeleteMouseX = mouseX;
                        c._pendingDeleteMouseY = mouseY;
                    }
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
                c._rulerIndicatorH.classList.toggle('is-visible', inCanvas);
                c._rulerIndicatorH.style.left = `${px - 5}px`;
                c._rulerIndicatorV.classList.toggle('is-visible', inCanvas);
                c._rulerIndicatorV.style.top = `${py - 5}px`;
            }
            if (tool === 'MEASURE') ic.handleMeasureMouseMove(mouseX, mouseY);
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
            else if((e.buttons & 1) !== 0 && c.current_state === 'DRAGGING_ELLIPSE') {
                const ewX = (mouseX - offsetX) / c.scale, ewY = (mouseY - offsetY) / c.scale;
                ic.handleEllipseMouseMove(mouseX, mouseY, ewX, ewY, e.ctrlKey);
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
                if (handleHit === 'tl' || handleHit === 'br') c.canvasObj.dataset.cursor = 'nwse-resize';
                else if (handleHit === 'tr' || handleHit === 'bl') c.canvasObj.dataset.cursor = 'nesw-resize';
                else if (handleHit === 'tc' || handleHit === 'bc') c.canvasObj.dataset.cursor = 'ns-resize';
                else if (handleHit === 'ml' || handleHit === 'mr') c.canvasObj.dataset.cursor = 'ew-resize';
                else if (handleHit === 'rot_tl' || handleHit === 'rot_br') c.canvasObj.dataset.cursor = 'crosshair';
                else if (handleHit === 'rot_tr' || handleHit === 'rot_bl') c.canvasObj.dataset.cursor = 'crosshair';
                else if (handleHit === 'shear_tc' || handleHit === 'shear_bc') c.canvasObj.dataset.cursor = 'ew-resize';
                else if (handleHit === 'shear_ml' || handleHit === 'shear_mr') c.canvasObj.dataset.cursor = 'ns-resize';
                else if (handleHit === 'pivot') c.canvasObj.dataset.cursor = 'move';
                else if (c._hoveredUserGuideId !== null) {
                    // Guide hover overrides curve/object hit but not handles
                } else {
                    let hitCurveSegment = c.utils.hitTestCurve(mouseX, mouseY);
                    const ix = c.getInteractionSnapshot();
                    const refItem = hitCurveSegment?.refId ? c.curve_manager.treeItems.get(hitCurveSegment.refId) : null;
                    c.canvasObj.dataset.cursor = (hitCurveSegment && (snapshotIncludesCurve(ix, hitCurveSegment.curve) || snapshotIncludesRef(ix, refItem))) ? 'move' : 'default';
                }
            } else if (c._hoveredUserGuideId !== null) {
                // Guide hover for non-SELECT tools
            } else if (c.current_state !== 'TRANSFORMING_OBJECTS' && c.current_state !== 'PANNING' && c.current_state !== 'DRAGGING_NODE' && c.current_state !== 'DRAGGING_USER_GUIDE' && c.current_state !== 'DRAGGING_DIVIDER') {
                    if (c.getActiveTool() !== 'DRAW' && c.getActiveTool() !== 'ELLIPSE') {
                        const divHit = c.utils.hitTestDividerLines(mouseX, mouseY);
                        c.canvasObj.dataset.cursor = divHit ? "ew-resize" : "default";
                    } else {
                        c.canvasObj.dataset.cursor = "crosshair";
                    }
            }
            if (c.current_state === 'IDLE') {
                c.renderer.update_previewData(mouseX, mouseY); if (c.last_on_curve_node_marker !== null) c.is_dirty = true;
            } else { if (c.previewData !== null) { c.previewData = null; c.is_dirty = true; } }
        });
        c.addGlobalListener(c.canvasObj, "mouseleave", () => {
            if (c._rulerIndicatorH) c._rulerIndicatorH.classList.remove('is-visible');
            if (c._rulerIndicatorV) c._rulerIndicatorV.classList.remove('is-visible');
            if (!c._draggingUserGuide) {
                c._hoveredUserGuideId = null;
                c.is_dirty = true;
            }
            if (!c._draggingDivider) {
                c._hoveredDividerId = null;
                c.is_dirty = true;
            }
            if (c._hoveredRulerId !== null || c._hoveredRulerEndpoint !== null) {
                c._hoveredRulerId = null;
                c._hoveredRulerEndpoint = null;
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
                angle: type === "v" ? 90 : 0,
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
                startUserGuideDrag("h", e.clientX, e.clientY);
            });
        }
        if (c.ruler_vertical) {
            c.ruler_vertical.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (c.guideline_lock) return;
                e.preventDefault();
                e.stopPropagation();
                startUserGuideDrag("v", e.clientX, e.clientY);
            });
        }
        c.addGlobalListener('window', "mousemove", (e) => {
            if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
            const guide = c._draggingUserGuide;
            if (!guide._dragStarted) {
                if (Math.abs(e.clientX - guide._clientX) <= 4 && Math.abs(e.clientY - guide._clientY) <= 4) return;
                guide._dragStarted = true;
            }
            c.canvasObj.dataset.cursor = guide.type === 'v' ? 'ew-resize' : 'ns-resize';
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            guide.x = (pointer.x - offsetX) / c.scale;
            guide.y = (pointer.y - offsetY) / c.scale;
            c.is_dirty = true;
        });
        c.addGlobalListener('window', "mousemove", (e) => {
            if (c.current_state !== 'DRAGGING_DIVIDER' || !c._draggingDivider) return;
            const div = c._draggingDivider;
            if (!div._dragStarted) {
                if (Math.abs(e.clientX - div._clientX) <= 4 && Math.abs(e.clientY - div._clientY) <= 4) return;
                div._dragStarted = true;
            }
            c.canvasObj.dataset.cursor = 'ew-resize';
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            const dx = pointer.x - div.startScreenX;
            const newAdvance = Math.max(0, div.startAdvance + dx / c.scale);
            const group = c.curve_manager.treeItems.get(div.groupId);
            if (group) {
                group.advance = newAdvance;
                group.is_modified = true;
                c.curve_manager.calculateSequenceOffsets();
            }
            c.is_dirty = true;
        });
        c.addGlobalListener('window', "mouseup", (e) => {
            if (c.current_state !== 'DRAGGING_USER_GUIDE' || !c._draggingUserGuide) return;
            const guide = c._draggingUserGuide;
            const wasNew = guide._isNew;
            const origX = guide._origX;
            const origY = guide._origY;
            const dragStarted = !!guide._dragStarted;
            c._draggingUserGuide = null;
            c.current_state = 'IDLE';
            if (!dragStarted) {
                if (!wasNew && origX != null) { guide.x = origX; guide.y = origY; }
                c.is_dirty = true;
                return;
            }
            const pa = c.painting_area?.getBoundingClientRect();
            if (pa) {
                const toRuler = e.clientY <= pa.top + 18 || e.clientX <= pa.left + 18;
                if (toRuler) {
                    if (!wasNew) {
                        c.user_guidelines = c.user_guidelines.filter(g => g.id !== guide.id);
                        CanvasDispatcher.requestHistoryCommit("deleteUserGuideline", { id: guide.id });
                    }
                    c.is_dirty = true;
                    return;
                }
            }
            if (wasNew) {
                c.user_guidelines.push(guide);
                CanvasDispatcher.requestHistoryCommit("createUserGuideline", { id: guide.id });
            } else {
                CanvasDispatcher.requestHistoryCommit("moveUserGuideline", { id: guide.id });
            }
            c.is_dirty = true;
        });
        c.addGlobalListener('window', "mouseup", (e) => {
            if (c.current_state !== 'DRAGGING_DIVIDER' || !c._draggingDivider) return;
            const div = c._draggingDivider;
            c._draggingDivider = null;
            c.current_state = 'IDLE';
            const group = c.curve_manager.treeItems.get(div.groupId);
            if (!div._dragStarted) {
                if (group) {
                    group.advance = div.startAdvance;
                    group.is_modified = true;
                    c.curve_manager.calculateSequenceOffsets();
                }
                c.is_dirty = true;
                return;
            }
            if (group) {
                const currentAdv = group.advance;
                group.advance = div.startAdvance;
                CanvasDispatcher.requestSetGroupAdvance(div.groupId, currentAdv, { recordHistory: true });
            } else {
                c.is_dirty = true;
            }
        });
        c.addGlobalListener(c.canvasObj, "mousemove", (e) => {
            if (c.current_state === 'DRAGGING_USER_GUIDE' || c.current_state === 'DRAGGING_DIVIDER') return;
            if (c.current_state === 'TRANSFORMING_OBJECTS' || c.current_state === 'PANNING' || c.current_state === 'DRAGGING_NODE') return;
            // During pen / ellipse drawing, suppress all guide and divider interactions
            if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') {
                if (c._hoveredUserGuideId !== null || c._hoveredDividerId !== null) {
                    c._hoveredUserGuideId = null;
                    c._hoveredDividerId = null;
                    c.is_dirty = true;
                }
                return;
            }
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
            if (c.guideline_lock) {
                if (c._hoveredUserGuideId !== null) {
                    c._hoveredUserGuideId = null;
                    c.is_dirty = true;
                }
            } else {
                const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
                const newId = hit ? hit.guide.id : null;
                if (c._hoveredUserGuideId !== newId) {
                    c._hoveredUserGuideId = newId;
                    c.canvasObj.dataset.cursor = hit ? (hit.guide.type === 'v' ? 'ew-resize' : 'ns-resize') : "default";
                    c.is_dirty = true;
                }
            }
            const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
            const divId = divHit ? divHit.groupId + "-" + divHit.seqIndex + "-r" : null;
            if (c._hoveredDividerId !== divId) {
                c._hoveredDividerId = divId;
                c.is_dirty = true;
            }
            // Ruler hover (only in MEASURE mode)
            if (c.getActiveTool() === "MEASURE") {
                // Check endpoint first; when an endpoint is hovered, skip line hover
                const epHit = c._hitTestRulerEndpoint(pointer.x, pointer.y);
                const prevEpRulerId = c._hoveredRulerEndpoint?.rulerId;
                const prevEp = c._hoveredRulerEndpoint?.endpoint;
                const newEpRulerId = epHit ? epHit.ruler.id : null;
                const newEp = epHit ? epHit.endpoint : null;
                if (newEpRulerId !== prevEpRulerId || newEp !== prevEp) {
                    c._hoveredRulerEndpoint = epHit ? { rulerId: epHit.ruler.id, endpoint: epHit.endpoint } : null;
                    c.is_dirty = true;
                }
                // Only line-hover when NOT hovering an endpoint
                const rulerHit = !epHit ? c._hitTestRulerLine(pointer.x, pointer.y) : null;
                const prevRulerId = c._hoveredRulerId;
                c._hoveredRulerId = rulerHit ? rulerHit.id : null;
                if (c._hoveredRulerId !== prevRulerId) c.is_dirty = true;
            } else if (c._hoveredRulerId !== null || c._hoveredRulerEndpoint !== null) {
                c._hoveredRulerId = null;
                c._hoveredRulerEndpoint = null;
                c.is_dirty = true;
            }
        });
        c.addGlobalListener(c.canvasObj, "dblclick", (e) => {
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
            if (c.getActiveTool() === "MEASURE") {
                const rulerHit = c._hitTestRulerLine(pointer.x, pointer.y);
                if (rulerHit) {
                    e.preventDefault();
                    e.stopPropagation();
                    c._showRulerEditDialog(rulerHit, e.clientX, e.clientY);
                    return;
                }
            }
            const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
            if (hit) {
                if (c.guideline_lock) return;
                if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') return;
                e.preventDefault();
                e.stopPropagation();
                c._showUserGuideEditDialog(hit.guide, e.clientX, e.clientY);
                return;
            }
            const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
            if (divHit) {
                if (c.guideline_lock) return;
                if (c.getActiveTool() === 'DRAW' || c.getActiveTool() === 'ELLIPSE') return;
                const group = c.curve_manager.treeItems.get(divHit.groupId);
                if (group && group.locked) return;
                e.preventDefault();
                e.stopPropagation();
                c._showDividerEditDialog(divHit.groupId, e.clientX, e.clientY);
            }
        });
        c.addGlobalListener(c.canvasObj, "mousedown", (e) => {
            if (e.button !== 0) return;
            if (c.current_state === 'DRAGGING_USER_GUIDE' || c.current_state === 'DRAGGING_DIVIDER') return;
            c.refreshViewportConfig();
            const pointer = c.getViewportMousePosition(e.clientX, e.clientY);
            // Node/curve hits take priority over guideline/divider drag
            const tool = c.getActiveTool();
            const hitMarker = c.utils.hitTestNode(pointer.x, pointer.y)?.marker ?? null;
            const hitCurveSegment = tool === 'SELECT' ? c.utils.hitTestCurve(pointer.x, pointer.y) : null;
            const handleHit = tool === 'SELECT' ? c.utils.hitTestTransformHandles(pointer.x, pointer.y) : null;
            const hasInteractiveHit = (tool === 'NODE' && hitMarker) || (tool === 'SELECT' && (handleHit || hitCurveSegment));
            const hit = c.utils.hitTestUserGuides(pointer.x, pointer.y);
            if (hit) {
                if (c.guideline_lock) return;
                if (tool === 'DRAW' || tool === 'ELLIPSE') return;
                if (hasInteractiveHit) return;
                e.preventDefault();
                e.stopPropagation();
                c.current_state = 'DRAGGING_USER_GUIDE';
                const guide = hit.guide;
                c._draggingUserGuide = guide;
                guide._isNew = false;
                guide._dragStarted = false;
                guide._origX = guide.x;
                guide._origY = guide.y;
                guide._clientX = e.clientX;
                guide._clientY = e.clientY;
                return;
            }
            const divHit = c.utils.hitTestDividerLines(pointer.x, pointer.y);
            if (divHit) {
                if (c.guideline_lock) return;
                if (tool === 'DRAW' || tool === 'ELLIPSE') return;
                if (hasInteractiveHit) return;
                const group = c.curve_manager.treeItems.get(divHit.groupId);
                if (group && group.locked) return;
                e.preventDefault();
                e.stopPropagation();
                c.current_state = 'DRAGGING_DIVIDER';
                c._draggingDivider = {
                    groupId: divHit.groupId,
                    dividerId: divHit.groupId + "-" + divHit.seqIndex + "-r",
                    startScreenX: divHit.screenX,
                    startAdvance: group ? group.advance : 1000,
                    _clientX: e.clientX,
                    _clientY: e.clientY,
                    _dragStarted: false
                };
                return;
            }
        });
        c.addGlobalListener(c.canvasObj, "contextmenu", (e) => {
            if (c.getActiveTool() === "MEASURE") {
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                const rulerHit = c._hitTestRulerLine(pointer.x, pointer.y);
                if (rulerHit) {
                    e.preventDefault();
                    e.stopPropagation();
                    c.rulers = c.rulers.filter(r => r.id !== rulerHit.id);
                    c.is_dirty = true;
                }
            }
        });
        const readDialogNumber = (input, { min = -Infinity } = {}) => {
            if (!input || input.value === '') return null;
            const value = Number(input.value);
            return Number.isFinite(value) && value >= min ? value : null;
        };
        const installDialogInputValidation = (inputs, overlay, rules = {}) => {
            inputs.forEach((input) => {
                input.dataset.prevValue = input.value;
                input.addEventListener("focusin", () => {
                    input.dataset.prevValue = input.value;
                });
                input.addEventListener("focusout", () => {
                    const rule = rules[input.dataset.field] || {};
                    if (readDialogNumber(input, rule) === null) {
                        input.value = input.dataset.prevValue ?? "";
                    }
                });
                input.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter") {
                        ev.preventDefault();
                        input.blur();
                    }
                    if (ev.key === "Escape") overlay.remove();
                });
            });
        };
        c._showUserGuideEditDialog = (guide, clientX, clientY) => {
            const old = document.querySelector(".user-guide-edit-overlay");
            if (old) old.remove();
            const overlay = document.createElement("div");
            overlay.className = "user-guide-edit-overlay";
            const dlg = document.createElement("div");
            dlg.className = "user-guide-edit-dialog";
            dlg.style.left = `${clientX}px`;
            dlg.style.top = `${clientY}px`;
            const H = c.canvas_size_height;
            const viewY = H - guide.y;
            dlg.innerHTML = `<div class="field-row"><label>X</label><input type="number" step="1" value="${guide.x.toFixed(1)}" data-field="x"></div>
                <div class="field-row"><label>Y</label><input type="number" step="1" value="${viewY.toFixed(1)}" data-field="y"></div>
                <div class="field-row"><label>Angle</label><input type="number" step="1" value="${(guide.angle || 0).toFixed(1)}" data-field="angle"></div>
                <div class="btn-row"><button class="btn-cancel">Cancel</button><button class="btn-ok">OK</button></div>`;
            overlay.appendChild(dlg);
            document.body.appendChild(overlay);
            const rect = dlg.getBoundingClientRect();
            if (rect.right > window.innerWidth) dlg.style.left = `${clientX - rect.width}px`;
            if (rect.bottom > window.innerHeight) dlg.style.top = `${clientY - rect.height}px`;
            const inputs = dlg.querySelectorAll("input");
            inputs[0].focus(); inputs[0].select();
            installDialogInputValidation([...inputs], overlay);
            const apply = () => {
                const x = readDialogNumber(dlg.querySelector('[data-field="x"]'));
                const rawY = readDialogNumber(dlg.querySelector('[data-field="y"]'));
                const angle = readDialogNumber(dlg.querySelector('[data-field="angle"]'));
                if (x === null || rawY === null || angle === null) return;
                guide.x = x;
                guide.y = H - rawY;
                guide.angle = angle;
                overlay.remove();
                c.is_dirty = true;
                CanvasDispatcher.requestHistoryCommit("editUserGuideline", { id: guide.id });
            };
            dlg.querySelector(".btn-ok").addEventListener("click", apply);
            dlg.querySelector(".btn-cancel").addEventListener("click", () => overlay.remove());
            overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) overlay.remove(); });
        };
        c._showDividerEditDialog = (groupId, clientX, clientY) => {
            const group = c.curve_manager.treeItems.get(groupId);
            const currentAdv = group && group.advance !== undefined ? group.advance : 1000;
            const old = document.querySelector(".user-guide-edit-overlay");
            if (old) old.remove();
            const overlay = document.createElement("div");
            overlay.className = "user-guide-edit-overlay";
            const dlg = document.createElement("div");
            dlg.className = "user-guide-edit-dialog";
            dlg.style.left = `${clientX}px`;
            dlg.style.top = `${clientY}px`;
            dlg.innerHTML = `<div class="field-row"><label>X</label><input type="number" step="1" value="${currentAdv.toFixed(1)}" data-field="x"></div>
                <div class="btn-row"><button class="btn-cancel">Cancel</button><button class="btn-ok">OK</button></div>`;
            overlay.appendChild(dlg);
            document.body.appendChild(overlay);
            const rect = dlg.getBoundingClientRect();
            if (rect.right > window.innerWidth) dlg.style.left = `${clientX - rect.width}px`;
            if (rect.bottom > window.innerHeight) dlg.style.top = `${clientY - rect.height}px`;
            const input = dlg.querySelector("input");
            input.focus(); input.select();
            installDialogInputValidation([input], overlay, { x: { min: 0 } });
            const apply = () => {
                const val = readDialogNumber(dlg.querySelector('[data-field="x"]'), { min: 0 });
                if (val === null) return;
                CanvasDispatcher.requestSetGroupAdvance(groupId, val, { recordHistory: true });
                overlay.remove();
            };
            dlg.querySelector(".btn-ok").addEventListener("click", apply);
            dlg.querySelector(".btn-cancel").addEventListener("click", () => overlay.remove());
            overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) overlay.remove(); });
        };
        c._showRulerEditDialog = (ruler, clientX, clientY) => {
            const old = document.querySelector(".user-guide-edit-overlay");
            if (old) old.remove();
            const overlay = document.createElement("div");
            overlay.className = "user-guide-edit-overlay";
            const dlg = document.createElement("div");
            dlg.className = "user-guide-edit-dialog ruler-edit-dialog";
            dlg.style.left = `${clientX}px`;
            dlg.style.top = `${clientY}px`;
            const dx = ruler.x2 - ruler.x1, dy = ruler.y2 - ruler.y1;
            const len = Math.hypot(dx, dy);
            const angleDeg = Math.atan2(-dy, dx) * 180 / Math.PI;
            dlg.innerHTML = `<div class="field-row"><label>X1</label><input type="number" step="0.1" value="${ruler.x1.toFixed(1)}" data-field="x1"></div>
                <div class="field-row"><label>Y1</label><input type="number" step="0.1" value="${ruler.y1.toFixed(1)}" data-field="y1"></div>
                <div class="field-row"><label>X2</label><input type="number" step="0.1" value="${ruler.x2.toFixed(1)}" data-field="x2"></div>
                <div class="field-row"><label>Y2</label><input type="number" step="0.1" value="${ruler.y2.toFixed(1)}" data-field="y2"></div>
                <div class="field-row"><label>L</label><input type="number" step="0.1" value="${len.toFixed(1)}" data-field="length"></div>
                <div class="field-row"><label>Angle</label><input type="number" step="0.1" value="${angleDeg.toFixed(1)}" data-field="angle"></div>
                <div class="btn-row"><button class="btn-delete">Delete</button><button class="btn-ok">OK</button></div>`;
            overlay.appendChild(dlg);
            document.body.appendChild(overlay);
            const rect = dlg.getBoundingClientRect();
            if (rect.right > window.innerWidth) dlg.style.left = `${clientX - rect.width}px`;
            if (rect.bottom > window.innerHeight) dlg.style.top = `${clientY - rect.height}px`;
            const inputs = {
                x1: dlg.querySelector('[data-field="x1"]'),
                y1: dlg.querySelector('[data-field="y1"]'),
                x2: dlg.querySelector('[data-field="x2"]'),
                y2: dlg.querySelector('[data-field="y2"]'),
                length: dlg.querySelector('[data-field="length"]'),
                angle: dlg.querySelector('[data-field="angle"]')
            };
            inputs.x1.focus(); inputs.x1.select();
            installDialogInputValidation(Object.values(inputs), overlay, { length: { min: 0 } });
            const updateFromEndpoints = () => {
                const x1 = readDialogNumber(inputs.x1);
                const y1 = readDialogNumber(inputs.y1);
                const x2 = readDialogNumber(inputs.x2);
                const y2 = readDialogNumber(inputs.y2);
                if (x1 === null || y1 === null || x2 === null || y2 === null) return;
                const ddx = x2 - x1, ddy = y2 - y1;
                inputs.length.value = Math.hypot(ddx, ddy).toFixed(1);
                const ang = Math.atan2(-ddy, ddx) * 180 / Math.PI;
                inputs.angle.value = ang.toFixed(1);
            };
            const updateFromPolar = () => {
                const x1 = readDialogNumber(inputs.x1);
                const y1 = readDialogNumber(inputs.y1);
                const l = readDialogNumber(inputs.length, { min: 0 });
                const a = readDialogNumber(inputs.angle);
                if (x1 === null || y1 === null || l === null || a === null) return;
                const aRad = a * Math.PI / 180;
                inputs.x2.value = (x1 + l * Math.cos(aRad)).toFixed(1);
                inputs.y2.value = (y1 - l * Math.sin(aRad)).toFixed(1);
            };
            inputs.x1.addEventListener("input", updateFromEndpoints);
            inputs.y1.addEventListener("input", updateFromEndpoints);
            inputs.x2.addEventListener("input", updateFromEndpoints);
            inputs.y2.addEventListener("input", updateFromEndpoints);
            inputs.length.addEventListener("input", updateFromPolar);
            inputs.angle.addEventListener("input", updateFromPolar);
            const apply = () => {
                const x1 = readDialogNumber(inputs.x1);
                const y1 = readDialogNumber(inputs.y1);
                const x2 = readDialogNumber(inputs.x2);
                const y2 = readDialogNumber(inputs.y2);
                if (x1 === null || y1 === null || x2 === null || y2 === null) return;
                ruler.x1 = x1;
                ruler.y1 = y1;
                ruler.x2 = x2;
                ruler.y2 = y2;
                overlay.remove();
                c.is_dirty = true;
            };
            const deleteRuler = () => {
                c.rulers = c.rulers.filter(r => r.id !== ruler.id);
                overlay.remove();
                c.is_dirty = true;
            };
            dlg.querySelector(".btn-ok").addEventListener("click", apply);
            dlg.querySelector(".btn-delete").addEventListener("click", deleteRuler);
            overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) overlay.remove(); });
        };
        c._hitTestRulerLine = (canvasX, canvasY) => {
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            for (const ruler of (c.rulers || [])) {
                const sx = ruler.x1 * c.scale + offsetX, sy = ruler.y1 * c.scale + offsetY;
                const ex = ruler.x2 * c.scale + offsetX, ey = ruler.y2 * c.scale + offsetY;
                const dist = c._pointToSegmentDist(canvasX, canvasY, sx, sy, ex, ey);
                if (dist < 6) return ruler;
            }
            return null;
        };
        c._hitTestRulerEndpoint = (canvasX, canvasY) => {
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            for (const ruler of (c.rulers || [])) {
                const sx = ruler.x1 * c.scale + offsetX, sy = ruler.y1 * c.scale + offsetY;
                const ex = ruler.x2 * c.scale + offsetX, ey = ruler.y2 * c.scale + offsetY;
                if (Math.hypot(canvasX - sx, canvasY - sy) < 6) return { ruler, endpoint: 'start' };
                if (Math.hypot(canvasX - ex, canvasY - ey) < 6) return { ruler, endpoint: 'end' };
            }
            return null;
        };
        c._pointToSegmentDist = (px, py, ax, ay, bx, by) => {
            const abx = bx - ax, aby = by - ay;
            const apx = px - ax, apy = py - ay;
            const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby || 1)));
            const cx = ax + t * abx, cy = ay + t * aby;
            return Math.hypot(px - cx, py - cy);
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
            if (c.current_state === 'DRAGGING_DIVIDER') {
                const div = c._draggingDivider;
                c._draggingDivider = null;
                c.current_state = 'IDLE';
                if (div) {
                    const group = c.curve_manager.treeItems.get(div.groupId);
                    if (div._dragStarted) {
                        if (group) {
                            const currentAdv = group.advance;
                            group.advance = div.startAdvance;
                            CanvasDispatcher.requestSetGroupAdvance(div.groupId, currentAdv, { recordHistory: true });
                        }
                    } else if (group) {
                        group.advance = div.startAdvance;
                        group.is_modified = true;
                        c.curve_manager.calculateSequenceOffsets();
                    }
                }
                c.is_dirty = true;
                return;
            }
            if (c.current_state === 'DRAGGING_RULER_ENDPOINT') {
                c._draggingRulerEndpoint = null;
                c.current_state = 'IDLE';
                c.is_dirty = true;
                return;
            }
            if (e.button === 0) {
                if (c.current_state === 'TRANSFORMING_OBJECTS') { ic.handleTransformMouseUp(); return; }
                if (tool === 'MEASURE') { ic.handleMeasureMouseUp(); return; }
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
                if (c.current_state === 'DRAGGING_ELLIPSE') { ic.handleEllipseMouseUp(); c.is_dirty = true; return; }
                c.current_state = 'IDLE'; c.dragging_node_marker = null; c.dragging_node_seq_idx = -1;
                c.dragging_node_matrix = null; c.dragging_node_refId = null;
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                c.renderer.update_previewData(pointer.x, pointer.y);
                c.notifyPropertiesUpdate(); c.is_dirty = true;
            }
            if (e.button === 2 && c._pendingDeleteControlMarker) {
                c.refreshViewportConfig();
                const pointer = c.getViewportMousePosition(e.clientX, e.clientY, e);
                const dist = Math.hypot(pointer.x - c._pendingDeleteMouseX, pointer.y - c._pendingDeleteMouseY);
                if (dist < 10) {
                    let node = c.curve_manager.find_node_by_curve(c._pendingDeleteControlMarker);
                    if (node && node.type === null) {
                        c.commands.deleteControlNode(c._pendingDeleteControlMarker);
                    }
                }
                c._pendingDeleteControlMarker = null;
                c._pendingDeleteMouseX = null;
                c._pendingDeleteMouseY = null;
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
        // Flag must be set so reconnect path re-registers only global listeners
        c._inputControllerCanvasBound = true;
    }
}
