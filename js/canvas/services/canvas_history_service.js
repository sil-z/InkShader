import { StorageUtils } from "../../services/storage.js";
import { isDesktop } from "../../app/app_mode.js";
import { interactionMetaFromCanvas } from "../../app/editor_history_state.js";
import { mergeInteractionFromStoreState, resolveActiveCanvasTool } from "../../app/editor_interaction_state.js";
import { SnapshotPatchExecutor, snapshotDeepClone } from "../../domain/history/snapshot_patch_executor.js";
import {
    applySnapshotPatchesToRuntime,
    fontSettingsFromSnapshot,
    syncRuntimeFromSnapshotObject,
    syncTreeHierarchyFromSnapshot
} from "../../domain/history/snapshot_runtime_applier.js";
import { EDITOR_ACTIONS } from "../../domain/actions/editor_actions.js";
import {
    expectsDocumentPatches,
    isMetaOnlyHistoryCommand
} from "../../app/history_patch_policy.js";
import { reportFatalError, showErrorDialog } from "../../services/error_log.js";

export class CanvasHistoryService {
    constructor(canvas) {
        this.canvas = canvas;
        this._patchExecutor = new SnapshotPatchExecutor(() => ({
            max_command_patch_count: canvas.max_command_patch_count,
            max_granular_array_length: canvas.max_granular_array_length,
            max_granular_object_keys: canvas.max_granular_object_keys,
            coarse_patch_paths: canvas.coarse_patch_paths,
            granular_patch_paths: canvas.granular_patch_paths
        }));
    }

    /** @private */ _debugCommand() {}

    _deepClone(value) {
        return snapshotDeepClone(value);
    }

    /**
     * Shallow-clone sessionImages preserving HTML Image element references.
     * _deepClone destroys them (structuredClone throws on DOM elements,
     * JSON.parse(JSON.stringify) yields {}), causing ctx.drawImage to throw
     * and the render loop to die (canvas "freeze").
     */
    _cloneSessionImages(sessionImages) {
        if (!Array.isArray(sessionImages)) return [];
        return sessionImages.map((item) => {
            if (!item || typeof item !== "object") return item;
            return { ...item };
        });
    }

    _normalizeHistoryPayload(value, seen = new WeakMap(), refs = { count: 0 }) {
        if (value === null || value === undefined) return value;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
        if (typeof value === "function") return undefined;
        if (typeof value !== "object") return value;

        if (typeof DOMMatrix !== "undefined" && value instanceof DOMMatrix) {
            return { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f };
        }

        if (seen.has(value)) return { ref: seen.get(value) };
        refs.count += 1;
        const refId = `ref_${refs.count}`;
        seen.set(value, refId);

        if (Array.isArray(value)) {
            return value
                .map((item) => this._normalizeHistoryPayload(item, seen, refs))
                .filter((item) => item !== undefined);
        }

        if (typeof value.id === "string" && (value.nextOnCurve || value.lastOnCurve || value.curve || value.main_node)) {
            return { id: value.id };
        }

        const output = {};
        for (const [key, item] of Object.entries(value)) {
            const normalized = this._normalizeHistoryPayload(item, seen, refs);
            if (normalized !== undefined) output[key] = normalized;
        }
        return output;
    }

    _buildSnapshotPatches(beforeValue, afterValue) {
        return this._patchExecutor.buildPatches(beforeValue, afterValue);
    }

    _buildSnapshotPatchesReport(beforeValue, afterValue) {
        return this._patchExecutor.buildPatchesReport(beforeValue, afterValue);
    }

    _hasTreeHierarchyChange(beforeSnap, afterSnap) {
        if (!beforeSnap || !afterSnap) return false;
        return JSON.stringify(beforeSnap.editor_root_order || null) !== JSON.stringify(afterSnap.editor_root_order || null);
    }

    /**
     * Patch integrity warning; throws when history_strict_patch_runtime=true (dev toggle).
     */
    _reportPatchIssue(code, detail = {}, { throwIfStrict = true } = {}) {
        // History patch warning disabled
        if (throwIfStrict && this.canvas.history_strict_patch_runtime) {
            throw new Error(`[HistoryPatch] ${code}: ${JSON.stringify(detail)}`);
        }
    }

    /** Live image items as plain clones (existence-preserving capture for history apply) */
    _captureLiveSessionImages() {
        const cm = this.canvas?.curve_manager;
        if (!cm?.treeItems) return null;
        return Array.from(cm.treeItems.entries())
            .filter(([, item]) => item.type === "image")
            .map(([, item]) => ({ ...item }));
    }

    _captureRecoveryState() {
        const c = this.canvas;
        const s = c.currentStateObj;
        if (!s) return null;
        return {
            snapshotObj: this._deepClone(s.snapshotObj),
            json: s.json,
            selection: this._deepClone(s.selection),
            selectedCurveIds: this._deepClone(s.selectedCurveIds || []),
            selectedRefIds: this._deepClone(s.selectedRefIds || []),
            sessionImages: this._cloneSessionImages(s.sessionImages),
            sequenceText: s.sequenceText,
            activeIndices: this._deepClone(s.activeIndices || []),
            activeGroupId: s.activeGroupId,
            currentTool: s.currentTool
        };
    }

