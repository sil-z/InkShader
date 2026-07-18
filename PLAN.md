# InkShader Canvas 渲染优化方案（修订版 v2）

> 基于对 Inkscape Cairo tile 渲染管线的深度分析（`canvas.cpp`、`updaters.cpp`、`stores.cpp`、`drawing-item.cpp`、`drawing-surface.cpp`），结合 InkShader 在浏览器端 Canvas2D 的实际瓶颈，制定可落地的分阶段优化方案。

---

## 问题诊断

### 当前渲染管线 `CanvasRendererService.renderCanvas()`

```
renderCanvas()
  ├─ PANNING          → _renderViewportPreview()   [单张快照 blit，平移露白]
  ├─ DRAGGING_NODE    → _renderNodeDragPreview()   [三明治合成]
  ├─ BOX_SELECTING    → _renderBoxSelectPreview()  [单张快照 blit]
  ├─ 稳定场景缓存命中 → _tryRenderFromStableScene() [blit + 增量节点]
  └─ 全量重绘        → _renderScene()              [~20,000 Canvas2D 调用/帧]
```

### 核心瓶颈

| 瓶颈 | 根因 | 影响 |
|------|------|------|
| **节点渲染** | ~2000 节点 × ~10 Canvas2D API 调用 = ~20,000 次/帧 | **鼠标移动卡顿**（Chrome 尤甚，因 GPU 命令提交开销更高） |
| **平移露白** | 单张视口快照缓存，移出边界即空白 | 平移体验差 |
| **无时间预算** | rAF 循环内全量渲染，不做切片 | 单帧可能 >16ms，丢帧 |
| **无优先级** | 所有节点/路径同等对待 | 鼠标附近无优先响应 |
| **密度逃逸** | `_renderScene` 中 `candCount > 400` 时完全禁用视口裁剪 | 密集场景退化为 O(n) 全遍历 |
| **单路径原子性** | 单条复杂路径（如 1024 节点）不能被瓦片化拆分 | 每次渲染仍是完整 O(n) 发射 |

### Inkscape 给我们的启示

经过对 Inkscape `canvas.cpp`（2514 行）的完整分析，其渲染管线核心架构：

```
schedule_redraw() → launch_redraw() → snapshot
  → init_tiler() [posted to thread pool]
    → init_redraw() [3-phase priority]
      Phase 0: 解耦模式下可见但未覆盖的区域（边缘闪烁防护）
      Phase 1: 可见但不清洁的区域（主要工作，~15ms 时间预算）
      Phase 2: 视口外围预渲染（最低优先级）
    → process_redraw(bounds, clean)：
      - 脏区粗化合并（避免碎片化小 tile）
      - make_heap（按距离鼠标远近排序）
    → render_tile(thread_id) [多线程]：
      - pop_heap 取出最近 tile
      - bisect 过大 tile 到 ~256px
      - paint_rect() → paint_single_buffer()
        - 背景 → CanvasItem 树渲染 → CMS 变换
      - 超时检查 → 超时标记，下次 idle 继续
  → after_redraw() [主线程]：
    - commit_tiles() → graphics->draw_tile() → queue_draw_area()
    - 如果还有工作 → 再次 launch_redraw()
```

**关键区别**：Inkscape 不是"缓存 tile"，而是 **直接在 tile 上渲染**（Tile-Based Rendering）。它的平铺是渲染策略而非缓存策略。

### Inkscape 额外启发：两项被原方案忽略的关键架构

1. **`DrawingItem::_cache`（逐项栅格缓存）**：Inkscape 为每个 `DrawingItem` 维护一个可选的栅格缓存（`CacheData`）。当路径复杂且稳定时，将其渲染为离屏表面（`DrawingCache`），后续帧直接从缓存 `paintFromCache()` 绘制到 tile 上。这使得单条复杂路径只需一次完整渲染，后续所有覆盖的 tile 都从缓存 blit。这是原方案缺失的关键机制。

2. **`MultiscaleUpdater`（多分辨率更新策略）**：Inkscape 的三种更新策略之一是 Multiscale，它在缩放时以不同分辨率分层更新视口。`next_frame()` 使用计数器控制：当前分辨率停留 `2^scale` 帧后才切换到下一分辨率。低分辨率更新快，高分辨率逐步精化。这避免了缩放后全量重建的开销。

---

## 优化方案总览

