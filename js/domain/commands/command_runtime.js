/**
 * 画布命令运行时辅助（经 commandHostPort，不引用 EditorStore / CanvasDispatcher）。
 */
import { EDITOR_ACTIONS } from "../actions/editor_actions.js";
import { getCanvasCommandPort } from "../ports/canvas_command_host_port.js";
import { commitDispatchingOrNamed } from "../history/command_commit.js";

export function commandCanvas(host) {
    return host._canvas ?? host;
}

export function selectedTreeIdsFromStore(canvas, ids = null) {
    if (Array.isArray(ids)) return ids;
    const state = getCanvasCommandPort(canvas).getStoreState();
    return [...(state?.selectedTreeIds || [])];
}

export function isStoreInteractionDispatch(canvas) {
    return getCanvasCommandPort(canvas).isStoreDispatching();
}

export function commitInteractionFromCommand(host, action) {
    const canvas = commandCanvas(host);
    if (isStoreInteractionDispatch(canvas)) return false;
    return getCanvasCommandPort(canvas).commitInteraction(action, { emit: true });
}

/** 绘制/粘贴前：CM.activeGroupId 与 Store 对齐（渲染层读 Store 快照） */
export function syncActiveGroupToStore(host, groupId) {
    if (!groupId) return false;
    const canvas = commandCanvas(host);
    const storeId = getCanvasCommandPort(canvas).getStoreState()?.activeGroupId ?? null;
    if (storeId === groupId) return true;
    return commitInteractionFromCommand(host, {
        type: EDITOR_ACTIONS.SET_ACTIVE_GROUP,
        payload: { id: groupId }
    });
}

export function finishInteractionCommand(host) {
    host.notifyPropertiesUpdate();
    host.is_dirty = true;
    return true;
}

/** 领域命令已写 CM 序列态时，经 reducer 镜像到 Store（非 refreshSequenceFromCurveManager 直写） */
export function refreshStoreSequence(host) {
    const canvas = commandCanvas(host);
    const cm = canvas?.curve_manager;
    if (!cm) return false;
    return commitInteractionFromCommand(host, {
        type: EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
        payload: {
            text: cm.sequenceText ?? "",
            activeIndices: Array.from(cm.activeSequenceIndices || [])
        }
    });
}

export function commitCommandHistoryFromHost(host, commandName, payload = {}) {
    return commitDispatchingOrNamed(commandCanvas(host), commandName, payload);
}

export function commitCommandHistoryUnlessDispatching(host, commandName, payload = {}) {
    const canvas = commandCanvas(host);
    const dispatching = getCanvasCommandPort(canvas).getDispatchingAction();
    if (
        dispatching?.type &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_HISTORY &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_SEQUENCE_HISTORY
    ) {
        return false;
    }
    return commitDispatchingOrNamed(canvas, commandName, payload);
}