    /** Update currentStateObj meta slice without cloning snapshotObj (undo/redo hot path) */
    _syncUiAfterHistoryApply() {
        const c = this.canvas;
        const cm = c.curve_manager;
        if (cm && c.currentStateObj?.snapshotObj) {
            syncTreeHierarchyFromSnapshot(cm, c.currentStateObj.snapshotObj);
        }
        cm?.groupFlatCache?.clear?.();
        cm?.calculateSequenceOffsets?.();
        cm?.notifyModelUpdate?.();
        cm?.notifyTreeUpdate?.();
        c.bumpEditorStoreTreeRevision?.();
        c.is_dirty = true;
    }

    _syncCurrentStateJson() {
        const c = this.canvas;
        const snap = c.currentStateObj?.snapshotObj;
        if (snap) c.currentStateObj.json = JSON.stringify(snap);
    }

    _assignCurrentStateMeta(meta = {}) {
        const c = this.canvas;
        const prev = c.currentStateObj || {};
        c.currentStateObj = {
            snapshotObj: prev.snapshotObj,
            json: prev.json,
            selection: this._deepClone(meta.selection || { treeIds: [], nodes: [] }),
            selectedCurveIds: [...(meta.selectedCurveIds || [])],
            selectedRefIds: [...(meta.selectedRefIds || [])],
            sessionImages: this._cloneSessionImages(meta.sessionImages),
            sequenceText: meta.sequenceText ?? "",
            activeIndices: [...(meta.activeIndices || [])],
            activeGroupId: meta.activeGroupId ?? null,
            currentTool: meta.currentTool ?? prev.currentTool
        };
    }

    _canApplyPatches(snapshotObj, patches = [], direction = "undo") {
        return this._patchExecutor.canApplyPatches(snapshotObj, patches, direction);
    }

    _applySnapshotPatches(snapshotObj, patches = [], direction = "undo") {
        return this._patchExecutor.applyPatches(snapshotObj, patches, direction);
    }

    _saveRuntimeState(fast = false) {
        const c = this.canvas;
        // 桌面模式：文件即权威存储，浏览器缓存整体禁用（含自动保存落 IndexedDB）
        if (isDesktop()) return;
        if (!c.currentStateObj?.snapshotObj) return;

        // Never persist a pristine (empty, never-modified) project to cache.
        // The ProjectManager saves active-project data through saveToCache which has
        // its own pristine guard, but _saveRuntimeState is the timeout-based auto-save
        // path that fires after any history record — it calls StorageUtils.saveProject
        // directly and MUST also check pristine to prevent auto-created empty projects
        // from accumulating as garbage in IndexedDB.
        if (c.projectManager?.isProjectPristine?.()) return;

        // Use the cached JSON string (already set by getHistoryState / _syncCurrentStateJson)
        // instead of deepCloning the snapshotObj. This avoids re-serializing the entire document
        // on every auto-save — the serialization cost was already paid when the snapshot was created.
        const jsonStr = c.currentStateObj.json;
        const data = {
            latestSnapshot: jsonStr ? JSON.parse(jsonStr) : this._deepClone(c.currentStateObj.snapshotObj),
            commandStack: this._deepClone(c.commandStack || []),
            redoCommandStack: this._deepClone(c.redoCommandStack || [])
        };
        if (c.projectManager && c.projectManager.getActiveProjectName()) {
            const projectName = c.projectManager.getActiveProjectName();
            if (fast) {
                // Unload path (beforeunload): the page dies right after the handler
                // returns, so a get→put→order chain stalls before the put is issued.
                // saveProjectNow keeps the chain at a single microtask hop so the
                // transaction + put are dispatched synchronously in this task.
                StorageUtils.saveProjectNow(projectName, data)
                    .catch((e) => console.error(" [Storage] Project save (fast) failed:", e));
                // localStorage is fully synchronous — guaranteed to survive the
                // teardown even if Chrome aborts the IndexedDB transaction (larger
                // payloads don't commit in time). Recovered on next boot.
                StorageUtils.saveUnloadFallback(projectName, data);
            } else {
                StorageUtils.saveProject(projectName, data)
                    .catch((e) => console.error(" [Storage] Project save failed:", e));
            }
            // Persist the active project name to localStorage alongside the
            // IndexedDB save, so that on next page load the project is findable
            // even if it was auto-created without localStorage persistence.
            StorageUtils.saveActiveProject(projectName);
        }
        StorageUtils.save(data).catch((e) => console.error(" [Storage] Runtime state save failed:", e));
    }

    _queueRuntimeStateSave() {
        const c = this.canvas;
        clearTimeout(c._runtimeSaveTimer);
        c._runtimeSaveTimer = setTimeout(() => this._saveRuntimeState(), 120);
    }

    _flushRuntimeStateSave(fast = false) {
        const c = this.canvas;
        clearTimeout(c._runtimeSaveTimer);
        this._saveRuntimeState(fast);
    }

