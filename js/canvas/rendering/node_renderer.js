/**
 * Node handle Canvas rendering (domain CurveNode provides only coordinates and control_mode).
 *
 * Uses pre-rasterized sprites for node body shapes and control handle circles,
 * avoiding Canvas2D path tessellation overhead for 4000+ nodes per frame.
 * Sprites are built once per theme and reused across frames via ctx.drawImage
 * (pure pixel blit, no path creation).
 */
import { getCanvasTheme } from "./canvas_theme.js";
import { createViewportTransform } from "./viewport_transform.js";

// ── Sprite cache (module-level, rebuilt on theme change or DPR change) ──

let _spriteCache = null;
let _spriteThemeRef = null;
let _spriteDPR = 0;

/**
 * Create a sprite at devicePixelRatio resolution.
 * Uses OffscreenCanvas + transferToImageBitmap (synchronous ImageBitmap creation)
 * to avoid Canvas2D canvas-source readback overhead in drawImage.
 * Falls back to HTMLCanvasElement when OffscreenCanvas is unavailable.
 *
 * @param {number} cssSize  Desired CSS pixel size.
 * @param {(ctx:CanvasRenderingContext2D, cx:number, cy:number, dpr:number)=>void} drawFn
 *        Draw function receiving context in CSS-pixel coordinates (pre-scaled for DPR).
 * @returns {{ canvas:ImageBitmap|HTMLCanvasElement, half:number, dpr:number }}
 */
function _makeSprite(cssSize, drawFn) {
    const dpr = Math.ceil(window.devicePixelRatio || 1);
    const px = Math.ceil(cssSize * dpr);
    const useOC = typeof OffscreenCanvas !== 'undefined';
    if (useOC) {
        const canvas = new OffscreenCanvas(px, px);
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        drawFn(ctx, cssSize / 2, cssSize / 2, dpr);
        return { canvas: canvas.transferToImageBitmap(), half: cssSize / 2, dpr };
    }
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    drawFn(ctx, cssSize / 2, cssSize / 2, dpr);
    return { canvas, half: cssSize / 2, dpr };
}

function _buildNodeSprite(mode, baseR, fillStyle, strokeStyle, lineWidth) {
    const extent =
        mode === 0 ? baseR * 1.25
            : mode === 2 ? baseR
                : baseR * 0.9;
    const cssSize = Math.ceil((extent + Math.max(1, lineWidth / 2)) * 2 + 2);
    return _makeSprite(cssSize, (ctx, cx, cy) => {
        ctx.lineWidth = lineWidth;
        ctx.fillStyle = fillStyle;
        ctx.strokeStyle = strokeStyle;
        ctx.beginPath();
        if (mode === 2) {
            ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
        } else if (mode === 0) {
            const d = baseR * 1.25;
            ctx.moveTo(cx, cy - d);
            ctx.lineTo(cx + d, cy);
            ctx.lineTo(cx, cy + d);
            ctx.lineTo(cx - d, cy);
            ctx.closePath();
        } else {
            const s = baseR * 0.9;
            ctx.rect(cx - s, cy - s, s * 2, s * 2);
        }
        ctx.fill();
        ctx.stroke();
    });
}

function _buildHandleSprite(radius, fillStyle, strokeStyle, lineWidth) {
    const cssSize = Math.ceil((radius + Math.max(1, lineWidth / 2)) * 2 + 2);
    return _makeSprite(cssSize, (ctx, cx, cy) => {
        ctx.lineWidth = lineWidth;
        ctx.fillStyle = fillStyle;
        ctx.strokeStyle = strokeStyle;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });
}

/**
 * Draw a 30° apex isosceles triangle arrow whose geometric centroid sits at (cx, cy).
 * The triangle points in the given `angle` direction (forward tangent of the curve).
 *
 * Geometry: for a 30° isosceles triangle with height h, the centroid lies at
 * 2h/3 from the apex along the symmetry axis.  We offset the apex backwards
 * so the centroid lands exactly at (cx, cy).
 *
 * @param {number} baseLength  Desired base width in CSS px (≈ square node side).
 */
