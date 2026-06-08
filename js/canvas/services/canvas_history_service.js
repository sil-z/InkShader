import { StorageUtils } from "../../services/storage.js";
import { interactionMetaFromCanvas } from "../../app/editor_history_state.js";
import { mergeInteractionFromStoreState, resolveActiveCanvasTool } from "../../app/editor_interaction_state.js";
import { SnapshotPatchExecutor, snapshotDeepClone } from "../../domain/history/snapshot_patch_executor.js";
import {
    applySnapshotPatchesToRuntime,
    syncRuntimeFromSnapshotObject,
    syncTreeHierarchyFromSnapshot
} from "../../domain/history/snapshot_runtime_applier.js";
import {
    expectsDocumentPatches,
    isMetaOnlyHistoryCommand
} from "../../app/history_patch_policy.js";

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

    _formatDebugPayload(payload = {}) {
        const keys = Object.keys(payload || {});
        if (keys.length === 0) return "";
        return ` payload=${JSON.stringify(payload)}`;
    }

    _debugCommand(message, payload = {}) {
        console.log(`[CommandDebug] ${message}${this._formatDebugPayload(payload)}`);
    }

    _deepClone(value) {
        return snapshotDeepClone(value);
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
        if (JSON.stringify(beforeSnap.editor_root_order || null) !== JSON.stringify(afterSnap.editor_root_order || null)) {
            return true;
        }
        for (const bucket of ["ch", "components"]) {
            const beforeBucket = beforeSnap[bucket] || {};
            const afterBucket = afterSnap[bucket] || {};
            const keys = new Set([...Object.keys(beforeBucket), ...Object.keys(afterBucket)]);
            for (const groupName of keys) {
                const a = beforeBucket[groupName]?.tree_child_order;
                const b = afterBucket[groupName]?.tree_child_order;
                if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) return true;
            }
        }
        return false;
    }

    /**
     * 补丁完整性告警；history_strict_patch_runtime=true 时抛错（开发期开关）。
     */
    _reportPatchIssue(code, detail = {}, { throwIfStrict = true } = {}) {
        const payload = { code, ...detail };
        if (this.canvas.history_patch_warnings !== false) {
            console.warn("[HistoryPatch]", payload);
        }
        if (throwIfStrict && this.canvas.history_strict_patch_runtime) {
            throw new Error(`[HistoryPatch] ${code}: ${JSON.stringify(detail)}`);
        }
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
            sessionImages: this._deepClone(s.sessionImages || []),
            sequenceText: s.sequenceText,
            activeIndices: this._deepClone(s.activeIndices || []),
            activeGroupId: s.activeGroupId,
            currentTool: s.currentTool
        };
    }

    /** 更新 currentStateObj 的 meta 切片，不克隆 snapshotObj（undo/redo 热路径） */
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
            sessionImages: this._deepClone(meta.sessionImages || []),
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

    _saveRuntimeState() {
        const c = this.canvas;
        if (!c.currentStateObj?.snapshotObj) return;
        const data = {
            runtimeVersion: 2,
            latestSnapshot: this._deepClone(c.currentStateObj.snapshotObj),
            commandStack: this._deepClone(c.commandStack || []),
            redoCommandStack: this._deepClone(c.redoCommandStack || [])
        };
        StorageUtils.save(data).catch((e) => console.error(" [Storage] 运行态保存失败:", e));
    }

    _queueRuntimeStateSave() {
        const c = this.canvas;
        clearTimeout(c._runtimeSaveTimer);
        c._runtimeSaveTimer = setTimeout(() => this._saveRuntimeState(), 120);
    }

    _flushRuntimeStateSave() {
        const c = this.canvas;
        clearTimeout(c._runtimeSaveTimer);
        this._saveRuntimeState();
    }

    _isMetaSame(beforeState, afterState) {
        if (!beforeState || !afterState) return false;
        const isSelSame = JSON.stringify(beforeState.selection) === JSON.stringify(afterState.selection);
        const isCurveSame =
            JSON.stringify(beforeState.selectedCurveIds || []) ===
            JSON.stringify(afterState.selectedCurveIds || []);
        const isRefSame =
            JSON.stringify(beforeState.selectedRefIds || []) ===
            JSON.stringify(afterState.selectedRefIds || []);
        const isSeqSame = beforeState.sequenceText === afterState.sequenceText;
        const isToolSame = (beforeState.currentTool || "DRAW") === (afterState.currentTool || "DRAW");
        return isSelSame && isCurveSame && isRefSame && isSeqSame && isToolSame;
    }

    _buildStateFromSnapshotAndMeta(snapshotObj, meta = {}) {
        const safeSnapshot = this._deepClone(snapshotObj || {});
        return {
            json: JSON.stringify(safeSnapshot),
            snapshotObj: safeSnapshot,
            selection: this._deepClone(meta.selection || { treeIds: [], nodes: [] }),
            selectedCurveIds: this._deepClone(meta.selectedCurveIds || []),
            selectedRefIds: this._deepClone(meta.selectedRefIds || []),
            sessionImages: this._deepClone(meta.sessionImages || []),
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

    _reconcileRuntimeHistoryStacks() {
        const c = this.canvas;
        if (!c.currentStateObj?.snapshotObj) return;
        const commandStack = Array.isArray(c.commandStack) ? c.commandStack : [];
        const redoStack = Array.isArray(c.redoCommandStack) ? c.redoCommandStack : [];

        let commandProbe = this._deepClone(c.currentStateObj.snapshotObj);
        let keepCommandFrom = commandStack.length;
        for (let i = commandStack.length - 1; i >= 0; i--) {
            const entry = this._sanitizeCommandEntry(commandStack[i]);
            if (!entry) break;
            if (!this._canApplyPatches(commandProbe, entry.snapshotPatches, "undo")) break;
            commandProbe = this._applySnapshotPatches(commandProbe, entry.snapshotPatches, "undo");
            keepCommandFrom = i;
        }
        c.commandStack = commandStack.slice(keepCommandFrom).map((entry) => this._sanitizeCommandEntry(entry)).filter(Boolean);

        let redoProbe = this._deepClone(c.currentStateObj.snapshotObj);
        let keepRedoFrom = redoStack.length;
        for (let i = redoStack.length - 1; i >= 0; i--) {
            const entry = this._sanitizeCommandEntry(redoStack[i]);
            if (!entry) break;
            if (!this._canApplyPatches(redoProbe, entry.snapshotPatches, "redo")) break;
            redoProbe = this._applySnapshotPatches(redoProbe, entry.snapshotPatches, "redo");
            keepRedoFrom = i;
        }
        c.redoCommandStack = redoStack.slice(keepRedoFrom).map((entry) => this._sanitizeCommandEntry(entry)).filter(Boolean);
    }

    async _recoverAfterHistoryFailure(previousRuntimeState, commandEntry, direction, error) {
        const c = this.canvas;
        this._debugCommand("history recovery start", {
            direction,
            command: commandEntry?.commandName || "unknown-command",
            error: String(error?.message || error)
        });

        const brokenId = commandEntry?.id;
        if (brokenId) {
            c.commandStack = (c.commandStack || []).filter((entry) => entry?.id !== brokenId);
            c.redoCommandStack = (c.redoCommandStack || []).filter((entry) => entry?.id !== brokenId);
        }

        let recovered = false;
        if (previousRuntimeState?.snapshotObj) {
            try {
                c.currentStateObj = this._deepClone(previousRuntimeState);
                await this._applyState(c.currentStateObj, null, direction, { forceFullSnapshotSync: true });
                recovered = true;
            } catch (recoveryError) {
                this._debugCommand("history recovery previous-state failed", {
                    error: String(recoveryError?.message || recoveryError)
                });
            }
        }

        if (!recovered) {
            const fallbackState = this.getHistoryState();
            c.commandStack = [];
            c.redoCommandStack = [];
            c.currentStateObj = fallbackState;
            await this._applyState(fallbackState, null, direction, { forceFullSnapshotSync: true });
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
                offset_x: c.offset.x,
                offset_y: c.offset.y,
                right_width: layoutState.rightWidth,
                tree_flex: layoutState.treeFlex,
                prop_flex: layoutState.propFlex,
                dock_layout: layoutState.dockLayout,
                active_group_id: interaction.activeGroupId,
                active_sequence_indices: [...(storeState.activeSequenceIndices || [])],
                current_tool: resolveActiveCanvasTool(c),
                draw_tool_settings: c.drawToolSettings,
                selected_tree_ids: interaction.selectedTreeIds,
                sequence_text: c.curve_manager.sequenceText
            };
            StorageUtils.saveViewState(viewState).catch((e) => console.error(" [Storage] 保存视图状态失败:", e));
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
     * 写历史条目时导出当前文档快照（含 exportJSON，仅 commit 路径调用，非 undo/redo）。
     */
    getHistoryState() {
        const c = this.canvas;
        const cm = c.curve_manager;
        const meta = interactionMetaFromCanvas(c);
        const jsonStr = c.io.save_file();
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
        const newState = this.getHistoryState();
        const commandName =
            detail?.action?.type || detail?.commandName || "anonymous-command";
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
                      sessionImages: this._deepClone(c.currentStateObj.sessionImages || []),
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
                sessionImages: this._deepClone(newState.sessionImages || []),
                sequenceText: newState.sequenceText,
                activeIndices: this._deepClone(newState.activeIndices || []),
                activeGroupId: newState.activeGroupId,
                currentTool: newState.currentTool
            }
        };

        c.commandStack.push(entry);
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
                await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
            } else if (patches.length > 0) {
                if (c.history_use_patch_runtime === false) {
                    this._reportPatchIssue("HISTORY_PATCH_RUNTIME_DISABLED", {
                        commandName: commandEntry?.commandName
                    });
                    if (!c.history_allow_snapshot_fallback) {
                        throw new Error("Patch runtime disabled and snapshot fallback is off");
                    }
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
                        await syncRuntimeFromSnapshotObject(c, stateObj.snapshotObj || {});
                    }
                }
            }

            if (stateObj.sessionImages) {
                c.curve_manager.restoreSessionImages(stateObj.sessionImages);
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
