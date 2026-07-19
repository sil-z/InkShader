import { getCanvasTheme } from "../rendering/canvas_theme.js";
import {
    shouldIncludeCurrentDrawingCurve,
    snapshotIncludesNodeMarker
} from "../../app/editor_interaction_state.js";
import {
    appendCurveFillPath,
    shouldBatchFillCurve,
    drawCurveStroke,
    isCurveStrokePreview,
    canFillSmartStrokeWithPath2D,
    fillSmartStrokePath2D
} from "../rendering/curve_renderer.js";
import { drawCurveNode, drawHoveredHandle } from "../rendering/node_renderer.js";
import { createViewportTransform } from "../rendering/viewport_transform.js";
export class CanvasRendererService {
    constructor(canvas) {
        this.canvas = canvas;
        // Ruler / canvas layout change detection (avoid DOM rebuild when unchanged)
        this._rulerHState = null;
        this._rulerVState = null;
        this._canvasState = null;
        this._viewportPreviewCache = null;
        this._nodeDragPreviewCache = null;
        this._zoomPreviewCache = null;
        this._boxSelectPreviewCache = null;
        /** Path fills/strokes at a viewport; reused when only selection/hover overlays change. */
        this._stableSceneCache = null;
        /** Full overlay (nodes + selection effects, no hover) cached to offscreen canvas. */
        this._nodeLayerCache = null;
        /** Last full-scene paint cost (ms); drives adaptive zoom/pan retained mode. */
        this._lastExactRenderMs = 0;

    }

    /** Stable blit must be path-only (no nodes/chrome). Bump when capture point changes. */
    static STABLE_SCENE_FORMAT = 2;

    /**
     * Whether wheel-zoom should use bitmap scale preview instead of exact redraw.
     * Light documents stay on exact zoom; heavy scenes blit until settle (snappy;
     * path soft-blur + temporary node scale clear on settle — mid-gesture node
     * redraw proved too expensive).
     */
    shouldUseRetainedZoomPreview() {
        const measured = this._lastExactRenderMs || 0;
        // Missed ~45fps budget on last exact paint → prefer blit zoom.
        if (measured >= 22) return true;

        const cm = this.canvas?.curve_manager;
        if (!cm) return false;
        // domMap includes on-curve + control markers (~2–3× vertices).
        const markers = cm.domMap?.size || 0;
        if (markers >= 1200) return true;

        let booleanSegs = 0;
        const smart = cm.curveStore?.smartStrokeCurves;
        if (smart?.size) {
            for (const curve of smart) {
                const geom = curve?.cached_boolean_geometry;
                if (!Array.isArray(geom)) continue;
                for (const sub of geom) {
                    booleanSegs += sub?.segments?.length || 0;
                    if (booleanSegs >= 2500) return true;
                }
            }
        }
        return false;
    }

    /** Capture the current viewport for transient wheel-zoom compositing. */
    beginZoomPreview() {
        if (!this.shouldUseRetainedZoomPreview()) {
            // Drop any stale preview so render stays on exact path.
            if (this._zoomPreviewCache) {
                this._zoomPreviewCache = null;
            }
            return false;
        }
        if (this._zoomPreviewCache) return true;
        const cache = this._captureViewportSnapshot();
        if (!cache) return false;
        cache.baseScale = cache.scale;
        this._zoomPreviewCache = cache;
        return true;
    }

    /** End transient wheel-zoom compositing and request an exact frame. */
    endZoomPreview() {
        this._zoomPreviewCache = null;
        this.canvas.is_dirty = true;
    }

    /**
     * Instant framebuffer snapshot (drawImage of the current canvas).
     * Avoids re-rasterizing thousands of node markers on the main thread.
     */
    _captureViewportSnapshot() {
        const c = this.canvas;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (width <= 0 || height <= 0 || !c.canvasObj) return null;
        const dpr = c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio();
        const cache = this._createCacheCanvas(width, height, dpr);
        if (!cache) return null;
        const src = c.canvasObj;
        cache.ctx.setTransform(1, 0, 0, 1, 0, 0);
        cache.ctx.imageSmoothingEnabled = false;
        // Explicit 1:1 copy — never resample into the pan/zoom retained buffer.
        cache.ctx.drawImage(
            src,
            0,
            0,
            src.width,
            src.height,
            0,
            0,
            cache.canvas.width,
            cache.canvas.height
        );
        cache.baseOffset = { ...c.offset };
        cache.scale = c.scale;
        cache.viewportWidth = width;
        cache.viewportHeight = height;
        return cache;
    }

    /**
     * Start transform-only panning from an instant snapshot of the current frame.
     * Each pan tick: integer nearest-neighbor blit only (uncovered margins blank until
     * pan end). Mid-gesture exact/strip fills were either chaotic or too expensive.
     */
    beginViewportPreview() {
        const c = this.canvas;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (width <= 0 || height <= 0) return false;
        const existing = this._viewportPreviewCache;
        if (
            existing &&
            existing.baseOffset?.x === c.offset.x &&
            existing.baseOffset?.y === c.offset.y &&
            existing.scale === c.scale &&
            existing.viewportWidth === width &&
            existing.viewportHeight === height
        ) {
            return true;
        }
        const cache = this._captureViewportSnapshot();
        if (!cache) return false;
        this._viewportPreviewCache = cache;
        return true;
    }

    /** End transform-only panning and request an exact frame. */
    endViewportPreview() {
        this._viewportPreviewCache = null;
        this.canvas.is_dirty = true;
    }

    /**
     * Bake static layers for node-drag compositing:
     * - Main: non-mover paths/nodes + frozen (non-moving) nodes on mover curves
     * - Node top: same frozen mover nodes alone (blitted above the live stroke so the
     *   path cannot cover them — single-canvas draw order would otherwise put stroke on top)
     * Live each frame: mover stroke → node-top blit → sparse moving markers
     * @param {string[]} curveIds - Curves that remain dynamic during the drag
     */
    beginNodeDragPreview(curveIds = []) {
        const ids = new Set();
        for (const key of curveIds || []) {
            if (!key) continue;
            ids.add(String(key).split("::")[0]);
        }
        if (ids.size === 0) return false;
        const c = this.canvas;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (width <= 0 || height <= 0) return false;

        const excludeNodeMarkers = new Set();
        const addMarker = (marker) => {
            if (marker == null) return;
            excludeNodeMarkers.add(marker);
            if (marker?.id != null) excludeNodeMarkers.add(marker.id);
        };
        for (const marker of c.drag_initial_nodes?.keys?.() || []) {
            addMarker(marker);
            // Main-node drag also moves its controls — keep them out of the static bake.
            const n = c.curve_manager?.find_node_by_curve?.(marker);
            if (n) {
                addMarker(n.control1?.main_node);
                addMarker(n.control2?.main_node);
            }
        }
        addMarker(c.dragging_node_marker);
        // Control-handle drag: dragging_node_marker is the handle, not the on-curve node.
        // Exclude the parent main node so bake does not stamp handle stubs at the start pose.
        {
            const dragged = c.curve_manager?.find_node_by_curve?.(c.dragging_node_marker);
            if (dragged && dragged.type == null) {
                const parent = dragged.nextOnCurve || dragged.lastOnCurve;
                addMarker(parent?.main_node);
                addMarker(parent?.control1?.main_node);
                addMarker(parent?.control2?.main_node);
            }
        }

        // Cache only nodes (no paths) — all paths render live in a single batched pass
        // so even-odd fill interacts correctly between all curves in the same glyph.
        const cache = this._renderIntoCache({
            width,
            height,
            nodesOnly: true,
            excludeNodeMarkers
        });
        if (!cache) return false;
        cache.curveIds = ids;
        cache.baseOffset = { ...c.offset };
        cache.scale = c.scale;
        this._nodeDragPreviewCache = cache;
        return true;
    }

    /** End the node-drag cache and request an exact frame. */
    endNodeDragPreview() {
        this._nodeDragPreviewCache = null;
        this.canvas.is_dirty = true;
    }

    /**
     * Snapshot the current frame for marquee box-select.
     * Drag frames only blit + draw the selection rectangle (no full node redraw).
     */
    beginBoxSelectPreview() {
        const cache = this._captureViewportSnapshot();
        if (!cache) return false;
        this._boxSelectPreviewCache = cache;
        return true;
    }

    endBoxSelectPreview() {
        this._boxSelectPreviewCache = null;
        this.canvas.is_dirty = true;
    }

    /** Drop retained bitmaps (resize / theme / settled geometry). */
    invalidateRetainedCaches() {
        this._viewportPreviewCache = null;
        this._nodeDragPreviewCache = null;
        this._zoomPreviewCache = null;
        this._boxSelectPreviewCache = null;
        this._rulerHState = null;
        this._rulerVState = null;
    }

    _createCacheCanvas(width, height, dpr) {
        const cacheCanvas = this.canvas.env.createDOMElement("canvas");
        cacheCanvas.width = Math.max(1, Math.round(width * dpr));
        cacheCanvas.height = Math.max(1, Math.round(height * dpr));
        const ctx = this.canvas.env.getCanvasContext(cacheCanvas, "2d");
        return ctx ? { canvas: cacheCanvas, ctx, width, height, dpr } : null;
    }

    /** Render the current scene into an offscreen cache (optionally filtering curves). */
    _renderIntoCache({
        width,
        height,
        curveFilter = null,
        skipNodes = false,
        extraNodeCurveIds = null,
        excludeNodeMarkers = null,
        nodesOnly = false,
        pathsOnly = false,
        skipPathLayer = false,
        overlayOnly = false,
        noHover = false
    } = {}) {
        const c = this.canvas;
        const dpr = c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio();
        const cache = this._createCacheCanvas(width, height, dpr);
        if (!cache) return null;
        const originalCtx = c.ctx;
        const originalViewport = c.viewportConfig;
        const originalOffset = c.offset;
        try {
            c.ctx = cache.ctx;
            c.viewportConfig = {
                ...(originalViewport || {}),
                userSpaceWidth: width,
                userSpaceHeight: height,
                viewportWidth: width,
                viewportHeight: height,
                devicePixelRatio: dpr
            };
            this._renderScene({
                curveFilter,
                skipNodes,
                extraNodeCurveIds,
                excludeNodeMarkers,
                nodesOnly,
                pathsOnly,
                skipPathLayer,
                overlayOnly,
                noHover
            });
        } finally {
            c.ctx = originalCtx;
            c.viewportConfig = originalViewport;
            c.offset = originalOffset;
        }
        return cache;
    }

    _blitSnapshot(cache, destX = 0, destY = 0, destW = null, destH = null) {
        const c = this.canvas;
        if (!cache || !c.ctx) return false;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        const dpr = cache.dpr;
        c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.ctx.clearRect(0, 0, width, height);
        // Integer pan blits must stay nearest-neighbor — Chrome compounds blur if smoothing
        // stays on after a zoom preview frame.
        c.ctx.imageSmoothingEnabled = false;
        c.ctx.drawImage(
            cache.canvas,
            0,
            0,
            cache.canvas.width,
            cache.canvas.height,
            destX,
            destY,
            destW == null ? cache.width : destW,
            destH == null ? cache.height : destH
        );
        return true;
    }

    /** Composite a cache on top of the current frame without clearing. */
    _blitSnapshotOnTop(cache) {
        const c = this.canvas;
        if (!cache || !c.ctx) return false;
        const dpr = cache.dpr;
        c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.ctx.imageSmoothingEnabled = false;
        c.ctx.drawImage(
            cache.canvas,
            0,
            0,
            cache.canvas.width,
            cache.canvas.height,
            0,
            0,
            cache.width,
            cache.height
        );
        return true;
    }

    /**
     * Retained pan: integer nearest-neighbor blit from the gesture-start capture.
     * Uncovered margins stay blank until endViewportPreview (exact paint).
     * No mid-gesture exact refresh — that reintroduced severe pan jank.
     */
    _renderViewportPreview() {
        const c = this.canvas;
        const cache = this._viewportPreviewCache;
        if (!cache || cache.scale !== c.scale) return false;
        const dx = Math.round(c.offset.x - cache.baseOffset.x);
        const dy = Math.round(c.offset.y - cache.baseOffset.y);
        return this._blitSnapshot(cache, dx, dy);
    }

    _renderNodeDragPreview() {
        const c = this.canvas;
        const cache = this._nodeDragPreviewCache;
        if (
            !cache ||
            cache.scale !== c.scale ||
            cache.baseOffset.x !== c.offset.x ||
            cache.baseOffset.y !== c.offset.y
        ) {
            return false;
        }
        // 1) ALL paths (dragged + non-dragged) in one batched pass so even-odd
        //    fill interacts correctly between all curves in the same glyph.
        //    No overlayOnly — we need paths rendered AND guidelines in chrome pass.
        this._renderScene({
            clear: true,
            skipNodes: true
        });
        // 2) Cached static nodes on top (includes ALL non-moving markers).
        if (!this._blitSnapshotOnTop(cache)) return false;
        // 3) Live moving markers on top.
        this._renderScene({
            clear: false,
            curveFilter: (curve) => cache.curveIds.has(curve?.id),
            sparseNodes: true,
            skipPathLayer: true,
            overlayOnly: true
        });
        return true;
    }

