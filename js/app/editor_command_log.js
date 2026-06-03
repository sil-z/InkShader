export {
    shouldCommitCommandAfterDispatch,
    shouldPostDispatchCommit,
    normalizeCommandCommitDetail,
    commitDispatchingOrNamed
} from "../domain/history/command_commit.js";

export function getMainCanvas() {
    return typeof document !== "undefined" ? document.querySelector("main-canvas") : null;
}

/** 唯一显式写栈辅助（交互拖拽结束、import 等不经 dispatch 的路径） */
export function commitCommandHistory(detail = {}) {
    const canvas = getMainCanvas();
    if (canvas?.editorStore?.commitCommand) {
        return canvas.editorStore.commitCommand(detail);
    }
    return false;
}

