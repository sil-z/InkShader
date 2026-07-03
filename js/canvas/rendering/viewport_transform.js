/**
 * Viewport transform: model coordinates → canvas logical pixels (presentation layer; domain layer does not depend on it).
 */

export function createViewportTransform({
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    seqOffsetX = 0,
    matrix = null
} = {}) {
    return (x, y) => {
        let mx = x;
        let my = y;
        if (matrix) {
            mx = x * matrix.a + y * matrix.c + matrix.e;
            my = x * matrix.b + y * matrix.d + matrix.f;
        }
        return {
            x: (mx + seqOffsetX) * scale + offsetX,
            y: my * scale + offsetY
        };
    };
}

export function createDeviceViewportTransform(viewport, dpr = 1) {
    const map = createViewportTransform(viewport);
    return (x, y) => {
        const p = map(x, y);
        return { x: p.x * dpr, y: p.y * dpr };
    };
}
