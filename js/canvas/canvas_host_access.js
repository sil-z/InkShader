/**
 * Resolves MainCanvas host from document (explicit composition entry: services / commands / editorStore).
 */

export function getCanvasHostFromDocument() {
    if (typeof document === "undefined") return null;
    return document.querySelector("main-canvas");
}

export function whenCanvasHostReady(callback) {
    const run = () => {
        const host = getCanvasHostFromDocument();
        if (host?.commands && host?.renderer) {
            callback(host);
            return true;
        }
        return false;
    };
    if (run()) return;
    const observer = new MutationObserver(() => {
        if (run()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}
