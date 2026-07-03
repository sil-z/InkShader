export {
    shouldCommitCommandAfterDispatch,
    shouldPostDispatchCommit,
    normalizeCommandCommitDetail,
    commitDispatchingOrNamed
} from "../domain/history/command_commit.js";

export function getMainCanvas() {
    return typeof document !== "undefined" ? document.querySelector("main-canvas") : null;
}

/** Only explicit stack-write helper (paths like drag-end, import that bypass dispatch) */
export function commitCommandHistory(detail = {}) {
    const canvas = getMainCanvas();
    if (canvas?.editorStore?.commitCommand) {
        return canvas.editorStore.commitCommand(detail);
    }
    return false;
}