    _idListSame(a, b) {
        const aa = a || [];
        const bb = b || [];
        if (aa.length !== bb.length) return false;
        for (let i = 0; i < aa.length; i++) {
            if (aa[i] !== bb[i]) return false;
        }
        return true;
    }

    _isMetaSame(beforeState, afterState) {
        if (!beforeState || !afterState) return false;
        // NOTE: currentTool is deliberately excluded from the meta comparison.
        // The active tool is editor state, independent of the document history:
        // it is never recorded as a history entry itself, and it must not cause
        // (or suppress) history recording — otherwise a tool switch between two
        // file operations would produce spurious or mis-deduped entries.
        if (beforeState.sequenceText !== afterState.sequenceText) return false;
        if ((beforeState.activeGroupId || null) !== (afterState.activeGroupId || null)) return false;
        if (!this._idListSame(beforeState.selectedCurveIds, afterState.selectedCurveIds)) return false;
        if (!this._idListSame(beforeState.selectedRefIds, afterState.selectedRefIds)) return false;
        if (!this._idListSame(beforeState.activeIndices, afterState.activeIndices)) return false;
        const bs = beforeState.selection || {};
        const as = afterState.selection || {};
        if (!this._idListSame(bs.treeIds, as.treeIds)) return false;
        if (!this._idListSame(bs.nodes, as.nodes)) return false;
        return true;
    }

    /**
     * Selection / tool-only history: reuse current snapshot JSON — never call save_file.
     * Full serialize of dense glyphs is multi-second and must not run on box-select mouseup.
     */
    _recordMetaOnlyHistory(detail, commandName) {
        const c = this.canvas;
        const cm = c.curve_manager;
        const meta = interactionMetaFromCanvas(c);
        const sessionImages = Array.from(cm.treeItems.entries())
            .filter(([, item]) => item.type === "image")
            .map(([, item]) => ({ ...item }));
        const newState = {
            json: c.currentStateObj?.json ?? null,
            snapshotObj: c.currentStateObj?.snapshotObj ?? null,
            selection: meta.selection,
            selectedCurveIds: meta.selectedCurveIds,
            selectedRefIds: meta.selectedRefIds,
            sessionImages,
            sequenceText: meta.sequenceText,
            activeIndices: meta.activeIndices,
            activeGroupId: meta.activeGroupId,
            currentTool: meta.currentTool
        };
        if (c.currentStateObj && this._isMetaSame(c.currentStateObj, newState)) {
            return false;
        }

        const payload = this._normalizeHistoryPayload(
            detail?.action?.payload || detail?.payload || {}
        );
        const cloneIdList = (list) => (Array.isArray(list) ? list.slice() : []);
        const entry = {
            id: detail?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            commandName,
            payload,
            action: detail?.action ? this._deepClone(detail.action) : null,
            timestamp: detail?.timestamp || Date.now(),
            snapshotPatches: [],
            documentChanged: false,
            beforeMeta: c.currentStateObj
                ? {
                      selection: {
                          treeIds: cloneIdList(c.currentStateObj.selection?.treeIds),
                          nodes: cloneIdList(c.currentStateObj.selection?.nodes)
                      },
                      selectedCurveIds: cloneIdList(c.currentStateObj.selectedCurveIds),
                      selectedRefIds: cloneIdList(c.currentStateObj.selectedRefIds),
                      sessionImages: this._cloneSessionImages(c.currentStateObj.sessionImages),
                      sequenceText: c.currentStateObj.sequenceText,
                      activeIndices: cloneIdList(c.currentStateObj.activeIndices),
                      activeGroupId: c.currentStateObj.activeGroupId,
                      currentTool: c.currentStateObj.currentTool
                  }
                : null,
            afterMeta: {
                selection: {
                    treeIds: cloneIdList(newState.selection?.treeIds),
                    nodes: cloneIdList(newState.selection?.nodes)
                },
                selectedCurveIds: cloneIdList(newState.selectedCurveIds),
                selectedRefIds: cloneIdList(newState.selectedRefIds),
                sessionImages: this._cloneSessionImages(newState.sessionImages),
                sequenceText: newState.sequenceText,
                activeIndices: cloneIdList(newState.activeIndices),
                activeGroupId: newState.activeGroupId,
                currentTool: newState.currentTool
            }
        };

        c.commandStack.push(entry);
        if (c.commandStack.length > c.max_command_log) c.commandStack.shift();
        c.currentStateObj = newState;
        c.redoCommandStack = [];
        this._debugCommand(`recorded ${commandName} (meta-only)`, payload);
        this._queueRuntimeStateSave();
        this.saveCurrentViewState(false);
        c.syncEditorStoreHistoryStacks();
        return true;
    }

