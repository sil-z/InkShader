/**
 * 从 main-canvas 解析宿主（UI 不得 CurveManager.getInstance()）。
 * 组件可能早于 main-canvas 挂载，使用 whenCanvasReady 延迟初始化。
 */

export function getMainCanvasFromDocument() {
    if (typeof document === "undefined") return null;
    return document.querySelector("main-canvas") ?? null;
}

export function getCurveManagerFromDocument() {
    return getMainCanvasFromDocument()?.curve_manager ?? null;
}

export function getEditorStoreFromDocument() {
    return getMainCanvasFromDocument()?.editorStore ?? null;
}

export function whenCanvasReady(callback, { maxFrames = 600 } = {}) {
    let frames = 0;
    const tick = () => {
        const canvas = getMainCanvasFromDocument();
        if (canvas?.curve_manager && canvas.editorStore) {
            callback(canvas);
            return;
        }
        if (++frames < maxFrames) {
            requestAnimationFrame(tick);
        }
    };
    tick();
}

/** @deprecated 使用 whenCanvasReady；保留别名供现有 UI 导入 */
export function whenCurveManagerReady(callback, options = {}) {
    whenCanvasReady((canvas) => callback(canvas.curve_manager), options);
}
