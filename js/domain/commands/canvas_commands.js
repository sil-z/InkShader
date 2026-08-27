import { generateMarker } from "../../core/bezier/utils.js";
import { CurveNode } from "../../core/bezier/node.js";
import { EDITOR_ACTIONS } from "../actions/editor_actions.js";
import {
    commandCanvas,
    commitCommandHistoryFromHost,
    commitCommandHistoryUnlessDispatching,
    commitInteractionFromCommand,
    finishInteractionCommand,
    isStoreInteractionDispatch,
    refreshStoreSequence,
    selectedTreeIdsFromStore,
    syncActiveGroupToStore
} from "./command_runtime.js";
import { resolveMarkersFromCanvas } from "../selection/marker_resolution.js";

/**
 * Solve quadratic equation at^2 + bt + c = 0, adding valid (0,1) roots to result set.
 */
function _solveQuadratic(a, b, c, result) {
    const EPS = 1e-8;
    if (Math.abs(a) < EPS) {
        // Linear: bt + c = 0
        if (Math.abs(b) > EPS) {
            const t = -c / b;
            if (t > EPS && t < 1 - EPS) result.add(t);
        }
        return;
    }
    const disc = b * b - 4 * a * c;
    if (disc < -EPS) return;
    const sqrtDisc = Math.sqrt(Math.max(0, disc));
    const t1 = (-b + sqrtDisc) / (2 * a);
    const t2 = (-b - sqrtDisc) / (2 * a);
    if (t1 > EPS && t1 < 1 - EPS) result.add(t1);
    if (t2 > EPS && t2 < 1 - EPS) result.add(t2);
}

/**
 * Check if a node is redundant: nearly collinear with its neighbors and
 * close to the line between them (within tolerance).
 */
function _isRedundant(prev, curr, next, tolerance) {
    // Distance from curr to line(prev→next)
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return false; // degenerate segment
    const dist = Math.abs((curr.x - prev.x) * dy - (curr.y - prev.y) * dx) / Math.sqrt(lenSq);
    return dist < tolerance;
}

function snapshotString(snapshot, key, fallback, defaultValue = "") {
    return Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : fallback ?? defaultValue;
}

function snapshotNumber(snapshot, key, fallback, defaultValue) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) return fallback ?? defaultValue;
    const value = Number(snapshot[key]);
    return Number.isFinite(value) ? value : fallback ?? defaultValue;
}

/**
 * Restore editor ephemeral state (guidelines, guideline_lock) from snapshot.
 * These are top-level fields in the file format but not part of curve data.
 */
function restoreEditorStateFromSnapshot(canvas, snapshotObj) {
    if (Array.isArray(snapshotObj.editor_guidelines)) {
        canvas.guidelines = snapshotObj.editor_guidelines.map(g => ({
            id: canvas._nextUserGuideId++,
            x: g.x, y: g.y, angle: g.angle,
            type: g.type
        }));
    }
    if (snapshotObj.editor_guideline_lock !== undefined) {
        canvas.guideline_lock = !!snapshotObj.editor_guideline_lock;
    }
    // Canvas size (em box, design units) is written to the file (S014a) and
    // drives UFO/SVG export constants - restore it. Legacy files predate the
    // field: keep the current size.
    const canvasSizeW = Number(snapshotObj.canvas_size_width);
    if (Number.isFinite(canvasSizeW) && canvasSizeW > 0) canvas.canvas_size_width = canvasSizeW;
    const canvasSizeH = Number(snapshotObj.canvas_size_height);
    if (Number.isFinite(canvasSizeH) && canvasSizeH > 0) canvas.canvas_size_height = canvasSizeH;
    // expand_stroke_round_cap is now per-curve (expanded_round_cap in path data).
    // The global file-level field is no longer read.
}

function fontSettingsFromSnapshot(snapshot = {}, fallback = {}) {
    return {
        family: snapshotString(snapshot, "family_name", fallback.family, "InkShader Default Font"),
        style: snapshotString(snapshot, "font_style", fallback.style, "Regular"),
        postscript_name: snapshotString(snapshot, "postscript_name", fallback.postscript_name),
        preferred_family: snapshotString(snapshot, "preferred_family", fallback.preferred_family),
        preferred_subfamily: snapshotString(snapshot, "preferred_subfamily", fallback.preferred_subfamily),
        style_map_family: snapshotString(snapshot, "style_map_family", fallback.style_map_family),
        copyright: snapshotString(snapshot, "copyright", fallback.copyright),
        designer: snapshotString(snapshot, "designer", fallback.designer),
        designer_url: snapshotString(snapshot, "designer_url", fallback.designer_url),
        manufacturer: snapshotString(snapshot, "manufacturer", fallback.manufacturer),
        manufacturer_url: snapshotString(snapshot, "manufacturer_url", fallback.manufacturer_url),
        license: snapshotString(snapshot, "license", fallback.license),
        license_url: snapshotString(snapshot, "license_url", fallback.license_url),
        trademark: snapshotString(snapshot, "trademark", fallback.trademark),
        description: snapshotString(snapshot, "description", fallback.description),
        sample_text: snapshotString(snapshot, "sample_text", fallback.sample_text),
        upm: snapshotNumber(snapshot, "upm", fallback.upm, 1000),
        weight_class: snapshotNumber(snapshot, "weight_class", fallback.weight_class, 400),
        width_class: snapshotNumber(snapshot, "width_class", fallback.width_class, 5),
        ascender: snapshotNumber(snapshot, "ascender", fallback.ascender, 800),
        descender: snapshotNumber(snapshot, "descender", fallback.descender, -200),
        x_height: snapshotNumber(snapshot, "x_height", fallback.x_height, 500),
        cap_height: snapshotNumber(snapshot, "cap_height", fallback.cap_height, 700),
        italic_angle: snapshotNumber(snapshot, "italic_angle", fallback.italic_angle, 0),
        version: snapshotString(snapshot, "font_version", fallback.version, "1.0"),
        project_name: snapshotString(snapshot, "project_name", fallback.project_name),
        basic_spacing: snapshotNumber(snapshot, "basic_spacing", fallback.basic_spacing, 1000)
    };
}

export class CanvasCommands {
    /** Canvas direct-command history write without dispatch (others go through EditorStore auto commit) */
    _commitHistory(commandName, payload = {}) {
        return commitCommandHistoryFromHost(this, commandName, payload);
    }

    /** Canvas Delete etc.: dispatch path writes stack via finalize, direct commands must self-commit */
    _commitHistoryUnlessDispatching(commandName, payload = {}) {
        return commitCommandHistoryUnlessDispatching(this, commandName, payload);
    }

    async loadSnapshotCommand(jsonStr) {
        if (jsonStr === null || jsonStr === undefined) return false;
        if (typeof jsonStr === "object") {
            await this.curve_manager.loadFromSnapshotObject(jsonStr);
            const canvas = commandCanvas(this);
            canvas.fontSettings = fontSettingsFromSnapshot(jsonStr, canvas.fontSettings);
            restoreEditorStateFromSnapshot(canvas, jsonStr);
            return true;
        }
        if (typeof jsonStr !== "string" || jsonStr.length === 0) return false;
        let snapshotObj = null;
        try {
            snapshotObj = JSON.parse(jsonStr);
        } catch (_) {
            snapshotObj = null;
        }
        await this.curve_manager.loadFromJSON(jsonStr);
        if (snapshotObj) {
            const canvas = commandCanvas(this);
            canvas.fontSettings = fontSettingsFromSnapshot(snapshotObj, canvas.fontSettings);
            restoreEditorStateFromSnapshot(canvas, snapshotObj);
        }
        return true;
    }

    /**
     * Command: commits coordinate changes to a control point
     * Effect: called terminally on mouseup (drag release), writes history once
     */
    changeControlNodePosition(marker, x, y) {
        let success = this.curve_manager.adjustControlNode(marker, x, y);
        if (success) {
            this.notifyPropertiesUpdate();
            this.bumpGeometryEpoch();
            this.curve_manager.rebuildSpatialGrid();
            this._commitHistory("changeControlNodePosition");
        }
        return success;
    }

    deleteControlNode(marker) {
        let success = this.curve_manager.deleteControlNode(marker);
        if (success) {
            this.notifyPropertiesUpdate();
            this.bumpGeometryEpoch();
            this._commitHistory("deleteControlNode");
        }
        return success;
    }

    /**
     * Command: commits coordinate changes to selected main nodes
     * Effect: called terminally on mouseup (main node drag release), writes history once
     */
    changeSelectedNodesPosition(updates = null) {
        if (updates && updates.length > 0) {
            this.curve_manager.moveSelectedNodes(updates);
        }
        this.notifyPropertiesUpdate();
        this.bumpGeometryEpoch();
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("changeSelectedNodesPosition");
        return true;
    }