```
Phase A ──── 节点渲染优化 + 现有问题修复（高收益，低风险）
  ├─ A0: 修复密度逃逸阈值
  ├─ A1: Path2D 批量节点绘制
  ├─ A2: LOD 裁剪（缩小/密集节点跳过）
  └─ A3: 节点标记缓存（稳定帧复用）

Phase A.5 ── 路径级栅格缓存（高收益，中风险）← 新增
  └─ A5: 复杂路径 OffscreenCanvas 缓存（Inkscape DrawingItem::_cache 模式）

Phase B ──── Tile-Based 平铺渲染（中收益，中风险）
  ├─ B1: OffscreenCanvas tile 池
  ├─ B2: 脏区追踪与失效
  ├─ B3: 平铺合成覆盖层
  └─ B4: 缩放感知 tile 尺寸管理 ← 强化

Phase C ──── 异步调度系统（高收益，中风险）
  ├─ C1: rAF 时间分片渲染（主要机制）← 重写
  ├─ C2: 鼠标距离优先级
  └─ C3: 时间预算与超时续作

Phase D ──── WebGL 加速（高收益，高风险，可选）
  └─ D1: 用 WebGL 纹理合成 tiles
```

---

## Phase A: 节点渲染优化 + 现有问题修复

### A0: 修复密度逃逸阈值（新增）

**现状**：`_renderScene` 中第 672 行：
```javascript
cullPasses = candCount > 400 ? [] : built.passes;
```
当分组内超过 400 个候选曲线时，**完全禁用视口裁剪**，回退到完整序列遍历。对 1024 个节点对象在同一字形中的场景，cullPasses 永远为 `[]`。

**方案**：移除密度逃逸，或大幅提高阈值（如 10000）。Tile 系统的存在使得即使候选多，每个 tile 只需渲染自己的内容：
```javascript
// 移除逃逸：tile 调度器会处理密集场景，不需要在这里阻止裁剪
// BEFORE:
cullPasses = candCount > 400 ? [] : built.passes;
// AFTER:
cullPasses = built.passes; // 依靠 tile 调度器做进一步裁剪
```

**预期收益**：密集场景下从 O(n) 全遍历降至视口内 O(vp_curves)。

**修改文件**：`js/canvas/services/canvas_renderer_service.js`

### A1: Path2D 批量绘制

**现状**：`node_renderer.js` 的 `drawCurveNode()` 对每个节点逐个调用 `ctx.beginPath()` + `ctx.arc()`/`moveTo()`/`lineTo()` + `ctx.fill()`/`stroke()`。2000 节点 = 2000 次 Path2D 构建 + 2000 次 Canvas2D draw call。

**方案**：按节点类型（on-curve 圆点、控制柄方块、控制线）合并为 3 个 Path2D：

```javascript
// 当前（逐个绘制）
nodes.forEach(n => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
});

// 优化后（批量 Path2D）
const path = new Path2D();
nodes.forEach(n => {
    path.moveTo(n.x + radius, n.y);
    path.arc(n.x, n.y, radius, 0, Math.PI * 2);
});
ctx.fillStyle = color;
ctx.fill(path);
```

**预期收益**：Canvas2D draw call 从 O(n) 降到 O(1)～O(3)，Chrome 下收益尤其显著（Chrome Canvas2D 的 GPU 命令提交开销比 Firefox 高 3-5 倍，批处理后两者接近）。

**修改文件**：`js/canvas/rendering/node_renderer.js`

**风险**：Path2D 在 Firefox 下可能有路径点数量上限（实测 >10000 点需分段）。应对：按 ~5000 点分段。

### A2: LOD 裁剪

**现状**：所有节点无论视觉大小都绘制。

**方案**：缩放比低于阈值（节点屏幕直径 < 3px）时跳过 on-curve 圆形绘制，只画控制柄（或者全跳过）。控制柄屏幕长度 < 2px 时也跳过。

```javascript
const nodeScale = c.scale * dpr;
if (nodeScale < MIN_NODE_SCALE) return; // 跳过所有节点
if (handleLengthScreen < MIN_HANDLE_PX) skipControlHandles = true;
```

**预期收益**：缩小到 50% 时跳过 ~50% 节点绘制；缩到 20% 时跳过 ~90%。

**修改文件**：`js/canvas/rendering/node_renderer.js`、`js/canvas/services/canvas_renderer_service.js`

### A3: 节点标记缓存

**现状**：`_tryRenderFromStableScene()` 每帧调用 `_renderScene({ skipPathLayer: true })` 重绘所有节点。

**方案**：稳定场景下（无节点拖拽、无选中变化），节点也进入缓存。即将节点层渲染到一张离屏 canvas，与路径缓存层合成。

```javascript
// 新增：stableNodeCache
if (stable && !selectionChanged && !hoverChanged) {
    // 复用缓存的节点层，只需增量更新 hover 标记
    blit(stablePathCache);
    blit(stableNodeCache);
    renderHoverOnly();  // ~O(1)
    return;
}
```

**预期收益**：鼠标悬停检测场景从每次 ~20000 调用降到 ~100 调用。

**修改文件**：`js/canvas/services/canvas_renderer_service.js`