    /**
     * PAINTING_HANDLE fast path — mirrors _renderNodeDragPreview structure.
     *
     * Handle drag during path drawing is semantically identical to node dragging
     * (adjustControlNode modifies local node coordinates, no geometryEpoch bump).
     * Render ALL paths fresh (no stale-cache ghosts), then overlay the node-layer
     * cache, then push just the current curve's nodes on top.
     */
    /** Compute logical-screen bounding box for current curve's nodes + control handles. */
    _getPaintHandleClipRect() {
        const c = this.canvas;
        const curve = c.current_curve;
        if (!curve?.startNode) return null;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const scale = c.scale;
        const seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let node = curve.startNode;
        while (node) {
            const sx = (node.x + seqOffsetX) * scale + offsetX;
            const sy = node.y * scale + offsetY;
            minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
            minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
            if (node.control1) {
                const cx = (node.control1.x + seqOffsetX) * scale + offsetX;
                const cy = node.control1.y * scale + offsetY;
                minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
                minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            }
            if (node.control2) {
                const cx = (node.control2.x + seqOffsetX) * scale + offsetX;
                const cy = node.control2.y * scale + offsetY;
                minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
                minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            }
            node = node.nextOnCurve;
        }
        // Generous padding: covers old cache handle positions + node marker size
        const pad = 120;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        // Clip to viewport
        const { width: vw, height: vh } = c.viewportService.getCanvasUserSpaceSize();
        minX = Math.max(0, Math.floor(minX));
        minY = Math.max(0, Math.floor(minY));
        maxX = Math.min(vw, Math.ceil(maxX));
        maxY = Math.min(vh, Math.ceil(maxY));
        if (maxX <= minX || maxY <= minY) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /**
     * PAINTING_HANDLE fast path — mirrors _renderNodeDragPreview structure.
     *
     * Handle drag during path drawing only changes current-curve node positions
     * (adjustControlNode modifies local coordinates, does NOT bump geometryEpoch).
     * Same strategy as node drag:
     *
     * 1) ALL paths rendered fresh in one batched pass — every curve participates
     *    in the non-zero winding fill composition against every other curve in the
     *    same glyph. No stale-cache skeletons, no ghost trails.
     * 2) Node-layer cache blit with evenodd clip — excludes current-curve bbox so
     *    stale node markers (captured before handle adjustment) never show.
     * 3) Current curve's nodes fresh on top.
     * 4) Chrome + hovered node.
     */
    _renderPaintHandlePreview() {
        const c = this.canvas;

        // ── 0) Apply deferred paint-handle position (batched from mousemove) ──
        //     Use curveStore.adjustControlNode directly instead of
        //     curve_manager.adjustControlNode to skip ~13ms of DOM CustomEvent
        //     dispatch (notifyModelUpdate) that no consumer needs during
        //     PAINTING_HANDLE — only the renderer reads these node positions.
        const curveStore = c.curve_manager?.curveStore;
        if (c._pendingPaintPos && curveStore) {
            const pp = c._pendingPaintPos;
            c._pendingPaintPos = null;
            if (c.new_curve_handle !== null && c.last_on_curve_node_marker) {
                const last_node_n = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
                if (last_node_n?.control1?.main_node && last_node_n.control2?.main_node) {
                    const other_x = 2 * last_node_n.x - pp.worldX;
                    const other_y = 2 * last_node_n.y - pp.worldY;
                    curveStore.adjustControlNode(last_node_n.control1.main_node, pp.worldX, pp.worldY);
                    curveStore.adjustControlNode(last_node_n.control2.main_node, other_x, other_y);
                }
            }
        }

        const t0 = performance.now();
        const seq = ++this._paintHandleSeq || (this._paintHandleSeq = 1);

        // ── 1) ALL paths fresh — single batched pass for correct even-odd fill ──
        //     skipOverlay: no nodes/chrome needed in this pass (node cache handles
        //     static markers; current-curve nodes render in step 3).
        this._renderScene({ clear: true, skipNodes: true, skipOverlay: true });
        const tPaths = performance.now();

        // ── 2) Node-layer cache with evenodd clip (excludes current-curve bbox) ──
        const { width: vw, height: vh } = c.viewportService.getCanvasUserSpaceSize();
        let clipActive = false;
        const clipR = c.current_curve ? this._getPaintHandleClipRect() : null;
        if (clipR && clipR.w > 0 && clipR.h > 0) {
            c.ctx.save();
            c.ctx.beginPath();
            c.ctx.rect(0, 0, vw, vh);
            c.ctx.rect(clipR.x, clipR.y, clipR.w, clipR.h);
            c.ctx.clip('evenodd');
            clipActive = true;
        }
        if (!this._isNodeLayerCacheValid()) this._captureNodeLayerCache();
        if (this._nodeLayerCache) this._blitSnapshotOnTop(this._nodeLayerCache);
        if (clipActive) c.ctx.restore();
        const tNodesBlit = performance.now();

        // ── 3) Current curve's nodes + chrome (single pass, no extra overlay loop) ──
        if (c.current_curve) {
            this._renderScene({
                clear: false,
                curveFilter: (curve) => curve?.id === c.current_curve.id,
                skipPathLayer: true
            });
        }
        if (c.hovered_node_marker) this._drawHoveredNode();
        const tEnd = performance.now();

        const dtPaths = tPaths - t0, dtBlit = tNodesBlit - tPaths,
              dtRest = tEnd - tNodesBlit;
        const dtTotal = tEnd - t0;
        if (dtPaths > 3 || dtBlit > 2 || dtRest > 2) {
            console.log(`[paint-handle#${seq}] paths=${dtPaths.toFixed(1)}ms  blit+clip=${dtBlit.toFixed(1)}ms  rest=${dtRest.toFixed(1)}ms  total=${dtTotal.toFixed(1)}ms`);
        }
        return true;
    }

    _renderZoomPreview() {
        const c = this.canvas;
        const cache = this._zoomPreviewCache;
        if (!cache || !cache.baseScale || !c.ctx) return false;
        const factor = c.scale / cache.baseScale;
        if (!Number.isFinite(factor) || factor <= 0) return false;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (width <= 0 || height <= 0) return false;
        const ruler = c.ruler_size;
        const baseLogicalX = ruler + cache.baseOffset.x;
        const baseLogicalY = ruler + cache.baseOffset.y;
        const currentLogicalX = ruler + c.offset.x;
        const currentLogicalY = ruler + c.offset.y;
        const tx = currentLogicalX - baseLogicalX * factor;
        const ty = currentLogicalY - baseLogicalY * factor;
        const dpr = cache.dpr;
        c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.ctx.clearRect(0, 0, width, height);
        // Delayed mode: soft blit only; settle does the exact crisp frame.
        c.ctx.imageSmoothingEnabled = true;
        c.ctx.drawImage(
            cache.canvas,
            0,
            0,
            cache.canvas.width,
            cache.canvas.height,
            tx,
            ty,
            cache.width * factor,
            cache.height * factor
        );
        return true;
    }

    _renderBoxSelectPreview() {
        const c = this.canvas;
        const cache = this._boxSelectPreviewCache;
        if (!cache || !c.is_box_selecting) return false;
        if (
            cache.scale !== c.scale ||
            cache.baseOffset.x !== c.offset.x ||
            cache.baseOffset.y !== c.offset.y
        ) {
            return false;
        }
        if (!this._blitSnapshot(cache)) return false;
        this._drawBoxSelectMarquee();
        return true;
    }

    _drawBoxSelectMarquee() {
        const c = this.canvas;
        if (!c.is_box_selecting || !c.box_select_start || !c.box_select_end || !c.ctx) return;
        const p = getCanvasTheme();
        c.ctx.save();
        c.ctx.strokeStyle = p.marquee_stroke;
        c.ctx.fillStyle = p.marquee_fill;
        c.ctx.lineWidth = 1;
        c.ctx.setLineDash([4, 4]);
        const x = Math.min(c.box_select_start.x, c.box_select_end.x);
        const y = Math.min(c.box_select_start.y, c.box_select_end.y);
        const w = Math.abs(c.box_select_start.x - c.box_select_end.x);
        const h = Math.abs(c.box_select_start.y - c.box_select_end.y);
        c.ctx.fillRect(x, y, w, h);
        c.ctx.strokeRect(x, y, w, h);
        c.ctx.restore();
    }

    invalidateStableSceneCache() {
        this._stableSceneCache = null;
        this._nodeLayerCache = null;
    }

    _refreshStableSceneCache() {
        const c = this.canvas;
        const cache = this._captureViewportSnapshot();
        if (!cache) return;
        cache.format = CanvasRendererService.STABLE_SCENE_FORMAT;
        cache.geometryEpoch = (c.curve_manager?._geometryEpoch || 0) ^ (c._geometryEpoch || 0);
        this._stableSceneCache = cache;
    }

    /**
     * Render the full overlay (all nodes with selection effects, no hover) to an offscreen canvas.
     * Used as the node layer cache; drawn via single blit each frame.
     */
    _captureNodeLayerCache() {
        const c = this.canvas;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (width <= 0 || height <= 0) return;
        const t0 = performance.now();

        // ── Phase A: offscreen canvas allocation ──
        const dpr = c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio();
        const tCanvas = performance.now();
        const cache = this._createCacheCanvas(width, height, dpr);
        if (!cache) return;
        const dtCanvas = performance.now() - tCanvas;

        // ── Phase B: render overlay to offscreen ──
        const originalCtx = c.ctx;
        const originalViewport = c.viewportConfig;
        const originalOffset = c.offset;
        const tRender = performance.now();
        try {
            c.ctx = cache.ctx;
            // Match the main canvas rendering: nearest-neighbor for sprite blits
            // so the cached node sprites composite identically when _drawHoveredNode
            // draws over them on the main canvas.
            c.ctx.imageSmoothingEnabled = false;
            c.viewportConfig = {
                ...(originalViewport || {}),
                userSpaceWidth: width,
                userSpaceHeight: height,
                viewportWidth: width,
                viewportHeight: height,
                devicePixelRatio: dpr
            };
            this._renderScene({
                skipPathLayer: true,
                overlayOnly: true,
                noHover: true
            });
        } finally {
            c.ctx = originalCtx;
            c.viewportConfig = originalViewport;
            c.offset = originalOffset;
        }
        const dtRender = performance.now() - tRender;

        // ── Phase C: metadata + log ──
        const tMeta = performance.now();
        cache.baseOffset = { x: c.offset.x, y: c.offset.y };
        cache.scale = c.scale;
        cache.viewportWidth = width;
        cache.viewportHeight = height;
        cache.geometryEpoch = (c.curve_manager?._geometryEpoch || 0) ^ (c._geometryEpoch || 0);
        cache.selCount = c.getInteractionSnapshot()?.selectedNodeMarkerIds?.size || 0;
        cache.activeTool = c.getActiveTool?.() || null;
        this._nodeLayerCache = cache;
        const totalMs = performance.now() - t0;
        if (totalMs > 50) {
            console.log(`[cache] render=${totalMs.toFixed(0)}ms  alloc=${dtCanvas.toFixed(1)}ms  scene=${dtRender.toFixed(0)}ms  (${width}x${height} @${dpr}x)`);
        }
    }

    /**
     * Draw the single hovered node on top of the cached node layer.
     * Uses domMap O(1) lookup instead of forEachPathPass (~5s for 4096 nodes).
     */
    _drawHoveredNode() {
        const c = this.canvas;
        const marker = c.hovered_node_marker;
        if (!marker || !c.ctx) return;
        // PAINTING_HANDLE already embeds the hover effect in its step-3
        // _renderScene call (curveFilter removes noHover), so the overlay
        // here would double-draw and cause alpha accumulation.
        if (c.current_state === "PAINTING_HANDLE") return;
        // O(1) node lookup via domMap (could return main node or control handle).
        const hitNode = c.curve_manager?.find_node_by_curve?.(marker);
        if (!hitNode) return;
        const curve = hitNode.curve;
        if (!curve) return;
        // Determine the main node to draw and which parts are hovered.
        const isCtrl = hitNode.type === null && hitNode.nextOnCurve?.type !== null;
        const mainNode = isCtrl ? hitNode.nextOnCurve : hitNode;
        if (!mainNode) return;
        const isMainHov = !isCtrl;
        const isC1Hov = !isMainHov && mainNode.control1 && marker === mainNode.control1.main_node;
        const isC2Hov = !isMainHov && !isC1Hov && mainNode.control2 && marker === mainNode.control2.main_node;
        // Find seqOffsetX for this curve's group.
        const groupId = curve.groupId;
        const seqTokens = c.curve_manager.sequenceTokens || [];
        let seqOffsetX = 0;
        for (let i = 0; i < seqTokens.length; i++) {
            const token = seqTokens[i];
            const gid = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            if (gid === groupId) { seqOffsetX = c.curve_manager.getSeqOffset(i); break; }
        }
        // Find curve data for matrix.
        let cdMatrix = null;
        const cdl = c.curve_manager.getCurvesForGroup(groupId);
        if (cdl) {
            for (const cd of cdl) {
                if (cd.curve === curve) { cdMatrix = cd.matrix; break; }
            }
        }
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cdMatrix || null };
        const p = getCanvasTheme();
        const ix = c.getInteractionSnapshot();
        const isSelected = snapshotIncludesNodeMarker(ix, mainNode.main_node);

        // Compute showHandles matching _renderScene logic.
        let showHandles = false;
        if (mainNode.curve) {
            const cId = mainNode.curve.id;
            if (ix.selectedCurveIds?.has(cId)) showHandles = true;
        }
        if (!showHandles && c.current_curve && mainNode.curve === c.current_curve) showHandles = true;
        if (!showHandles && isSelected) showHandles = true;
        if (!showHandles && ix.selectedNodeMarkerIds?.size) {
            for (const selMarker of ix.selectedNodeMarkerIds) {
                const selNode = c.curve_manager?.find_node_by_curve?.(selMarker);
                if (!selNode || selNode.curve !== mainNode.curve) continue;
                if (selNode.lastOnCurve === mainNode || selNode.nextOnCurve === mainNode) {
                    showHandles = true; break;
                }
                if (mainNode.curve?.closed) {
                    if (selNode === mainNode.curve.startNode && mainNode === mainNode.curve.endNode) { showHandles = true; break; }
                    if (selNode === mainNode.curve.endNode && mainNode === mainNode.curve.startNode) { showHandles = true; break; }
                }
            }
        }

        // The node layer cache was blitted with the evenodd clip excluding
        // only the body shape (plus the hovered handle sprite for control
        // hover), so those specific pixels are drawn fresh at clean alpha.
        // showHandles=false keeps handle lines + non-hovered sprites single-
        // draw from the cache — no line thickening, no sprite doubling.
        const mapPt = createViewportTransform(viewport);
        drawCurveNode(c.ctx, mainNode, viewport, p, {
            isSelected, showHandles: false,
            precomputedMap: mapPt,
            hoverStates: { main: isMainHov, c1: isC1Hov, c2: isC2Hov }
        });
        // Control hover: the evenodd clip also excluded the normal handle
        // sprite (r=3).  Draw the enlarged handle on top so the user sees
        // the hover effect at clean alpha.
        if (!isMainHov) {
            const hoveredHandle = isC1Hov ? mainNode.control1 : mainNode.control2;
            if (hoveredHandle) {
                drawHoveredHandle(c.ctx, hoveredHandle, viewport, p, isSelected);
            }
        }
    }

