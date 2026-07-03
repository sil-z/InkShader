/**
 * Resolves host from main-canvas (UI must not call CurveManager.getInstance()).
 * Components may mount before main-canvas; use whenCanvasReady for deferred initialization.
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

/** @deprecated Use whenCanvasReady; keep alias for existing UI imports */
export function whenCurveManagerReady(callback, options = {}) {
    whenCanvasReady((canvas) => callback(canvas.curve_manager), options);
}