### Phase A 实现步骤

```
Step A0: 移除 _renderScene 中的密度逃逸（candCount > 400 ? []）
Step A1: 重构 node_renderer.js → drawCurveNode 改为 appendToPath2D
   输入参数增加 path2d 对象，不再直接操作 ctx
Step A2: renderCanvas() 稳定场景分支支持节点缓存
Step A3: 添加 LOD 裁剪逻辑
```

---

## Phase A.5: 路径级栅格缓存（新增）

### 为什么需要这一阶段

原方案最关键的缺失：**单条复杂路径不能被瓦片化**。如果一条路径包含 1024 个节点且跨越整个视口，它覆盖的每个 tile 都需要完整发射该路径的所有 Bezier 段。在平铺系统中，这意味着同一条路径被重复渲染了数十次。

Inkscape 的解决方案是 `DrawingItem::_cache`（`drawing-item.cpp:260-284`）：当一个 item 被标记为 `_cached`，其渲染结果存储在离屏表面（`DrawingCache`，`drawing-surface.cpp:137`）。后续帧通过 `paintFromCache()` 直接从缓存 blit 到 tile，只更新脏区域。

### A5: 复杂路径 OffscreenCanvas 缓存

**方案**：对满足以下条件的路径，渲染到独立 OffscreenCanvas 缓存：
- 路径节点数 > 阈值（如 50 节点）
- 路径在稳定状态（非拖拽/编辑中）
- 路径的几何（节点/闭合/描边宽度）未变化

```javascript
class PathRasterCache {
    constructor(maxSize = 4096) {
        this.cache = new Map(); // curveId → { canvas, epoch, worldBounds }
        this.maxSize = maxSize;
    }

    getOrRender(curve, viewportScale) {
        const key = curve.id;
        const epoch = curve.geometryEpoch;
        const cached = this.cache.get(key);

        // 缓存命中且几何未变
        if (cached && cached.epoch === epoch && cached.scale === viewportScale) {
            return cached;
        }

        // 计算路径的世界空间包围盒
        const bounds = curve.getBounds();
        const padding = curve.stroke_width / 2;
        const w = (bounds.maxX - bounds.minX + padding * 2) * viewportScale;
        const h = (bounds.maxY - bounds.minY + padding * 2) * viewportScale;

        // 限制缓存尺寸，超大路径降级（仍比逐 tile 重复好）
        if (w > this.maxSize || h > this.maxSize) return null;

        // 渲染到离屏 canvas
        const canvas = new OffscreenCanvas(Math.ceil(w), Math.ceil(h));
        const ctx = canvas.getContext('2d');
        ctx.scale(viewportScale, viewportScale);
        // ... 完整渲染路径（fill + stroke）

        const entry = { canvas, epoch, scale: viewportScale,
            worldBounds: { x: bounds.minX - padding, y: bounds.minY - padding, w, h } };
        this.cache.set(key, entry);
        return entry;
    }

    invalidate(curveId) { this.cache.delete(curveId); }
}
```

**使用方式**：在瓦片渲染（Phase B）中，对瓦片内的每条路径，先尝试从 PathRasterCache 获取缓存。如果命中，直接 `drawImage` 到瓦片（单次调用），而不是发射 Bezier 段。

```javascript
_renderCurveToTile(tileCtx, curve, viewport) {
    const cache = this.pathCache.getOrRender(curve, viewport.scale);
    if (cache) {
        // 缓存命中：单次 drawImage
        const sx = cache.worldBounds.x * viewport.scale + viewport.offsetX;
        const sy = cache.worldBounds.y * viewport.scale + viewport.offsetY;
        tileCtx.drawImage(cache.canvas, sx, sy);
        return;
    }
    // 缓存未命中：传统 Bezier 发射
    appendCurveFillPath(tileCtx, curve, viewport);
    drawCurveStroke(tileCtx, curve, viewport);
}
```

**预期收益**：
| 场景 | 无路径缓存 | 有路径缓存 |
|------|-----------|-----------|
| 1 条路径 × 1024 节点，覆盖 20 个 tile | 20 × 1024 节点发射 | 1 次完整发射 + 19 次 drawImage |
| 鼠标移动（复杂路径场景） | 每次 ~25ms | 每次 ~3-5ms |

**修改文件**：新建 `js/canvas/rendering/path_raster_cache.js`

**风险**：
- 缓存表面占用额外内存。可按 LRU 淘汰，限制最大缓存数（如 50 条路径）。
- 路径变换（如 seqOffsetX 变化）使缓存失效——需用 viewport 偏移量作为缓存键的一部分。
- 选中/悬停高亮需要在缓存之上覆盖绘制——Phase C 覆盖层处理。

---