function _drawStartArrow(ctx, cx, cy, angle, baseLength, fillStyle, strokeStyle, lineWidth) {
    const apexAngle = Math.PI / 6; // 30°
    const halfAngle = apexAngle / 2;
    const height = (baseLength / 2) / Math.tan(halfAngle);
    const halfBase = baseLength / 2;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const perpX = -sin;
    const perpY = cos;

    // Centroid is 2h/3 from apex along symmetry axis → offset apex AHEAD
    // so the centroid lands at (cx, cy) and the tip points in direction `angle`.
    const offset = (2 * height) / 3;
    const ax = cx + offset * cos;
    const ay = cy + offset * sin;

    // Base center is `height` pixels BEHIND the apex
    const bcx = ax - height * cos;
    const bcy = ay - height * sin;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bcx + halfBase * perpX, bcy + halfBase * perpY);
    ctx.lineTo(bcx - halfBase * perpX, bcy - halfBase * perpY);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

function _ensureSprites(theme) {
    const dpr = Math.ceil(window.devicePixelRatio || 1);
    if (_spriteCache && _spriteThemeRef === theme && _spriteDPR === dpr) return;
    const sw = theme.path_stroke_width;
    const cache = {};
    // 12 node body sprites: 3 modes × 2 selection states × 2 sizes (normal / hovered)
    const col = {
        u: { fill: theme.oncurve_fill_color, stroke: theme.oncurve_stroke_color },
        s: { fill: theme.selected_fill_color, stroke: theme.selected_stroke_color }
    };
    for (const mode of [0, 1, 2]) {
        for (const sel of ["u", "s"]) {
            for (const baseR of [4.2, 5]) {
                cache[`${mode}_${sel}_${baseR}`] = _buildNodeSprite(mode, baseR, col[sel].fill, col[sel].stroke, sw);
            }
        }
    }
    // 4 handle sprites: 2 selection states × 2 sizes (normal / hovered)
    for (const sel of ["u", "s"]) {
        const fc = sel === "s" ? col.s : { fill: theme.control_fill_color, stroke: theme.control_stroke_color };
        for (const r of [3, 4]) {
            cache[`h_${sel}_${r}`] = _buildHandleSprite(r, fc.fill, fc.stroke, sw);
        }
    }
    _spriteCache = cache;
    _spriteThemeRef = theme;
    _spriteDPR = dpr;
}

/**
 * Draw a sprite canvas at CSS-pixel position with explicit CSS-pixel size,
 * preserving crisp rendering at any devicePixelRatio.
 */
function _drawSprite(ctx, sprite, x, y) {
    const cssSize = sprite.half * 2;
    // Explicit source/dest rect avoids browser auto-scaling from intrinsic size.
    ctx.drawImage(
        sprite.canvas,
        0, 0, sprite.canvas.width, sprite.canvas.height,
        x, y, cssSize, cssSize
    );
}

// ── Public API ──

/**
 * Draw a single enlarged control handle sprite at the handle's position.
 * Used by the hover overlay to avoid redrawing the node body (which would
 * alpha-blend with the cached body, causing darkening).
 */
export function drawHoveredHandle(ctx, handle, viewport, theme, isSelected) {
    if (!ctx || !handle) return;
    _ensureSprites(theme);
    const mapPoint = createViewportTransform(viewport);
    const hp = mapPoint(handle.x, handle.y);
    const r = 4; // enlarged for hover
    const selKey = isSelected ? "s" : "u";
    const hs = _spriteCache[`h_${selKey}_${r}`];
    if (hs) {
        _drawSprite(ctx, hs, hp.x - hs.half, hp.y - hs.half);
    }
}