    /**
     * Compact history entry for SET_FONT_SETTINGS — no snapshot patches.
     * A UPM change rescales every coordinate in the document, so a
     * full-document diff produces multi-MB patches and multi-second undo
     * (measured on a ×500 document: 10.6MB patches / 4.2s undo). Instead,
     * store the before/after font settings; undo/redo re-execute the command
     * with the recorded settings — setFontSettings applies the inverse UPM
     * ratio to every coordinate and restores the other font fields — then
     * re-capture the snapshot baseline (scaleAllCoordinates marks every
     * glyph dirty, so the re-serialize is complete).
     */
    _recordFontSettingsHistory(detail, commandName) {
        const c = this.canvas;
        if (c.is_restoring) return false;
        const newState = this.getHistoryState(/* clearDirty= */ false);
        const beforeSnap = c.currentStateObj?.snapshotObj || {};
        const beforeFontSettings = fontSettingsFromSnapshot(beforeSnap, c.fontSettings);
        const afterFontSettings = fontSettingsFromSnapshot(newState.snapshotObj, c.fontSettings);
        const snapshotJsonChanged =
            !!c.currentStateObj?.json &&
            !!newState.json &&
            c.currentStateObj.json !== newState.json;
        if (!snapshotJsonChanged && this._isMetaSame(c.currentStateObj, newState)) {
            return false;
        }
        const payload = this._normalizeHistoryPayload(
            detail?.action?.payload || detail?.payload || {}
        );
        const entry = {
            id: detail?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            commandName,
            payload,
            action: detail?.action ? this._deepClone(detail.action) : null,
            timestamp: detail?.timestamp || Date.now(),
            snapshotPatches: [],
            documentChanged: false,
            fontSettingsEntry: true,
            beforeFontSettings,
            afterFontSettings,
            beforeMeta: c.currentStateObj
                ? {
                      selection: this._deepClone(c.currentStateObj.selection),
                      selectedCurveIds: this._deepClone(c.currentStateObj.selectedCurveIds || []),
                      selectedRefIds: this._deepClone(c.currentStateObj.selectedRefIds || []),
                      sessionImages: this._cloneSessionImages(c.currentStateObj.sessionImages),
                      sequenceText: c.currentStateObj.sequenceText,
                      activeIndices: this._deepClone(c.currentStateObj.activeIndices || []),
                      activeGroupId: c.currentStateObj.activeGroupId,
                      currentTool: c.currentStateObj.currentTool
                  }
                : null,
            afterMeta: {
                selection: this._deepClone(newState.selection),
                selectedCurveIds: this._deepClone(newState.selectedCurveIds || []),
                selectedRefIds: this._deepClone(newState.selectedRefIds || []),
                sessionImages: this._cloneSessionImages(newState.sessionImages),
                sequenceText: newState.sequenceText,
                activeIndices: this._deepClone(newState.activeIndices || []),
                activeGroupId: newState.activeGroupId,
                currentTool: newState.currentTool
            }
        };

        c.commandStack.push(entry);
        // Grid + tree sync: scaleAllCoordinates no longer rebuilds the
        // spatial grid itself (the double rebuild cost ~2.5s on dense
        // documents); notifyTreeUpdate owns it. Must run BEFORE
        // clearDirtyGlyphs — it reads the dirty set for its incremental
        // decision, and the whole document is dirty after a UPM scale, so
        // it takes the full-rebuild path.
        c.curve_manager.notifyTreeUpdate?.();
        c.curve_manager.clearDirtyGlyphs();
        if (c.commandStack.length > c.max_command_log) c.commandStack.shift();
        c.currentStateObj = newState;
        c.redoCommandStack = [];
        this._debugCommand(`recorded ${commandName} (font-settings compact)`, payload);
        this._queueRuntimeStateSave();
        this.saveCurrentViewState(false);
        c.syncEditorStoreHistoryStacks();
        return true;
    }

    _buildStateFromSnapshotAndMeta(snapshotObj, meta = {}) {
        const safeSnapshot = this._deepClone(snapshotObj || {});
        return {
            json: JSON.stringify(safeSnapshot),
            snapshotObj: safeSnapshot,
            selection: this._deepClone(meta.selection || { treeIds: [], nodes: [] }),
            selectedCurveIds: this._deepClone(meta.selectedCurveIds || []),
            selectedRefIds: this._deepClone(meta.selectedRefIds || []),
            sessionImages: this._cloneSessionImages(meta.sessionImages),
            sequenceText: meta.sequenceText || "",
            activeIndices: this._deepClone(meta.activeIndices || []),
            activeGroupId: meta.activeGroupId || null,
            currentTool: meta.currentTool || "DRAW"
        };
    }

    _sanitizeCommandEntry(entry) {
        const clean = this._patchExecutor.sanitizeCommandEntry(entry);
        if (!clean) return null;
        clean.payload = this._normalizeHistoryPayload(entry.payload || {});
        return clean;
    }

    /** @deprecated Replaced by lazy patch validation on each undo/redo — no longer needed at load time. */
    _reconcileRuntimeHistoryStacks() {
        // No-op. Patch validity is now checked lazily when the user actually triggers undo/redo.
        // The old approach replayed ALL patches on load to detect corruption early, but this was
        // O(n * snapshot_size) on every page load — unnecessary cost for a rare edge case.
    }