## Phase B: Tile-Based 平铺渲染

### 核心思路

将画布划分为 **256×256 逻辑像素** 的 tile 网格。每个 tile 是一个 OffscreenCanvas（或 2D Canvas），**直接在 tile 上渲染曲线内容**，然后合成到主画布。

```
┌────────┬────────┬────────┬────────┐
│ tile00 │ tile01 │ tile02 │ tile03 │  ← 每个 tile ≈ 256×256 CSS px
├────────┼────────┼────────┼────────┤
│ tile10 │ tile11 │ tile12 │ tile13 │  ← 可见视口覆盖 ~(N×M) tiles
├────────┼────────┼────────┼────────┤
│ tile20 │ tile21 │ tile22 │ tile23 │
└────────┴────────┴────────┴────────┘
     ↑ 已渲染/缓存      ↑ 当前帧需合成     ↑ 新露出/脏 → 调度渲染
```

### Inkscape 启发

Inkscape 的 `Stores` + `Graphics` 架构是核心参考：
- **`Stores`**：管理 tile 集合，处理视口变化（recreate/shift）
- **`Graphics`**：Cairo/OpenGL 后端，提供 `request_tile_surface()`、`draw_tile()`
- 非"渲染后缓存到 tile"，而是 **直接渲染进 tile**
- `Stores` 的 `snapshot` 机制（`take_snapshot` / `snapshot_combine`）在缩放/旋转时保持旧 tile 可见，后台逐步精化——这是平移无空白的保障

### B1: OffscreenCanvas Tile 池

```javascript
class TilePool {
    constructor(tileSize = 256) {
        this.tileSize = tileSize;
        this.tiles = new Map(); // key: "col,row" → { canvas, ctx, epoch, dirty, lastUsed }
        this.maxTiles = 300;    // 允许更多 tile（~75MB @ 2x DPI），但需 LRU 淘汰
        this.maxMemoryMB = 200; // 硬性内存上限
    }

    getTile(col, row, epoch) {
        const key = `${col},${row}`;
        let tile = this.tiles.get(key);
        if (!tile || tile.epoch !== epoch) {
            this._ensureMemoryBudget(); // 淘汰低频 tile
            tile = this._createTile(col, row, epoch);
            this.tiles.set(key, tile);
        }
        tile.lastUsed = performance.now();
        return tile;
    }

    _createTile(col, row, epoch) {
        const canvas = new OffscreenCanvas(this.tileSize, this.tileSize);
        const ctx = canvas.getContext('2d');
        const worldBounds = this._tileToWorld(col, row);
        return { canvas, ctx, epoch, worldBounds, dirty: true, rendered: false };
    }

    collectVisible(viewportBounds, epoch) { /* 视口 → tile 列表 */ }
    invalidate(worldBounds) { /* 标记脏区覆盖的 tile */ }

    /**
     * LRU 淘汰：按 lastUsed 升序排列，淘汰到内存预算以下。
     * 优先淘汰远离鼠标的 tile（与调度优先级一致）。
     */
    _ensureMemoryBudget() {
        if (this._estimateMemoryMB() < this.maxMemoryMB) return;
        const sorted = [...this.tiles.entries()]
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        while (this._estimateMemoryMB() >= this.maxMemoryMB && sorted.length > 0) {
            const [key] = sorted.shift();
            this.tiles.delete(key);
        }
    }
}
```

### B2: 脏区追踪与失效

**现状**：`canvas.is_dirty = true` 全局布尔值，无细粒度脏区。

**方案**：改用 `Geom.IntRect` 或 `Cairo::Region` 等效的脏区累积。

```javascript
// 新增 CanvasRendererService._dirtyRegion
_dirtyRegion = null; // null = 全脏，或 Region 对象（多个矩形合并）

markDirty(bbox) {
    if (!this._dirtyRegion) {
        this._dirtyRegion = new Region([bbox]);
    } else {
        this._dirtyRegion.add(bbox);
        // Inkscape 的 coarsener：相邻脏区合并，避免碎片化小 tile
        this._coarsenIfNeeded();
    }
}

// 几何变更时调用
onCurveChange(curveId) {
    const bbox = curveManager.getCurveBounds(curveId);
    this.markDirty(bbox);
}
```

**预期收益**：单节点编辑时仅失效 1-2 个 tile，而非全帧重绘。

### B3: 平铺合成覆盖层

**渲染循环**——区分两种模式：

```
正常模式（IDLE/HOVER）：
  rAF:
    - 合成已渲染的 tile（drawImage 到主画布）
    - 渲染覆盖层（selection box / guides / cursor）
    - 收集缺失/脏 tile → 提交给调度器
    - 如果有待渲染 tile → requestIdleCallback / rAF 时间分片

平移模式（PANNING）：
  rAF:
    - 复用前一帧所有 tile（整数像素偏移 → 快速 blit）
    - 渲染新露出的 tile 边缘（Phase C 调度）
    - 覆盖层（仅光标）
```

