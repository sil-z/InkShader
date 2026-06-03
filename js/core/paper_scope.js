/**
 * Paper.js 离屏作用域：由宿主在启动时注入 canvas 工厂，领域层不触碰 document。
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