    async _recoverAfterHistoryFailure(previousRuntimeState, commandEntry, direction, error) {
        const c = this.canvas;
        this._debugCommand("history recovery start", {
            direction,
            command: commandEntry?.commandName || "unknown-command",
            error: String(error?.message || error)
        });

        // 历史栈故障：必须让人看见（每次都要弹，不能按会话去重），并且要能
        // 复制原文给开发者 —— 所以走可复制对话框 + error.log，而不是原生 alert。
        reportFatalError(
            "history_recovery",
            "undo/" + direction + " failed for command '" +
                (commandEntry?.commandName || "?") + "': " + (error?.message || error) +
                "\n\nHistory recovery triggered. The corrupted history entry has been removed.",
            {
                commandName: commandEntry?.commandName || null,
                direction,
                error: String(error?.message || error),
                failedEntryId: commandEntry?.id || null,
                patchPaths: (commandEntry?.snapshotPatches || []).map((p) => (p?.path || []).join("."))
            },
            { alwaysShow: true }
        );

        const brokenId = commandEntry?.id;
        if (brokenId) {
            c.commandStack = (c.commandStack || []).filter((entry) => entry?.id !== brokenId);
            c.redoCommandStack = (c.redoCommandStack || []).filter((entry) => entry?.id !== brokenId);
        }

        let recovered = false;
        if (previousRuntimeState?.snapshotObj) {
            try {
                c.currentStateObj = this._deepClone(previousRuntimeState);
                // The failed apply may already have wiped treeItems (full sync);
                // restore images from the captured pre-failure state.
                await this._applyState(c.currentStateObj, null, direction, {
                    forceFullSnapshotSync: true,
                    sessionImages: previousRuntimeState.sessionImages
                });
                recovered = true;
            } catch (recoveryError) {
                this._debugCommand("history recovery previous-state failed", {
                    error: String(recoveryError?.message || recoveryError)
                });
            }
        }

        if (!recovered) {
            reportFatalError(
                "history_recovery_fatal",
                "Primary recovery failed — falling back to current snapshot.\n" +
                    "All undo/redo history has been cleared.",
                { direction },
                { alwaysShow: true }
            );
            const fallbackState = this.getHistoryState();
            c.commandStack = [];
            c.redoCommandStack = [];
            c.currentStateObj = fallbackState;
            await this._applyState(fallbackState, null, direction, {
                forceFullSnapshotSync: true,
                sessionImages: this._captureLiveSessionImages()
            });
            this._debugCommand("history recovery fallback snapshot applied", {});
        }

        this._flushRuntimeStateSave();
    }

    saveCurrentViewState(immediate = true) {
        const c = this.canvas;
        const doSave = () => {
            const layoutState = c.env.getExternalLayoutState();
            const storeState = c.editorStore?.getState?.() || {};
            const interaction = mergeInteractionFromStoreState(storeState);
            const viewState = {
                scale: c.scale,
                zoom_ticks: c.zoomTicks,
                offset_x: c.offset.x,
                offset_y: c.offset.y,
                // Canvas view rotation in degrees (see MainCanvas.setViewRotation)
                view_rotation: c.viewRotation || 0,
                vp_width: c.viewportConfig?.viewportWidth || 0,
                vp_height: c.viewportConfig?.viewportHeight || 0,
                right_width: layoutState.rightWidth,
                tree_flex: layoutState.treeFlex,
                prop_flex: layoutState.propFlex,
                dock_layout: layoutState.dockLayout,
                // dock 布局版本号：restoreState 只恢复当前版本的布局（旧版布局
                // 被新默认取代，恢复旧布局会覆盖用户期望的新默认）
                dock_layout_version: 3,
                active_group_id: interaction.activeGroupId,
                active_sequence_indices: [...(storeState.activeSequenceIndices || [])],
                current_tool: resolveActiveCanvasTool(c),
                draw_tool_settings: c.drawToolSettings,
                ellipse_tool_settings: c.ellipseToolSettings,
                guideline_lock: c.guideline_lock,
                snap_alignment_enabled: c.snap_alignment_enabled,
                snap_coincident_enabled: c.snap_coincident_enabled,
                divider_visible: c.divider_visible,
                coord_transform_mode: c.coordTransformMode || 'global',
                selected_tree_ids: interaction.selectedTreeIds,
                sequence_text: c.curve_manager.sequenceText
            };
            StorageUtils.saveViewState(viewState).catch((e) => console.error(" [Storage] View state save failed:", e));
        };

        if (immediate) {
            clearTimeout(c._viewSaveTimer);
            doSave();
        } else {
            clearTimeout(c._viewSaveTimer);
            c._viewSaveTimer = setTimeout(doSave, 300);
        }
    }