```javascript
_compositeTiles() {
    const tiles = this.tilePool.collectVisible(viewport, epoch);
    // 批量 blit：对相邻 tile 可先合并到中间 canvas 再 drawImage
    // 减少 Canvas2D drawImage 调用次数
    if (tiles.length > 16) {
        this._compositeTilesBatched(tiles); // 4×4 合并
    } else {
        tiles.forEach(tile => {
            if (tile.rendered) this._blitTile(tile);
        });
    }
}
```

**合成优化**：当视口内 tile 数量 > 16 时，预先合并相邻 tile 到中间 canvas（如 4×4=16 个 tile 合并），减少主画布 `drawImage` 调用次数。每次 `drawImage` 有非零开销，从 O(N) 降到 O(N/16)。

### B4: 缩放感知 tile 尺寸管理（强化）

**问题**：固定 256×256 的 tile 在缩放时出现两个问题：
1. **缩小时**：一个 tile 包含过多内容，渲染耗时长
2. **放大时**：大量 tile 在视口外，浪费内存

**方案**：根据缩放级别动态调整 tile 尺寸：

```
scale < 0.1:  tileSize = 512  (缩小，合并更多内容到一个 tile)
0.1 ≤ scale < 0.5:  tileSize = 256  (默认)
0.5 ≤ scale < 2.0:  tileSize = 128  (放大，更精细的增量更新)
scale ≥ 2.0:   tileSize = 64   (放大，最小粒度)
```

**缩放过渡**（Inkscape snapshot 模式）：
```
缩放开始 → 冻结当前 tile 快照 → 基于快照做 imageSmoothingEnabled 缩放显示
         → 后台逐步重建新缩放级别的 tile（按鼠标距离优先级）
         → 重建完成后切换
```
这比原方案的 `zoomPreviewCache` 更平滑——原方案缩放松手后全量重绘，此处是渐进精化。

**修改文件**：`js/canvas/rendering/tile_pool.js`

### Phase B 实现步骤

```
Step B1: 新建 js/canvas/rendering/tile_pool.js → TilePool 类
Step B2: 新建 js/canvas/rendering/tile_scheduler.js → 调度器基础框架
Step B3: CanvasRendererService 增加 tile 合成路径
Step B4: 增量替换现有缓存（viewportPreviewCache 可删除）
Step B5: 添加缩放感知 tile 尺寸 + LRU 淘汰
```

---

## Phase C: 异步调度系统

这是从 Inkscape 学到的**最核心的架构改进**。Inkscape 之所以能保持交互流畅，不是因为渲染快，而是因为**渲染被合理地切片和优先级排序**了。

### C1: rAF 时间分片渲染（重写——原方案过度依赖 requestIdleCallback）

**现状**：所有渲染在 rAF 中同步完成。

**原方案问题**：`requestIdleCallback` 在高强度交互（鼠标快速移动、平移）时**几乎从不触发**——浏览器忙于处理输入事件和 rAF，没有空闲时间。这导致后台瓦片渲染在交互期间完全停止。

**修正方案**：以 **rAF 时间分片**为主调度机制，`requestIdleCallback` 仅作为渐进增强。

```
rAF 主循环:
  1. 计算帧预算: frameBudget = max(0, 16.67 - 预留覆盖层时间)
  2. 合成已完成的 tile + 覆盖层（必须完成，~2ms）
  3. 计算剩余时间: remaining = frameBudget - elapsed
  4. 如果 remaining > 2ms:
     a. 从优先级队列中取 tile
     b. 每个 tile 渲染前检查时间: 如果 elapsed > frameBudget → 停止，标记超时
     c. 渲染尽可能多的 tile
  5. 请求下一帧 rAF

当 rAF 内无剩余时间但仍有待渲染 tile:
  → requestIdleCallback 作为辅助（仅在浏览器空闲时触发）
  → 如果 idle 也不触发 → 下帧 rAF 继续
```