export function drawCurveNode(
    ctx,
    node,
    viewport,
    theme = getCanvasTheme(),
    opts = {}
) {
    const {
        isSelected = false,
        hoverStates = {},
        showHandles = true,
        precomputedMap = null,   // optional: reuse transform across batched nodes
        isStartNode = false,     // true → draw directional arrow instead of node body (when unselected)
        nextNode = null          // the node after this one on the curve (used for arrow direction)
    } = opts;
    if (!ctx || !node) return;
    _ensureSprites(theme);

    const mapPoint = precomputedMap || createViewportTransform(viewport);
    const mainPt = mapPoint(node.x, node.y);
    const sx = mainPt.x;
    const sy = mainPt.y;

    // ── Handle lines (dynamic per-frame, draw directly) ──
    // Independent color (handle_line_color) — deliberately NOT the skeleton
    // line color (path_stroke_color); both are separately configurable.
    if (showHandles) {
        ctx.lineWidth = theme.path_stroke_width * 0.75;
        if (node.control1 !== null) {
            const cp = mapPoint(node.control1.x, node.control1.y);
            ctx.strokeStyle = theme.handle_line_color;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(cp.x, cp.y);
            ctx.stroke();
        }
        if (node.control2 !== null) {
            const cp = mapPoint(node.control2.x, node.control2.y);
            ctx.strokeStyle = theme.handle_line_color;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(cp.x, cp.y);
            ctx.stroke();
        }
    }


    // ── Node body sprite ──
    const baseR = hoverStates.main ? 5 : 4.2;
    const selKey = isSelected ? "s" : "u";

    // Start-node directional arrow: 30° isosceles triangle whose centroid sits
    // at the node position, pointing in the forward tangent direction.
    // Tangent at t=0 = 3*(control1 − startNode), direction toward control1.
    // Fallback when control1 is null (degenerate first derivative):
    //   B'(0)=0 → B''(0)=6(P2−P0) → direction toward P2 = nextNode.control2
    //   (segment P0,P1,P2,P3 with P1=P0: the second derivative points toward P2)
    // Final fallback: chord direction startNode→nextOnCurve (straight segment).
    // When the start node is selected, fall back to the normal node sprite.
    if (opts.isStartNode && !isSelected) {
        const fwd = node.control1 ?? opts.nextNode?.control2 ?? opts.nextNode;
        if (fwd) {
            const fwdPt = mapPoint(fwd.x, fwd.y);
            const angle = Math.atan2(fwdPt.y - sy, fwdPt.x - sx);
            // baseLength ≈ square node side: baseR * 0.9 * 2
            const baseLen = baseR * 0.9 * 2;
            _drawStartArrow(ctx, sx, sy, angle, baseLen,
                theme.oncurve_fill_color, theme.oncurve_stroke_color,
                theme.path_stroke_width);
        } else {
            // Degenerate: no forward direction at all — draw normal sprite
            const sprite = _spriteCache[`${node.control_mode}_${selKey}_${baseR}`];
            if (sprite) _drawSprite(ctx, sprite, sx - sprite.half, sy - sprite.half);
        }
    } else {
        const sprite = _spriteCache[`${node.control_mode}_${selKey}_${baseR}`];
        if (sprite) {
            _drawSprite(ctx, sprite, sx - sprite.half, sy - sprite.half);
        }
    }

    // ── Control handle sprites ──
    if (showHandles) {
        const drawHandle = (handle, isHov) => {
            if (!handle) return;
            const hp = mapPoint(handle.x, handle.y);
            const r = isHov ? 4 : 3;
            const hs = _spriteCache[`h_${selKey}_${r}`];
            if (hs) {
                _drawSprite(ctx, hs, hp.x - hs.half, hp.y - hs.half);
            }
        };
        drawHandle(node.control1, hoverStates.c1);
        drawHandle(node.control2, hoverStates.c2);
    }
}
