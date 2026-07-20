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
            id: g.id, x: g.x, y: g.y, angle: g.angle
        }));
    }
    if (snapshotObj.editor_guideline_lock !== undefined) {
        canvas.guideline_lock = !!snapshotObj.editor_guideline_lock;
    }
}

function fontSettingsFromSnapshot(snapshot = {}, fallback = {}) {
    return {
        family: snapshotString(snapshot, "family_name", fallback.family, "InkShader Default Font"),
        style: snapshotString(snapshot, "font_style", fallback.style, "Regular"),
        postscript_name: snapshotString(snapshot, "postscript_name", fallback.postscript_name),
        preferred_family: snapshotString(snapshot, "preferred_family", fallback.preferred_family),
        preferred_subfamily: snapshotString(snapshot, "preferred_subfamily", fallback.preferred_subfamily),
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
            this.is_dirty = true;
            this.curve_manager.rebuildSpatialGrid();
            this._commitHistory("changeControlNodePosition");
        }
        return success;
    }

    deleteControlNode(marker) {
        let success = this.curve_manager.deleteControlNode(marker);
        if (success) {
            this.notifyPropertiesUpdate();
            this.is_dirty = true;
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
        this.is_dirty = true;
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
            smart_stroke: this.drawToolSettings.smart_expand,
            show_skeleton: this.drawToolSettings.show_skeleton
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
        const allowed = ['stroke_width', 'closed', 'smart_expand', 'show_skeleton'];
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
        const allowed = ['stroke_width', 'closed', 'smart_expand', 'show_skeleton'];
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
            curve.updateBooleanCache();

            if (!Array.isArray(curve.cached_boolean_geometry) || curve.cached_boolean_geometry.length === 0) {
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
                    changed = true;
                }
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
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
        this.notifyPropertiesUpdate();
        this.is_dirty = true;
        this.curve_manager.rebuildSpatialGrid();
        this._commitHistory("joinSelectedNodes");
        return true;
    }

    /**
     * Disconnect every segment whose two endpoint nodes are selected.
     *
     * Segment membership is snapshotted before mutation. Repeatedly splitting the live
     * chain makes every other selected node become an endpoint and skips it, which was
     * the source of the "alternating segments" bug for contiguous selections.
     */
    breakPathAtSelectedNodes() {
        const markers = resolveMarkersFromCanvas(commandCanvas(this));
        if (markers.length < 2) return false;

        const cm = this.curve_manager;
        const selectedIds = new Set(markers.map((m) => m?.id ?? m));
        const curves = new Set();
        for (const marker of markers) {
            const curve = cm.find_node_by_curve(marker)?.curve;
            if (curve) curves.add(curve);
        }
        let changed = false;

        for (const curve of curves) {
            const nodes = [];
            let node = curve.startNode;
            while (node) {
                nodes.push(node);
                if (node === curve.endNode) break;
                node = node.nextOnCurve;
            }
            if (nodes.length < 2) continue;

            // Edge i connects nodes[i] to nodes[(i + 1) % count].
            const edgeCount = curve.closed ? nodes.length : nodes.length - 1;
            const cuts = new Set();
            for (let i = 0; i < edgeCount; i++) {
                const from = nodes[i];
                const to = nodes[(i + 1) % nodes.length];
                if (
                    selectedIds.has(from.main_node?.id ?? from.main_node) &&
                    selectedIds.has(to.main_node?.id ?? to.main_node)
                ) {
                    cuts.add(i);
                }
            }
            if (cuts.size === 0) continue;

            // Handles pointing into a removed segment no longer have geometry to control.
            for (const edgeIndex of cuts) {
                const from = nodes[edgeIndex];
                const to = nodes[(edgeIndex + 1) % nodes.length];
                if (from.control1) {
                    cm.domMap.delete(from.control1.main_node);
                    curve.domMap.delete(from.control1.main_node);
                    from.control1 = null;
                }
                if (to.control2) {
                    cm.domMap.delete(to.control2.main_node);
                    curve.domMap.delete(to.control2.main_node);
                    to.control2 = null;
                }
            }

            // Build connected components from the immutable edge snapshot.
            const components = [];
            if (curve.closed) {
                const firstCut = cuts.values().next().value;
                let component = [];
                for (let step = 0; step < nodes.length; step++) {
                    const index = (firstCut + 1 + step) % nodes.length;
                    component.push(nodes[index]);
                    if (cuts.has(index)) {
                        components.push(component);
                        component = [];
                    }
                }
            } else {
                let component = [nodes[0]];
                for (let i = 0; i < nodes.length - 1; i++) {
                    if (cuts.has(i)) {
                        components.push(component);
                        component = [];
                    }
                    component.push(nodes[i + 1]);
                }
                components.push(component);
            }

            const groupId = curve.groupId;
            const copyCurveProperties = (target) => {
                target.closed = false;
                target.stroke_width = curve.stroke_width;
                target.smart_stroke = curve.smart_stroke;
                target.smart_stroke_clockwise = curve.smart_stroke_clockwise;
                target.show_skeleton = curve.show_skeleton;
                target.visible = curve.visible !== false;
                target.locked = curve.locked === true;
            };
            curve.domMap.clear();

            for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
                const component = components[componentIndex];
                if (component.length === 0) continue;
                const target = componentIndex === 0 ? curve : cm.create_temp_curve();
                copyCurveProperties(target);
                target.startNode = component[0];
                target.endNode = component[component.length - 1];
                target.domMap.clear();

                for (let i = 0; i < component.length; i++) {
                    const current = component[i];
                    current.lastOnCurve = i > 0 ? component[i - 1] : null;
                    current.nextOnCurve = i + 1 < component.length ? component[i + 1] : null;
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
                if (componentIndex > 0) cm.addPath(target, groupId);
            }
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
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
                    changed = true;
                }
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
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
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
            rightCurve.show_skeleton = curve.show_skeleton;

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
            changed = true;
        }

        if (!changed) return false;
        // Stale markers remain in Store selection after runtime mutations; clear them.
        commitInteractionFromCommand(this, {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: { strategy: "clear" }
        });
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
}