```javascript
_renderFrame(timestamp) {
    const frameBudget = 12; // ms —— 预留 ~5ms 给合成 + 覆盖层 + 事件处理
    const frameStart = performance.now();

    // 1. 合成 tile + 覆盖层（必须完成）
    this._compositeTilesAndOverlay();

    // 2. 计算本帧剩余时间
    const elapsed = performance.now() - frameStart;
    const remaining = frameBudget - elapsed;

    // 3. 时间分片：在剩余时间内渲染尽可能多的待处理 tile
    if (remaining > 1) {
        this.scheduler.processTiles({
            timeBudget: remaining,
            mousePos: this.canvas.last_mouse_pos
        });
    }

    // 4. 如果还有工作未完成 → 注册空闲回调（辅助）
    if (this.scheduler.hasPending()) {
        if ('requestIdleCallback' in globalThis) {
            requestIdleCallback((deadline) => {
                this.scheduler.processTiles({
                    timeBudget: deadline.timeRemaining(),
                    mousePos: this.canvas.last_mouse_pos
                });
                if (this.scheduler.hasPending()) {
                    requestIdleCallback(/* ... */);
                }
            });
        }
        // 注意：不 requestIdleCallback 也能继续——下帧 rAF 会继续处理
    }

    // 5. 继续下一帧
    requestAnimationFrame(() => this._renderFrame());
}
```

**为什么以 rAF 为主**：Inkscape 的 `render_tile()` 使用同步时间预算检查（`elapsed > render_time_limit * 1000`），不依赖空闲回调。它的"后台执行"通过线程池实现，而非依赖主线程空闲。在浏览器中，rAF 是唯一可靠的高频定时器——必须以它为主。

### C2: 鼠标距离优先级

**Inkscape 的启发**：`RedrawData::getcmp()` 按 `rect.distanceSq(mouse_loc)` 排序，`std::make_heap` + `pop_heap` 保证最近鼠标的 tile 最先渲染。

```javascript
class TileScheduler {
    constructor() {
        this.queue = [];        // 按优先级堆
        this.mousePos = { x: 0, y: 0 };
        this.inFlight = new Set();
        this._processing = false;
    }

    schedule(tiles, { mousePos }) {
        this.mousePos = mousePos;
        tiles.forEach(t => {
            if (!this.inFlight.has(t.key)) {
                const dist = this._tileDistToMouse(t);
                this.queue.push({ tile: t, dist });
                // 二叉堆插入（O(log n)），不是 sort（O(n log n)）
                this._heapPush();
            }
        });
    }

    /**
     * 在 timeBudget ms 内尽可能多地渲染 tile。
     * 返回实际渲染的 tile 数。
     */
    processTiles({ timeBudget, mousePos }) {
        if (mousePos) this.mousePos = mousePos;
        const start = performance.now();
        let count = 0;

        while (this.queue.length > 0) {
            // 超时检查——Inkscape 的 timeoutflag
            if (performance.now() - start > timeBudget) break;

            // pop_heap：取出最近鼠标的 tile
            const item = this._heapPop();
            if (!item) break;

            this.inFlight.add(item.tile.key);
            this._renderTile(item.tile);
            this.inFlight.delete(item.tile.key);
            count++;
        }
        return count;
    }

    _tileDistToMouse(tile) {
        // 计算 tile 中心到鼠标的距离（Inkscape: rect.distanceSq）
        const cx = tile.worldBounds.x + tile.worldBounds.w / 2;
        const cy = tile.worldBounds.y + tile.worldBounds.h / 2;
        return (cx - this.mousePos.x) ** 2 + (cy - this.mousePos.y) ** 2;
    }
}
```

### C3: 时间预算与超时续作

**Inkscape 的 Time Limit**：默认 `render_time_limit = 15`（毫秒）。`render_tile()` 每次循环后检查 `elapsed > render_time_limit * 1000`，超时则设置 `timeoutflag = true` 中断当前周期。下次 `after_redraw()` 检测到 `timeoutflag` 会自动重新 `launch_redraw()`。

在浏览器中的实现：

```javascript
// TileScheduler.processTiles 中的超时检查
processTiles({ timeBudget, mousePos }) {
    const startTime = performance.now();

    while (this.queue.length > 0) {
        // 超时 → 标记，下帧继续
        if (performance.now() - startTime > timeBudget) {
            this._timedOut = true;
            break;
        }
        // 渲染一个 tile
        /* ... */
    }
}

// rAF 主循环检测超时标记
if (this.scheduler.timedOut) {
    // 不是错误——只是时间片用完了，下帧继续
    this.scheduler.timedOut = false;
    // 无需特殊处理：下帧 _renderFrame 会自动继续处理队列
}
```

### Phase C 实现步骤

```
Step C1: 基于 TilePool 实现 TileScheduler（优先级堆 + processTiles）
Step C2: 重写 rAF 主循环（_renderFrame）加入时间分片
Step C3: 鼠标位置追踪 → 距离排序
Step C4: requestIdleCallback 作为辅助（渐进增强）
Step C5: 增量调度测试（平移场景优先启用）
```

---

## Phase D: 覆盖层优化

### 现状与问题

覆盖层（selection box、handles、guides、divider、marquee、hover highlight）每帧通过 `_renderScene()` 中的 overlay 路径绘制。

主要问题是**节点选中高亮**（Selection box）也在 Canvas2D 中逐点绘制。

