/**
 * Paper.js off-screen scope: host injects canvas factory at startup, domain layer does not touch document.
 */
let _createCanvas = null;
let _paperScope = null;

export function configurePaperScope(createCanvas) {
    _createCanvas = typeof createCanvas === "function" ? createCanvas : null;
    _paperScope = null;
}

export function getPaperScope() {
    if (typeof window === "undefined" || !window.paper) return null;
    if (_paperScope) return _paperScope;
    if (!_createCanvas) return null;

    _paperScope = new paper.PaperScope();
    const canvas = _createCanvas();
    _paperScope.setup(canvas);
    return _paperScope;
}

export function resetPaperScope() {
    _paperScope = null;
}