    /** Apply evenodd clip excluding the hovered node's body shape (plus
     *  the hovered handle sprite for control hover) so the node layer cache
     *  blit leaves those pixels transparent.  The hovered node is then
     *  redrawn at clean alpha by _drawHoveredNode — the body-shaped hole
     *  avoids excluding other nodes that pass through a rectangular bbox.
     *  Returns true if clip was applied (caller must restore ctx after blit). */
    _applyHoverClip(c, logicalW, logicalH) {
        const marker = c.hovered_node_marker;
        if (!marker) return false;
        const hitNode = c.curve_manager?.find_node_by_curve?.(marker);
        if (!hitNode || !hitNode.curve) return false;
        const isCtrl = hitNode.type === null && hitNode.nextOnCurve?.type !== null;
        const mainNode = isCtrl ? hitNode.nextOnCurve : hitNode;
        if (!mainNode) return false;
        const curve = hitNode.curve;
        const groupId = curve.groupId;
        const seqTokens = c.curve_manager.sequenceTokens || [];
        let seqOffsetX = 0;
        for (let i = 0; i < seqTokens.length; i++) {
            const token = seqTokens[i];
            const gid = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            if (gid === groupId) { seqOffsetX = c.curve_manager.getSeqOffset(i); break; }
        }
        let cdMatrix = null;
        const cdl = c.curve_manager.getCurvesForGroup(groupId);
        if (cdl) {
            for (const cd of cdl) {
                if (cd.curve === curve) { cdMatrix = cd.matrix; break; }
            }
        }
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cdMatrix || null };
        const mapPt = createViewportTransform(viewport);
        const { x: sx, y: sy } = mapPt(mainNode.x, mainNode.y);
        const isMainHov = !isCtrl;
        const isC1Hov = !isMainHov && mainNode.control1 && marker === mainNode.control1.main_node;
        const isC2Hov = !isMainHov && !isC1Hov && mainNode.control2 && marker === mainNode.control2.main_node;
        const baseR = 4.2;
        c.ctx.save();
        c.ctx.beginPath();
        // Full canvas rect — everything in clip by default (odd crossings).
        c.ctx.rect(0, 0, logicalW, logicalH);
        // Body shape sub-path — creates a hole (even crossings) so the body
        // pixels are excluded from the cache blit.  Shape matches node_renderer
        // _buildNodeSprite: circle (mode=2), diamond (mode=0), square (mode=1).
        if (mainNode.control_mode === 2) {
            c.ctx.arc(sx, sy, baseR, 0, Math.PI * 2);
        } else if (mainNode.control_mode === 0) {
            const d = baseR * 1.25;
            c.ctx.moveTo(sx, sy - d);
            c.ctx.lineTo(sx + d, sy);
            c.ctx.lineTo(sx, sy + d);
            c.ctx.lineTo(sx - d, sy);
            c.ctx.closePath();
        } else {
            const s = baseR * 0.9;
            c.ctx.rect(sx - s, sy - s, s * 2, s * 2);
        }
        // Control hover: also exclude the normal handle sprite circle (r=3).
        // The enlarged handle is drawn by drawHoveredHandle after the blit.
        if (!isMainHov) {
            const handle = isC1Hov ? mainNode.control1 : mainNode.control2;
            if (handle) {
                const hp = mapPt(handle.x, handle.y);
                c.ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
            }
        }
        c.ctx.clip('evenodd');
        return true;
    }

    _isNodeLayerCacheValid() {
        if (!this._nodeLayerCache) return false;
        const c = this.canvas;
        const epoch = (c.curve_manager?._geometryEpoch || 0) ^ (c._geometryEpoch || 0);
        if (this._nodeLayerCache.geometryEpoch !== epoch) return false;
        if (this._nodeLayerCache.scale !== c.scale) return false;
        if (this._nodeLayerCache.baseOffset.x !== c.offset.x || this._nodeLayerCache.baseOffset.y !== c.offset.y) return false;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (this._nodeLayerCache.viewportWidth !== width || this._nodeLayerCache.viewportHeight !== height) return false;
        // Invalidate when selection count changes (cache has selection colors baked in).
        const curSel = c.getInteractionSnapshot()?.selectedNodeMarkerIds?.size || 0;
        if (this._nodeLayerCache.selCount !== curSel) return false;
        // Invalidate when active tool changes (cache may have NODE overlay visible for DRAW tool).
        const curTool = c.getActiveTool?.() || null;
        if (this._nodeLayerCache.activeTool !== curTool) return false;
        return true;
    }

    _tryRenderFromStableScene() {
        const c = this.canvas;
        const cache = this._stableSceneCache;
        if (!cache) { return false; }
        if (c.current_state === "TRANSFORMING_OBJECTS" && c.transform_started_moving) {
            return false;
        }
        if (
            c.current_state === "DRAGGING_USER_GUIDE" ||
            c.current_state === "DRAGGING_METRIC_GUIDE" ||
            c.current_state === "DRAGGING_DIVIDER"
        ) {
            return false;
        }
        if (c.current_state === "DRAGGING_NODE" || c.current_state === "DRAGGING_NODE_READY") {
            return false;
        }
        // PAINTING_HANDLE uses its own preview path (_renderPaintHandlePreview).
        if (c.current_state === "PAINTING_HANDLE") {
            return false;
        }
        if (cache.format !== CanvasRendererService.STABLE_SCENE_FORMAT) return false;
        const epoch = (c.curve_manager?._geometryEpoch || 0) ^ (c._geometryEpoch || 0);
        if (cache.geometryEpoch !== epoch) return false;
        if (cache.scale !== c.scale) return false;
        if (cache.baseOffset.x !== c.offset.x || cache.baseOffset.y !== c.offset.y) return false;
        const { width, height } = c.viewportService.getCanvasUserSpaceSize();
        if (cache.viewportWidth !== width || cache.viewportHeight !== height) return false;
        if (!this._blitSnapshot(cache)) return false;
        // Node layer cache: blit cached overlay (all nodes + selection, no hover).
        // CRITICAL: skip forEachPathPass traversal entirely — iterating 4096 nodes takes ~5s.
        if (!this._isNodeLayerCacheValid()) {
            this._captureNodeLayerCache();
        }
        if (this._nodeLayerCache) {
            // Body-shaped evenodd clip: exclude the hovered node body (and
            // for control hover, the handle sprite) so those pixels draw
            // fresh via _drawHoveredNode — no alpha accumulation, no white
            // box covering other nodes.
            const hadClip = this._applyHoverClip(c, width, height);
            if (hadClip) {
                this._blitSnapshotOnTop(this._nodeLayerCache);
                c.ctx.restore();
            } else {
                this._blitSnapshotOnTop(this._nodeLayerCache);
            }
        }
        // Draw just the hovered node on top (O(1) via domMap, no forEachPathPass iteration).
        if (c.hovered_node_marker) {
            this._drawHoveredNode();
        }
        // Render chrome on top of cached scene (previewData, guidelines, metrics, dividers).
        // Paths + nodes are already in their respective caches; skip both for perf.
        this._renderScene({ clear: false, skipPathLayer: true, skipNodes: true });
        return true;
    }

    renderCanvas() {
        const state = this.canvas.current_state;
        if (state === "PANNING" && this._renderViewportPreview()) return;
        if (this._zoomPreviewCache && this._renderZoomPreview()) return;
        if (state === "DRAGGING_NODE" && this._renderNodeDragPreview()) return;
        if (state === "DRAGGING_NODE") {
            this._renderScene({ sparseNodes: true });
            return;
        }
        if (state === "PAINTING_HANDLE" && this._renderPaintHandlePreview()) return;
        if (this.canvas.is_box_selecting && this._renderBoxSelectPreview()) return;
        const t0 = performance.now();
        const hit = this._tryRenderFromStableScene();
        const dt = performance.now() - t0;
        if (hit) {
            if (dt > 500) console.log(`[rc] cache-hit ${dt.toFixed(0)}ms`);
            return;
        }
        const tFull = performance.now();
        this._renderScene({ captureStableBeforeSelection: true });
        const fullDt = performance.now() - tFull;
        if (fullDt > 100) console.log(`[rc] full-render ${fullDt.toFixed(0)}ms`);
    }

    _renderScene({
        clear = true,
        curveFilter = null,
        skipNodes = false,
        sparseNodes = false,
        overlayOnly = false,
        /** Paths already blitted (stable scene); skip fill/stroke emit, still draw chrome. */
        skipPathLayer = false,
        /** Curve ids that still get node markers even when omitted from pathFilter. */
        extraNodeCurveIds = null,
        /** Markers omitted from node pass (moving nodes during drag bake). */
        excludeNodeMarkers = null,
        viewCullRect = null,
        captureStableBeforeSelection = false,
        /** Only path fill/stroke — no nodes, guides, selection chrome (pan edge strips). */
        pathsOnly = false,
        /** Only node markers — no paths/chrome (node-drag top layer bake). */
        nodesOnly = false,
        /** Skip the node-handle overlay pass entirely. */
        skipOverlay = false,
        /** When true, force hoverStates to {} (for caching overlay without hover baked in). */
        noHover = false,
        /** Skip character preview text + image children (they're already in the cached blit). */
        skipCharsAndImages = false
    } = {}) {
        const c = this.canvas;
        if (!c.ctx) return;
        const trackExactCost = clear && !overlayOnly && !skipPathLayer && !viewCullRect && !curveFilter && !pathsOnly && !nodesOnly;
        const renderStartedAt = trackExactCost ? performance.now() : 0;
        const dpr = c.viewportConfig?.devicePixelRatio || c.env.getDevicePixelRatio();
        const { width: logicalW, height: logicalH } = c.viewportService.getCanvasUserSpaceSize();
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();

        // ── Clear canvas ──
        c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (clear && logicalW > 0 && logicalH > 0) c.ctx.clearRect(0, 0, logicalW, logicalH);

        // Viewport bounds in world coordinates (for viewport culling)
        const cull = viewCullRect || { x: 0, y: 0, w: logicalW, h: logicalH };
        const vpBounds = {
            minX: (cull.x - offsetX) / c.scale,
            minY: (cull.y - offsetY) / c.scale,
            maxX: (cull.x + cull.w - offsetX) / c.scale,
            maxY: (cull.y + cull.h - offsetY) / c.scale
        };
        const ix = c.getInteractionSnapshot();
        let seqTokens = c.curve_manager.sequenceTokens || [];
        let activeIndices = c.curve_manager.activeSequenceIndices;
        const p = getCanvasTheme();
        const getCurveDataList = (groupId) => {
            const list = c.curve_manager.getCurvesForGroup(groupId);
            return curveFilter ? list.filter((cd) => curveFilter(cd.curve, cd)) : list;
        };
        const getNodeCurveDataList = (groupId) => {
            const list = c.curve_manager.getCurvesForGroup(groupId);
            if (!curveFilter && !extraNodeCurveIds?.size) return list;
            return list.filter((cd) => {
                const id = cd.curve?.id;
                if (id && extraNodeCurveIds?.has(id)) return true;
                if (curveFilter) return curveFilter(cd.curve, cd);
                return true;
            });
        };

        // When many curves exist, restrict path/node passes to viewport AABB candidates.
        // viewCullRect: ALWAYS iterate query hits (or node-grid fallback) — never fall back
        // to a full O(C) walk (approxCells gate previously disabled this when zoomed out).
        let viewportCurveKeys = null;
        /** @type {Array<{seqIdx:number, seqOffsetX:number, curves:Array}>|null} */
        let cullPasses = null;
        const grid = c.curve_manager?.spatialGrid;
        const curveInstanceCount = grid?._curveToCells?.size || 0;
        const pad = 2;
        const vpW = (vpBounds.maxX - vpBounds.minX) + pad * 2;
        const vpH = (vpBounds.maxY - vpBounds.minY) + pad * 2;

        const buildPassesFromCurveEntries = (entries) => {
            const keys = new Set();
            const bySeq = new Map();
            for (const e of entries) {
                const id = e.curveId || e.curve?.id;
                if (!id || !e.curve?.startNode) continue;
                if (!activeIndices.has(e.seqIdx)) continue;
                keys.add(`${id}|${e.seqIdx ?? ""}|${e.refId ?? ""}`);
                let pass = bySeq.get(e.seqIdx);
                if (!pass) {
                    pass = {
                        seqIdx: e.seqIdx,
                        seqOffsetX: e.seqOffsetX ?? c.curve_manager.getSeqOffset(e.seqIdx),
                        curves: []
                    };
                    bySeq.set(e.seqIdx, pass);
                }
                pass.curves.push({
                    curve: e.curve,
                    matrix: e.matrix || new DOMMatrix(),
                    refId: e.refId ?? null,
                    effectiveVis: true,
                    effectiveLock: false
                });
            }
            return {
                keys,
                passes: [...bySeq.values()].sort((a, b) => a.seqIdx - b.seqIdx)
            };
        };

        if (!curveFilter && !nodesOnly && grid) {
            if (viewCullRect && typeof grid.queryCurvesRect === "function") {
                let entries = curveInstanceCount > 0
                    ? grid.queryCurvesRect(vpBounds.minX - pad, vpBounds.minY - pad, vpW, vpH)
                    : [];
                // Single-node paths: if curve AABB index is cold/empty, derive from node grid.
                if (entries.length === 0 && typeof grid.queryRect === "function" && grid.size > 0) {
                    const seen = new Set();
                    entries = [];
                    for (const e of grid.queryRect(vpBounds.minX - pad, vpBounds.minY - pad, vpW, vpH)) {
                        const id = e.curve?.id;
                        if (!id) continue;
                        const k = `${id}|${e.seqIdx ?? ""}|${e.refId ?? ""}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        entries.push({
                            curve: e.curve,
                            curveId: id,
                            seqIdx: e.seqIdx,
                            seqOffsetX: e.seqOffsetX,
                            matrix: e.matrix,
                            refId: e.refId ?? null
                        });
                    }
                }
                const built = buildPassesFromCurveEntries(entries);
                viewportCurveKeys = built.keys;
                // Density escape: fall back to full walk with viewportCurveKeys filtering
                // instead of building strip geometry for too many candidates.
                let candCount = 0;
                for (const pass of built.passes) candCount += pass.curves.length;
                cullPasses = candCount > 400 ? null : built.passes;
            } else if (
                typeof grid.queryCurvesRect === "function" &&
                curveInstanceCount > 32
            ) {
                const cell = grid.cellSize || 10;
                const approxCells =
                    Math.ceil(Math.max(1, vpW) / cell) * Math.ceil(Math.max(1, vpH) / cell);
                if (approxCells <= 4096) {
                    const entries = grid.queryCurvesRect(
                        vpBounds.minX - pad,
                        vpBounds.minY - pad,
                        vpW,
                        vpH
                    );
                    if (entries.length < curveInstanceCount * 0.85) {
                        const built = buildPassesFromCurveEntries(entries);
                        viewportCurveKeys = built.keys;
                    }
                }
            }
        }
        // _isCurveInViewport below is the sole visibility filter. The grid query's
        // viewportCurveKeys pre-filter is disabled because it can miss curves near cell
        // boundaries or with stale AABBs at high zoom — leading to false negatives
        // that _isCurveInViewport can never correct (the curve never reaches it).
        const isCurveInstanceVisible = () => true;
        const skipViewportBoundsCheck = skipPathLayer;

        /** Path/node instance lists: cullPasses when set, else full sequence walk. */
        const forEachPathPass = (fn) => {
            if (cullPasses) {
                for (const pass of cullPasses) {
                    fn(pass.seqIdx, pass.seqOffsetX, pass.curves, pass.curves);
                }
                return;
            }
            for (let i = 0; i < seqTokens.length; i++) {
                const seqOffsetX = c.curve_manager.getSeqOffset(i);
                const token = seqTokens[i];
                const groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let curveDataList = getCurveDataList(groupId);
                if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                    if (!curveDataList.find((cd) => cd.curve === c.current_curve)) {
                        curveDataList = curveDataList.concat([{
                            curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false
                        }]);
                    }
                }
                let nodeCurveDataList = getNodeCurveDataList(groupId);
                if (shouldIncludeCurrentDrawingCurve(c, ix, groupId)) {
                    if (!nodeCurveDataList.find((cd) => cd.curve === c.current_curve)) {
                        nodeCurveDataList = nodeCurveDataList.concat([{
                            curve: c.current_curve, matrix: new DOMMatrix(), refId: null, effectiveVis: true, effectiveLock: false
                        }]);
                    }
                }
                fn(i, seqOffsetX, curveDataList, nodeCurveDataList);
            }
        };

        // overlayOnly / skipPathLayer / nodesOnly / pan strips: blit already has static content.
        // pathsOnly still draws char preview + images (scene under nodes); viewCullRect strips skip them.
        if (!overlayOnly && !skipPathLayer && !nodesOnly && !viewCullRect && !skipCharsAndImages) for (let i = 0; i < seqTokens.length; i++) {
            let seqOffsetX = c.curve_manager.getSeqOffset(i);
            let token = seqTokens[i];
            let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
            let group = c.curve_manager.treeItems.get(groupId);
            let charCode = group?.charCode;
            if (charCode != null) {
                let displayChar;
                if (typeof charCode === "string") {
                    displayChar = charCode;
                } else if (typeof charCode === "number" && Number.isFinite(charCode) && charCode > 0) {
                    try { displayChar = String.fromCodePoint(charCode); } catch (_) { displayChar = null; }
                }
                if (displayChar) {
                    let advance = (group && group.advance !== undefined) ? group.advance : 1000;
                    // Viewport culling: skip char preview if group is outside visible range
                    if (seqOffsetX + advance < vpBounds.minX || seqOffsetX > vpBounds.maxX) continue;
                    let fontH = c.canvas_size_height * c.scale;
                    let cx = (seqOffsetX + advance / 2) * c.scale + offsetX;
                    let baselineY = offsetY + 0.8 * fontH;
                    c.ctx.save();
                    c.ctx.font = `${fontH}px sans-serif`;
                    c.ctx.textAlign = "center";
                    c.ctx.textBaseline = "alphabetic";
                    c.ctx.fillStyle = p.char_preview_color;
                    c.ctx.fillText(displayChar, cx, baselineY);
                    c.ctx.restore();
                }
            }
        }
        if (!overlayOnly && !skipPathLayer && !nodesOnly && !viewCullRect && !skipCharsAndImages) {
            for (let i = 0; i < seqTokens.length; i++) {
                let seqOffsetX = c.curve_manager.getSeqOffset(i);
                let token = seqTokens[i];
                let groupId = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                const imgGroup = c.curve_manager.treeItems.get(groupId);
                const childrenIds = imgGroup?.children || [];
                childrenIds.forEach((id) => {
                    const item = c.curve_manager.treeItems.get(id);
                    if (item && item.type === "image" && item.visible) {
                        c.ctx.save();
                        c.ctx.translate(offsetX + seqOffsetX * c.scale, offsetY);
                        c.ctx.scale(c.scale, c.scale);
                        const m = item.transform;
                        c.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                        c.ctx.drawImage(item.image, 0, 0);
                        c.ctx.restore();
                    }
                });
            }
            // Render root-level images (not associated with any sequence group)
            const rootChildren = c.curve_manager.rootChildren || [];
            rootChildren.forEach((id) => {
                const item = c.curve_manager.treeItems.get(id);
                if (item && item.type === "image" && item.visible) {
                    c.ctx.save();
                    c.ctx.translate(offsetX, offsetY);
                    c.ctx.scale(c.scale, c.scale);
                    const m = item.transform;
                    c.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                    c.ctx.drawImage(item.image, 0, 0);
                    c.ctx.restore();
                }
            });
        }
        // ── Build showHandlesSet from selection state (avoid iterating ALL nodes per frame) ──
        let globalShowHandlesSet = new Set();
        const curveStore = c.curve_manager.curveStore;
        const addToShowHandles = (node, curve) => {
            if (!node) return;
            globalShowHandlesSet.add(node);
            if (node.lastOnCurve) globalShowHandlesSet.add(node.lastOnCurve);
            if (node.nextOnCurve) globalShowHandlesSet.add(node.nextOnCurve);
            if (curve?.closed) {
                if (node === curve.startNode && curve.endNode) globalShowHandlesSet.add(curve.endNode);
                if (node === curve.endNode && curve.startNode) globalShowHandlesSet.add(curve.startNode);
            }
        };
        const addAllNodes = (curve) => {
            if (!curve || !curve.startNode) return;
            let cur = curve.startNode;
            while (cur) { addToShowHandles(cur, curve); cur = cur.nextOnCurve; }
        };
        // sparseNodes (drag overlay): only selected markers + neighbors — never whole curves.
        if (!sparseNodes) {
            for (const curveId of (ix.selectedCurveIds || [])) {
                const curve = curveStore.curveById.get(curveId);
                if (curve) addAllNodes(curve);
            }
            if (c.current_curve) addAllNodes(c.current_curve);
        }
        const selMarkers = ix.selectedNodeMarkerIds;
        if (selMarkers && selMarkers.size > 0) {
            for (const marker of selMarkers) {
                const node = curveStore.domMap.get(marker);
                if (node) addToShowHandles(node, node.curve);
            }
        }
        if (sparseNodes && c.drag_initial_nodes?.size) {
            for (const marker of c.drag_initial_nodes.keys()) {
                const node = curveStore.domMap.get(marker);
                if (node) addToShowHandles(node, node.curve);
            }
        }
        // Control-handle drag may not list the parent in drag_initial_nodes; still need live handles.
        if (sparseNodes && c.dragging_node_marker) {
            const dragged =
                curveStore.domMap.get(c.dragging_node_marker) ||
                c.curve_manager?.find_node_by_curve?.(c.dragging_node_marker);
            if (dragged) {
                if (dragged.type == null) {
                    const parent = dragged.nextOnCurve || dragged.lastOnCurve;
                    if (parent) addToShowHandles(parent, parent.curve);
                } else {
                    addToShowHandles(dragged, dragged.curve);
                }
            }
        }

        // ── PASS 1: Curve fill + stroke ──
        // skipPathLayer: stable blit already has path pixels (avoid covering guides/chrome).
        const tPass1 = performance.now();
        if (!skipPathLayer && !nodesOnly) {
            let _pLoopMs = 0, _pFillMs = 0, _pStrokeMs = 0, _pCurveCount = 0;
            const _pT0 = performance.now();
            forEachPathPass((i, seqOffsetX, curveDataList) => {
            // ── Fill (batched per-group; Path2D smart fills drawn individually) ──
            const _tFill0 = performance.now();
            c.ctx.beginPath();
            let hasFill = false;
            const path2dFills = [];
            for (const cd of curveDataList) {
                if (!cd.effectiveVis) continue;
                if (cd.curve?.startNode) {
                    if (!isCurveInstanceVisible(cd.curve, i, cd.refId ?? null)) continue;
                    if (!skipViewportBoundsCheck && !this._isCurveInViewport(cd.curve, cd.matrix, seqOffsetX, vpBounds)) continue;
                    const refId = cd.refId ?? null;
                    const strokePreview = isCurveStrokePreview(c, cd.curve.id, refId);
                    if (!shouldBatchFillCurve(cd.curve, { strokePreview })) continue;
                    const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                    if (canFillSmartStrokeWithPath2D(cd.curve, { strokePreview })) {
                        path2dFills.push({ curve: cd.curve, viewport });
                        continue;
                    }
                    appendCurveFillPath(c.ctx, cd.curve, viewport, {
                        refId,
                        strokePreview
                    });
                    hasFill = true;
                }
            }
            if (hasFill) { c.ctx.fillStyle = p.path_fill_color; c.ctx.fill("nonzero"); }
            for (const item of path2dFills) {
                fillSmartStrokePath2D(c.ctx, item.curve, item.viewport, p.path_fill_color);
            }
            _pFillMs += performance.now() - _tFill0;

            // ── Stroke (per-curve) ──
            const _tStroke0 = performance.now();
            for (const cd of curveDataList) {
                if (!cd.effectiveVis) continue;
                if (cd.curve?.startNode) {
                    if (!isCurveInstanceVisible(cd.curve, i, cd.refId ?? null)) continue;
                    if (!skipViewportBoundsCheck && !this._isCurveInViewport(cd.curve, cd.matrix, seqOffsetX, vpBounds)) continue;
                    const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                    const refId = cd.refId ?? null;
                    drawCurveStroke(c.ctx, cd.curve, viewport, p, {
                        renderMode: "stroke",
                        refId,
                        strokePreview: isCurveStrokePreview(c, cd.curve.id, refId)
                    });
                    _pCurveCount++;
                }
            }
            _pStrokeMs += performance.now() - _tStroke0;
            });
            _pLoopMs = performance.now() - _pT0 - _pFillMs - _pStrokeMs;
            const dtP1 = performance.now() - tPass1;
            if (_pCurveCount < 100 && dtP1 > 3) {
                console.log(`[rc] pass1-paths: fill=${_pFillMs.toFixed(1)}ms  stroke=${_pStrokeMs.toFixed(1)}ms  loop=${_pLoopMs.toFixed(1)}ms  curves=${_pCurveCount}  total=${dtP1.toFixed(1)}ms`);
            } else if (dtP1 > 100) {
                console.log(`[rc] pass1-paths ${dtP1.toFixed(0)}ms  fill=${_pFillMs.toFixed(0)}ms  stroke=${_pStrokeMs.toFixed(0)}ms  loop=${_pLoopMs.toFixed(0)}ms  curves=${_pCurveCount}`);
            }
        }

        // Path pixels only — nodes/chrome stay out so NODE→SELECT cannot leave marker ghosts,
        // and guide/selection drags can redraw chrome without stale blits.
        if (
            captureStableBeforeSelection &&
            clear &&
            !overlayOnly &&
            !skipPathLayer &&
            !viewCullRect &&
            !curveFilter &&
            !pathsOnly &&
            !nodesOnly
        ) {
            this._refreshStableSceneCache();
        }

        // Pan edge strips: paths only — skip nodes + chrome (exact frame on pan end).
        if (pathsOnly) {
            if (trackExactCost) this._lastExactRenderMs = performance.now() - renderStartedAt;
            return;
        }

        // ── PASS 2: Overlays ──
        // SELECT/MEASURE/ELLIPSE tools don't render node handles or hovered segments;
        // the forEachPathPass traversal is pure overhead. Skip it entirely.
        const _overlayTool = c.getActiveTool?.() || 'SELECT';
        const _overlayNTokens = seqTokens.length;
        let _overlayFnCalls = 0;
        let tOverlay = 0;
        if (skipOverlay || _overlayTool === 'SELECT' || _overlayTool === 'MEASURE' || _overlayTool === 'ELLIPSE') {
            // no overlay work needed for these tools
        } else if (captureStableBeforeSelection && !this._isNodeLayerCacheValid()) {
            // Cache miss: render overlay to offscreen ONCE, cache it, blit to main canvas.
            // Avoids double render (main canvas + cache) on the next frame.
            this._captureNodeLayerCache();
            // Body-shaped evenodd clip: exclude the hovered node body (and
            // for control hover, the handle sprite) so those pixels draw
            // fresh via _drawHoveredNode — no alpha accumulation, no white
            // box covering other nodes.
            const hadClip = !noHover && c.hovered_node_marker && this._applyHoverClip(c, logicalW, logicalH);
            if (hadClip) {
                this._blitSnapshotOnTop(this._nodeLayerCache);
                c.ctx.restore();
            } else {
                this._blitSnapshotOnTop(this._nodeLayerCache);
            }
            // The cache was captured with noHover=true — redraw the hovered node
            // on top so it stays enlarged immediately after selection change
            // (click) rather than shrinking until the next mousemove.
            if (c.hovered_node_marker) this._drawHoveredNode();
        } else {
        tOverlay = performance.now();
        forEachPathPass((i, seqOffsetX, curveDataList, nodeCurveDataList) => {
            _overlayFnCalls++;
            // ── Hovered curve segment overlay ──
            if (!overlayOnly && c.hovered_curve_segment && c.getActiveTool() !== "SELECT" && c.hovered_curve_segment.seqIndex === i) {
                const seg = c.hovered_curve_segment;
                for (const cd of curveDataList) {
                    if (seg.curve === cd.curve && seg.refId === cd.refId) {
                        const current = seg.startNode; const next = seg.nextNode;
                        if (!current || !next) continue;
                        const pt = (x, y) => {
                            let mx = x, my = y;
                            if (cd.matrix) { mx = x * cd.matrix.a + y * cd.matrix.c + cd.matrix.e; my = x * cd.matrix.b + y * cd.matrix.d + cd.matrix.f; }
                            return { x: (mx + seqOffsetX) * c.scale + offsetX, y: my * c.scale + offsetY };
                        };
                        c.ctx.save(); c.ctx.beginPath();
                        let p0 = pt(current.x, current.y); c.ctx.moveTo(p0.x, p0.y);
                        let cp1 = pt(current.control1?.x ?? current.x, current.control1?.y ?? current.y);
                        let cp2 = pt(next.control2?.x ?? next.x, next.control2?.y ?? next.y);
                        let endP = pt(next.x, next.y);
                        c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endP.x, endP.y);
                        c.ctx.lineWidth = 3; c.ctx.strokeStyle = p.hovered_curve_stroke_color; c.ctx.stroke(); c.ctx.restore();
                    }
                }
            }

            // ── Node handles ──
            if (!skipNodes && activeIndices.has(i)) {
                const _tb4 = performance.now();
                let _nCurves = 0; let _nNodes = 0;
                const _tFilter = performance.now();
                // Single filter pass: collect passing curves into _filtered[].
                // Reads hot properties into locals to avoid repeated accessor dispatch (~4× faster).
                const _filtered = [];
                const _tool = c.getActiveTool();
                const _isSelDraw = _tool === "SELECT" || _tool === "MEASURE" || _tool === "ELLIPSE";
                const _isToolDraw = _tool === "DRAW";
                for (const cd of nodeCurveDataList) {
                    if (!cd.effectiveVis || cd.effectiveLock) continue;
                    if (_isSelDraw) continue;
                    if (_isToolDraw && cd.curve !== c.current_curve) continue;
                    if (!isCurveInstanceVisible(cd.curve, i, cd.refId ?? null)) continue;
                    if (!skipViewportBoundsCheck && !this._isCurveInViewport(cd.curve, cd.matrix, seqOffsetX, vpBounds)) continue;
                    _filtered.push(cd);
                }
                const _nFiltered = _filtered.length;
                // Draw only from filtered list (no re-filtering needed).
                if (_nFiltered > 0) {
                    const _tFilterDone = performance.now();
                    for (const cd of _filtered) {
                        const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX, matrix: cd.matrix };
                        const mapPt = createViewportTransform(viewport);
                        let start_node = cd.curve.startNode;
                        while (start_node !== null) {
                            _nNodes++;
                            const marker = start_node.main_node;
                            if (excludeNodeMarkers?.size) {
                                const c1m = start_node.control1?.main_node;
                                const c2m = start_node.control2?.main_node;
                                const excluded =
                                    excludeNodeMarkers.has(marker) ||
                                    excludeNodeMarkers.has(marker?.id) ||
                                    (c1m && (excludeNodeMarkers.has(c1m) || excludeNodeMarkers.has(c1m.id))) ||
                                    (c2m && (excludeNodeMarkers.has(c2m) || excludeNodeMarkers.has(c2m.id)));
                                if (excluded) {
                                    start_node = start_node.nextOnCurve;
                                    continue;
                                }
                            }
                            let isSelected = snapshotIncludesNodeMarker(ix, marker);
                            let showHandles = globalShowHandlesSet.has(start_node);
                            if (sparseNodes && !isSelected && !showHandles) {
                                start_node = start_node.nextOnCurve;
                                continue;
                            }
                            let nodeToDraw = start_node;
                            drawCurveNode(c.ctx, nodeToDraw, viewport, p, { isSelected, showHandles, precomputedMap: mapPt,
                                hoverStates: noHover ? {} : { main: c.hovered_node_marker === marker, c1: start_node.control1 && c.hovered_node_marker === start_node.control1.main_node, c2: start_node.control2 && c.hovered_node_marker === start_node.control2.main_node }
                            });
                            start_node = start_node.nextOnCurve;
                        }
                    }
                    const _tDone = performance.now();
                    const _dtF = _tDone - _tFilter;
                    if (_dtF > 10) {
                        console.log(`[rc] draw-filtered: filter=${(_tFilterDone-_tFilter).toFixed(0)}ms  draw=${(_tDone-_tFilterDone).toFixed(0)}ms  total=${_dtF.toFixed(0)}ms  curves=${_filtered.length} nodes=${_nNodes}`);
                    }
                }
                const _dtN = performance.now() - _tb4;
                if (_dtN > 100) console.log(`[rc] nodes=${_dtN.toFixed(0)}ms curves=${_nFiltered} nodes=${_nNodes}`);
            }
        }); // end forEachPathPass overlay
        } // end else (tool needs overlay)
        if (_overlayFnCalls > 0) {
            const dtOverlay = performance.now() - tOverlay;
            if (dtOverlay > 50) console.log(`[rc] overlay=${dtOverlay.toFixed(0)}ms tokens=${_overlayNTokens} fnCalls=${_overlayFnCalls}`);
        }
        if (nodesOnly) {
            if (trackExactCost) this._lastExactRenderMs = performance.now() - renderStartedAt;
            return;
        }
        // Pan edge strips: paths + nodes only. Guides/selection already live on the blit;
        // re-emitting full chrome here was O(extra work) every frame for no benefit.
        if (viewCullRect) {
            if (trackExactCost) this._lastExactRenderMs = performance.now() - renderStartedAt;
            return;
        }
        const tChrome = performance.now();
        if (!overlayOnly && c.previewData && c.last_on_curve_node_marker) {
            const pd = c.previewData;
            c.ctx.beginPath(); c.ctx.moveTo(pd.p0_x, pd.p0_y); c.ctx.bezierCurveTo(pd.p1_x, pd.p1_y, pd.p2_x, pd.p2_y, pd.p3_x, pd.p3_y);
            c.ctx.strokeStyle = p.preview_color; c.ctx.lineWidth = 0.5; c.ctx.stroke();
            let curve = c.curve_manager.find_curve_by_dom(c.last_on_curve_node_marker) || c.current_curve;
            let closedBySetting = c.drawToolSettings?.closed === true;
            if (pd._p2_x !== undefined && curve && (curve.closed || closedBySetting)) {
                c.ctx.beginPath(); c.ctx.moveTo(pd.p0_x, pd.p0_y); c.ctx.bezierCurveTo(pd.p1_x, pd.p1_y, pd._p2_x, pd._p2_y, pd._p3_x, pd._p3_y);
                c.ctx.strokeStyle = p.preview_color; c.ctx.lineWidth = 0.5; c.ctx.stroke();
            }
        }
        // Ellipse drag preview
        if (!overlayOnly && c._ellipseWorldStartX !== undefined && c._ellipseWorldEndX !== undefined) {
            this._drawEllipsePreview(c, p);
        }
        // Node drag: ghost preview of affected curves at original (pre-drag) positions.
        // Instead of iterating all tokens/curves to find affected ones, build a direct
        // lookup map from curveId → { seqOffsetX, matrix } for the affected curves only.
        if (c.drag_preview && (c.current_state === 'DRAGGING_NODE' || c.current_state === 'DRAGGING_NODE_READY')) {
            c.ctx.save();
            const seqTokens2 = seqTokens;
            const dragCtxMap = new Map();
            for (let i = 0; i < seqTokens2.length; i++) {
                const seqOffX2 = c.curve_manager.getSeqOffset(i);
                const token2 = seqTokens2[i];
                const gid2 = token2.isChar ? c.curve_manager.getDefaultGroupForChar(token2.value) : token2.value;
                // Group-level viewport culling
                const dg = c.curve_manager.treeItems.get(gid2);
                if (dg) {
                    const dAdv = dg.advance !== undefined ? dg.advance : 1000;
                    if (seqOffX2 + dAdv < vpBounds.minX || seqOffX2 > vpBounds.maxX) continue;
                }
                const cdl2 = getCurveDataList(gid2);
                for (const cd of cdl2) {
                    if (!cd.curve?.startNode || !c.drag_preview.curveIds.has(cd.curve.id)) continue;
                    dragCtxMap.set(cd.curve.id, { seqOffsetX: seqOffX2, matrix: cd.matrix || new DOMMatrix() });
                }
            }
            for (const [curveId, ctx2] of dragCtxMap) {
                const cdCurve = c.curve_manager.curveById.get(curveId);
                if (!cdCurve?.startNode) continue;
                const viewport = { scale: c.scale, offsetX, offsetY, seqOffsetX: ctx2.seqOffsetX, matrix: ctx2.matrix };
                const mapPoint = createViewportTransform(viewport);
                const nodePositions = c.drag_preview.nodePositions;
                    // Build ordered node list from snapshot data, tracking which nodes are being dragged
                    const nodes = [];
                    const isDragged = [];
                    let current = cdCurve.startNode;
                    while (current) {
                        const snap = nodePositions.get(current.main_node);
                        nodes.push(snap || {
                            x: current.x, y: current.y,
                            c1x: current.control1?.x ?? null,
                            c1y: current.control1?.y ?? null,
                            c2x: current.control2?.x ?? null,
                            c2y: current.control2?.y ?? null
                        });
                        isDragged.push(c.drag_initial_nodes.has(current.main_node));
                        current = current.nextOnCurve;
                    }
                    if (nodes.length < 2) continue;
                    c.ctx.beginPath();
                    let hasSegment = false;
                    let lastEndX = null, lastEndY = null;
                    const emitSegment = (curr, next) => {
                        const p0 = mapPoint(curr.x, curr.y);
                        if (!hasSegment) { c.ctx.moveTo(p0.x, p0.y); hasSegment = true; }
                        const cp1 = mapPoint(curr.c1x ?? curr.x, curr.c1y ?? curr.y);
                        const cp2 = mapPoint(next.c2x ?? next.x, next.c2y ?? next.y);
                        const end = mapPoint(next.x, next.y);
                        c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
                        lastEndX = end.x; lastEndY = end.y;
                    };
                    for (let j = 0; j < nodes.length - 1; j++) {
                        // Only draw segments adjacent to at least one dragged node
                        if (!isDragged[j] && !isDragged[j + 1]) continue;
                        emitSegment(nodes[j], nodes[j + 1]);
                    }
                    if (cdCurve.closed && nodes.length > 1) {
                        // Closing segment (endNode -> startNode): only if either endpoint is dragged
                        if (isDragged[nodes.length - 1] || isDragged[0]) {
                            const lastNode = nodes[nodes.length - 1];
                            const firstNode = nodes[0];
                            const pCurr = mapPoint(lastNode.x, lastNode.y);
                            if (!hasSegment || pCurr.x !== lastEndX || pCurr.y !== lastEndY) {
                                c.ctx.moveTo(pCurr.x, pCurr.y);
                            }
                            if (!hasSegment) hasSegment = true;
                            const cp1 = mapPoint(lastNode.c1x ?? lastNode.x, lastNode.c1y ?? lastNode.y);
                            const cp2 = mapPoint(firstNode.c2x ?? firstNode.x, firstNode.c2y ?? firstNode.y);
                            const end = mapPoint(firstNode.x, firstNode.y);
                            c.ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
                        }
                    }
                    if (!hasSegment) continue;
                    c.ctx.strokeStyle = p.preview_color;
                    c.ctx.lineWidth = 0.5;
                    c.ctx.stroke();
                }
            c.ctx.restore();
        }
        // Retained drag overlay: static layer already has guides/metrics/dividers.
        // Only redraw ephemeral snap guides created during this drag.
        if (overlayOnly) {
            const temps = (c.guidelines || []).filter((g) => g && g._temp);
            if (temps.length > 0) {
                const rad = Math.PI / 180;
                for (const g of temps) {
                    const screenX = g.x * c.scale + offsetX;
                    const screenY = g.y * c.scale + offsetY;
                    const a = (g.angle || 0) * rad;
                    const cosA = Math.cos(a), sinA = Math.sin(a);
                    const extend = 20000;
                    c.ctx.save();
                    c.ctx.strokeStyle = p.guide_stroke;
                    c.ctx.lineWidth = 1;
                    c.ctx.setLineDash([4, 4]);
                    c.ctx.beginPath();
                    c.ctx.moveTo(screenX - extend * cosA, screenY + extend * sinA);
                    c.ctx.lineTo(screenX + extend * cosA, screenY - extend * sinA);
                    c.ctx.stroke();
                    c.ctx.restore();
                }
            }
            return;
        }
        {
            const rad = Math.PI / 180;
            const allGuides = c.guidelines || [];
            if (allGuides.length > 0) {
                const lockActive = !!c.guideline_lock;
                for (const g of allGuides) {
                    const screenX = g.x * c.scale + offsetX;
                    const screenY = g.y * c.scale + offsetY;
                    const a = (g.angle || 0) * rad;
                    const cosA = Math.cos(a), sinA = Math.sin(a);
                    const extend = 20000;
                    const isTemp = !!g._temp;
                    const isHovered = !lockActive && !isTemp && c._hoveredUserGuideId === g.id;
                    const isDragging = !lockActive && !isTemp && c._draggingUserGuide && c._draggingUserGuide.id === g.id;
                    let strokeColor, fillColor;
                    if (isDragging) {
                        strokeColor = p.guide_drag_stroke;
                        fillColor = p.guide_drag_fill;
                    } else if (isHovered) {
                        strokeColor = p.guide_hover_stroke;
                        fillColor = p.guide_hover_fill;
                    } else {
                        strokeColor = p.guide_stroke;
                        fillColor = p.guide_fill;
                    }
                    c.ctx.save();
                    c.ctx.strokeStyle = strokeColor;
                    c.ctx.lineWidth = 1;
                    c.ctx.setLineDash([4, 4]);
                    c.ctx.beginPath();
                    c.ctx.moveTo(screenX - extend * cosA, screenY + extend * sinA);
                    c.ctx.lineTo(screenX + extend * cosA, screenY - extend * sinA);
                    c.ctx.stroke();
                    c.ctx.setLineDash([]);
                    if (!isTemp) {
                        c.ctx.fillStyle = fillColor;
                        c.ctx.beginPath();
                        c.ctx.arc(screenX, screenY, 2.5, 0, Math.PI * 2);
                        c.ctx.fill();
                    }
                    c.ctx.restore();
                }
            }
        }
        if (c.getActiveTool() === "SELECT") {
            let bounds = c.utils.getSelectionBounds();
            if (bounds) {
                let minSX = bounds.minX * c.scale + offsetX; let minSY = bounds.minY * c.scale + offsetY;
                let maxSX = bounds.maxX * c.scale + offsetX; let maxSY = bounds.maxY * c.scale + offsetY;
                let pad = 1.5; minSX -= pad; minSY -= pad; maxSX += pad; maxSY += pad;
                let w = maxSX - minSX; let h = maxSY - minSY;
                let midSX = minSX + w / 2; let midSY = minSY + h / 2;
                c.ctx.save(); c.ctx.strokeStyle = p.select_box_stroke; c.ctx.lineWidth = 1; c.ctx.setLineDash([]); c.ctx.strokeRect(minSX, minSY, w, h);

                if (c.transform_mode === 'scale') {
                    // Scale mode: 8 square handles
                    const drawHandle = (x, y) => {
                        c.ctx.fillStyle = p.select_handle_fill;
                        c.ctx.strokeStyle = p.select_handle_stroke;
                        c.ctx.lineWidth = 1.5;
                        c.ctx.beginPath();
                        c.ctx.rect(x - 3.5, y - 3.5, 7, 7);
                        c.ctx.fill();
                        c.ctx.stroke();
                    };
                    drawHandle(minSX, minSY); drawHandle(midSX, minSY); drawHandle(maxSX, minSY);
                    drawHandle(minSX, midSY); drawHandle(maxSX, midSY);
                    drawHandle(minSX, maxSY); drawHandle(midSX, maxSY); drawHandle(maxSX, maxSY);
                } else {
                    // Rotate/Shear mode: circular rot handles at corners, diamond shear at edges
                    const drawRotHandle = (x, y) => {
                        c.ctx.fillStyle = p.select_handle_fill;
                        c.ctx.strokeStyle = p.select_handle_stroke;
                        c.ctx.lineWidth = 1.5;
                        c.ctx.beginPath();
                        c.ctx.arc(x, y, 3.5, 0, Math.PI * 2);
                        c.ctx.fill();
                        c.ctx.stroke();
                    };
                    const drawShearHandle = (x, y, isHorizontal) => {
                        c.ctx.fillStyle = p.select_handle_fill;
                        c.ctx.strokeStyle = p.select_handle_stroke;
                        c.ctx.lineWidth = 1.5;
                        c.ctx.beginPath();
                        if (isHorizontal) {
                            // Diamond pointed left/right for horizontal edges — short axis (vertical) = 7
                            c.ctx.moveTo(x - 4, y);
                            c.ctx.lineTo(x, y - 3.5);
                            c.ctx.lineTo(x + 4, y);
                            c.ctx.lineTo(x, y + 3.5);
                        } else {
                            // Diamond pointed up/down for vertical edges — short axis (horizontal) = 7
                            c.ctx.moveTo(x, y - 4);
                            c.ctx.lineTo(x + 3.5, y);
                            c.ctx.lineTo(x, y + 4);
                            c.ctx.lineTo(x - 3.5, y);
                        }
                        c.ctx.closePath();
                        c.ctx.fill();
                        c.ctx.stroke();
                    };
                    drawRotHandle(minSX, minSY); drawRotHandle(maxSX, minSY);
                    drawRotHandle(minSX, maxSY); drawRotHandle(maxSX, maxSY);
                    drawShearHandle(midSX, minSY, true); drawShearHandle(midSX, maxSY, true);
                    drawShearHandle(minSX, midSY, false); drawShearHandle(maxSX, midSY, false);
                }

                // Draw center pivot (rotate_shear mode only — scale uses opposite-handle pivot)
                if (c.transform_mode === 'rotate_shear') {
                    const pivotScreen = c.utils._getTransformPivotScreen(c, bounds);
                    if (pivotScreen) {
                        const px = pivotScreen.x, py = pivotScreen.y;
                        c.ctx.fillStyle = p.select_handle_fill;
                        c.ctx.strokeStyle = p.select_handle_stroke;
                        c.ctx.lineWidth = 1.5;
                        // Crosshair lines
                        const cr = 8;
                        c.ctx.beginPath();
                        c.ctx.moveTo(px - cr, py); c.ctx.lineTo(px + cr, py);
                        c.ctx.moveTo(px, py - cr); c.ctx.lineTo(px, py + cr);
                        c.ctx.stroke();
                        // Outer circle
                        c.ctx.beginPath();
                        c.ctx.arc(px, py, 3.5, 0, Math.PI * 2);
                        c.ctx.fill();
                        c.ctx.stroke();
                    }
                }
                c.ctx.restore();
            }
        }
        if ((c.getActiveTool() === "SELECT" || c.getActiveTool() === "NODE") && c.is_box_selecting && c.box_select_start && c.box_select_end) {
            this._drawBoxSelectMarquee();
        }
        // ── Render persistent rulers ──
        for (const ruler of (c.rulers || [])) {
            this._drawRuler(c, ruler, offsetX, offsetY, p);
        }
        // ── Render current measure drag ──
        if (c.getActiveTool() === "MEASURE" && c.measure_start && c.measure_end) {
            let sx = c.measure_start.x * c.scale + offsetX; let sy = c.measure_start.y * c.scale + offsetY;
            let ex = c.measure_end.x * c.scale + offsetX; let ey = c.measure_end.y * c.scale + offsetY;
            c.ctx.save(); c.ctx.strokeStyle = p.measure_color; c.ctx.lineWidth = 1;
            c.ctx.setLineDash([3, 3]);
            c.ctx.beginPath(); c.ctx.moveTo(sx, sy); c.ctx.lineTo(ex, ey); c.ctx.stroke();
            c.ctx.setLineDash([]);
            c.ctx.fillStyle = p.measure_color; c.ctx.beginPath(); c.ctx.arc(sx, sy, 3, 0, Math.PI * 2); c.ctx.fill();
            c.ctx.beginPath(); c.ctx.arc(ex, ey, 3, 0, Math.PI * 2); c.ctx.fill();
            let dx = c.measure_end.x - c.measure_start.x; let dy = c.measure_end.y - c.measure_start.y;
            let length = Math.hypot(dx, dy); let angleRad = Math.atan2(-dy, dx); let angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
            let text = `L: ${length.toFixed(1)}, A: ${angleDeg}°`; c.ctx.font = "12px sans-serif";
            let midX = (sx + ex) / 2, midY = (sy + ey) / 2;
            c.ctx.fillStyle = p.measure_color; c.ctx.fillText(text, midX + 5, midY - 3); c.ctx.restore();
        }

        // ── Render baseline (permanent reference at design y=0, not draggable) ──
        {
            const fs = c.fontSettings || {};
            const upm = fs.upm || 1000;
            const fontH = c.canvas_size_height * c.scale;
            const baselineY = offsetY + 0.8 * fontH;
            const cw = logicalW;
            const isBaseHovered = c._hoveredMetricGuideKey === 'baseline';
            c.ctx.save();
            c.ctx.strokeStyle = isBaseHovered ? p.guide_hover_stroke : p.metric_guide_color;
            c.ctx.lineWidth = 1;
            c.ctx.setLineDash([4, 4]);
            c.ctx.beginPath();
            c.ctx.moveTo(0, baselineY);
            c.ctx.lineTo(cw, baselineY);
            c.ctx.stroke();
            c.ctx.setLineDash([]);
            if (isBaseHovered) {
                c.ctx.fillStyle = p.guide_hover_fill;
                c.ctx.font = '10px sans-serif';
                c.ctx.textAlign = 'left';
                c.ctx.textBaseline = 'bottom';
                c.ctx.fillText('Baseline: 0', c.ruler_size + 4, baselineY - 2);
            }
            c.ctx.restore();
        }

        // ── Render metric guidelines (ascender, descender, x-height, cap-height) ──
        {
            const mg = c.metric_guidelines;
            if (mg && mg.items) {
                const fs = c.fontSettings || {};
                const upm = fs.upm || 1000;
                const fontH = c.canvas_size_height * c.scale;
                const baselineY = offsetY + 0.8 * fontH;
                const cw = logicalW;
                const metricTypes = [
                    { key: 'ascender',   value: fs.ascender ?? 800,   label: 'Ascender' },
                    { key: 'descender',  value: fs.descender ?? -200, label: 'Descender' },
                    { key: 'x_height',   value: fs.x_height ?? 500,  label: 'x-Height' },
                    { key: 'cap_height', value: fs.cap_height ?? 700,label: 'Cap Height' }
                ];
                c.ctx.save();
                for (const mt of metricTypes) {
                    const item = mg.items[mt.key];
                    if (!item || item.visible === false) continue;
                    const sy = baselineY - (mt.value / upm) * fontH;
                    const isHovered = c._hoveredMetricGuideKey === mt.key;
                    c.ctx.strokeStyle = isHovered ? p.guide_hover_stroke : p.metric_guide_color;
                    c.ctx.lineWidth = 1;
                    c.ctx.setLineDash([4, 4]);
                    c.ctx.beginPath();
                    c.ctx.moveTo(0, sy);
                    c.ctx.lineTo(cw, sy);
                    c.ctx.stroke();
                    c.ctx.setLineDash([]);
                    if (isHovered) {
                        c.ctx.fillStyle = p.guide_hover_fill;
                        c.ctx.font = '10px sans-serif';
                        c.ctx.textAlign = 'left';
                        c.ctx.textBaseline = 'bottom';
                        c.ctx.fillText(mt.label + ': ' + mt.value, c.ruler_size + 4, sy - 2);
                    }
                }
                c.ctx.restore();
            }
        }

        // ── Render dividers ──
        if (c.curve_manager.activeSequenceIndices.size > 0 && c.divider_visible !== false) {
            c.ctx.save(); c.ctx.strokeStyle = p.canvas_divider; c.ctx.setLineDash([4, 4]); c.ctx.lineWidth = 1; c.ctx.beginPath();
            let hoveredScreenX = null;
            let hoveredLeftGid = null;
            let hoveredRightGid = null;
            let hoveredLeftAdvance = null;
            let drawnPositions = new Set();
            for (let i = 0; i < seqTokens.length; i++) {
                if (!activeIndices.has(i)) continue;
                let seqOffsetX = c.curve_manager.getSeqOffset(i);
                let token = seqTokens[i]; let gid = token.isChar ? c.curve_manager.getDefaultGroupForChar(token.value) : token.value;
                let group = c.curve_manager.treeItems.get(gid); let advance = (group && group.advance !== undefined) ? group.advance : 1000;
                let sx = seqOffsetX * c.scale + offsetX;
                let ex = (seqOffsetX + advance) * c.scale + offsetX;
                if (!drawnPositions.has(sx)) {
                    // Left-edge hover — leftmost divider of first glyph shows LSB of its only right group
                    let leftId = gid + "-" + i + "-l";
                    if (!c.divider_locked && c._hoveredDividerId === leftId && hoveredScreenX === null) {
                        hoveredScreenX = sx;
                        hoveredLeftGid = null;
                        hoveredRightGid = gid;
                        hoveredLeftAdvance = null;
                    } else {
                        c.ctx.moveTo(sx, 0); c.ctx.lineTo(sx, logicalH);
                    }
                    drawnPositions.add(sx);
                }
                if (drawnPositions.has(ex)) continue;
                let rightId = gid + "-" + i + "-r";
                let isHov = !c.divider_locked && (c._hoveredDividerId === rightId || (c._draggingDivider && c._draggingDivider.dividerId === rightId));
                if (isHov) {
                    hoveredScreenX = ex;
                    hoveredLeftGid = gid;
                    hoveredLeftAdvance = advance;
                    if (i + 1 < seqTokens.length) {
                        let nextTok = seqTokens[i + 1];
                        hoveredRightGid = nextTok.isChar ? c.curve_manager.getDefaultGroupForChar(nextTok.value) : nextTok.value;
                    }
                } else {
                    c.ctx.moveTo(ex, 0); c.ctx.lineTo(ex, logicalH);
                    drawnPositions.add(ex);
                }
            }
            c.ctx.stroke(); c.ctx.restore();
            if (hoveredScreenX !== null) {
                c.ctx.save();
                c.ctx.strokeStyle = p.divider_highlight; c.ctx.setLineDash([4, 4]); c.ctx.lineWidth = 1;
                c.ctx.beginPath(); c.ctx.moveTo(hoveredScreenX, 0); c.ctx.lineTo(hoveredScreenX, logicalH); c.ctx.stroke();
                // LSB/RSB display — skip if hovered divider is off-screen
                if ((hoveredLeftGid != null || hoveredRightGid != null) &&
                    hoveredScreenX >= -50 && hoveredScreenX <= logicalW + 50) {
                    const computeExtents = (gid) => {
                        const cdList = getCurveDataList(gid) || [];
                        let minX = Infinity, maxX = -Infinity;
                        for (const cd of cdList) {
                            if (!cd.effectiveVis || !cd.curve) continue;
                            const bounds = cd.curve.getBounds();
                            if (!bounds) continue;
                            if (bounds.minX < minX) minX = bounds.minX;
                            if (bounds.maxX > maxX) maxX = bounds.maxX;
                        }
                        return { minX: minX === Infinity ? 0 : minX, maxX: maxX === -Infinity ? 0 : maxX };
                    };
                    const fs2 = c.fontSettings || {};
                    const upm2 = fs2.upm || 1000;
                    const fontH2 = c.canvas_size_height * c.scale;
                    const baselineY2 = offsetY + 0.8 * fontH2;
                    const descenderY = baselineY2 - ((fs2.descender ?? -200) / upm2) * fontH2;
                    c.ctx.font = '10px sans-serif';
                    c.ctx.textBaseline = 'bottom';
                    const lx = hoveredScreenX;
                    const paintLeft = offsetX;
                    const paintRight = logicalW + offsetX - paintLeft; // same as logicalW
                    if (hoveredLeftGid) {
                        const leftExt = computeExtents(hoveredLeftGid);
                        let leftGroup = c.curve_manager.treeItems.get(hoveredLeftGid);
                        let leftAdv = (leftGroup && leftGroup.advance !== undefined) ? leftGroup.advance : 1000;
                        const rsb = leftAdv - leftExt.maxX;
                        c.ctx.fillStyle = p.divider_highlight;
                        c.ctx.textAlign = 'right';
                        c.ctx.fillText('Right side bearing: ' + Math.round(rsb), Math.max(lx - 6, paintLeft), descenderY);
                    }
                    if (hoveredRightGid) {
                        const rightExt = computeExtents(hoveredRightGid);
                        const lsb = rightExt.minX;
                        c.ctx.fillStyle = p.divider_highlight;
                        c.ctx.textAlign = 'left';
                        c.ctx.fillText('Left side bearing: ' + Math.round(lsb), Math.min(lx + 6, paintRight - 60), descenderY);
                    }
                    c.ctx.restore();
                }
                c.ctx.restore();
            }
        }
        {
            const tChromeEnd = performance.now();
            const dtChrome = tChromeEnd - tChrome;
            if (dtChrome > 200) console.log(`[rc] chrome=${dtChrome.toFixed(0)}ms`);
            if (trackExactCost) {
                this._lastExactRenderMs = tChromeEnd - renderStartedAt;
            }
        }
    }
    _isCurveInViewport(curve, matrix, seqOffsetX, vpBounds) {
        const bounds = curve.getBounds(matrix || undefined);
        if (!bounds) return false;
        // World-space bounds: matrix transform + seqOffsetX on X axis
        const worldMinX = bounds.minX + seqOffsetX;
        const worldMaxX = bounds.maxX + seqOffsetX;
        const worldMinY = bounds.minY;
        const worldMaxY = bounds.maxY;
        // AABB overlap check (use <=/>= to include degenerate bounds for single-node curves)
        return worldMinX <= vpBounds.maxX && worldMaxX >= vpBounds.minX
            && worldMinY <= vpBounds.maxY && worldMaxY >= vpBounds.minY;
    }
    update_previewData(mouseX, mouseY) {
        const c = this.canvas;
        if (c.last_on_curve_node_marker !== null) {
            let lastNode = c.curve_manager.find_node_by_curve(c.last_on_curve_node_marker);
            if (!lastNode) return;
            let seqOffsetX = c.drawing_seq_offset !== undefined ? c.drawing_seq_offset : 0;
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            let p0_x = mouseX, p0_y = mouseY; let p1_x = p0_x, p1_y = p0_y;
            let p3_x = (lastNode.x + seqOffsetX) * c.scale + offsetX; let p3_y = lastNode.y * c.scale + offsetY;
            let p2_x = ((lastNode.control1?.x ?? lastNode.x) + seqOffsetX) * c.scale + offsetX; let p2_y = (lastNode.control1?.y ?? lastNode.y) * c.scale + offsetY;
            let curve = c.curve_manager.find_curve_by_dom(c.last_on_curve_node_marker) || c.current_curve;
            let previewObj = { p0_x, p0_y, p1_x, p1_y, p2_x, p2_y, p3_x, p3_y };
            if (curve && curve.startNode) {
                previewObj._p3_x = (curve.startNode.x + seqOffsetX) * c.scale + offsetX; previewObj._p3_y = curve.startNode.y * c.scale + offsetY;
                previewObj._p2_x = ((curve.startNode.control2?.x ?? curve.startNode.x) + seqOffsetX) * c.scale + offsetX; previewObj._p2_y = (curve.startNode.control2?.y ?? curve.startNode.y) * c.scale + offsetY;
            }
            c.previewData = previewObj;
        } else {
            c.previewData = null;
        }
    }
    getStepAndPrecision(scale) {
        const c = this.canvas;
        const roughStep = 50 / scale;
        const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
        let step = steps[0];
        for (const s of steps) { if (s >= roughStep) { step = s; break; } }
        let precision = 0; if (step < 1) { precision = Math.ceil(-Math.log10(step)); }
        return { step, precision };
    }
    update_ruler() { this.update_ruler_horizontal(); this.update_ruler_vertical(); }
    update_ruler_horizontal() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const w = Number.isFinite(viewport.viewportWidth) ? viewport.viewportWidth : 0;
        const h = Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size;
        if (w <= 0 || h <= 0) return;
        const stateKey = `${c.scale},${c.offset.x},${w}`;
        if (stateKey === this._rulerHState) return;
        this._rulerHState = stateKey;
        c.ruler_horizontal.replaceChildren();
        const svg = c.env.createSVGElement("svg");
        svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
        svg.classList.add("svg-ruler-overlay");
        const { step, precision } = this.getStepAndPrecision(c.scale);
        const origin = c.offset.x;
        const theme = getCanvasTheme();
        const textColor = theme.ruler_text_color;
        const lineColor = theme.ruler_line_color;
        let start_i = Math.floor(-10 * origin / (c.scale * step)) - 10;
        let end_i = Math.ceil(10 * (w - origin) / (c.scale * step)) + 10;
        for (let i = start_i; i <= end_i; i++) {
            let j = i / 10; const x = origin + j * c.scale * step;
            if (x < -c.scale * step || x > w + c.scale * step) continue;
            const line = c.env.createSVGElement("line");
            line.setAttribute("x1", String(x)); line.setAttribute("y1", String(h)); line.setAttribute("x2", String(x));
            if (i % 10 === 0) {
                line.setAttribute("y2", "0");
                const text = c.env.createSVGElement("text"); text.textContent = `${(j * step).toFixed(precision)}`;
                text.setAttribute("x", String(x + 5)); text.setAttribute("y", String(h / 3)); text.setAttribute("font-size", "10px"); text.setAttribute("fill", textColor); text.setAttribute("text-anchor", "right"); text.setAttribute("dominant-baseline", "middle");
                svg.appendChild(text);
            } else if (i % 2 === 0) { line.setAttribute("y2", String(h / 2)); } else { line.setAttribute("y2", String(h / 4 * 3)); }
            line.setAttribute("stroke", lineColor); line.setAttribute("stroke-width", "1"); svg.appendChild(line);
        }
        c.ruler_horizontal.appendChild(svg);
    }
    update_ruler_vertical() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const w = Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size;
        const h = Number.isFinite(viewport.viewportHeight) ? viewport.viewportHeight : 0;
        if (w <= 0 || h <= 0) return;
        const stateKey = `${c.scale},${c.offset.y},${c.canvas_size_height},${h}`;
        if (stateKey === this._rulerVState) return;
        this._rulerVState = stateKey;
        c.ruler_vertical.replaceChildren();
        const svg = c.env.createSVGElement("svg");
        svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
        svg.classList.add("svg-ruler-overlay");
        const { step, precision } = this.getStepAndPrecision(c.scale);
        const baselineScreenY = c.offset.y + 0.8 * c.canvas_size_height * c.scale;
        const theme = getCanvasTheme();
        const textColor = theme.ruler_text_color;
        const lineColor = theme.ruler_line_color;
        // designY = (baselineScreenY - screenY) / scale — baseline at 0, positive upward
        const designY_top = baselineScreenY / c.scale;
        const designY_bot = (baselineScreenY - h) / c.scale;
        let start_i = Math.floor(10 * designY_bot / step) - 10;
        let end_i = Math.ceil(10 * designY_top / step) + 10;
        for (let i = start_i; i <= end_i; i++) {
            let j = i / 10;
            const designValue = j * step;
            const y = baselineScreenY - designValue * c.scale;
            if (y < -c.scale * step || y > h + c.scale * step) continue;
            const line = c.env.createSVGElement("line");
            line.setAttribute("y1", String(y)); line.setAttribute("x1", String(w)); line.setAttribute("y2", String(y));
            if (i % 10 === 0) {
                line.setAttribute("x2", "0");
                const cx = w / 3; const cy = y - 5;
                const text = c.env.createSVGElement("text"); text.textContent = `${designValue.toFixed(precision)}`;
                text.setAttribute("x", String(cx)); text.setAttribute("y", String(cy)); text.setAttribute("font-size", "10px"); text.setAttribute("fill", textColor); text.setAttribute("text-anchor", "right"); text.setAttribute("dominant-baseline", "middle"); text.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
                svg.appendChild(text);
            } else if (i % 2 === 0) { line.setAttribute("x2", String(w / 2)); } else { line.setAttribute("x2", String(w / 4 * 3)); }
            line.setAttribute("stroke", lineColor); line.setAttribute("stroke-width", "1"); svg.appendChild(line);
        }
        c.ruler_vertical.appendChild(svg);
    }
    update_canvas() {
        const c = this.canvas;
        const viewport = c.viewportConfig || {};
        const left = (Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size) + c.offset.x;
        const top = (Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size) + c.offset.y;
        const tokens = c.curve_manager?.sequenceTokens || [];
        const tokenSummary = tokens.length > 0
            ? `${tokens.length},${c.curve_manager.getSeqOffset(tokens.length - 1)}`
            : '0';
        const canvasKey = `${c.scale},${left},${top},${tokenSummary},${c.canvas_size_height}`;
        if (canvasKey === this._canvasState) return;
        this._canvasState = canvasKey;
        let w;
        if (tokens.length > 0) {
            const lastIdx = tokens.length - 1;
            const lastOff = c.curve_manager.getSeqOffset(lastIdx);
            const lastToken = tokens[lastIdx];
            const lastGid = lastToken.isChar ? c.curve_manager.getDefaultGroupForChar(lastToken.value) : lastToken.value;
            const lastGroup = c.curve_manager.treeItems.get(lastGid);
            const lastAdv = (lastGroup && lastGroup.advance !== undefined) ? lastGroup.advance : 1000;
            w = lastOff + lastAdv;
        } else {
            w = c.canvas_size_width;
        }
        // Position the white canvas (main_canvas DIV) so its top edge aligns with
        // the ascender line and bottom edge aligns with the descender line.
        const fs = c.fontSettings || {};
        const upm = fs.upm || 1000;
        const fontH = c.canvas_size_height * c.scale;
        const baselineY = top + 0.8 * fontH;
        const ascenderY = baselineY - ((fs.ascender ?? 800) / upm) * fontH;
        const descenderY = baselineY - ((fs.descender ?? -200) / upm) * fontH;
        const newTop = ascenderY;
        const newH = Math.max(1, descenderY - ascenderY);
        c.main_canvas.style.transform = `translate(${left}px, ${newTop}px)`;
        c.main_canvas.style.width = `${w * c.scale}px`;
        c.main_canvas.style.height = `${newH}px`;
    }
    change_canvas_size(dy, x, y, fixed, viewportCenter = false) {
        const c = this.canvas;
        if (viewportCenter) {
            const viewport = c.viewportConfig || {};
            const rect = {
                width: Number.isFinite(viewport.viewportWidth) ? viewport.viewportWidth : 0,
                height: Number.isFinite(viewport.viewportHeight) ? viewport.viewportHeight : 0
            };
            const ruler_w = Number.isFinite(viewport.rulerWidth) ? viewport.rulerWidth : c.ruler_size;
            const ruler_h = Number.isFinite(viewport.rulerHeight) ? viewport.rulerHeight : c.ruler_size;
            x = (rect.width / 2) - ruler_w - c.offset.x;
            y = (rect.height / 2) - ruler_h - c.offset.y;
        } else if (fixed) {
            x = c.canvas_size_width / 2 * c.scale; y = c.canvas_size_height / 2 * c.scale;
        }
        // Geometric zoom via zoomTicks: scale = scaleBase * factor^zoomTicks
        const oldTicks = c.zoomTicks;
        c.zoomTicks += dy < 0 ? 1 : -1;
        let new_scale = c.zoomTicksToScale(c.zoomTicks);
        // If clamping hit the boundary, revert zoomTicks
        if (new_scale === c.scale && c.zoomTicks !== oldTicks) {
            c.zoomTicks = oldTicks;
            return;
        }
        const x_new = x / c.scale * new_scale; const y_new = y / c.scale * new_scale;
        c.scale = new_scale;
        c.offset = { x: (c.offset.x + x - x_new), y: (c.offset.y + y - y_new) };
        c.editorStore?.syncViewFromCanvas?.();
        c.history.saveCurrentViewState();
    }
    _drawRuler(c, ruler, offsetX, offsetY, p) {
        if (!ruler || ruler.x1 === undefined) return;
        let sx = ruler.x1 * c.scale + offsetX; let sy = ruler.y1 * c.scale + offsetY;
        let ex = ruler.x2 * c.scale + offsetX; let ey = ruler.y2 * c.scale + offsetY;
        let isLineHovered = c._hoveredRulerId === ruler.id;
        const ep = c._hoveredRulerEndpoint;
        let isStartHovered = ep?.rulerId === ruler.id && ep?.endpoint === 'start';
        let isEndHovered = ep?.rulerId === ruler.id && ep?.endpoint === 'end';
        let lineColor = isLineHovered ? p.measure_hover_color : p.measure_color;
        let lineWidth = isLineHovered ? 2 : 1;
        c.ctx.save();
        c.ctx.strokeStyle = lineColor; c.ctx.lineWidth = lineWidth;
        c.ctx.beginPath(); c.ctx.moveTo(sx, sy); c.ctx.lineTo(ex, ey); c.ctx.stroke();
        let startColor = isStartHovered ? p.measure_hover_color : p.measure_color;
        let endColor = isEndHovered ? p.measure_hover_color : p.measure_color;
        c.ctx.fillStyle = startColor; c.ctx.beginPath(); c.ctx.arc(sx, sy, 4, 0, Math.PI * 2); c.ctx.fill();
        c.ctx.fillStyle = endColor; c.ctx.beginPath(); c.ctx.arc(ex, ey, 4, 0, Math.PI * 2); c.ctx.fill();
        let dx = ruler.x2 - ruler.x1; let dy = ruler.y2 - ruler.y1;
        let length = Math.hypot(dx, dy); let angleRad = Math.atan2(-dy, dx); let angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
        let text = `L: ${length.toFixed(1)}, A: ${angleDeg}°`; c.ctx.font = "12px sans-serif";
        let midX = (sx + ex) / 2, midY = (sy + ey) / 2;
        c.ctx.fillStyle = p.measure_color; c.ctx.fillText(text, midX + 5, midY - 3);
        c.ctx.restore();
    }

    _drawEllipsePreview(c, p) {
        const rawSx = c._ellipseWorldStartX, rawSy = c._ellipseWorldStartY;
        const rawEx = c._ellipseWorldEndX, rawEy = c._ellipseWorldEndY;
        if (rawSx === undefined || rawEx === undefined) return;

        // Collect all sequence offsets for the active group's instances
        const offsets = this._getGroupSeqOffsets(c);
        if (!offsets || offsets.length === 0) return;
        const masterOff = offsets[0];

        for (const instOff of offsets) {
            const dx = instOff - masterOff;
            this._drawOneEllipseAt(c, p,
                (rawSx + dx) * c.scale,
                rawSy * c.scale,
                (rawEx + dx) * c.scale,
                rawEy * c.scale);
        }
    }

    _getGroupSeqOffsets(c) {
        const storeId = c.commandHostPort?.getStoreState?.()?.activeGroupId;
        const activeGroupId = storeId ?? c.curve_manager.ensureActiveGroup();
        if (!activeGroupId) return null;
        const seqTokens = c.curve_manager.sequenceTokens || [];
        const offsets = [];
        let foundActive = false;
        for (let i = 0; i < seqTokens.length; i++) {
            const t = seqTokens[i];
            const gid = t.isChar ? c.curve_manager.getDefaultGroupForChar(t.value) : t.value;
            if (gid === activeGroupId) {
                const off = c.curve_manager.getSeqOffset(i);
                offsets.push(off);
                if (c.curve_manager.activeSequenceIndices?.has(i) && !foundActive) {
                    foundActive = true;
                    // Swap so the active instance is first (master)
                    if (offsets.length > 1) {
                        const tmp = offsets[0];
                        offsets[0] = off;
                        offsets[offsets.length - 1] = tmp;
                    }
                }
            }
        }
        return offsets;
    }

    _drawOneEllipseAt(c, p, sx, sy, ex, ey) {
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        sx += offsetX; sy += offsetY; ex += offsetX; ey += offsetY;

        const minSX = Math.min(sx, ex), minSY = Math.min(sy, ey);
        const maxSX = Math.max(sx, ex), maxSY = Math.max(sy, ey);
        const pad = 1.5;

        // Selection-style bounding rectangle (solid, no handles)
        c.ctx.save();
        c.ctx.strokeStyle = p.select_box_stroke;
        c.ctx.lineWidth = 1;
        c.ctx.setLineDash([]);
        c.ctx.strokeRect(minSX - pad, minSY - pad, maxSX - minSX + pad * 2, maxSY - minSY + pad * 2);
        c.ctx.restore();

        // Ellipse dimensions
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        let rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
        if (c._ellipseIsCtrl) { const r = Math.max(rx, ry); rx = ry = r; }
        if (rx < 0.5 || ry < 0.5) return;

        const k = 0.5522847498;
        const kx = k * rx, ky = k * ry;

        // control1 = outgoing from current node; control2 = incoming to next node
        const nodes = [
            { x: cx + rx, y: cy,     c1x: cx + rx, c1y: cy + ky, c2x: cx + rx, c2y: cy - ky },
            { x: cx,      y: cy + ry, c1x: cx - kx, c1y: cy + ry, c2x: cx + kx, c2y: cy + ry },
            { x: cx - rx, y: cy,     c1x: cx - rx, c1y: cy - ky, c2x: cx - rx, c2y: cy + ky },
            { x: cx,      y: cy - ry, c1x: cx + kx, c1y: cy - ry, c2x: cx - kx, c2y: cy - ry }
        ];

        // Draw filled ellipse (same as final result)
        c.ctx.save();
        c.ctx.beginPath();
        c.ctx.moveTo(nodes[0].x, nodes[0].y);
        for (let i = 0; i < 4; i++) {
            const n0 = nodes[i];
            const n1 = nodes[(i + 1) % 4];
            c.ctx.bezierCurveTo(n0.c1x, n0.c1y, n1.c2x, n1.c2y, n1.x, n1.y);
        }
        c.ctx.closePath();
        c.ctx.fillStyle = p.path_fill_color;
        c.ctx.fill("nonzero");
        c.ctx.strokeStyle = p.path_stroke_color;
        c.ctx.lineWidth = 1;
        c.ctx.stroke();
        c.ctx.restore();
    }
}