### 优化方向

| 覆盖层 | 绘制方式 | 优化 |
|--------|----------|------|
| 选择框 (selection box) | `drawFrame()` 逐段绘制 | 暂不优化（绘制量极小） |
| 节点选中高亮 | `drawCurveNode()` 逐节点 | **已由 Phase A Path2D 覆盖** |
| 参考线 | `ctx.strokeRect()` | 暂不优化（个位数调用） |
| 光标 hover | 单个标记 | 已优化 |
| 测量标尺 | 少量路径操作 | 暂不优化 |

### Node-Renderer 的进一步优化

Path2D 批量渲染之后，主要的 Canvas2D 调用来源变为**覆盖层中的选中节点高亮**。如果稳定场景缓存了节点层，覆盖层就只需渲染：

1. 当前 hover 的节点标记（~1 个）
2. 选中的节点标记（可能几十个，但已由 Path2D 批量）
3. 选中框（少量 rect）

**预期**：稳定场景下覆盖层 Canvas2D 调用 < 100 次/帧。

---

## 性能预期（修正版）

| 场景 | 当前 (Phase 0) | Phase A (节点优化) | +A.5 (路径缓存) | +B+C (Tile+调度) |
|------|---------------|-------------------|-----------------|------------------|
| 鼠标移动（1024 单节点对象） | ~15ms（卡） | ~5ms（流畅） | ~5ms（流畅） | **~2-4ms**（流畅） |
| 鼠标移动（1 路径 × 1024 节点） | ~20ms（卡） | ~12ms（可察觉卡顿） | **~3-5ms**（流畅） | **~2-4ms**（流畅） |
| 拖拽节点（1024 节点总量） | ~20ms（卡） | ~8ms（基本流畅） | ~5ms（流畅） | **~3-5ms**（流畅） |
| 平移（1000+ 节点） | 空白边缘，松开加载 | 空白边缘（同上） | 空白边缘 | **边缘渐显，无空白** |
| 缩放后恢复 | ~50ms（全量重绘） | ~20ms | ~15ms | **~5-10ms**（渐进精化） |
| 文件加载（100 字形） | < 2s | 不变 | 不变 | 不变 |

**注**：修正版预测比原方案更保守。原方案预测 Phase A 将 2000 节点降到 5ms，但实际 Path2D 构建 + 坐标变换 + 视口裁剪仍有 O(n) 成本。A.5 路径缓存对单条复杂路径场景是关键差异。

---

## 现有缓存处理

| 缓存 | 保留？ | 说明 |
|------|--------|------|
| `viewportPreviewCache` | ❌ **删除** | Phase B+C tile 合成替代 |
| `nodeDragPreviewCache` | ✅ 保留 | 节点拖拽专用三明治合成，叠加 tile 上层 |
| `zoomPreviewCache` | ⚠️ **逐步迁移** | Phase B4 缩放感知 tile + snapshot 替代 |
| `boxSelectPreviewCache` | ✅ 保留 | 框选用，tile 上层 |
| `stableSceneCache` | ⚠️ **逐步迁移** | Phase A3 节点缓存 + Phase B tile 替代 |
| `_dirtyRegion`（新增） | ✅ 新增 | 细粒度脏区追踪 |
| `PathRasterCache`（新增） | ✅ 新增 | 路径级栅格缓存（Phase A.5） |

---

## 实现路线图

### 建议执行顺序

```
Week 1: Phase A (节点渲染优化 + 修复)
  ├─ A0 修复密度逃逸阈值             → 立即收益，1 行改动
  ├─ A1 Path2D 批量绘制               → 收益最大，改动最小
  ├─ A2 LOD 裁剪                      → 边界场景加速
  └─ A3 节点缓存                      → 稳定场景降本

Week 2: Phase A.5 (路径级栅格缓存) ← 优先级高于 B 阶段
  ├─ A5.1 PathRasterCache 类          → 基础设施
  ├─ A5.2 集成到现有 _renderScene      → 验证收益
  └─ A5.3 LRU 淘汰 + 内存控制         → 稳定性

Week 3-4: Phase B (Tile 平铺渲染)
  ├─ B1 TilePool 类                   → 基础设施
  ├─ B2 脏区追踪                      → 细粒度失效
  ├─ B3 合成集成                      → 替代 viewportPreviewCache
  └─ B4 缩放感知 tile 尺寸             → 自适应

Week 4-5: Phase C (异步调度系统)
  ├─ C1 rAF 时间分片主循环            → 核心机制
  ├─ C2 鼠标距离优先级                → 交互优化
  ├─ C3 时间预算 + 超时续作           → 帧率稳定
  └─ C4 requestIdleCallback 辅助      → 渐进增强

Week 6+: 性能调优 + 边界处理
  ├─ LRU 淘汰策略调优（tile + path cache）
  ├─ 内存压力测试（极端场景：5000 路径 × 50 节点）
  ├─ 高 DPI / 双屏适配
  ├─ 监控埋点（每帧统计 Canvas2D 调用 / 合成耗时 / 渲染耗时）
  └─ WebGL 合成评估（Phase D，非必须）
```