    /**
     * Command: changes smooth mode for all selected nodes
     */
    changeSmoothModeOnSelectedNode(markers, mode, forceCreateHandles = false) {
        let changed = false;
        for (const marker of markers) {
            if (this.curve_manager.changeSmoothModeOnSingleNode(marker, mode, forceCreateHandles)) {
                changed = true;
            }
        }
        if (changed) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
        }
        return changed;
    }

    /**
     * Command: inserts a new node in an existing path
     */
    insertMainNode(segment, localX, localY) {
        if (!segment) return null;

        let best_t = this.utils.getClosestTOnSegment(segment.startNode, segment.nextNode, localX, localY, 0);
        const n1 = segment.startNode, n2 = segment.nextNode;
        const d1 = Math.hypot(localX - n1.x, localY - n1.y);
        const d2 = Math.hypot(localX - n2.x, localY - n2.y);
        if (d1 < 1e-6 || d2 < 1e-6) return null;

        if (segment.startNode && segment.startNode.control_mode === 2) {
            segment.startNode.control_mode = 1;
        }
        if (segment.nextNode && segment.nextNode.control_mode === 2) {
            segment.nextNode.control_mode = 1;
        }

        let newMarker = segment.curve.insertNodeAt(segment.startNode, best_t, this.curve_manager);
        if (!newMarker) return null;

        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "replace", markerIds: [newMarker.id] }
        });
        this.hovered_curve_segment = null;
        this.hovered_node_marker = newMarker;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.bumpGeometryEpoch();
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("insertMainNode");
        return newMarker;
    }

    /** Write CM active group to Store (draw render reads Store.activeGroupId) */
    syncActiveGroupForDraw(groupId) {
        return syncActiveGroupToStore(this, groupId);
    }

    /**
     * Action: Start creating a new path
     */
    startAddingPath(activeGroupId, seqOffsetX) {
        syncActiveGroupToStore(this, activeGroupId);
        const curve = this.curve_manager.startAddingPath(activeGroupId, {
            stroke_width: this.drawToolSettings.stroke_width,
            closed: this.drawToolSettings.closed,
            smart_stroke: this.drawToolSettings.smart_expand
        });
        if (!curve) return false;

        this.current_curve = curve;
        this.drawing_seq_offset = seqOffsetX;
        this.last_on_curve_node_marker = null;
        return true;
    }

    /**
     * Action: Finish creating current path
     */
    finishAddingPath() {
        this.curve_manager.finishAddingPath(this.current_curve);
        this.current_curve = null;
        this.last_on_curve_node_marker = null;
        this.previewData = null;
        this.new_curve_handle = null;
        this.drawing_seq_offset = undefined;
        this.closing_path_on_mouseup = false;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
    }

    /**
     * Command: Complete current path and write to history once
     */
    finishAddingPathCommand() {
        const hasPath = !!(this.current_curve && this.current_curve.startNode);
        this.finishAddingPath();
        if (hasPath) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this.curve_manager.rebuildSpatialGrid();
            this._commitHistory("finishAddingPathCommand");
        }
        return hasPath;
    }

    /**
     * Command: Append a main node at the end of the current drawing path
     */
    addMainNode(worldX, worldY) {
        if (!this.current_curve) return null;

        let new_marker = generateMarker("vertex");
        this.curve_manager.add_node_by_curve(new_marker, "vertex", worldX, worldY, null, this.last_on_curve_node_marker, this.current_curve, String(new_marker.id));

        this.last_on_curve_node_marker = new_marker;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "replace", markerIds: [new_marker.id] }
        });
        return new_marker;
    }

    /**
     * Action: undo the last main node during drawing (does not write history)
     */
    undoDrawingStep() {
        if (!this.current_curve || !this.current_curve.startNode) return false;
        this.curve_manager.rollbackLastPathNode(this.current_curve);
        if (this.current_curve.startNode) {
            this.last_on_curve_node_marker = this.current_curve.endNode ? this.current_curve.endNode.main_node : null;
            if (this.last_on_curve_node_marker) {
                commitInteractionFromCommand(this, {
                    type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                    payload: { strategy: "replace", markerIds: [this.last_on_curve_node_marker.id] }
                });
            }
        } else {
            this.current_curve = null;
            this.last_on_curve_node_marker = null;
            this.drawing_seq_offset = undefined;
            this.new_curve_handle = null;
            this.closing_path_on_mouseup = false;
            commitInteractionFromCommand(this, {
                type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                payload: { strategy: "clear" }
            });
        }

        this.previewData = null;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: deletes all selected nodes
     * Effect: batch executes delete action, then cleanup and single snapshot save
     */
    deleteSelectedNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length === 0) return false;

        let changed = false;
        for (let marker of markers) {
            if (this.curve_manager.deleteSingleNode(marker)) {
                changed = true;
            }
        }

        if (changed) {
            commitInteractionFromCommand(this, {
                type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
                payload: { strategy: "clear" }
            });
            this.curve_manager.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            this.curve_manager.rebuildSpatialGrid();
            this._commitHistory("deleteSelectedNodes");
        }
        return changed;
    }

    /**
     * Command: deletes all selected objects
     * Effect: batch executes object delete action, writes history once after completion
     */
    deleteSelectedObjects(ids = null) {
        const canvas = commandCanvas(this);
        const targetIds = selectedTreeIdsFromStore(canvas, ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.deleteSingleObject(id)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.updateSequenceParsing();
        const remaining = targetIds.filter((id) => this.curve_manager.treeItems.has(id));
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_TREE_SELECTION,
            payload: { ids: remaining }
        });
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this._commitHistoryUnlessDispatching("deleteSelectedObjects");
        return true;
    }

    /**
     * Command: changes group/hierarchy position for multiple objects
     * Effect: batch calls changeSingleObjectGroup, writes history once
     */
    changeSelectedObjectsGroup(ids = [], targetId = null, mode = 'inside') {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        if (!targetId) return false;

        let changed = false;
        for (const id of ids) {
            if (this.curve_manager.changeSingleObjectGroup(id, targetId, mode)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.updateSequenceParsing();
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        // When objects are moved to a different group, update the active group
        // so the tree view and render layer reflect the new context.
        syncActiveGroupToStore(this, targetId);
        this._commitHistoryUnlessDispatching("changeSelectedObjectsGroup");
        return true;
    }

    /**
     * Command: batch update single object properties
     * updates: [{ id, props }]
     */
    setSingleObjectProperties(updates = [], options = {}) {
        if (!Array.isArray(updates) || updates.length === 0) return false;
        let changed = false;
        for (const update of updates) {
            if (!update || !update.id || !update.props) continue;
            if (this.curve_manager.setSingleObjectProperties(update.id, update.props)) changed = true;
        }
        // If recordHistory is requested (e.g. change/blur event), do NOT return false
        // when no model change is detected: the value may have already been applied
        // by a prior input event (realtimeIds path) — we still need the dispatch
        // chain to reach editorStore.commitCommand so the snapshot change delta
        // (currentStateObj → current model) is captured into history.
        if (!changed && !options.recordHistory) return false;

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: commits object transform (drag/scale/rotate)
     * Effect: unifies state sync and history recording
     */
    changeSelectedObjectsTransform(hasChanged = false) {
        this.curve_manager.syncTreeSelectionFromCanvas();
        if (hasChanged) {
            this.curve_manager.rebuildSpatialGrid();
            this._commitHistory("changeSelectedObjectsTransform");
            // Bump geometry epoch so the renderer invalidates its stable scene cache
            // (transform operations modify node positions without notifyTreeUpdate).
            this.curve_manager._geometryEpoch = (this.curve_manager._geometryEpoch || 0) + 1;
        }
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return hasChanged;
    }

    /**
     * Command: modify selected object bounding box parameters (x/y/w/h)
     */
    changeSelectedObjectsBounds(prop, value, options = {}) {
        const bounds = this.utils.getSelectionBounds();
        if (!bounds) return false;
        const geometryBounds = (prop === 'w' || prop === 'h') ? this.utils.getSelectionBounds('geometry') : null;

        const changed = this.curve_manager.changeSelectedObjectsBounds(prop, value, bounds, geometryBounds, options);
        // Same input-event race as setSingleObjectProperties: input events via realtimeIds
        // pre-apply the value, so the change event finds nothing to do. Always proceed when
        // recordHistory is requested so the snapshot delta is captured.
        if (!changed && !options.recordHistory) return false;

        this.curve_manager._geometryEpoch = (this.curve_manager._geometryEpoch || 0) + 1;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        return true;
    }

    /**
     * Command: copy selected objects to clipboard
     */
    copySelectedObjects(ids = null) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        const payload = [];
        for (const id of targetIds) {
            const item = this.curve_manager.treeItems.get(id);
            if (!item) continue;
            if (item.type === 'curve') {
                const curve = this.curve_manager.curveById.get(item.curveId);
                if (curve) payload.push({ type: 'curve', data: curve });
            } else if (item.type === 'group') {
                const actualRefId = item.isRef ? item.refId : id;
                payload.push({
                    type: 'group',
                    id: actualRefId,
                    name: item.name,
                    transform: item.isRef ? item.transform : null
                });
            }
        }
        this.curve_manager.clipboard = payload;
        return payload.length > 0;
    }

    /**
     * Command: paste clipboard objects to target group
     */
    pasteCopiedObjects(targetId = null) {
        const cm = this.curve_manager;
        if (!cm.clipboard || cm.clipboard.length === 0) return false;
        const resolvedTargetId = targetId || cm.ensureActiveGroup();
        if (!resolvedTargetId) return false;

        let changed = false;
        for (const item of cm.clipboard) {
            if (!item) continue;
            if (item.type === 'curve' && item.data) {
                const duplicated = cm.cloneCurveToGroup(item.data, resolvedTargetId);
                if (duplicated) changed = true;
            } else if (item.type === 'group' && item.id) {
                cm.pasteGroupRef(item.id, resolvedTargetId, item.transform || null);
                changed = true;
            }
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: duplicate selected objects
     */
    duplicateSelectedObjects(ids = null) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        const duplicatedTreeIds = [];
        for (const id of targetIds) {
            const item = this.curve_manager.treeItems.get(id);
            if (!item) continue;
            if (item.type === 'curve') {
                const curve = this.curve_manager.curveById.get(item.curveId);
                const duplicated = curve ? this.curve_manager.cloneCurveToGroup(curve, item.parentId) : null;
                if (duplicated) {
                    duplicatedTreeIds.push(duplicated.id);
                    changed = true;
                }
            } else if (item.type === 'group') {
                const duplicatedGroup = this.curve_manager.duplicateGroupDeep(item.id, item.parentId);
                if (duplicatedGroup?.id) {
                    duplicatedTreeIds.push(duplicatedGroup.id);
                    if (duplicatedGroup.sequenceChanged) {
                        refreshStoreSequence(this);
                    }
                    changed = true;
                }
            }
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();

        if (duplicatedTreeIds.length > 0) {
            const validIds = duplicatedTreeIds.filter((id) => this.curve_manager.treeItems.has(id));
            if (validIds.length > 0) {
                commitInteractionFromCommand(this, {
                    type: EDITOR_ACTIONS.SET_TREE_SELECTION,
                    payload: { ids: validIds }
                });
            }
        }

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: lock/unlock all selected objects
     */
    toggleSelectedObjectsLock(ids = null, locked = undefined) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        const cm = this.curve_manager;
        const targetGroupIds = new Set(
            targetIds
                .map((id) => cm.treeItems.get(id))
                .filter((item) => item && item.type === "group" && item.parentId === null)
                .map((item) => item.id)
        );

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.toggleSingleObjectLock(id, locked)) changed = true;
        }
        if (!changed) return false;

        // Lock/unlock is equivalent to sequence activation state:
        // - Lock    => corresponding sequence index set to inactive
        // - Unlock  => corresponding sequence index set to active
        // Curve locked is still an independent property; this only syncs "root groups".
        const nextActive = new Set(cm.activeSequenceIndices || []);
        if (targetGroupIds.size > 0 && Array.isArray(cm.sequenceTokens)) {
            for (let i = 0; i < cm.sequenceTokens.length; i++) {
                const token = cm.sequenceTokens[i];
                if (!token) continue;
                const gid = token.isChar ? cm.getDefaultGroupForChar(token.value) : token.value;
                if (!gid || !targetGroupIds.has(gid)) continue;

                const item = cm.treeItems.get(gid);
                const isNowLocked = !!(item && item.locked === true);
                if (isNowLocked) nextActive.delete(i);
                else nextActive.add(i);
            }
        }
        cm.setActiveIndices(nextActive);
        refreshStoreSequence(this);

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: show/hide all selected objects
     */
    toggleSelectedObjectsDisplay(ids = null, visible = undefined) {
        const targetIds = selectedTreeIdsFromStore(commandCanvas(this), ids);
        if (targetIds.length === 0) return false;

        let changed = false;
        for (const id of targetIds) {
            if (this.curve_manager.toggleSingleObjectDisplay(id, visible)) changed = true;
        }
        if (!changed) return false;

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: rename a single tree object
     */
    renameTreeItem(itemId, newName) {
        const item = this.curve_manager.treeItems.get(itemId);
        if (!item) return false;
        if (item.name === newName) return false;
        if (!this.curve_manager.renameItem(itemId, newName)) return false;

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: update group advance
     */
    setGroupAdvance(groupId, advance, options = {}) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group') return false;
        if (advance === '') return false;
        const num = Number(advance);
        if (!Number.isFinite(num) || num < 0) return false;
        if (item.advance === num) {
            return options.recordHistory === true;
        }

        item.advance = num;
        item.is_modified = true;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: apply kerning pair changes (set or remove) through the history
     * pipeline. Each item: { left, right, value } to set, or
     * { left, right, remove: true } to delete. No change -> false (history is
     * still recorded when recordHistory is requested, matching the advance
     * command convention). Direct kerning mutations bypassing this command are
     * NOT undoable: the history snapshot includes the `kerning`/`kerning_classes`
     * fields (snapshot_patch_executor + snapshot_runtime_applier restore them),
     * so every command commit captures the full kerning state.
     */
    setKerningPairs(pairs = [], options = {}) {
        const km = this.curve_manager?.kerningManager;
        if (!km || !Array.isArray(pairs) || pairs.length === 0) return false;
        let changed = false;
        for (const p of pairs) {
            if (!p || typeof p.left !== 'string' || typeof p.right !== 'string' || !p.left || !p.right) continue;
            if (p.remove === true) {
                if (km.removePair(p.left, p.right)) changed = true;
            } else if (p.value !== undefined) {
                const num = Number(p.value);
                if (!Number.isFinite(num)) continue;
                if (km.getPair(p.left, p.right) !== num) {
                    km.setPair(p.left, p.right, num);
                    changed = true;
                }
            }
        }
        if (!changed) return options.recordHistory === true;

        // Sequence offsets depend on kerning (sequence_service.calculateSequenceOffsets);
        // stable-scene cache holds divider positions, so both must refresh.
        this.curve_manager.calculateSequenceOffsets?.();
        this.renderer?.invalidateStableSceneCache?.();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: update single node property
     */
    updateSingleNodeProperty(marker, propId, value, options = {}) {
        const num = Number(value);
        if (!Number.isFinite(num)) return false;
        const changed = this.curve_manager.updateNodeProperty(marker, propId, num);
        if (!changed) {
            return options.recordHistory === true;
        }
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        return true;
    }

    /**
     * Command: update ellipse tool default properties
     */
    setEllipseProperties(updates = {}, options = {}) {
        if (!updates || typeof updates !== 'object') return false;
        let changed = false;
        const allowed = ['stroke_width', 'closed', 'smart_expand'];
        for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
            const nextVal = updates[key];
            if (key === 'stroke_width' && nextVal === '') continue;
            if (key === 'stroke_width' && (!Number.isFinite(Number(nextVal)) || Number(nextVal) < 0)) {
                continue;
            }
            if (this.ellipseToolSettings[key] !== nextVal) {
                this.ellipseToolSettings[key] = key === 'stroke_width' ? Number(nextVal) : nextVal;
                changed = true;
            }
        }
        if (!changed) {
            return options.recordHistory === true;
        }
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_ELLIPSE_TOOL_SETTINGS,
            payload: { ...this.ellipseToolSettings }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: update pen tool default properties
     */
    setPenProperties(updates = {}, options = {}) {
        if (!updates || typeof updates !== 'object') return false;
        let changed = false;
        const allowed = ['stroke_width', 'closed', 'smart_expand'];
        for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
            const nextVal = updates[key];
            if (key === 'stroke_width' && nextVal === '') continue;
            if (key === 'stroke_width' && (!Number.isFinite(Number(nextVal)) || Number(nextVal) < 0)) {
                continue;
            }
            if (this.drawToolSettings[key] !== nextVal) {
                this.drawToolSettings[key] = key === 'stroke_width' ? Number(nextVal) : nextVal;
                changed = true;
            }
        }
        if (!changed) {
            return options.recordHistory === true;
        }
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_DRAW_TOOL_SETTINGS,
            payload: { ...this.drawToolSettings }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: update document font settings.
     */
	    setFontSettings(updates = {}, options = {}) {
	        const canvas = commandCanvas(this);
	        if (!updates || typeof updates !== 'object') return false;
	        const previous = canvas.fontSettings || {};
	        const next = { ...previous, ...updates };
	        if (JSON.stringify(previous) === JSON.stringify(next)) {
	            return options.recordHistory === true;
	        }

	        // UPM change: scale EVERY coordinate-bearing value in the document
	        // model so the whole design space follows the new UPM (user rule:
	        // "changing the UPM must uniformly scale all coordinate data in
	        // the font file - nothing may be left unscaled").
	        const prevUpm = Number(previous.upm) || 1000;
	        const newUpm = Number(next.upm);
	        if (Number.isFinite(newUpm) && newUpm > 0 && Number.isFinite(prevUpm) && prevUpm > 0 && newUpm !== prevUpm) {
	            const ratio = newUpm / prevUpm;
	            const scaleVal = (v) => v * ratio;

	            // 1) Document model: node coordinates, control handles, stroke
	            //    widths, group advances, ref translations and kerning -
	            //    all stored in UPM units (schemas/project_schema.json).
	            this.curve_manager.scaleAllCoordinates(ratio);

	            // 2) Editor overlays stored in design units.
	            for (const g of canvas.guidelines || []) {
	                if (Number.isFinite(g.x)) g.x = scaleVal(g.x);
	                if (Number.isFinite(g.y)) g.y = scaleVal(g.y);
	            }
	            for (const r of canvas.rulers || []) {
	                if (r && Number.isFinite(r.x1) && Number.isFinite(r.x2)) {
	                    r.x1 = scaleVal(r.x1); r.y1 = scaleVal(r.y1);
	                    r.x2 = scaleVal(r.x2); r.y2 = scaleVal(r.y2);
	                }
	            }

	            // 3) Em-box size: canvas_size is the design-space baseline
	            //    (UFO/SVG exports derive font y from it) - it must track
	            //    the new UPM so import/export stay consistent.
	            if (Number.isFinite(canvas.canvas_size_width) && canvas.canvas_size_width > 0) {
	                canvas.canvas_size_width = Math.max(1, Math.round(scaleVal(canvas.canvas_size_width)));
	            }
	            if (Number.isFinite(canvas.canvas_size_height) && canvas.canvas_size_height > 0) {
	                canvas.canvas_size_height = Math.max(1, Math.round(scaleVal(canvas.canvas_size_height)));
	            }

	            // 4) Metrics: scale unless the user explicitly typed a new
	            //    value in this same save. The popup pre-fills every field
	            //    from the current settings (or the built-in defaults), so
	            //    an untouched field arrives equal to its previous value —
	            //    and on a fresh document the previous value is undefined
	            //    while the incoming one is a pre-fill, not an edit. Both
	            //    cases scale; only a value that differs from the previous
	            //    one is the user's own new value and must win.
	            for (const key of ['ascender', 'descender', 'x_height', 'cap_height', 'basic_spacing']) {
	                const prevVal = previous[key];
	                const updVal = updates[key];
	                const userEdited = updVal !== undefined && prevVal !== undefined && updVal !== prevVal;
	                const base = prevVal !== undefined ? prevVal : updVal;
	                if (!userEdited && base !== undefined) {
	                    next[key] = Math.round(scaleVal(base));
	                }
	            }

	            // 5) Viewport invariance (user rule): a UPM change must NOT touch
	            //    scale / scaleBase / zoomTicks / offset. The old compensation
	            //    (scaleBase = scale / ratio) pushed scale below scale_min when
	            //    the zoom was already small, which killed wheel zoom (clamp-
	            //    revert in change_canvas_size) and froze the rulers (step-table
	            //    fallback in getStepAndPrecision) - removed.

	            // 6) Geometry epoch + smart-stroke boolean caches: every curve
	            //    changed (scaleAllCoordinates already cleared per-curve
	            //    caches; this also invalidates the stable scene cache).
	            canvas.flushSmartStrokeBooleanCache?.();
	        }
        canvas.fontSettings = next;

        // Sync project name with ProjectManager immediately so the brand title
	        // and cached project list reflect the change without relying on the
	        // EditorStore → STATE_CHANGED → syncActiveProjectNameFromCanvas pipeline
	        // (which may not fire if recordHistory returns false for metadata-only changes).
	        if (next.project_name && next.project_name !== previous.project_name) {
	            canvas.projectManager?.syncActiveProjectNameFromCanvas?.()?.catch(e =>
	                console.error("[setFontSettings] Failed to sync project name:", e)
	            );
	        }

	        this.notifyPropertiesUpdate();
	        this.is_dirty = true;
	        return true;
	    }

    /**
     * Command: update group character mapping (g_char)
     */
    setGroupCharCode(groupId, rawValue, options = {}) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) {
            return { success: false, error: 'Invalid group target.' };
        }

        const newVal = rawValue === '' ? null : rawValue;
        if (item.charCode === newVal) return { success: false };

        if (newVal !== null) {
            for (let [otherId, otherItem] of this.curve_manager.treeItems.entries()) {
                if (otherId === groupId) continue;
                if (otherItem.type === 'group' && otherItem.parentId === null && !otherItem.isRef) {
                    if (otherItem.charCode === newVal) {
                        return { success: false, error: `Character code '${newVal}' is already used by '${otherItem.name}'. Character codes must be unique.` };
                    }
                }
            }
        }

        const oldChar = item.charCode;
        item.charCode = newVal;
        item.is_modified = true;
        if (oldChar !== null) this.curve_manager.defaultGlyphs.delete(oldChar);
        if (newVal !== null) this.curve_manager.defaultGlyphs.set(newVal, groupId);

        const tokens = this.curve_manager.sequenceTokens || [];
        let newText = '';
        let seqChanged = false;
        for (let t of tokens) {
            if ((t.isChar && oldChar !== null && t.value === oldChar) || (!t.isChar && t.value === item.id)) {
                newText += `\\${item.name}\\`;
                seqChanged = true;
            } else {
                newText += t.raw;
            }
        }

        if (seqChanged) {
            this.curve_manager.setSequenceState({
                text: newText,
                activeIndices: Array.from(this.curve_manager.activeSequenceIndices)
            });
            refreshStoreSequence(this);
        } else {
            this.curve_manager.notifyTreeUpdate();
        }

        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return { success: true };
    }

    /**
     * Command: update sequence editor state (text + activeIndices)
     * Does not write history by default; controlled by options.recordHistory
     */
    setSequenceEditorState({ text, activeIndices } = {}, options = {}) {
        const cm = this.curve_manager;
        if (typeof text !== "string" && activeIndices === undefined) return false;
        cm.setSequenceState({ text, activeIndices });
        cm.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: delete group and sync sequence state (for sequence editor menu)
     */
    deleteGroupAndUpdateSequence(groupId, { text, activeIndices } = {}, options = {}) {
        if (!groupId || typeof text !== 'string') return false;
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) return false;

        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: { strategy: "clear" }
        });
        const deleted = this.curve_manager.deleteSingleObject(groupId);
        if (!deleted) return false;

        this.curve_manager.setSequenceState({ text, activeIndices });

        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: canvas object selection (SELECT tool click/box-select, no history write)
     * payload: { strategy, curveIds?, refIds?, activeGroupId? }
     */
    changeObjectSelection(strategy = "replace", payload = {}) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: { strategy, ...payload }
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: node selection (NODE/DRAW tool; Store already applied before dispatch, aligned with CM here)
     */
    changeNodeSelection(strategy = "replace", payload = {}) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy, ...payload }
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: set tree selection (interaction only, no history write)
     */
    setTreeSelection(ids = [], activeGroupId = undefined) {
        if (!Array.isArray(ids)) return false;
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const payload = { ids };
        if (activeGroupId !== undefined && activeGroupId !== null) {
            payload.activeGroupId = activeGroupId;
        }
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_TREE_SELECTION,
            payload
        });
        if (ok) finishInteractionCommand(this);
        return ok;
    }

    /**
     * Command: set current active group (interaction only, no history write)
     */
    setActiveGroup(groupId) {
        const canvas = commandCanvas(this);
        if (isStoreInteractionDispatch(canvas)) return finishInteractionCommand(this);
        const ok = commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.SET_ACTIVE_GROUP,
            payload: { id: groupId }
        });
        if (!ok) return false;
        return finishInteractionCommand(this);
    }

    /**
     * Command: collapse/expand group (interaction only, no history write)
     */
    toggleGroupCollapsed(groupId) {
        const item = this.curve_manager.treeItems.get(groupId);
        if (!item || item.type !== 'group' || item.isRef) return false;
        item.collapsed = !item.collapsed;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: merge selected paths (Boolean Union)
     */
    booleanUnionSelectedCurves() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let firstGroupId = null;
        let validCurves = [];
        for (let id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') {
                console.warn("Union Failed: Please select ONLY basic paths.");
                return false;
            }
            const curve = cm.curveById.get(item.curveId);
            if (!curve) continue;
            if (firstGroupId === null) {
                firstGroupId = curve.groupId;
            } else if (curve.groupId !== firstGroupId) {
                console.warn("Union Failed: All selected paths must belong to the exact same Group.");
                return false;
            }
            validCurves.push(curve);
        }
        if (validCurves.length === 0) return false;
        const changed = cm.executeBooleanUnion(validCurves, firstGroupId);
        if (!changed) return false;
        cm.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: unlink references (batch)
     */
    unlinkSelectedReferences(ids = []) {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        let changed = false;
        for (const id of ids) {
            if (this.curve_manager.unlinkReferenceDeep(id)) changed = true;
        }
        if (!changed) return false;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        return true;
    }

    /**
     * Command: expand stroke (batch)
     * Follows proven patterns from cloneCurveToGroup (direct add_node_by_curve + changeSmoothModeOnSingleNode)
     * and executeBooleanUnion (unregisterCurveDomMarkers for proper domMap cleanup).
     */
    expandSelectedStroke() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let changed = false;
        const expandedCurves = [];
        let validCurves = [];
        for (let id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve) continue;
            validCurves.push(curve);
        }
        if (validCurves.length === 0) return false;

        const cs = cm.curveStore;
        for (let curve of validCurves) {
            let originalSmart = curve.smart_stroke;
            curve.smart_stroke = true;
            cs.updateSmartStrokeStatus(curve);
            // _expandRoundCap is now read from the curve's own per-curve property
            curve.updateBooleanCache();

            if (!Array.isArray(curve.cached_boolean_geometry) || curve.cached_boolean_geometry.length === 0) {
                curve.smart_stroke = originalSmart;
                curve.smart_stroke = originalSmart;
                cs.updateSmartStrokeStatus(curve);
                continue;
            }

            let parentGroupId = curve.groupId;
            for (let sub of curve.cached_boolean_geometry) {
                if (sub.segments.length < 2) continue;
                let newCurve = cm.create_temp_curve();
                newCurve.closed = sub.closed;
                newCurve.stroke_width = 0;
                newCurve.smart_stroke = true;
                newCurve.smart_stroke_clockwise = curve.smart_stroke_clockwise !== false;

                let last_main_node = null;

                for (let i = 0; i < sub.segments.length; i++) {
                    let seg = sub.segments[i];
                    if (sub.closed && i === sub.segments.length - 1 && i > 0) {
                        let firstSeg = sub.segments[0];
                        if (Math.abs(firstSeg.x - seg.x) < 0.001 && Math.abs(firstSeg.y - seg.y) < 0.001) {
                            let firstNode = newCurve.startNode;
                            if (seg.inX !== 0 || seg.inY !== 0) {
                                if (!firstNode.control2) cm.changeSmoothModeOnSingleNode(firstNode.main_node, 1, true);
                                if (firstNode.control2) {
                                    firstNode.control2.x = seg.x + seg.inX;
                                    firstNode.control2.y = seg.y + seg.inY;
                                }
                            }
                            continue;
                        }
                    }

                    // Direct add_node_by_curve (same pattern as cloneCurveToGroup)
                    let marker = generateMarker("vertex");
                    cm.add_node_by_curve(marker, "vertex", seg.x, seg.y, null, last_main_node, newCurve, String(marker.id));
                    last_main_node = marker;
                    let node = cm.find_node_by_curve(marker);

                    // Create handles for segments with offset geometry;
                    // changeSmoothModeOnSingleNode internally calls applyMode which creates
                    // both handles at default 30px offset - we must delete degenerate handles
                    // (zero-length) to keep them from corrupting the curve shape.
                    const outLen = Math.hypot(seg.outX || 0, seg.outY || 0);
                    const inLen = Math.hypot(seg.inX || 0, seg.inY || 0);
                    const hasOut = outLen >= 0.001;
                    const hasIn = inLen >= 0.001;

                    if (hasOut || hasIn) {
                        cm.changeSmoothModeOnSingleNode(marker, 1, true);
                        if (node.control1) {
                            if (hasOut) {
                                node.control1.x = seg.x + (seg.outX || 0);
                                node.control1.y = seg.y + (seg.outY || 0);
                            } else {
                                cm.deleteControlNode(node.control1.main_node);
                            }
                        }
                        if (node.control2) {
                            if (hasIn) {
                                node.control2.x = seg.x + (seg.inX || 0);
                                node.control2.y = seg.y + (seg.inY || 0);
                            } else {
                                cm.deleteControlNode(node.control2.main_node);
                            }
                        }
                    }

                    newCurve.endNode = node;
                }

                cm.addPath(newCurve, parentGroupId);
                expandedCurves.push(newCurve);
            }

            // Proper cleanup matching executeBooleanUnion pattern:
            // remove DOM markers first, then tree item, then splice from curves array.
            // remove_curve() alone doesn't clean domMap, leaving stale markers that
            // confuse resolveMarkerById and corrupt undo/redo state.
            cm.curveStore.unregisterCurveDomMarkers(curve);
            cm.treeStore.deleteTreeItem(curve.id, false);
            cm.curveStore.remove_curve(curve.id);
            cm.notifyTreeUpdate();
            changed = true;
        }

        if (!changed) return false;
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: {
                strategy: "replace",
                curveIds: expandedCurves.map((c) => c.id),
                refIds: []
            }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    // =========================================================================
    // Node operations (batch)
    // =========================================================================

    /**
     * Command: insert node at midpoint of each segment in curves with selected nodes.
     * For each segment (between consecutive nodes), a new node is inserted at t=0.5.
     */
    /**
     * Command: insert node at midpoint of each segment where BOTH endpoints are selected.
     * Only segments whose two endpoints are both among the selected markers qualify.
     */
    insertNodeSelectedSegments() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 2) return false;

        const cm = this.curve_manager;
        // Build a set of selected marker IDs for O(1) lookup
        const selectedIds = new Set();
        for (const m of markers) {
            selectedIds.add(m?.id ?? m);
        }

        // Determine which curves contain selected markers (O(k) where k = selected markers)
        const curveIds = new Set();
        for (const m of markers) {
            const node = cm.find_node_by_curve(m);
            if (node?.curve?.id) curveIds.add(node.curve.id);
        }
        if (curveIds.size === 0) return false;

        let changed = false;
        for (const curveId of curveIds) {
            const curve = cm.curveById.get(curveId);
            if (!curve) continue;
            // Walk all segments of this curve
            const segments = []; // list of { from: Node, to: Node }
            let n = curve.startNode;
            while (n) {
                const next = n.nextOnCurve;
                if (next) {
                    segments.push({ from: n, to: next });
                }
                if (n === curve.endNode) break;
                n = next;
            }
            // For closed curves, the endNode→startNode closing segment
            if (curve.closed && curve.endNode && curve.startNode !== curve.endNode) {
                const nMarkerId = curve.endNode.main_node?.id ?? curve.endNode.main_node;
                const nextMarkerId = curve.startNode.main_node?.id ?? curve.startNode.main_node;
                if (selectedIds.has(nMarkerId) && selectedIds.has(nextMarkerId)) {
                    segments.push({ from: curve.endNode, to: curve.startNode });
                }
            }

            for (const seg of segments) {
                const fromId = seg.from.main_node?.id ?? seg.from.main_node;
                const toId = seg.to.main_node?.id ?? seg.to.main_node;
                if (selectedIds.has(fromId) && selectedIds.has(toId)) {
                    const newMarker = curve.insertNodeAt(seg.from, 0.5, cm);
                    if (newMarker) changed = true;
                }
            }
        }

        if (!changed) return false;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.bumpGeometryEpoch();
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("insertNodeSelectedSegments");
        return true;
    }

    /**
     * Command: merge each pair of endpoints into a single node at the average position.
     * Pairs are taken as (0,1), (2,3)... from the selected markers. Non-endpoint
     * nodes are ignored (filtered out before pairing).
     * If on the same curve (start+end): close the curve.
     * If on different curves: the two curves merge through the shared node.
     */
    joinSelectedNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 2) return false;

        const cm = this.curve_manager;
        /** Curves whose geometry was modified — invalidate boolean caches after the loop. */
        const modifiedCurves = new Set();
        // Filter to endpoint nodes only
        const endMarkers = [];
        for (const m of markers) {
            const n = cm.find_node_by_curve(m);
            if (n && n.curve && (n === n.curve.startNode || n === n.curve.endNode)) {
                endMarkers.push(m);
            }
        }
        if (endMarkers.length < 2) return false;

        let changed = false;
        for (let i = 0; i + 1 < endMarkers.length; i += 2) {
            const m1 = endMarkers[i];
            const m2 = endMarkers[i + 1];
            const n1 = cm.find_node_by_curve(m1);
            const n2 = cm.find_node_by_curve(m2);
            if (!n1 || !n2 || !n1.curve || !n2.curve) continue;

            const avgX = (n1.x + n2.x) / 2;
            const avgY = (n1.y + n2.y) / 2;

            const c1 = n1.curve;
            const c2 = n2.curve;

            if (c1 === c2) {
                // Same curve: close it if n1 is start and n2 is end (or vice versa)
                if ((n1 === c1.startNode && n2 === c1.endNode) ||
                    (n2 === c1.startNode && n1 === c1.endNode)) {
                    // Move n1 to avg (translate handles with node)
                    const dx = avgX - n1.x;
                    const dy = avgY - n1.y;
                    n1.x = avgX;
                    n1.y = avgY;
                    if (n1.control1) { n1.control1.x += dx; n1.control1.y += dy; }
                    if (n1.control2) { n1.control2.x += dx; n1.control2.y += dy; }
                    cm.deleteSingleNode(m2);
                    c1.closed = true;
                    modifiedCurves.add(c1);
                    changed = true;
                }
                continue;
            }

            // Different curves: validate both curves are in the same glyph before merging.
            if (c1.groupId !== c2.groupId) {
                console.warn("[Join] All selected endpoint nodes must belong to curves in the same Group.");
                continue;
            }

            // Different curves: identify the endNode (has incoming segment) and
            // startNode (has outgoing segment), regardless of which curve they are on.
            let endNode = (n1 === c1.endNode) ? n1 : (n2 === c2.endNode ? n2 : null);
            let startNode = (n2 === c2.startNode) ? n2 : (n1 === c1.startNode ? n1 : null);

            // Fallback: both endpoints are the same type (both endNodes or both startNodes).
            // Reverse one curve's chain so the pairing works.
            // Uses Curve.reverseSkeletonDirection() which correctly swaps per-node
            // control handles — a simple linked-list reversal would corrupt the Bezier segments.
            if (!endNode || !startNode) {
                if (n1 === c1.endNode && n2 === c2.endNode) {
                    c2.reverseSkeletonDirection();
                    startNode = n2;  // n2 is now c2.startNode
                    endNode = n1;
                } else if (n1 === c1.startNode && n2 === c2.startNode) {
                    c1.reverseSkeletonDirection();
                    endNode = n1;  // n1 is now c1.endNode
                    startNode = n2;
                } else {
                    continue;
                }
            }
            if (endNode.curve === startNode.curve) continue;

            const sourceCurve = startNode.curve;  // the curve we absorb from
            const targetCurve = endNode.curve;     // the curve we keep

            // Move endNode to average position
            const dx = avgX - endNode.x;
            const dy = avgY - endNode.y;
            endNode.x = avgX;
            endNode.y = avgY;

            // Handle strategy: keep only "meaningful" handles.
            // endNode (end point): control2 is meaningful (incoming segment), control1 is dangling
            // startNode (start point): control1 is meaningful (outgoing segment), control2 is dangling
            // Translate meaningful handles to the merged position.

            // endNode.control2 (incoming) — translate to new position
            if (endNode.control2) {
                endNode.control2.x += dx;
                endNode.control2.y += dy;
            }

            // Apply startNode.control1's direction (outgoing) to endNode,
            // replacing its dangling control1.
            if (startNode.control1) {
                const dirX = startNode.control1.x - startNode.x;
                const dirY = startNode.control1.y - startNode.y;
                if (endNode.control1) {
                    endNode.control1.x = endNode.x + dirX;
                    endNode.control1.y = endNode.y + dirY;
                } else {
                    // Create a new control1 for endNode
                    const c1Marker = generateMarker("circle");
                    const c1Node = new CurveNode(c1Marker, null,
                        endNode.x + dirX, endNode.y + dirY,
                        endNode, null, String(c1Marker.id));
                    c1Node.curve = targetCurve;
                    endNode.control1 = c1Node;
                    cm.domMap.set(c1Marker, c1Node);
                    targetCurve.domMap.set(c1Marker, c1Node);
                }
            } else if (endNode.control1) {
                // No outgoing direction to inherit — degernate the dangling handle
                endNode.control1.x = endNode.x;
                endNode.control1.y = endNode.y;
            }

            // Connect endNode to the chain after startNode (skipping startNode itself)
            if (startNode.nextOnCurve) {
                endNode.nextOnCurve = startNode.nextOnCurve;
                startNode.nextOnCurve.lastOnCurve = endNode;
            } else {
                endNode.nextOnCurve = null;
            }

            // Remove startNode's dangling control2 (if any) before cleaning up
            if (startNode.control2) {
                cm.domMap.delete(startNode.control2.main_node);
                sourceCurve.domMap.delete(startNode.control2.main_node);
            }
            // Remove startNode
            sourceCurve.startNode = startNode.nextOnCurve || null;
            cm.domMap.delete(startNode.main_node);
            if (startNode.control1) cm.domMap.delete(startNode.control1.main_node);
            if (startNode.control2) cm.domMap.delete(startNode.control2.main_node);

            // Migrate all remaining sourceCurve nodes to targetCurve
            let walk = endNode.nextOnCurve;
            while (walk) {
                walk.curve = targetCurve;
                if (walk === sourceCurve.endNode) break;
                walk = walk.nextOnCurve;
            }
            targetCurve.endNode = sourceCurve.endNode;
            sourceCurve.endNode = null;

            // Remove the now-empty source curve
            cm.remove_curve(sourceCurve.id);
            modifiedCurves.add(targetCurve);
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
        // Invalidate curve-level boolean caches for all modified curves so the renderer
        // does not draw stale geometry (ensureBooleanCache fast-path and _booleanPath2D).
        for (const curve of modifiedCurves) {
            curve._lastHash = null;
            curve._booleanContentHash = null;
            curve._booleanPath2D = null;
            curve._boundsCache = null;
            curve._matrixBoundsCache = null;
        }
        this.curve_manager._geometryEpoch = (this.curve_manager._geometryEpoch || 0) + 1;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("joinSelectedNodes");
        return true;
    }

    /**
     * Break path at each selected node.
     *
     * Each selected node is split in two (original + position duplicate) so the
     * chain is disconnected at that point, producing one open curve per component.
     * Closed paths become open; open paths with k selected nodes become k+1 curves.
     */
    breakPathAtSelectedNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 1) return false;

        const cm = this.curve_manager;
        const selectedIds = new Set(markers.map((m) => m?.id ?? m));
        const curves = new Set();
        for (const marker of markers) {
            const curve = cm.find_node_by_curve(marker)?.curve;
            if (curve) curves.add(curve);
        }
        let changed = false;
        /** Curves whose geometry was modified — invalidate boolean caches after the loop. */
        const modifiedCurves = new Set();

        /** Duplicate a node — new marker at the same position with the same control handles. */
        const duplicateNode = (src) => {
            const marker = generateMarker("circle");
            const dup = new CurveNode(marker, src.type, src.x, src.y, null, null, marker.id);
            dup.curve = src.curve;
            dup.control_mode = src.control_mode;
            dup.synmove_mode = src.synmove_mode;
            dup.smooth = src.smooth;
            cm.domMap.set(marker, dup);
            if (src.control1) {
                const c1m = generateMarker("circle");
                const c1 = new CurveNode(c1m, null, src.control1.x, src.control1.y, dup, null, c1m.id);
                c1.curve = dup.curve;
                cm.domMap.set(c1m, c1);
                dup.control1 = c1;
            }
            if (src.control2) {
                const c2m = generateMarker("circle");
                const c2 = new CurveNode(c2m, null, src.control2.x, src.control2.y, dup, null, c2m.id);
                c2.curve = dup.curve;
                cm.domMap.set(c2m, c2);
                dup.control2 = c2;
            }
            return dup;
        };

        for (const curve of curves) {
            const copyCurveProperties = (target) => {
                target.closed = false;
                target.stroke_width = curve.stroke_width;
                target.smart_stroke = curve.smart_stroke;
                target.smart_stroke_clockwise = curve.smart_stroke_clockwise;
                target.visible = curve.visible !== false;
                target.locked = curve.locked === true;
            };

            // 1. Collect nodes in chain order
            const nodes = [];
            let n = curve.startNode;
            while (n) {
                nodes.push(n);
                if (n === curve.endNode) break;
                n = n.nextOnCurve;
            }
            if (nodes.length === 0) continue;

            // 2. Find break indices (selected nodes)
            const breakIndices = [];
            for (let i = 0; i < nodes.length; i++) {
                if (selectedIds.has(nodes[i].main_node?.id ?? nodes[i].main_node)) {
                    breakIndices.push(i);
                }
            }
            if (breakIndices.length === 0) continue;

            const groupId = curve.groupId;
            const isClosed = curve.closed;
            const originalStartNode = curve.startNode;

            // 3. For closed curves: rotate the node list so a break point becomes index 0.
            //    This lets us process the ring as an open chain with consistent split logic.
            let orderedNodes = nodes;
            if (isClosed) {
                const pivot = breakIndices[0];
                orderedNodes = nodes.slice(pivot).concat(nodes.slice(0, pivot));
                // Recompute break indices for the rotated list
                breakIndices.length = 0;
                for (let i = 0; i < orderedNodes.length; i++) {
                    if (selectedIds.has(orderedNodes[i].main_node?.id ?? orderedNodes[i].main_node)) {
                        breakIndices.push(i);
                    }
                }
                // For a closed curve, every node is a break point — bail out
                // (each node becomes its own single-node curve, which behaves identically
                //  to deleting all segments; that is a user education concern, not a bug).
            }

            // 4. Create duplicates for each break point.
            //    The original break node becomes the END of its left component.
            //    The duplicate becomes the START of the right component.
            const brkDup = new Map(); // index → duplicate node
            for (const bi of breakIndices) {
                if (bi >= orderedNodes.length) continue;
                brkDup.set(bi, duplicateNode(orderedNodes[bi]));
            }

            // 5. Re-link: break the chain at each break point.
            for (const bi of breakIndices) {
                if (bi >= orderedNodes.length) continue;
                const orig = orderedNodes[bi];

                // Disconnect the original node's outgoing link (it becomes an endpoint).
                orig.nextOnCurve = null;

                if (brkDup.has(bi)) {
                    const dup = brkDup.get(bi);
                    if (bi + 1 < orderedNodes.length) {
                        const nextOrig = orderedNodes[bi + 1];
                        dup.nextOnCurve = nextOrig;
                        nextOrig.lastOnCurve = dup;
                    } else {
                        // Last break point in a closed chain: wrap around
                        // The duplicate connects to the first node (orderedNodes[0])
                        dup.nextOnCurve = orderedNodes[0];
                        orderedNodes[0].lastOnCurve = dup;
                    }

                    // Reset last_touched so overlapping break nodes have equal priority
                    // in hit testing. Otherwise the original (pre-break selection) always
                    // wins, making the duplicate unreachable through body-click.
                    orig.last_touched = 0;

                    // Clean up endpoint handles:
                    // orig (now an endpoint) loses its outgoing handle (control1);
                    // dup (now a startpoint) loses its incoming handle (control2).
                    // Note: control_mode is NOT changed here — the nodes keep their
                    // original mode so they render as circles (not endpoint diamonds),
                    // because the split creates two overlapping circle nodes whose
                    // combined handles (control1 from dup + control2 from orig) are
                    // both visible and represent the full original pair of handles.
                    if (orig.control1) {
                        curve.domMap.delete(orig.control1.main_node);
                        cm.domMap.delete(orig.control1.main_node);
                        orig.control1 = null;
                    }
                    if (dup.control2) {
                        curve.domMap.delete(dup.control2.main_node);
                        cm.domMap.delete(dup.control2.main_node);
                        dup.control2 = null;
                    }
                }
            }

            // 6. Build components by walking from each start point.
            //    Start points: for the first component, use the curve's original startNode.
            //    For subsequent components, use the duplicate of each break point.
            const componentStarts = [];
            if (!isClosed) {
                componentStarts.push(originalStartNode);
            }
            for (const bi of breakIndices) {
                if (brkDup.has(bi)) {
                    componentStarts.push(brkDup.get(bi));
                }
            }

            // For closed curves, remove the original startNode if it's not a break point
            // because we rotated to start at a break. But for simplicity, let the walk
            // determine what's reachable.

            // Walk from each start point and collect reachable nodes until nextOnCurve is null.
            // Track visited nodes to avoid duplicates.
            const visited = new Set();
            const components = [];
            for (const start of componentStarts) {
                if (visited.has(start)) continue;
                const chain = [];
                let walk = start;
                while (walk && !visited.has(walk)) {
                    visited.add(walk);
                    chain.push(walk);
                    if (!walk.nextOnCurve) break;
                    walk = walk.nextOnCurve;
                }
                if (chain.length > 0) components.push(chain);
            }

            // Orphan detection: any non-break node in the original chain not reached
            // by a component walk gets its own singleton component. This protects
            // against stale nextOnCurve links from closed chains that leave nodes
            // unreachable when multiple break points split the ring.
            // Break-point nodes (orig) are always reachable as component endpoints
            // (they have nextOnCurve = null), so visited.has() filters them correctly.
            for (const node of orderedNodes) {
                if (!visited.has(node)) {
                    node.nextOnCurve = null;
                    node.lastOnCurve = null;
                    components.push([node]);
                    visited.add(node);
                }
            }

            for (let ci = 0; ci < components.length; ci++) {
                const chain = components[ci];
                if (chain.length === 0) continue;

                const target = ci === 0 ? curve : cm.create_temp_curve();
                copyCurveProperties(target);
                target.startNode = chain[0];
                target.endNode = chain[chain.length - 1];
                target.domMap.clear();

                // Fix internal chain links (break may have left stale nextOnCurve on
                // non-break nodes, e.g. when a neighbor was duplicated). Rebuild the
                // linked list from the component ordering.
                for (let i = 0; i < chain.length; i++) {
                    const current = chain[i];
                    current.lastOnCurve = i > 0 ? chain[i - 1] : null;
                    current.nextOnCurve = i + 1 < chain.length ? chain[i + 1] : null;
                    current.curve = target;
                    target.domMap.set(current.main_node, current);
                    if (current.control1) {
                        current.control1.curve = target;
                        target.domMap.set(current.control1.main_node, current.control1);
                    }
                    if (current.control2) {
                        current.control2.curve = target;
                        target.domMap.set(current.control2.main_node, current.control2);
                    }
                }
                target._invalidateBounds?.();
                if (ci > 0) cm.addPath(target, groupId);
                modifiedCurves.add(target);
            }
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
        // Invalidate curve-level boolean caches for all modified curves so the renderer
        // does not draw stale geometry (ensureBooleanCache fast-path and _booleanPath2D).
        for (const curve of modifiedCurves) {
            curve._lastHash = null;
            curve._booleanContentHash = null;
            curve._booleanPath2D = null;
            curve._boundsCache = null;
            curve._matrixBoundsCache = null;
        }
        cm._geometryEpoch = (cm._geometryEpoch || 0) + 1;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("breakPathAtSelectedNodes");
        return true;
    }

    /**
     * Command: add a new segment between pairs of end nodes, merging curves.
     * Filters markers to endpoints only, then for each pair (0,1), (2,3)...:
     * - If both are on the same curve (start+end): close the curve.
     * - If on different curves: connect endNode of first to startNode of second,
     *   merging them into a single curve with control handles preserved.
     * The last odd marker is discarded.
     */
    addSegmentBetweenEndnodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 2) return false;

        const cm = this.curve_manager;
        /** Curves whose geometry was modified — invalidate boolean caches after the loop. */
        const modifiedCurves = new Set();
        // Filter to endpoint nodes only
        const endMarkers = [];
        for (const m of markers) {
            const n = cm.find_node_by_curve(m);
            if (n && n.curve && (n === n.curve.startNode || n === n.curve.endNode)) {
                endMarkers.push(m);
            }
        }
        if (endMarkers.length < 2) return false;

        let changed = false;
        for (let i = 0; i + 1 < endMarkers.length; i += 2) {
            const m1 = endMarkers[i];
            const m2 = endMarkers[i + 1];
            const n1 = cm.find_node_by_curve(m1);
            const n2 = cm.find_node_by_curve(m2);
            if (!n1 || !n2 || !n1.curve || !n2.curve) continue;

            const c1 = n1.curve;
            const c2 = n2.curve;

            // Same curve: close if start+end
            if (c1 === c2) {
                if ((n1 === c1.startNode && n2 === c1.endNode) ||
                    (n2 === c1.startNode && n1 === c1.endNode)) {
                    c1.closed = true;
                    modifiedCurves.add(c1);
                    changed = true;
                }
                continue;
            }

            // Different curves: validate both curves are in the same glyph before connecting.
            if (c1.groupId !== c2.groupId) {
                console.warn("[AddSegment] All selected endpoint nodes must belong to curves in the same Group.");
                continue;
            }

            // Different curves: find endNode and startNode to connect.
            let endNode = (n1 === c1.endNode) ? n1 : (n2 === c2.endNode ? n2 : null);
            let startNode = (n2 === c2.startNode) ? n2 : (n1 === c1.startNode ? n1 : null);

            // Fallback: both endpoints are the same type (both endNodes or both startNodes).
            // Reverse one curve's chain so the pairing works.
            // Uses Curve.reverseSkeletonDirection() which correctly swaps per-node
            // control handles — a simple linked-list reversal would corrupt the Bezier segments.
            if (!endNode || !startNode) {
                if (n1 === c1.endNode && n2 === c2.endNode) {
                    c2.reverseSkeletonDirection();
                    startNode = n2;  // n2 is now c2.startNode
                    endNode = n1;
                } else if (n1 === c1.startNode && n2 === c2.startNode) {
                    c1.reverseSkeletonDirection();
                    endNode = n1;  // n1 is now c1.endNode
                    startNode = n2;
                } else {
                    continue;
                }
            }
            if (endNode.curve === startNode.curve) continue;

            // Connect endNode.nextOnCurve = startNode
            endNode.nextOnCurve = startNode;
            startNode.lastOnCurve = endNode;

            // Two cases for chain flow direction:
            //   Case A: endNode is on c1 → flow is c1(endNode) → c2(startNode)
            //     Combined chain: c1.startNode...endNode→startNode...c2.endNode
            //     c1 absorbs c2 (tail). Migrate c2's nodes from startNode onward.
            //     c1.startNode stays, c1.endNode = c2.endNode.
            //
            //   Case B: endNode is on c2 → flow is c2(endNode) → c1(startNode)
            //     Combined chain: c2.startNode...endNode→startNode...c1.endNode
            //     c1 absorbs c2 (head). Migrate c2's nodes from c2.startNode.
            //     c1.startNode = c2.startNode, c1.endNode stays unchanged.

            if (endNode.curve === c1) {
                // Case A: c2's chain (from startNode onward) gets absorbed into c1
                let walk = startNode;
                while (walk) {
                    walk.curve = c1;
                    if (walk === c2.endNode) break;
                    walk = walk.nextOnCurve;
                }
                c1.endNode = c2.endNode;
            } else {
                // Case B: c2's chain (from c2.startNode to endNode) gets absorbed into c1
                let walk = c2.startNode;
                while (walk) {
                    walk.curve = c1;
                    if (walk === c2.endNode) break;
                    walk = walk.nextOnCurve;
                }
                c1.startNode = c2.startNode;
                // c1.endNode stays unchanged (original end of c1's chain)
            }

            c2.endNode = null;
            cm.remove_curve(c2.id);
            modifiedCurves.add(c1);
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
        // Invalidate curve-level boolean caches for all modified curves so the renderer
        // does not draw stale geometry (ensureBooleanCache fast-path and _booleanPath2D).
        for (const curve of modifiedCurves) {
            curve._lastHash = null;
            curve._booleanContentHash = null;
            curve._booleanPath2D = null;
            curve._boundsCache = null;
            curve._matrixBoundsCache = null;
        }
        cm._geometryEpoch = (cm._geometryEpoch || 0) + 1;
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("addSegmentBetweenEndnodes");
        return true;
    }

    /**
     * Command: delete the segment between each selected pair of adjacent nodes.
     *
     * Instead of pairing markers by their index in the selection list (which
     * depends on selection order), this walks each curve's chain to find
     * consecutive selected node pairs in chain order. This guarantees that
     * selecting 3 consecutive nodes always deletes both connecting segments
     * regardless of selection order.
     *
     * Deletes only the Bezier segment between the pair — never removes nodes.
     * If the segment is at path boundaries, the path is truncated and the
     * orphaned node is extracted into its own single-node curve so it remains
     * visible and selectable. For closed paths, the segment removal opens the path.
     * For internal segments, the path is split into two curves.
     */
    deleteSegmentBetweenNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 2) return false;

        const cm = this.curve_manager;
        let changed = false;
        /** Curves whose geometry was modified — invalidate boolean caches after the loop. */
        const modifiedCurves = new Set();

        // Helper: extract an orphan node into its own single-node curve so it
        // remains visible, selectable, and its properties are preserved exactly.
        const adoptOrphan = (node, groupId) => {
            if (!node) return;
            const orphanCurve = cm.create_temp_curve();
            orphanCurve.closed = false;
            orphanCurve.startNode = node;
            orphanCurve.endNode = node;
            node.nextOnCurve = null;
            node.lastOnCurve = null;
            node.curve = orphanCurve;
            cm.addPath(orphanCurve, groupId);
        };

        // Build a Set of selected marker objects for fast lookup
        const selectedMarkers = new Set(markers);

        // Collect adjacent pairs by walking each curve's chain in order.
        // This is order-independent: marker list order doesn't matter,
        // only chain adjacency determines which segments to delete.
        const curvesSeen = new Set();
        const pairs = []; // { leadNode, trailNode }

        for (const m of markers) {
            const seed = cm.find_node_by_curve(m);
            if (!seed || !seed.curve || curvesSeen.has(seed.curve)) continue;
            curvesSeen.add(seed.curve);

            const curve = seed.curve;

            // Collect all nodes in chain order
            const chainNodes = [];
            let n = curve.startNode;
            while (n) {
                chainNodes.push(n);
                if (!curve.closed && n === curve.endNode) break;
                if (curve.closed && n.nextOnCurve === curve.startNode) break;
                n = n.nextOnCurve;
            }

            // Find consecutive selected pairs — uses chain order, not selection order
            for (let i = 0; i < chainNodes.length; i++) {
                const curr = chainNodes[i];
                const next = chainNodes[(i + 1) % chainNodes.length];
                // Only check if curr has a forward link to next
                if (curr.nextOnCurve !== next) continue;
                if (!selectedMarkers.has(curr.main_node) || !selectedMarkers.has(next.main_node)) continue;
                pairs.push({ leadNode: curr, trailNode: next });
                if (!curve.closed && curr === curve.endNode) break;
            }
        }

        // Process each pair. Use leadNode.curve at processing time so that
        // nodes reassigned by a previous Case-4 split are on the correct curve.
        for (const { leadNode, trailNode } of pairs) {
            const curve = leadNode.curve;
            if (!curve || leadNode.curve !== trailNode.curve) continue;
            // Verify the forward adjacency still holds (curve may have been
            // modified by a prior pair's head/tail truncation or split).
            if (leadNode.nextOnCurve !== trailNode) continue;

            // Case 1: Closed path — open it by disconnecting the segment.
            // leadNode is orphaned — extracted as its own curve.
            if (curve.closed) {
                // Walk from trailNode forward to find where it wraps around to leadNode
                let walk = trailNode;
                while (walk.nextOnCurve && walk.nextOnCurve !== leadNode) {
                    walk = walk.nextOnCurve;
                }
                if (walk.nextOnCurve === leadNode) {
                    walk.nextOnCurve = null;
                }
                leadNode.lastOnCurve = null;
                leadNode.nextOnCurve = null;
                trailNode.lastOnCurve = null;
                curve.startNode = trailNode;
                curve.endNode = walk;
                curve.closed = false;
                adoptOrphan(leadNode, curve.groupId);
                modifiedCurves.add(curve);
                changed = true;
                continue;
            }

            // Case 2: leadNode is startNode — truncate from the start.
            // leadNode (old startNode) becomes orphaned.
            if (leadNode === curve.startNode) {
                trailNode.lastOnCurve = null;
                leadNode.nextOnCurve = null;
                curve.startNode = trailNode;
                adoptOrphan(leadNode, curve.groupId);
                modifiedCurves.add(curve);
                changed = true;
                continue;
            }

            // Case 3: trailNode is endNode — truncate from the tail.
            // trailNode (old endNode) becomes orphaned.
            if (trailNode === curve.endNode) {
                leadNode.nextOnCurve = null;
                trailNode.lastOnCurve = null;
                curve.endNode = leadNode;
                adoptOrphan(trailNode, curve.groupId);
                modifiedCurves.add(curve);
                changed = true;
                continue;
            }

            // Case 4: Internal segment — split the path into two curves.
            // leadNode becomes endNode of the left curve (original).
            // trailNode becomes startNode of the right curve (new).
            // Both remain in their active chains — no orphan.
            const originalEndNode = curve.endNode;

            const rightCurve = cm.create_temp_curve();
            rightCurve.closed = false;
            rightCurve.stroke_width = curve.stroke_width;
            rightCurve.smart_stroke = curve.smart_stroke;
            rightCurve.smart_stroke_clockwise = curve.smart_stroke_clockwise;

            leadNode.nextOnCurve = null;
            curve.endNode = leadNode;
            trailNode.lastOnCurve = null;

            let walk = trailNode;
            while (walk) {
                walk.curve = rightCurve;
                if (walk === originalEndNode) break;
                walk = walk.nextOnCurve;
            }
            rightCurve.startNode = trailNode;
            rightCurve.endNode = originalEndNode;

            cm.addPath(rightCurve, curve.groupId);
            modifiedCurves.add(curve);
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
        // Invalidate curve-level boolean caches for all modified curves so the renderer
        // does not draw stale geometry (ensureBooleanCache fast-path and _booleanPath2D).
        for (const curve of modifiedCurves) {
            curve._lastHash = null;
            curve._booleanContentHash = null;
            curve._booleanPath2D = null;
            curve._boundsCache = null;
            curve._matrixBoundsCache = null;
        }
        cm._geometryEpoch = (cm._geometryEpoch || 0) + 1;
        cm.notifyModelUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("deleteSegmentBetweenNodes");
        return true;
    }

    // =========================================================================
    // Boolean operations (batch)
    // =========================================================================

    /**
     * Validates that all selected tree items are curves in the same group.
     * @returns {{ validCurves: Curve[], groupId: string|null }|null}
     */
    _resolveBooleanTargets() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return null;

        let firstGroupId = null;
        const validCurves = [];
        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') {
                console.warn("[Boolean] Please select ONLY basic paths.");
                return null;
            }
            const curve = cm.curveById.get(item.curveId);
            if (!curve) continue;
            if (firstGroupId === null) {
                firstGroupId = curve.groupId;
            } else if (curve.groupId !== firstGroupId) {
                console.warn("[Boolean] All selected paths must belong to the same Group.");
                return null;
            }
            validCurves.push(curve);
        }
        if (validCurves.length === 0) return null;
        return { validCurves, groupId: firstGroupId };
    }

    /**
     * Command: boolean intersection of selected paths.
     */
    booleanIntersectionSelectedCurves() {
        const targets = this._resolveBooleanTargets();
        if (!targets) return false;
        const changed = this.curve_manager.executeBooleanIntersection(targets.validCurves, targets.groupId);
        if (!changed) return false;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: boolean difference of selected paths (bottom minus top).
     * The bottom-most path (first in tree order) is the base; all others are subtracted from it.
     */
    booleanDifferenceSelectedCurves() {
        const targets = this._resolveBooleanTargets();
        if (!targets) return false;
        const changed = this.curve_manager.executeBooleanDifference(targets.validCurves, targets.groupId);
        if (!changed) return false;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: boolean exclusion (xor) of selected paths.
     */
    booleanExclusionSelectedCurves() {
        const targets = this._resolveBooleanTargets();
        if (!targets) return false;
        const changed = this.curve_manager.executeBooleanExclusion(targets.validCurves, targets.groupId);
        if (!changed) return false;
        this.curve_manager.notifyTreeUpdate();
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        return true;
    }

    /**
     * Command: add extrema points to all selected curves.
     * For each cubic bezier segment, finds parameter values where dx/dt=0 or dy/dt=0
     * (horizontal/vertical tangent) and inserts on-curve nodes at those positions.
     *
     * Strategy: collect all extrema per segment, then use insertNodeAt in
     * reverse segment order (high t first) to avoid parameter-space shift.
     */    addExtrema() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        const CLOSE_THRESHOLD = 0.005;
        let changed = false;

        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve || !curve.startNode) continue;

            const segments = curve.getSkeletonBezierSegments();
            if (segments.length === 0) continue;

            for (let si = 0; si < segments.length; si++) {
                const seg = segments[si];
                const { p0, p1, p2, p3 } = seg;

                // Derivative of cubic bezier B'(t)/3: at^2 + bt + c
                const ax = -p0.x + 3*p1.x - 3*p2.x + p3.x;
                const bx =  2*p0.x - 4*p1.x + 2*p2.x;
                const cx =  p1.x - p0.x;
                const ay = -p0.y + 3*p1.y - 3*p2.y + p3.y;
                const by =  2*p0.y - 4*p1.y + 2*p2.y;
                const cy =  p1.y - p0.y;

                const ts = new Set();
                _solveQuadratic(ax, bx, cx, ts);
                _solveQuadratic(ay, by, cy, ts);
                const extrema = [...ts]
                    .filter(t => t > 0 && t < 1)
                    .sort((a, b) => a - b);

                if (extrema.length === 0) continue;

                // Warn about extrema very close to endpoints
                for (const t of extrema) {
                    if (t < CLOSE_THRESHOLD || t > 1 - CLOSE_THRESHOLD) {
                        console.warn(
                            `[Add Extrema] Extremum at t=${t.toFixed(4)} is very close to ` +
                            `${t < 0.5 ? 'start' : 'end'} of segment ${si}. Inserting anyway.`
                        );
                    }
                }

                // Insert from highest t to lowest. Each insertNodeAt splits
                // the segment at seg.node, so the next call operates on the
                // sub-segment [0, prevT]. Local t = tOrig / prevT.
                // Always pass seg.node — insertNodeAt updates its control1
                // for the sub-curve, keeping subsequent splits correct.
                let prevT = 1;
                for (let i = extrema.length - 1; i >= 0; i--) {
                    const tOrig = extrema[i];
                    const tLocal = tOrig / prevT;
                    const result = curve.insertNodeAt(seg.node, tLocal, cm);
                    if (result) changed = true;
                    prevT = tOrig;
                }
            }
        }

        if (changed) {
            cm.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            cm.rebuildSpatialGrid();
            canvas.renderer?.invalidateStableSceneCache?.();
            this._commitHistory("addExtrema");
        }
        return changed;
    }

    /**
     * Command: simplify path by removing redundant nodes.
     * For each selected curve, removes on-curve nodes that are nearly collinear
     * with their neighbors and lie close to the line between them.
     * Tolerance is adaptive: 0.5% of the curve's bounding box diagonal.
     */
    simplifyPath() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let changed = false;
        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve || !curve.startNode) continue;

            const vertices = curve.getSkeletonVertices();
            if (vertices.length < 3) continue;

            // Compute bounding box for adaptive tolerance
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const v of vertices) {
                if (v.x < minX) minX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.x > maxX) maxX = v.x;
                if (v.y > maxY) maxY = v.y;
            }
            const diag = Math.hypot(maxX - minX, maxY - minY);
            const tolerance = Math.max(0.5, diag * 0.005);

            // Multi-pass removal: each pass may expose new redundancies
            for (let pass = 0; pass < 10; pass++) {
                const verts = curve.getSkeletonVertices();
                if (verts.length < 3) break;

                let removedInPass = false;
                const candidates = [];
                if (curve.closed) {
                    for (let i = 0; i < verts.length; i++) {
                        const prev = verts[(i - 1 + verts.length) % verts.length];
                        const curr = verts[i];
                        const next = verts[(i + 1) % verts.length];
                        if (_isRedundant(prev, curr, next, tolerance)) candidates.push(curr);
                    }
                } else {
                    for (let i = 1; i < verts.length - 1; i++) {
                        if (_isRedundant(verts[i - 1], verts[i], verts[i + 1], tolerance))
                            candidates.push(verts[i]);
                    }
                }

                for (const node of candidates) {
                    // Verify node is still in the curve (may have been removed in this pass)
                    if (curve.getSkeletonVertices().indexOf(node) === -1) continue;
                    // remove_node_by_dom expects the marker (main_node), not the node itself
                    if (curve.remove_node_by_dom(node.main_node)) {
                        removedInPass = true;
                    }
                }
                if (!removedInPass) break;
                changed = true;
            }
        }

        if (changed) {
            cm.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            cm.rebuildSpatialGrid();
            this._commitHistory("simplifyPath");
        }
        return changed;
    }

    /**
     * Optimize Path: clean up selected paths without changing shape.
     * 1. Remove micro control handles (handle length < epsilon)
     * 2. Remove orphaned endpoint control handles (open paths)
     * 3. Merge coincident adjacent nodes
     * 4. Remove collinear redundant nodes
     */
    optimizePath() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        const HANDLE_EPSILON = 0.5;
        const COLLIN_TOL = 0.5;
        let changed = false;

        // Helper: collect on-curve nodes via nextOnCurve chain
        function collectNodes(start) {
            const nodes = [];
            let n = start;
            while (n) { nodes.push(n); n = n.nextOnCurve; }
            return nodes;
        }

        // Helper: point-to-line-segment distance
        function distToSeg(px, py, ax, ay, bx, by) {
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 1e-10) return Math.hypot(px - ax, py - ay);
            let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }

        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve || !curve.startNode) continue;

            // Pass 1: Remove micro control handles
            let node = curve.startNode;
            while (node) {
                if (node.control1 && Math.hypot(node.control1.x - node.x, node.control1.y - node.y) < HANDLE_EPSILON) {
                    node.control1 = null;
                    changed = true;
                }
                if (node.control2 && Math.hypot(node.control2.x - node.x, node.control2.y - node.y) < HANDLE_EPSILON) {
                    node.control2 = null;
                    changed = true;
                }
                node = node.nextOnCurve;
            }

            // Pass 2: Remove orphaned endpoint control handles (open paths)
            if (!curve.closed && curve.startNode !== curve.endNode) {
                if (curve.startNode.control2) {
                    curve.startNode.control2 = null;
                    changed = true;
                }
                if (curve.endNode.control1) {
                    curve.endNode.control1 = null;
                    changed = true;
                }
            }

            // Collect nodes for passes 3 and 4
            let allNodes = collectNodes(curve.startNode);

            // Pass 3: Merge coincident adjacent nodes (iterate backwards)
            for (let i = allNodes.length - 1; i >= 1; i--) {
                const a = allNodes[i - 1], b = allNodes[i];
                if (Math.hypot(a.x - b.x, a.y - b.y) < COLLIN_TOL) {
                    if (curve.remove_node_by_dom(b.main_node)) {
                        allNodes.splice(i, 1);
                        changed = true;
                    }
                }
            }

            // Pass 4: Remove collinear redundant nodes (iterate backwards)
            // Skip endpoints for open paths
            const start = curve.closed ? 0 : 1;
            const end = curve.closed ? allNodes.length : allNodes.length - 1;
            for (let i = end - 1; i >= start; i--) {
                if (allNodes.length <= 2) break;
                const prev = allNodes[i - 1] || allNodes[allNodes.length - 1];
                const curr = allNodes[i];
                const next = allNodes[i + 1] || allNodes[0];
                if (!prev || !next) continue;
                const d = distToSeg(curr.x, curr.y, prev.x, prev.y, next.x, next.y);
                if (d < COLLIN_TOL) {
                    if (curve.remove_node_by_dom(curr.main_node)) {
                        allNodes.splice(i, 1);
                        changed = true;
                    }
                }
            }
        }

        if (changed) {
            cm.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            cm.rebuildSpatialGrid();
            this._commitHistory("optimizePath");
        }
        return changed;
    }

    /**
     * Round Node Coordinates: round all selected path node coordinates to integers.
     */
    roundNodes() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let changed = false;

        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve || !curve.startNode) continue;

            let node = curve.startNode;
            while (node) {
                const rx = Math.round(node.x);
                const ry = Math.round(node.y);
                if (rx !== node.x || ry !== node.y) {
                    node.x = rx;
                    node.y = ry;
                    changed = true;
                }
                if (node.control1) {
                    const cx = Math.round(node.control1.x);
                    const cy = Math.round(node.control1.y);
                    if (cx !== node.control1.x || cy !== node.control1.y) {
                        node.control1.x = cx;
                        node.control1.y = cy;
                        changed = true;
                    }
                }
                if (node.control2) {
                    const cx = Math.round(node.control2.x);
                    const cy = Math.round(node.control2.y);
                    if (cx !== node.control2.x || cy !== node.control2.y) {
                        node.control2.x = cx;
                        node.control2.y = cy;
                        changed = true;
                    }
                }
                node = node.nextOnCurve;
            }
        }
        if (changed) {
            cm.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            cm.rebuildSpatialGrid();
            this._commitHistory("roundNodes");
        }
        return changed;
    }

    /**
     * Smooth Curves: adjust handle lengths at each joint to achieve C2
     * (curvature) continuity. Node positions and handle directions are
     * unchanged — only the magnitude of each handle is adjusted.
     *
     * At a joint where two cubic Bezier segments meet (C1 already satisfied),
     * C2 requires:  |h_in| / |h_out| = sin(out_angle) / sin(in_angle)
     * where h_in is the incoming handle and h_out is the outgoing handle.
     */
    smoothCurves() {
        const cm = this.curve_manager;
        const canvas = commandCanvas(this);
        const selectedIds = selectedTreeIdsFromStore(canvas);
        if (selectedIds.length === 0) return false;

        let changed = false;
        const ITERATIONS = 3;

        for (const id of selectedIds) {
            const item = cm.treeItems.get(id);
            if (!item || item.type !== 'curve') continue;
            const curve = cm.curveById.get(item.curveId);
            if (!curve || !curve.startNode) continue;

            // Collect all nodes in order
            const nodes = [];
            const seen = new Set();
            let cur = curve.startNode;
            while (cur && !seen.has(cur.main_node)) {
                seen.add(cur.main_node);
                nodes.push(cur);
                cur = cur.nextOnCurve;
            }
            if (nodes.length < 3) continue;

            const isClosed = curve.closed;
            const count = nodes.length;

            for (let iter = 0; iter < ITERATIONS; iter++) {
                for (let i = 0; i < count; i++) {
                    const n = nodes[i];

                    // Determine predecessor and successor (with wrapping)
                    let prevIdx, nextIdx;
                    if (isClosed) {
                        prevIdx = (i - 1 + count) % count;
                        nextIdx = (i + 1) % count;
                    } else {
                        // Open path: skip endpoints (only one handle)
                        if (i === 0 || i === count - 1) continue;
                        prevIdx = i - 1;
                        nextIdx = i + 1;
                    }

                    const prev = nodes[prevIdx];
                    const next = nodes[nextIdx];

                    // Current handle lengths
                    const hIn  = n.control2 ? Math.hypot(n.control2.x - n.x, n.control2.y - n.y) : 0;
                    const hOut = n.control1 ? Math.hypot(n.control1.x - n.x, n.control1.y - n.y) : 0;

                    if (hIn < 0.01 || hOut < 0.01) continue;

                    // Vectors: from prev to n, from n to next
                    const dxIn  = n.x - prev.x;
                    const dyIn  = n.y - prev.y;
                    const dxOut = next.x - n.x;
                    const dyOut = next.y - n.y;

                    // Handle direction vectors (unit)
                    const hInDx  = (n.control2.x - n.x) / hIn;
                    const hInDy  = (n.control2.y - n.y) / hIn;
                    const hOutDx = (n.control1.x - n.x) / hOut;
                    const hOutDy = (n.control1.y - n.y) / hOut;

                    // Angle between handle and chord
                    const sinIn  = Math.abs(dxIn  * hInDy  - dyIn  * hInDx);
                    const sinOut = Math.abs(dxOut * hOutDy - dyOut * hOutDx);

                    // If either sin is near zero, handle is parallel to chord — skip
                    if (sinIn < 1e-6 || sinOut < 1e-6) continue;

                    // C2 target ratio: |h_in| / |h_out| = sinOut / sinIn
                    const targetRatio = sinOut / sinIn;

                    // New lengths (preserve total length, adjust ratio)
                    const total = hIn + hOut;
                    const newHOut = total * targetRatio / (1 + targetRatio);
                    const newHIn  = total / (1 + targetRatio);

                    // Apply new lengths, keep directions
                    if (n.control1) {
                        n.control1.x = n.x + hOutDx * newHOut;
                        n.control1.y = n.y + hOutDy * newHOut;
                    }
                    if (n.control2) {
                        n.control2.x = n.x + hInDx * newHIn;
                        n.control2.y = n.y + hInDy * newHIn;
                    }

                    changed = true;
                }
            }
        }

        if (changed) {
            cm.notifyModelUpdate();
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
            cm.rebuildSpatialGrid();
            this._commitHistory("smoothCurves");
        }
        return changed;
    }
}