    /**
     * Export current document snapshot when writing history entry (with exportJSON, called only from commit path, not undo/redo).
     */
    getHistoryState(clearDirty = true) {
        const c = this.canvas;
        const cm = c.curve_manager;
        const meta = interactionMetaFromCanvas(c);
        // Dirty glyph tracking: pass previous glyphs + dirty set to skip serializing unchanged glyphs
        const prevGlyphs = c.currentStateObj?.snapshotObj?.glyphs || null;
        const dirtyGlyphs = cm.getDirtyGlyphs();
        const extraState = prevGlyphs ? { prevGlyphs, dirtyGlyphs: dirtyGlyphs.size > 0 ? dirtyGlyphs : null } : {};
        const jsonStr = c.io.save_file(extraState);
        if (clearDirty) cm.clearDirtyGlyphs();
        let snapshotObj = {};
        try { snapshotObj = JSON.parse(jsonStr); } catch (_) {}
        return {
            json: jsonStr,
            snapshotObj,
            selection: meta.selection,
            selectedCurveIds: meta.selectedCurveIds,
            selectedRefIds: meta.selectedRefIds,
            sessionImages: Array.from(cm.treeItems.entries())
                .filter(([, item]) => item.type === "image")
                .map(([, item]) => ({ ...item })),
            sequenceText: meta.sequenceText,
            activeIndices: meta.activeIndices,
            activeGroupId: meta.activeGroupId,
            currentTool: meta.currentTool
        };
    }

    recordHistory(detail = {}) {
        const c = this.canvas;
        if (c.is_restoring) return false;
        const commandName =
            detail?.action?.type || detail?.commandName || "anonymous-command";
        // Selection / tool-only: never pay full-document serialize (multi-second on dense glyphs).
        if (isMetaOnlyHistoryCommand(commandName)) {
            return this._recordMetaOnlyHistory(detail, commandName);
        }
        // Font settings: compact entry — no snapshot patches. A UPM change
        // rescales every coordinate in the document, so a full-document diff
        // is multi-MB and multi-second to undo (measured: 10.6MB / 4.2s on a
        // ×500 document). undo/redo re-execute the command instead, which
        // applies the inverse UPM ratio itself.
        if (commandName === EDITOR_ACTIONS.SET_FONT_SETTINGS) {
            return this._recordFontSettingsHistory(detail, commandName);
        }
        const newState = this.getHistoryState(/* clearDirty= */ false);
        const patchReport = c.currentStateObj?.snapshotObj
            ? this._buildSnapshotPatchesReport(c.currentStateObj.snapshotObj, newState.snapshotObj)
            : { patches: [], warnings: [] };
        for (const warning of patchReport.warnings) {
            this._reportPatchIssue(warning.code, { ...warning, commandName }, { throwIfStrict: false });
        }
        let snapshotPatches = patchReport.patches;
        const treeHierarchyChanged = this._hasTreeHierarchyChange(
            c.currentStateObj?.snapshotObj,
            newState.snapshotObj
        );
        if (treeHierarchyChanged) {
            snapshotPatches = this._patchExecutor.ensureTreeHierarchyCoarsePatches(
                c.currentStateObj?.snapshotObj,
                newState.snapshotObj,
                snapshotPatches
            );
        }
        const snapshotJsonChanged =
            !!c.currentStateObj?.json &&
            !!newState.json &&
            c.currentStateObj.json !== newState.json;
        const documentChanged = treeHierarchyChanged || snapshotJsonChanged;
        const geometryHistoryExpected =
            !isMetaOnlyHistoryCommand(commandName) &&
            (documentChanged || expectsDocumentPatches(commandName));
        if (snapshotPatches.length === 0 && geometryHistoryExpected) {
            this._reportPatchIssue("HISTORY_NO_PATCHES_FOR_MODEL_CHANGE", { commandName });
            if (expectsDocumentPatches(commandName)) {
                this._reportPatchIssue("HISTORY_GEOMETRY_WITHOUT_PATCHES", { commandName });
            }
        }
        if (snapshotPatches.length === 0 && !treeHierarchyChanged && this._isMetaSame(c.currentStateObj, newState)) {
            return false;
        }

        const payload = this._normalizeHistoryPayload(
            detail?.action?.payload || detail?.payload || {}
        );
        const entry = {
            id: detail?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            commandName,
            payload,
            action: detail?.action ? this._deepClone(detail.action) : null,
            timestamp: detail?.timestamp || Date.now(),
            snapshotPatches,
            documentChanged: snapshotPatches.length > 0 || (documentChanged && !isMetaOnlyHistoryCommand(commandName)),
            beforeMeta: c.currentStateObj
                ? {
                      selection: this._deepClone(c.currentStateObj.selection),
                      selectedCurveIds: this._deepClone(c.currentStateObj.selectedCurveIds || []),
                      selectedRefIds: this._deepClone(c.currentStateObj.selectedRefIds || []),
                      sessionImages: this._cloneSessionImages(c.currentStateObj.sessionImages),
                      sequenceText: c.currentStateObj.sequenceText,
                      activeIndices: this._deepClone(c.currentStateObj.activeIndices || []),
                      activeGroupId: c.currentStateObj.activeGroupId,
                      currentTool: c.currentStateObj.currentTool
                  }
                : null,
            afterMeta: {
                selection: this._deepClone(newState.selection),
                selectedCurveIds: this._deepClone(newState.selectedCurveIds || []),
                selectedRefIds: this._deepClone(newState.selectedRefIds || []),
                sessionImages: this._cloneSessionImages(newState.sessionImages),
                sequenceText: newState.sequenceText,
                activeIndices: this._deepClone(newState.activeIndices || []),
                activeGroupId: newState.activeGroupId,
                currentTool: newState.currentTool
            }
        };

        c.commandStack.push(entry);
        c.curve_manager.clearDirtyGlyphs();
        if (c.commandStack.length > c.max_command_log) c.commandStack.shift();
        c.currentStateObj = newState;
        c.redoCommandStack = [];
        this._debugCommand(`recorded ${commandName}`, payload);
        this._queueRuntimeStateSave();
        this.saveCurrentViewState(false);
        c.syncEditorStoreHistoryStacks();
        return true;
    }