---

## 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| OffscreenCanvas 在部分浏览器不可用 | Tile 方案无法实施 | 检测支持，降级为 Phase A + PathRasterCache 优化 |
| Path2D 路径点过多导致 Firefox 崩溃 | Phase A 失效 | 每 5000 点分段绘制 |
| `requestIdleCallback` 在密集交互时不触发 | C1 调度失效 | **已修复**：rAF 时间分片为主调度，idle 仅辅助 |
| Tile 合成时 `drawImage` 开销高 | 合成帧耗时变长 | 批量合并相邻 tile 后 drawImage；WebGL 纹理替代（Phase D） |
| 脏区累积过多导致全量重绘 | Phase B 退化为当前性能 | 脏区粗化合并（Inkscape coarsener 算法） |
| 节点缓存与交互状态不一致 | 显示错误 | 每次选中/hover 变更时 invalidate 节点缓存 |
| **路径栅格缓存占用大量内存** | 浏览器崩溃 / OOM | LRU 淘汰 + 硬性内存上限（maxMemoryMB），超大路径降级不缓存 |
| **缩放级别变化频繁导致 tile 全量重建** | 缩放卡顿 | 保留旧缩放快照（Inkscape snapshot 模式），后台渐进精化 |
| **Chrome Canvas2D OffscreenCanvas 有额外开销** | Phase B 收益不及预期 | 基准测试先行，必要时用普通 Canvas 替代 OffscreenCanvas |

---

## 附录：Inkscape 渲染架构关键代码位置

| 功能 | 文件 | 行号 |
|------|------|------|
| Tile 数据结构 | `canvas.cpp` | 124-128 |
| RedrawData（异步渲染状态） | `canvas.cpp` | 140-191 |
| 调度入口 `schedule_redraw()` | `canvas.cpp` | 578-621 |
| 启动重绘 `launch_redraw()` | `canvas.cpp` | 624-755 |
| 后台初始化 `init_tiler()` | `canvas.cpp` | 2167-2189 |
| 多阶段调度 `init_redraw()` | `canvas.cpp` | 2191-2235 |
| 脏区处理 `process_redraw()` | `canvas.cpp` | 2239-2266 |
| 并行渲染 `render_tile()` | `canvas.cpp` | 2269-2378 |
| Tile 绘制 `paint_rect()` | `canvas.cpp` | 2402-2458 |
| 实际绘制 `paint_single_buffer()` | `canvas.cpp` | 2460-2492 |
| Tile 提交 `commit_tiles()` | `canvas.cpp` | 823-862 |
| 重绘完成 `after_redraw()` | `canvas.cpp` | 758-793 |
| Stores 管理 | `canvas/stores.cpp` | 全文 |
| Updater 策略（Responsive/FullRedraw/Multiscale） | `canvas/updaters.cpp` | 全文 |
| **Per-item DrawingCache (`DrawingCache`)** | `display/drawing-surface.cpp` | 137-276 |
| **渲染项缓存 (`DrawingItem::_cache`)** | `display/drawing-item.cpp` | 38-86, 260-284 |
| **MultiscaleUpdater 多分辨率调度** | `updaters.cpp` | 93-206 |


之前就这个项目的渲染性能做过一些优化，但作用非常有限，目前，创建一个项目，其中一个glyph中含有1024个单节点对象和1个含有1024个节点的对象，这个glyph位于画布上时，在firefox中，菜单等无关组件ui交互无卡顿，但鼠标在画布上移动的时候，根据右上角和标尺上的鼠标位置指示是可以看出来卡顿的；在chrome中，加载相同的文件，鼠标在画布上移动造成极其严重的卡顿。理想情况下，暂且不考虑一些算法的实现，最基本的应该做到拖动无卡顿，缩放借助某种延迟渲染的技术消除卡顿，鼠标移动等事件当然更不能有任何卡顿。应该允许画布上存在上万规模的节点和路径而不出现严重的延迟，允许文件中存在无限多的节点和路径而对当前的性能没有任何影响。目前没有满足这个要求。桌面上有一个inkscape的源码文件夹，根据inkscape的功能测试，画布上可以有任意多个节点和对象，几乎不会有明显的卡顿。之前根据源码分析了inkscape的渲染原理，并形成了一个plan.md位于项目根目录是预想的渲染方案。判断这个方案是否可行，是否能够形成性能过关的结果