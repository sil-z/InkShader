/**
 * 快照 JSON 上的 Delta Patch：生成、校验、应用（undo 反向 / redo 正向）。
 * 不依赖 per-command undo()，也不做全量文件快照恢复。
 */

function deepClone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(value);
        } catch (_) {
            /* fall through */
        }
    }
    return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SnapshotPatchExecutor {
    constructor(configProvider = () => ({})) {
        this._configProvider = configProvider;
    }

    _getConfig() {
        const raw = this._configProvider() || {};
        return {
            maxLeafPatches: Number.isFinite(raw.max_command_patch_count) ? raw.max_command_patch_count : 800,
            maxGranularArrayLength: Number.isFinite(raw.max_granular_array_length)
                ? raw.max_granular_array_length
                : 256,
            maxGranularObjectKeys: Number.isFinite(raw.max_granular_object_keys)
                ? raw.max_granular_object_keys
                : 160,
            coarsePathPrefixes: Array.isArray(raw.coarse_patch_paths) ? raw.coarse_patch_paths : [],
            granularPathPrefixes: Array.isArray(raw.granular_patch_paths)
                ? raw.granular_patch_paths
                : [["ch"], ["components"], ["editor_guideline_h"], ["editor_guideline_v"], ["editor_active_indices"]]
        };
    }

    _pathStartsWith(path, prefix) {
        if (!Array.isArray(path) || !Array.isArray(prefix)) return false;
        if (prefix.length > path.length) return false;
        for (let i = 0; i < prefix.length; i++) {
            if (path[i] !== prefix[i]) return false;
        }
        return true;
    }

    _shouldUseCoarsePatch(path, beforeValue, afterValue, config) {
        const granularForced = config.granularPathPrefixes.some((prefix) =>
            this._pathStartsWith(path, prefix)
        );
        if (granularForced) return false;
        const coarseForced = config.coarsePathPrefixes.some((prefix) =>
            this._pathStartsWith(path, prefix)
        );
        if (coarseForced) return true;

        if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
            return (
                beforeValue.length > config.maxGranularArrayLength ||
                afterValue.length > config.maxGranularArrayLength
            );
        }

        if (isObject(beforeValue) && isObject(afterValue)) {
            const keyCount = Math.max(Object.keys(beforeValue).length, Object.keys(afterValue).length);
            if (path.length >= 2 && keyCount > config.maxGranularObjectKeys) return true;
        }

        return false;
    }

    _pushReplacePatch(path, beforeValue, afterValue, patches, report = null) {
        if (report && path.length === 0) {
            report.warnings.push({
                code: "PATCH_COARSE_ROOT",
                path: []
            });
        }
        patches.push({
            path: [...path],
            oldExists: beforeValue !== undefined,
            newExists: afterValue !== undefined,
            oldValue: deepClone(beforeValue),
            newValue: deepClone(afterValue)
        });
    }

    buildPatches(beforeValue, afterValue, path = []) {
        return this.buildPatchesReport(beforeValue, afterValue, path).patches;
    }

    /**
     * @returns {{ patches: Array, warnings: Array<{code:string, path?:Array, limit?:number}> }}
     */
    buildPatchesReport(beforeValue, afterValue, path = []) {
        const config = this._getConfig();
        const patches = [];
        const report = { patches, warnings: [] };
        this._walkSnapshotDiff(beforeValue, afterValue, path, patches, config, report);
        if (patches.length >= config.maxLeafPatches) {
            report.warnings.push({
                code: "PATCH_LIMIT_REACHED",
                limit: config.maxLeafPatches
            });
        }
        return report;
    }

    _walkSnapshotDiff(beforeValue, afterValue, path, patches, config, report = null) {
        if (beforeValue === afterValue) return;
        if (patches.length >= config.maxLeafPatches) {
            if (report) {
                report.warnings.push({
                    code: "PATCH_LIMIT_TRUNCATED",
                    path: [...path],
                    limit: config.maxLeafPatches
                });
            }
            this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
            return;
        }

        const beforeIsArray = Array.isArray(beforeValue);
        const afterIsArray = Array.isArray(afterValue);
        if (this._shouldUseCoarsePatch(path, beforeValue, afterValue, config)) {
            if (report) {
                report.warnings.push({ code: "PATCH_COARSE_REPLACE", path: [...path] });
            }
            this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
            return;
        }

        if (beforeIsArray || afterIsArray) {
            if (!beforeIsArray || !afterIsArray || beforeValue.length !== afterValue.length) {
                this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
                return;
            }
            const startPatchLength = patches.length;
            for (let i = 0; i < beforeValue.length; i++) {
                this._walkSnapshotDiff(beforeValue[i], afterValue[i], [...path, i], patches, config, report);
                if (patches.length > config.maxLeafPatches) {
                    patches.length = startPatchLength;
                    if (report) {
                        report.warnings.push({
                            code: "PATCH_LIMIT_TRUNCATED",
                            path: [...path],
                            limit: config.maxLeafPatches
                        });
                    }
                    this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
                    return;
                }
            }
            return;
        }

        const beforeIsObj = isObject(beforeValue);
        const afterIsObj = isObject(afterValue);
        if (beforeIsObj && afterIsObj) {
            const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
            const startPatchLength = patches.length;
            for (const key of keys) {
                const beforeHas = Object.prototype.hasOwnProperty.call(beforeValue, key);
                const afterHas = Object.prototype.hasOwnProperty.call(afterValue, key);
                if (!beforeHas || !afterHas) {
                    patches.push({
                        path: [...path, key],
                        oldExists: beforeHas,
                        newExists: afterHas,
                        oldValue: beforeHas ? deepClone(beforeValue[key]) : undefined,
                        newValue: afterHas ? deepClone(afterValue[key]) : undefined
                    });
                } else {
                    this._walkSnapshotDiff(beforeValue[key], afterValue[key], [...path, key], patches, config, report);
                }
                if (patches.length > config.maxLeafPatches) {
                    patches.length = startPatchLength;
                    if (report) {
                        report.warnings.push({
                            code: "PATCH_LIMIT_TRUNCATED",
                            path: [...path],
                            limit: config.maxLeafPatches
                        });
                    }
                    this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
                    return;
                }
            }
            return;
        }

        this._pushReplacePatch(path, beforeValue, afterValue, patches, report);
    }

    _setPathValue(target, path, value, shouldExist) {
        if (!Array.isArray(path) || path.length === 0) return;
        let parent = target;
        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];
            if (parent[key] === undefined || parent[key] === null) {
                const nextKey = path[i + 1];
                parent[key] = typeof nextKey === "number" ? [] : {};
            }
            parent = parent[key];
        }
        const lastKey = path[path.length - 1];
        if (shouldExist) parent[lastKey] = deepClone(value);
        else if (Array.isArray(parent) && typeof lastKey === "number") parent.splice(lastKey, 1);
        else delete parent[lastKey];
    }

    _getParentByPath(target, path = []) {
        if (!Array.isArray(path) || path.length < 1) return { ok: false, parent: null, key: null };
        let current = target;
        for (let i = 0; i < path.length - 1; i++) {
            const seg = path[i];
            if (current === null || current === undefined) return { ok: false, parent: null, key: null };
            if (Array.isArray(current) && typeof seg === "number") {
                if (seg < 0 || seg >= current.length) return { ok: false, parent: null, key: null };
                current = current[seg];
                continue;
            }
            if (typeof current === "object" && Object.prototype.hasOwnProperty.call(current, seg)) {
                current = current[seg];
                continue;
            }
            return { ok: false, parent: null, key: null };
        }
        return { ok: true, parent: current, key: path[path.length - 1] };
    }

    validatePatchApplication(snapshotObj, patch, direction = "undo") {
        const applyReverse = direction === "undo";
        const sourceExists = applyReverse ? patch.newExists : patch.oldExists;
        const targetExists = applyReverse ? patch.oldExists : patch.newExists;
        const { ok, parent, key } = this._getParentByPath(snapshotObj, patch.path);
        if (!ok) return false;
        if (Array.isArray(parent) && typeof key === "number") {
            if (sourceExists && (key < 0 || key >= parent.length)) return false;
            if (!sourceExists && targetExists && (key < 0 || key > parent.length)) return false;
            return true;
        }
        if (typeof parent === "object" && parent !== null) {
            if (sourceExists && !Object.prototype.hasOwnProperty.call(parent, key)) return false;
            return true;
        }
        return false;
    }

    canApplyPatches(snapshotObj, patches = [], direction = "undo") {
        const applyReverse = direction === "undo";
        const ordered = applyReverse ? [...patches].reverse() : patches;
        const probe = deepClone(snapshotObj);
        for (const patch of ordered) {
            if (!this.validatePatchApplication(probe, patch, direction)) return false;
            const shouldExist = applyReverse ? patch.oldExists : patch.newExists;
            const value = applyReverse ? patch.oldValue : patch.newValue;
            this._setPathValue(probe, patch.path, value, shouldExist);
        }
        return true;
    }

    applySinglePatch(snapshotObj, patch, direction = "undo") {
        if (!patch || !Array.isArray(patch.path)) return;
        const applyReverse = direction === "undo";
        const shouldExist = applyReverse ? patch.oldExists : patch.newExists;
        const value = applyReverse ? patch.oldValue : patch.newValue;
        this._setPathValue(snapshotObj, patch.path, value, shouldExist);
    }

    /**
     * 原地应用补丁（undo/redo 热路径：不做整文档 probe 深拷贝）。
     */
    applyPatches(snapshotObj, patches = [], direction = "undo") {
        if (!Array.isArray(patches) || patches.length === 0) return snapshotObj;
        const applyReverse = direction === "undo";
        const orderedPatches = applyReverse ? [...patches].reverse() : patches;
        for (const patch of orderedPatches) {
            if (!this.validatePatchApplication(snapshotObj, patch, direction)) {
                throw new Error(
                    `Patch validation failed before ${direction} at path ${patch?.path?.join(".")}`
                );
            }
            this.applySinglePatch(snapshotObj, patch, direction);
        }
        return snapshotObj;
    }

    sanitizePatch(patch) {
        if (!patch || typeof patch !== "object") return null;
        if (!Array.isArray(patch.path)) return null;
        const normalizedPath = [];
        for (const seg of patch.path) {
            if (typeof seg !== "string" && typeof seg !== "number") return null;
            if (typeof seg === "number" && (!Number.isInteger(seg) || seg < 0)) return null;
            normalizedPath.push(seg);
        }
        return {
            path: normalizedPath,
            oldExists: patch.oldExists === true,
            newExists: patch.newExists === true,
            oldValue: deepClone(patch.oldValue),
            newValue: deepClone(patch.newValue)
        };
    }

    _pathIsTreeHierarchy(path) {
        if (!Array.isArray(path)) return false;
        if (path.length === 1 && path[0] === "editor_root_order") return true;
        return path.length === 3 && (path[0] === "ch" || path[0] === "components") && path[2] === "tree_child_order";
    }

    /**
     * 树顺序变更统一为整段 replace，避免逐索引补丁在运行时/撤回顺序上失步。
     */
    ensureTreeHierarchyCoarsePatches(beforeSnap, afterSnap, patches = []) {
        if (!beforeSnap || !afterSnap) return patches;
        const filtered = patches.filter((p) => !this._pathIsTreeHierarchy(p.path) && !this._pathUnderTreeChildOrder(p.path));
        const coarse = [];

        if (
            JSON.stringify(beforeSnap.editor_root_order ?? null) !==
            JSON.stringify(afterSnap.editor_root_order ?? null)
        ) {
            coarse.push({
                path: ["editor_root_order"],
                oldExists: Array.isArray(beforeSnap.editor_root_order),
                newExists: Array.isArray(afterSnap.editor_root_order),
                oldValue: deepClone(beforeSnap.editor_root_order),
                newValue: deepClone(afterSnap.editor_root_order)
            });
        }

        for (const bucket of ["ch", "components"]) {
            const beforeBucket = beforeSnap[bucket] || {};
            const afterBucket = afterSnap[bucket] || {};
            const keys = new Set([...Object.keys(beforeBucket), ...Object.keys(afterBucket)]);
            for (const groupName of keys) {
                const a = beforeBucket[groupName]?.tree_child_order;
                const b = afterBucket[groupName]?.tree_child_order;
                if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
                coarse.push({
                    path: [bucket, groupName, "tree_child_order"],
                    oldExists: Array.isArray(a),
                    newExists: Array.isArray(b),
                    oldValue: deepClone(a),
                    newValue: deepClone(b)
                });
            }
        }

        return [...filtered, ...coarse];
    }

    _pathUnderTreeChildOrder(path) {
        return (
            Array.isArray(path) &&
            path.length >= 4 &&
            (path[0] === "ch" || path[0] === "components") &&
            path[2] === "tree_child_order"
        );
    }

    sanitizeCommandEntry(entry) {
        if (!entry || typeof entry !== "object") return null;
        if (!Array.isArray(entry.snapshotPatches)) return null;
        const sanitizedPatches = [];
        for (const patch of entry.snapshotPatches) {
            const clean = this.sanitizePatch(patch);
            if (!clean) return null;
            sanitizedPatches.push(clean);
        }
        return {
            id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            commandName: entry.commandName || "unknown-command",
            payload: entry.payload || {},
            timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
            snapshotPatches: sanitizedPatches,
            beforeMeta: entry.beforeMeta ? deepClone(entry.beforeMeta) : null,
            afterMeta: entry.afterMeta ? deepClone(entry.afterMeta) : null
        };
    }
}

export { deepClone as snapshotDeepClone };