    async undo() {
        const c = this.canvas;
        if (c.commandStack.length === 0 || c.is_restoring) return;
        const previousRuntimeState = this._captureRecoveryState();
        const commandEntry = c.commandStack.pop();
        if (!commandEntry) return;

        try {
            c.redoCommandStack.push(commandEntry);
            if (commandEntry.fontSettingsEntry) {
                // Compact SET_FONT_SETTINGS undo: re-execute the command with
                // the recorded before-settings — setFontSettings applies the
                // inverse UPM ratio to every coordinate and restores the other
                // font fields — then re-capture the full snapshot baseline
                // (all glyphs are dirty after the scale, so the serialize is
                // complete). No patches are stored for this entry.
                c.commands.setFontSettings(commandEntry.beforeFontSettings || {}, {});
                c.currentStateObj = this.getHistoryState();
                this._assignCurrentStateMeta(commandEntry.beforeMeta || {});
                await this._applyState(c.currentStateObj, commandEntry, "undo");
                this._debugCommand(`undo ${commandEntry.commandName} (font-settings)`, commandEntry.payload);
                this._queueRuntimeStateSave();
                return;
            }
            const snapshotObj = c.currentStateObj?.snapshotObj;
            if (!snapshotObj) {
                throw new Error("undo: missing snapshotObj baseline");
            }
            const patches = commandEntry.snapshotPatches || [];
            if (patches.length > 0) {
                this._applySnapshotPatches(snapshotObj, patches, "undo");
                this._syncCurrentStateJson();
            } else if (
                commandEntry &&
                !isMetaOnlyHistoryCommand(commandEntry.commandName)
            ) {
                this._reportPatchIssue("HISTORY_EMPTY_PATCHES_ON_UNDO", {
                    commandName: commandEntry.commandName
                });
            }
            this._assignCurrentStateMeta(commandEntry.beforeMeta || {});
            await this._applyState(c.currentStateObj, commandEntry, "undo");
            this._debugCommand(`undo ${commandEntry.commandName}`, commandEntry.payload);
            this._queueRuntimeStateSave();
        } catch (e) {
            await this._recoverAfterHistoryFailure(previousRuntimeState, commandEntry, "undo", e);
        }
    }

    async redo() {
        const c = this.canvas;
        if (c.redoCommandStack.length === 0 || c.is_restoring) return;
        const previousRuntimeState = this._captureRecoveryState();
        const commandEntry = c.redoCommandStack.pop();
        if (!commandEntry) return;

        try {
            c.commandStack.push(commandEntry);
            if (commandEntry.fontSettingsEntry) {
                // Compact SET_FONT_SETTINGS redo: re-execute the command with
                // the recorded after-settings (inverse of the undo scale),
                // then re-capture the full snapshot baseline.
                c.commands.setFontSettings(commandEntry.afterFontSettings || {}, {});
                c.currentStateObj = this.getHistoryState();
                this._assignCurrentStateMeta(commandEntry.afterMeta || {});
                await this._applyState(c.currentStateObj, commandEntry, "redo");
                this._debugCommand(`redo ${commandEntry.commandName} (font-settings)`, commandEntry.payload);
                this._queueRuntimeStateSave();
                return;
            }
            const snapshotObj = c.currentStateObj?.snapshotObj;
            if (!snapshotObj) {
                throw new Error("redo: missing snapshotObj baseline");
            }
            const patches = commandEntry.snapshotPatches || [];
            if (patches.length > 0) {
                this._applySnapshotPatches(snapshotObj, patches, "redo");
                this._syncCurrentStateJson();
            } else if (commandEntry && !isMetaOnlyHistoryCommand(commandEntry.commandName)) {
                this._reportPatchIssue("HISTORY_EMPTY_PATCHES_ON_REDO", {
                    commandName: commandEntry.commandName
                });
            }
            this._assignCurrentStateMeta(commandEntry.afterMeta || {});
            await this._applyState(c.currentStateObj, commandEntry, "redo");
            this._debugCommand(`redo ${commandEntry.commandName}`, commandEntry.payload);
            this._queueRuntimeStateSave();
        } catch (e) {
            await this._recoverAfterHistoryFailure(previousRuntimeState, commandEntry, "redo", e);
        }
    }

    async _applyState(stateObj, commandEntry = null, direction = "undo", options = {}) {
        const c = this.canvas;
        const store = c.editorStore;
        const bodyDOM = c.env.queryDOM("body");
        if (bodyDOM) bodyDOM.style.pointerEvents = "none";
        c.is_restoring = true;
        c.__historyApplyDepth = (c.__historyApplyDepth || 0) + 1;
        // Image decoupling (no image persistence yet): undo/redo must not revert
        // image state, and a full snapshot sync (initTree wipes treeItems) must
        // not lose images. Capture the LIVE image list before applying; restore
        // it afterwards. Recovery paths pass an explicit override instead.
        const liveSessionImages = options.sessionImages !== undefined
            ? this._cloneSessionImages(options.sessionImages)
            : this._captureLiveSessionImages();
        try {
            const historyMeta =
                commandEntry && direction === "redo" ? commandEntry.afterMeta : commandEntry?.beforeMeta;
            const storeAction = direction === "redo" ? "REDO" : "UNDO";

            if (store && historyMeta) {
                store.restoreFromHistoryMeta(historyMeta, {
                    type: storeAction,
                    commandName: commandEntry?.commandName || null
                });
            }

            const patches = commandEntry?.snapshotPatches || [];
            let appliedIncrementally = false;
            const forceFullSnapshotSync = options.forceFullSnapshotSync === true;
            const documentChanged = commandEntry?.documentChanged === true;

            if (forceFullSnapshotSync) {
                await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
            } else if (patches.length === 0 && documentChanged) {
                reportFatalError(
                    "history_patches",
                    "undo/redo: command '" + (commandEntry?.commandName || "?") +
                        "' reports documentChanged=true but has zero patches.\n" +
                        "The runtime was re-synced from snapshot as fallback, but this indicates a bug " +
                        "in patch generation.",
                    { commandName: commandEntry?.commandName || null, direction },
                    { alwaysShow: true }
                );
                await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
            } else if (patches.length > 0) {
                if (c.history_use_patch_runtime === false) {
                    this._reportPatchIssue("HISTORY_PATCH_RUNTIME_DISABLED", {
                        commandName: commandEntry?.commandName
                    });
                    if (!c.history_allow_snapshot_fallback) {
                        throw new Error("Patch runtime disabled and snapshot fallback is off");
                    }
                    // 明确的配置开关，不是 bug：可复制即可，不必进 error.log。
                    showErrorDialog(
                        "[InkShader] history_patch_runtime_disabled",
                        "history_use_patch_runtime=false — incremental patch runtime is disabled. " +
                            "Falling back to full snapshot sync.\nCommand: " +
                            (commandEntry?.commandName || "?"),
                        { direction }
                    );
                    await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
                } else {
                    const runtimeResult = applySnapshotPatchesToRuntime(c, patches, direction);
                    appliedIncrementally = runtimeResult.ok;
                    if (!runtimeResult.ok) {
                        this._reportPatchIssue("HISTORY_RUNTIME_PATCH_FAILED", {
                            commandName: commandEntry?.commandName,
                            path: runtimeResult.failedPatch?.path,
                            direction
                        });
                        if (!c.history_allow_snapshot_fallback) {
                            throw new Error(
                                `Runtime patch failed at ${runtimeResult.failedPatch?.path?.join(".")}`
                            );
                        }
                        reportFatalError(
                            "history_patch_runtime",
                            "Runtime patch failed at " +
                                (runtimeResult.failedPatch?.path?.join(".") || "?") +
                                " (direction=" + direction + ", command=" +
                                (commandEntry?.commandName || "?") + ").\n" +
                                "Falling back to full snapshot sync.",
                            {
                                commandName: commandEntry?.commandName || null,
                                direction,
                                failedPath: runtimeResult.failedPatch?.path || null,
                                patchPaths: patches.map((p) => (p?.path || []).join("."))
                            },
                            { alwaysShow: true }
                        );
                        await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
                    }
                }
            }

            if (liveSessionImages) {
                c.curve_manager.restoreSessionImages(liveSessionImages);
            }

            if (store) {
                store.applyInteractionToRuntime();
                store.bumpRevisionsAfterHistory();
            }

            this._syncUiAfterHistoryApply();

            this._debugCommand(
                forceFullSnapshotSync
                    ? "history apply (forced full sync)"
                    : patches.length === 0 && documentChanged
                      ? "history apply (document snapshot sync)"
                      : patches.length === 0
                        ? "history apply (meta-only)"
                        : appliedIncrementally
                          ? "history apply (patch)"
                          : "history apply (snapshot fallback)",
                { command: commandEntry?.commandName, patchCount: patches.length }
            );

            c.current_state = "IDLE";
            c.dragging_node_marker = null;
            c.last_on_curve_node_marker = null;
            c.hovered_node_marker = null;
            c.hovered_node_refId = null;
            c.hovered_node_seqIndex = null;
            c.hovered_node_matrix = null;
            c.hovered_curve_segment = null;
            c.current_curve = null;
            c.new_curve_handle = null;
            c.previewData = null;
            c.transform_action = null;
            c.closing_path_on_mouseup = false;

            c.is_dirty = true;
            this.saveCurrentViewState(false);
        } finally {
            c.__historyApplyDepth = Math.max(0, (c.__historyApplyDepth || 1) - 1);
            c.env.requestAnimationFrame(() => {
                setTimeout(() => {
                    c.is_restoring = false;
                    if (bodyDOM) bodyDOM.style.pointerEvents = "auto";
                }, 0);
            });
        }
    }

}
