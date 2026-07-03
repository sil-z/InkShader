# InkShader 功能规约（中文·权威版）

> **中文版是唯一权威来源。** AI 直接参考中文版进行开发。工作流程详见 [AGENTS.md](AGENTS.md)，修改后必须逐条核对附录中的功能偏离检查清单。
> 你可以修改此文件来调整功能定义—修改后 AI 会自动基于新版本规约核对。

### 约束等级标签

每条规则前标注以下标签，表明约束强度：

| 标签 | 含义 | 违反后果 |
|------|------|----------|
| `[MUST]` | 硬性约束 | 违反 = bug |
| `[SHOULD]` | 推荐做法，可例外 | 例外需在代码注释中说明理由 |
| `[MAY]` | 允许做法，非强制 | 仅为说明性描述 |
| `[ASPIRATIONAL]` | 目标值 | 当前可能未达成，但修改时应朝此方向 |

> **标签说明**：本文档所有顶层规约条目均已标注约束等级（`[MUST]`/`[SHOULD]`/`[MAY]`/`[ASPIRATIONAL]`），子条目继承父条目的等级。架构/数据流/不变量类条目为 `[MUST]`，详细交互行为描述为 `[SHOULD]`。修改代码时如果发现标注不准确，欢迎修正标签。

---

## S001. [MUST] 架构分层与依赖方向

### 层级结构（从底层到上层）

```
core/       (几何 + 领域协调，零 DOM)     ← 可被所有层引用；可引 domain/ 下的事件常量和接口
domain/     (命令/选择/历史/序列/事件)    ← 可引 core，不可引 app/presentation/ui
app/        (Store/Dispatcher/EventBus)   ← 胶水层，引 domain 和 core
presentation/ (Canvas 控制器/工具)        ← 引 app 和 domain
canvas/     (渲染/视口/服务)              ← 引 core 和 domain
ui/         (Web Component)               ← 引 app 和 domain
services/   (i18n/主题/存储/项目管理)     ← 被所有层引用（无反向引用）
```

### 依赖规则
| 编号 | 规则 | 验证方式 |
|------|------|----------|
| S001a | `core/` 不可引用 `app/`、`ui/`、`presentation/`。允许引用 `domain/` — **但仅限于事件常量、接口定义、纯数据结构**。禁止引用 `domain/` 的业务逻辑（命令处理、历史、序列逻辑） | `grep -r "from.*app\|from.*ui\|from.*presentation" js/core/` |
| S001b | `domain/` 不可引用 `ui/`、`presentation/`、`canvas/` | `grep -r "from.*ui\|from.*presentation\|from.*canvas" js/domain/` |
| S001c | 所有模块不可引用 `vendor/`（vendor 仅供 index.html 直接引用） | `grep -r "from.*vendor" js/` |
| S001d | `canvas/` 可引 `core/`、`domain/`、`app/`、`presentation/`、`services/`，不可引 `ui/` | — |
| S001e | `services/` 不可引用 `core/` 以外任何项目模块。可引用 Web API（DOM、IndexedDB、localStorage），但禁止直接操作 UI 组件或修改 DOM 结构（仅做跨层工具，不依赖业务逻辑） | — |
| S001f | `app/` 是胶水层，可引 `core/` 和 `domain/`，不可引 `ui/`、`presentation/`、`canvas/` | — |
| S001g | UI 组件必须使用**自定义 Web Component**，不允许使用框架（React/Vue/Svelte）。Shadow DOM 默认关闭（与全局 CSS 变量保持一致） | — |
| S001h | DOM 访问限制见下方表格（⚠️ `core/` `domain/` 严格禁止 `window`/`document` 等全局对象） | — |

### DOM 访问限制

| 层 | 允许的 DOM 操作 |
|----|----------------|
| `core/` | **禁止**任何 DOM 访问（包括 `window`、`document` 等全局对象） |
| `domain/` | **禁止**任何 DOM 访问（包括 `window`、`document` 等全局对象） |
| `app/` | EventBus（通过 CustomEvent）、启动时初始化 |
| `canvas/` | Canvas 元素、Paper.js 作用域 |
| `ui/` | 完全 DOM 操作（组件自身元素） |
| `presentation/` | Canvas 交互事件监听 |
| `services/` | 有限 DOM 访问：读写元素属性（如 `data-theme`、`data-i18n`）、 localStorage/IndexedDB。**禁止**直接操作 UI 组件或修改 DOM 结构 |

<!-- 依赖方向检查命令（供 AI 手动执行验证） -->
<!--
  S001a: grep -r "from.*app\|from.*ui\|from.*presentation" js/core/
  S001b: grep -r "from.*ui\|from.*presentation\|from.*canvas" js/domain/
  S001c: grep -r "from.*vendor" js/
-->

---

## S002. [MUST] 数据流（单向）

### S002a. 写意图路径

```
UI 事件 → CanvasDispatcher.REQUEST_* 
       → CanvasController.dispatchAction 
       → CanvasCommands.* 
       → CurveManager 修改运行时状态 
       → EditorStore.commitCommand 写历史
```

关键文件：
- [canvas_events.js](./js/app/canvas_events.js) — 所有 REQUEST_* 事件常量定义
- [canvas_dispatcher.js](./js/app/canvas_dispatcher.js) — 写意图派发器
- [canvas_commands.js](./js/domain/commands/canvas_commands.js) — 命令实现

### S002b. 读状态路径

```
EditorStore.state → STATE_CHANGED 事件 → UI 订阅者更新视图
```

关键文件：
- [editor_store.js](./js/app/editor_store.js) — 唯一状态出口

### S002c. 领域事件路径

```
CurveManager → DOMAIN_EVENTS 
             → domain_event_bridge 
             → EventBus (CustomEvent on window)
             → UI 订阅者
```

事件常量：
- [DOMAIN_EVENTS](./js/domain/events/domain_events.js)：`MODEL_UPDATED`、`TREE_UPDATED`、`SELECTION_CHANGED`、`ACTIVE_GROUP_CHANGED`
- [CANVAS_EVENTS](./js/app/canvas_events.js)：所有 UI 层事件

### S002d. 历史/撤销路径

```
操作 → snapshot patch → EditorStore 存储
撤销 → restoreFromHistoryMeta → snapshot patch → applyInteractionToRuntime
重做 → 同上
```

> **约束**：`EditorStore` 是 SSOT，`CurveManager` 是投影，禁止反向 `absorb`。

### S002e. 事件常量定义位置

事件命名规范详见 [CODEGUIDE G002b](CODEGUIDE.md#G002b)。事件常量定义在以下文件：

- 领域层事件：`js/domain/events/domain_events.js` 中的 `DOMAIN_EVENTS`
- 应用层事件：`js/app/canvas_events.js` 中的 `CANVAS_EVENTS`

---

## S003. [MUST] 选择系统

### S003a. 选择状态结构

```
SelectionState:
  selectedTreeIds: Set<string>       — 树面板选中项
  node_selecting: Set<marker>        — 节点选中（按 marker）
  node_selecting_ref_by_marker: Map  — 节点选中的 ref 上下文
  selected_curves: Set<Curve>        — 曲线对象选中
  selected_refs: Set<RefItem>        — 引用对象选中
  focused_seq_idx: number            — 序列焦点索引
  activeGroupId: string | null       — 当前活动组
```

关键文件：[selection_state.js](./js/domain/selection/selection_state.js)

### S003b. 操作策略

| 策略 | 行为 |
|------|------|
| `replace` | 清空选中 → 添加新选中 |
| `add` | 追加到当前选中 |
| `remove` | 从当前选中移除 |
| `toggle` | 存在则移除，不存在则添加 |
| `clear` | 清空所有选中 |

### S003c. 选择联动规则

1. **节点选中 ↔ 对象选中互斥**：对象选中时会清空节点选中（`changeObjectSelection` 内 `node_selecting.clear()`）
2. **树选中同步**：画布选中后必须 `syncTreeSelectionFromCanvas()` 同步到 `selectedTreeIds`
3. **activeGroup**：选中变更时自动更新 `activeGroupId`
4. **选中验证**：`validateSelection()` 过滤掉已隐藏/已锁定的对象

### S003d. [MUST] 状态修改布尔返回值

所有同步状态修改方法应返回 `boolean` 表示是否发生实际变更（详见 CODEGUIDE.md [G007b](CODEGUIDE.md#G007b)）。

---

## S004. [MUST] 曲线系统

### S004a. 核心数据结构

```
Curve: {
  id: string,
  points: Node[],        // 节点链表
  closed: boolean,
  groupId: string,
  stroke_width: number,
  smart_stroke: boolean,
  show_skeleton: boolean,
  cached_boolean_geometry: Segment[]
}

Node: {
  id: string (marker),
  point: { x, y },       // 坐标（UPM 单位）
  control1: { x, y } | null,   // 出控制柄（相对 point 偏移）
  control2: { x, y } | null,   // 入控制柄（相对 point 偏移）
  control_mode: 0 | 1 | 2      // 0=角点 1=平滑 2=对称
}

Segment: { x, y, inX, inY, outX, outY, closed }
```

关键文件：[curve.js](./js/core/bezier/curve.js)、[node.js](./js/core/bezier/node.js)

### S004b. 不变量

| 编号 | 规则 |
|------|------|
| S004b1 | 坐标以 UPM（默认 1000）为单位，**不是像素** |
| S004b2 | `control1`/`control2` 总是相对于 `point` 的偏移量 |
| S004b3 | `stroke_width` ≥ 0 |
| S004b4 | 开放路径的起点和终点 `control_mode` 可以不是 0 |
| S004b5 | 闭合路径的终点自动连接回起点 |

---

## S005. [MUST] 序列系统

### S005a. 序列状态

```
sequenceTokens: Token[]    — 词法分析后的 Token 列表
activeSequenceIndices: Set<number>  — 当前激活序列索引
sequenceText: string       — 原始序列文本
```

关键文件：[sequence_service.js](./js/core/bezier/sequence_service.js)

### S005b. Token 类型

| 类型 | 格式 | 示例 |
|------|------|------|
| 字符 | 直接字符 | `A`, `b`, `1` |
| 组引用 | `\组名\` | `\MyGroup\` |
| 空格 | 空白字符 | ` ` |

### S005c. 序列规则

1. 每个根级 Group 可以被分配一个唯一 `charCode`（字符映射）
2. `charCode` 在根级 Group 中必须唯一（不允许重复映射）
3. 序列文本修改后必须 `rebuildDefaultGlyphs()` + `updateSequenceParsing()`
4. 锁定根级 Group → 对应序列索引取消激活
5. 解锁根级 Group → 对应序列索引恢复激活

---

## S006. [MUST] 历史系统

### S006a. Snapshot Patch 模式

```
操作前: 拍摄快照 (editor_store_snapshot.js)
操作后: 生成 patch (JSON diff, snapshot_patch_executor.js)
撤销:   反向应用 patch
重做:   正向应用 patch
```

关键文件：[snapshot_patch_executor.js](./js/domain/history/snapshot_patch_executor.js)

### S006b. 历史边界

| 参数 | 值 |
|------|-----|
| 最大历史步数 | 512 |
| 快照最大大小 | 10MB（超过则截断几何数据） |
| 操作合并窗口 | 同类型操作 300ms 内合并为一步 |

### S006c. 命令提交规则

1. 交互操作（拖拽/选区）不写历史，只在 `mouseup`/`finish` 时写
2. 每个完整命令必须写 `_commitHistory(commandName)`
3. 命令名使用 camelCase，与函数名一致
4. `commitHistoryUnlessDispatching` 用于 dispatch 路径中防重复

---

## S007. [SHOULD] Canvas 渲染

### S007a. [SHOULD] 渲染层级（从底到顶）

```
1. 网格背景 (canvas_base)
2. 字符预览
3. 参考线 (guidelines)
4. 路径预览 (临时绘制)
5. 路径填充 (fill)
6. 路径描边 (stroke)
7. 选中高亮 (selection box)
8. 节点/控制柄 (on-curve points + handles)
9. 测量数据 (measure tool)
10. 光标
```

### S007b. [ASPIRATIONAL] 性能目标

| 场景 | 目标 |
|------|------|
| 字形编辑（拖动节点） | 60fps |
| 字形切换 | < 100ms |
| 布尔运算 | < 500ms |
| 文件加载（100 字形） | < 2s |
| 导出 | < 3s |

---

## S008. [SHOULD] 工具系统

> 各工具的详细交互逻辑（点击策略、拖拽行为、快捷键等）已内联到对应源文件的类级 JSDoc 注释中，以此处代码注释为准。

### S008a. 工具列表

| 工具 | 类 | 功能 | 行为注释位置 |
|------|----|------|-------------|
| SELECT | `SelectTool` | 对象选择、框选、启动拖拽/缩放/旋转变换 | [select_tool.js](./js/presentation/canvas/tools/select_tool.js) |
| NODE | `NodeTool` | 节点选择、框选节点、拖拽节点（带吸附对齐）、控制柄编辑、螺旋滚轮选取 | [node_tool.js](./js/presentation/canvas/tools/node_tool.js) |
| DRAW | `DrawTool` | 贝塞尔路径绘制（钢笔工具） | [draw_tool.js](./js/presentation/canvas/tools/draw_tool.js) |
| ELLIPSE | `EllipseTool` | 椭圆路径创建 | [ellipse_tool.js](./js/presentation/canvas/tools/ellipse_tool.js) |
| MEASURE | `MeasureTool` | 测量距离 | [measure_tool.js](./js/presentation/canvas/tools/measure_tool.js) |

工具切换通过 `CanvasDispatcher.requestSetToolMode()` 派发，切换时 `CanvasController` 清理上一个工具状态。

通用工具规则详见 [base_tool.js](./js/presentation/canvas/tools/base_tool.js) 类级注释（工具职责边界、数据变更路径、切换生命周期）。

### S008h. 节点编辑模式

节点模式操作通过工具栏按钮触发，不依赖具体工具：

| 模式 | 按钮 | 功能 |
|------|------|------|
| CORNER | `btn_mode_corner` | 选中节点设为角点模式（control_mode=0），控制柄独立 |
| SMOOTH | `btn_mode_smooth` | 选中节点设为平滑模式（control_mode=1），控制柄共线 |
| SYMMETRIC | `btn_mode_symmetric` | 选中节点设为对称模式（control_mode=2），控制柄共线且等长 |

变换系统由 [transform_tool.js](./js/presentation/canvas/tools/transform_tool.js) 管理，详见其类级注释。

---

## S009. [MUST] i18n 国际化

### S009a. 规则

1. **所有用户可见文本必须通过 `I18nManager.t()`**
2. HTML 模板中使用 `data-i18n` 属性（自动渲染）
3. 工具提示使用 `data-i18n-tip` 属性
4. 新增翻译键同时在 `translations.en` 和 `translations.zh` 中添加
5. 翻译键命名规则：`{模块}.{具体含义}`（如 `prop.node_pos`、`tool.select`）

关键文件：[i18n.js](./js/services/i18n.js)

---

## S010. [MUST] 文件/存储

### S010a. 用户文件操作（JSON IO）

| 操作 | 触发 | 功能 |
|------|------|------|
| 新建项目 | 菜单「New」→ `ProjectManager.createNewProject()` | 清空当前编辑，创建空白快照，存入 IndexedDB |
| 加载文件 | 菜单「Load」→ `canvas_io_service.triggerLoad()` | 弹出文件选择器 → 读取 .json → `loadSnapshotCommand()` |
| 保存文件 | 菜单「Save」→ `canvas_io_service.triggerSave()` | 调用 `exportJSON()` → Blob 下载 `.json` 文件 |
| 导出 UFO | 菜单「Export As」→ `canvas_io_service.exportToUFO()` | 遍历字形 → GLIF 格式 → JSZip 打包 `.ufo.zip` 下载 |

### S010b. 运行时缓存（IndexedDB）

通过 `StorageUtils` 操作浏览器 IndexedDB（数据库名 `InkShaderEditorDB`），key-value 存储。

| 存储内容 | Key | 说明 |
|----------|-----|------|
| 当前编辑状态 | `last_edit_state` | 自动保存的完整快照 + 撤回栈 |
| 项目数据 | `projects` → `{ projectName: data }` | 多项目缓存，每个包含快照 + 撤回栈 |
| 当前活动项目名 | `active_project` | 重启时自动恢复的项目名 |
| 视图状态 | `last_view_state` | 画布缩放/偏移、面板布局、当前工具、选区等 |

自动保存策略：
- 每次命令提交后 120ms 防抖保存运行时状态（`_queueRuntimeStateSave`）
- 视图状态在命令提交 + 画布交互后 300ms 防抖保存
- 新建项目、加载文件、切换项目时立即持久化

关键文件：[storage.js](./js/services/storage.js)、[project_manager.js](./js/services/project_manager.js)

### S010c. 项目生命周期

```
启动 → ProjectManager.init() → 读取 active_project → 如有则 loadFromCache
新建 → createNewProject() → 生成唯一项目名 → 存入 IndexedDB
切换 → saveToCache(当前) → loadFromCache(目标)
删除 → deleteFromCache(name)
```

项目名格式：`InkShader_YYYYMMDD_HHmmss`（按需加数字后缀去重）。

---

## S011. [MUST] 扩展描边系统

### S011a. 智能扩展描边渲染

智能扩展描边开启时，路径渲染自动应用扩展描边算法，但保留原始节点数据供交互。

规则：
1. 开启智能扩展描边后，对满足 `stroke_width > 0` 的路径，自动在底层对其执行扩展描边算法
2. 画布上渲染的是扩展描边处理后的几何结果（视觉效果）
3. **原始节点数据和描边宽度保留不变**，用户的节点编辑交互仍基于原始路径
4. 关闭智能扩展描边后，恢复渲染原始路径的描边
5. 此功能仅影响渲染表现层，不修改底层曲线数据

### S011b. Union 布尔求和

对选中的所有对象执行布尔和（union）操作。

规则：
1. 在执行布尔和之前，先对所有选中的对象逐一应用扩展描边算法
2. 对扩展描边后的结果进行布尔和运算，合并为单个路径
3. 运算结果路径的 `stroke_width = 0`
4. 原始路径被运算结果替代

### S011c. 扩展描边替换

扩展描边可作为独立功能调用，不可逆地将路径替换为扩展描边后的结果。

规则：
1. 调用后，用计算后的扩展描边结果路径**不可逆地**替代原始路径
2. 新路径的 `stroke_width = 0`
3. 原始节点数据和描边宽度被丢弃
4. 此操作通过历史系统支持撤销（作为一次命令提交）

---

## S012. [MUST] 对象操作

### S012a. 对象属性编辑

属性面板支持编辑以下对象属性：

| 属性类别 | 编辑项 | 对应命令 |
|----------|--------|----------|
| 节点属性 | 坐标 X/Y、入控制柄 X/Y、出控制柄 X/Y、入角度、出角度 | `updateSingleNodeProperty` |
| 路径属性 | 描边宽度、闭合状态、智能描边、骨骼线、路径名、路径方向、扩展描边方向 | `setSingleObjectProperties` |
| 分组属性 | 分组名、字符映射、字面宽度（advance） | `renameTreeItem`, `setGroupCharCode`, `setGroupAdvance` |
| 边界框 | 位置 X/Y、尺寸 W/H | `changeSelectedObjectsBounds` |

实时编辑：输入过程中通过 `input` 事件预应用值（`realtimeIds`），`change`/`blur` 事件写入历史。

### S012b. 可见性与锁定

| 操作 | 功能 | 命令 |
|------|------|------|
| 切换可见性 | 显示/隐藏选中对象 | `toggleSelectedObjectsDisplay` |
| 切换锁定 | 锁定/解锁选中对象 | `toggleSelectedObjectsLock` |
| 锁定影响序列 | 锁定根级分组 → 对应序列索引取消激活 | - |

### S012c. 对象选中操作

| 操作 | 命令 |
|------|------|
| 删除选中对象 | `deleteSelectedObjects` |
| 删除选中节点 | `deleteSelectedNodes` |
| 更改对象归属组 | `changeSelectedObjectsGroup`（支持 `inside`/`before`/`after` 模式） |
| 选中对象变换确认 | `changeSelectedObjectsTransform`（拖拽/缩放/旋转后收口） |

### S012d. 剪贴板

| 操作 | 功能 | 命令 |
|------|------|------|
| 复制 | 将选中对象序列化到内存剪贴板 | `copySelectedObjects` |
| 粘贴 | 从剪贴板还原对象到目标组 | `pasteCopiedObjects` |
| 复制（Duplicate） | 深拷贝选中对象到同组 | `duplicateSelectedObjects` |

剪贴板存储在当前 `CurveManager.clipboard` 中，跨命令共享，页面刷新即丢失。

### S012e. 组件引用

| 操作 | 功能 | 命令 |
|------|------|------|
| 创建组件引用 | `pasteGroupRef` 在目标组下创建指向源组的引用 | - |
| 取消引用 | `unlinkReferenceDeep` 将引用组深拷贝为独立副本 | `unlinkSelectedReferences` |

引用组 (`isRef=true`) 共享源组的曲线数据，修改源组会影响所有引用实例。
取消引用后变换矩阵和可见性/锁定状态保留，但与源组的数据连接断开。

---

## S013. [SHOULD] 交互辅助系统

> 滚轮选取和吸附对齐的详细行为已内联到 [node_tool.js](./js/presentation/canvas/tools/node_tool.js) 的类级 JSDoc 中，以此处代码注释为准。

---

## S014. [MUST] 文件保存格式

### S014a. 顶层结构

项目文件以 JSON 格式保存，字段直接位于顶层（无嵌套对象分组），精确描述见 `project_schema.json`。

```
{
  version: "1.0",                    — 格式版本号
  canvas_size_width: number,         — 画布宽度（CSS 像素）
  canvas_size_height: number,        — 画布高度（CSS 像素）
  family_name: string,               — 字体族名
  project_name: string,              — 项目名（当前为空占位）
  basic_spacing: number,             — 默认 advance（默认 1000）
  editor_sequence: string,           — 序列文本（\group\ 引用格式）
  editor_active_indices: number[],   — 激活的序列索引
  editor_fill_color: string,         — 默认填充色（#RRGGBB）
  editor_stroke_color: string,       — 默认描边色（#RRGGBB）
  editor_guideline_h: number[],      — 水平参考线 Y 位置列表
  editor_guideline_v: number[],      — 垂直参考线 X 位置列表
  editor_guideline_lock: boolean,    — 参考线是否锁定
  editor_user_guidelines: UserGuideline[],  — 用户自定义参考线
  editor_root_order: string[],       — 根级分组显示顺序
  ch: { [groupName]: GroupData },    — 有字符映射的分组（字形）
  components: { [groupName]: GroupData }  — 无字符映射的分组（组件定义/文件夹）
}
```

### S014b. GroupData 结构

```
{
  original_id: string,               — 导入时保留的原始标识
  name: string,                      — 分组显示名
  char_code: string | null,          — 字符映射（字形）或 null（非字形）
  advance: number,                   — 字面宽度（UPM 单位，默认 1000）
  locked: boolean,                   — 是否锁定
  visible: boolean,                  — 是否可见
  paths: { [pathName]: PathData },   — 路径集合（嵌套存储，非扁平池）
  components: { [refName]: ComponentRef },  — 组件引用集合
  tree_child_order: string[]         — 子项显示顺序
}
```

### S014c. PathData 结构

```
{
  closed: boolean,                   — 是否闭合
  stroke_width: number,              — 描边宽度（UPM 单位）
  smart_stroke: boolean,             — 是否开启智能扩展描边
  smart_stroke_clockwise: boolean,   — 扩展描边方向（顺时针）
  show_skeleton: boolean,            — 是否显示骨骼线
  visible: boolean,                  — 是否可见
  locked: boolean,                   — 是否锁定
  render_mode: "auto",               — 渲染模式（当前固定 auto）
  vertices: { [nodeId]: VertexData } — 顶点集合（用 order 字段排序）
}
```

### S014d. VertexData 结构

```
{
  order: number,                     — 路径内遍历顺序（0 起始）
  node_id: string,                   — 全局唯一节点标识
  x: number, y: number,              — 坐标（UPM 单位）
  start: boolean,                    — 是否路径起点
  end: boolean,                      — 是否路径终点
  smooth: boolean,                   — 是否平滑节点
  control_mode: 0 | 1 | 2,          — 0=角点 1=平滑 2=对称
  control_1: { active, x, y },      — 出控制柄（绝对坐标）
  control_2: { active, x, y }       — 入控制柄（绝对坐标）
}
```

控制柄 `x`/`y` 为绝对坐标（非节点偏移）。

### S014e. ComponentRef 结构

```
{
  component_id: string,              — 目标组件分组名
  transform: [a, b, c, d, tx, ty],  — 仿射变换矩阵（行优先 2x3）
  visible: boolean,                  — 实例是否可见
  locked: boolean                    — 实例是否锁定
}
```

### S014f. UserGuideline 结构

```
{
  id: string,                        — 唯一标识
  type: "h" | "v" | "angled",       — 参考线类型
  x: number, y: number,              — 位置
  angle: number                      — 角度（弧度，仅 angled 类型）
}
```

### S014g. 不保存在文件中的内容

以下内容保存在 IndexedDB 缓存中（`projects` 对象存储），不写入 `.json` 文件：

| 内容 | 说明 |
|------|------|
| 导入的图片 | Image 对象及位图数据 |
| 页面布局 | Dock 面板位置、大小、折叠/浮动状态 |
| 画布缩放和位移 | Canvas zoom、pan、viewport |
| 工具设置 | 当前工具、绘制设置 |
| 对象和节点选择状态 | 选中的对象和节点 |

---

## S015. [SHOULD] UI 面板与布局

### S015a. 面板布局

使用 Dock 布局系统（`DockLayout`），四个默认面板：

| 面板 | DOM 元素 | 功能 |
|------|----------|------|
| Canvas | `.canvas-wrap` | 主画布 + 工具栏 + 序列条 |
| Objects | `object-tree` | 树形对象浏览器 |
| Properties | `.property_panel` | 属性面板（属性分区） |
| Console | `logger-panel` | 日志输出面板 |

布局持久化：存储到 `localStorage['inkshader_dock_layout_v2']`，支持面板拆分、浮动、拖拽重排。

关键文件：[dock_layout.js](./js/ui/dock_layout.js)

### S015b. 工具栏

固定在画布左侧，包含：

| 按钮 | 功能 | 关联 |
|------|------|------|
| SELECT | 选择/变换工具 | `SelectTool` |
| NODE | 节点编辑工具 | `NodeTool` |
| DRAW | 钢笔绘制工具 | `DrawTool` |
| ELLIPSE | 椭圆绘制工具 | `EllipseTool` |
| MEASURE | 测量工具 | `MeasureTool` |
| Corner/Smooth/Symmetric | 节点模式切换 | `btn_mode_*` |
| Union | 布尔求和 | `booleanUnionSelectedCurves` |
| Expand | 扩展描边替换 | `expandSelectedStroke` |

### S015c. 序列面板

| 组件 | 功能 |
|------|------|
| 序列条（`GlyphSequenceBar`） | 显示字形序列预览，点击/右键菜单操作（选择、删除、清空） |
| 序列编辑器（`GlyphSequenceEditor`） | 文本方式编辑序列内容，支持添加新分组 |

### S015d. 对象树面板

`ObjectTree` 组件（`object-tree`）显示树形对象层级，支持以下操作：

| 操作 | 行为 |
|------|------|
| 左键点击 | 选中树项（路径/引用；普通分组不参与选中） |
| 折叠/展开 | 点击 `tree_toggle` 按钮折叠/展开分组子项 |
| 拖拽 | 拖拽树项改变归属组（`initDragAndDrop`） |
| 右键菜单 | 弹出上下文菜单（复制/粘贴/删除/重命名等） |
| 重命名 | 右键菜单 → 重命名（`renameTreeItem`） |
| 滚动 | 支持方向性滚动检测 |

关键文件：[object_tree.js](./js/ui/object_tree.js)

### S015e. 属性面板分区

属性面板（`PropertyPanel`）按选中内容动态显示以下分区，每个分区可折叠/拖出为独立浮动窗口：

| 分区 | 对应组件 | 选中条件 |
|------|----------|----------|
| 节点属性 | `NodePropertyPopup` | 有选中节点 |
| 路径属性 | `PathPropertyPopup` | 有选中路径 |
| 边界框 | `BoundingBoxPopup` | 有选中对象（曲线/引用） |
| 分组设置 | `GroupSettingsPopup` | 有选中分组 |
| 钢笔工具设置 | `PenToolPopup` |  DRAW 工具激活时右键菜单打开 |
| 椭圆工具设置 | `EllipseToolPopup` |  ELLIPSE 工具激活时右键菜单打开 |

### S015f. 其他 UI

| 组件 | 功能 |
|------|------|
| 顶部菜单栏 | Load / New / Import / Save / Export As / Font / Preferences / Help |
| 首选项弹窗（`PreferencesModal`） | 语言切换（中文/英文）、画布颜色覆盖 |
| 字体设置弹窗（`FontPopup`） | Family/Style/UPM/Ascender/Descender/Version |
| 帮助弹窗（`HelpModal`） | 快捷键和操作说明 |
| 下拉菜单（`DropdownMenu`） | 保存格式选择等 |
| 鼠标坐标显示 | 画布右上角实时光标位置 |

---

## S016. [SHOULD] 画布交互

> 视口控制、Hover 系统、键盘快捷键等精细交互逻辑已内联到对应源文件的类级 JSDoc 中，以此处代码注释为准。

### S016a. [SHOULD] 视口控制（缩放/平移）

详细行为参见 [canvas_viewport_service.js](./js/canvas/services/canvas_viewport_service.js) 类级注释。

### S016b. 参考线系统

参考线分为两类：
- **固定参考线**（`editor_guideline_h` / `editor_guideline_v`）：由代码设置，保存在文件中
- **用户参考线**（`user_guidelines`）：用户交互创建，保存在文件中（`UserGuideline[]`）

用户参考线操作：

| 操作 | 行为 |
|------|------|
| 从顶部标尺栏拖拽 | 创建水平用户参考线 |
| 从左侧标尺栏拖拽 | 创建垂直用户参考线 |
| 拖拽已有参考线 | 移动位置 |
| 拖拽到标尺栏 | 删除该参考线 |
| 双击参考线 | 打开编辑弹窗（位置 X/Y + 角度） |
| 双击标尺分割线 | 打开 advance 编辑弹窗 |
| 锁定参考线按钮 | 切换 `guideline_lock`，锁定后禁止拖拽/编辑/删除 |

DRAW/ELLIPSE 工具激活时参考线和分割线交互被抑制。
参考线悬停时显示光标指示（ew-resize / ns-resize）。

### S016c. 标尺系统

| 组件 | 行为 |
|------|------|
| 顶部水平标尺 | 显示刻度 + 鼠标位置指示器（`_rulerIndicatorH`） |
| 左侧垂直标尺 | 显示刻度 + 鼠标位置指示器（`_rulerIndicatorV`） |
| 测量工具标尺（`rulers`） | MEASURE 工具创建的任意标尺，带端点拖拽、双击编辑、右键删除 |

标尺渲染尺寸固定为 `ruler_size = 18px`（与 CSS 一致）。

### S016d. 分割线（Divider）

序列预览中组之间的垂直分割线，支持交互：

| 操作 | 行为 |
|------|------|
| 拖拽分割线 | 实时调整该组的 advance 宽度（状态→ `DRAGGING_DIVIDER`） |
| 拖拽释放 | 写历史（`requestSetGroupAdvance`） |
| 双击分割线 | 打开 advance 编辑弹窗 |

分割线悬停显示 `ew-resize` 光标。

### S016e. 鼠标坐标显示

画布右上角实时显示世界坐标。详见 [canvas_input_controller.js](./js/presentation/canvas/canvas_input_controller.js) 类级注释。

### S016f. Hover 系统

悬停检测与光标反馈详见 [canvas_interaction_controller.js](./js/presentation/canvas/canvas_interaction_controller.js) 类级注释。

### S016g. 键盘快捷键

快捷键列表详见 [canvas_input_controller.js](./js/presentation/canvas/canvas_input_controller.js) 类级注释。

### S016h. 图片导入

| 操作 | 行为 |
|------|------|
| 菜单「Import」 | `triggerImportImage()` → 弹出文件选择器（`accept="image/*"`） |
| 选择图片 | `importImageToCurrentGroup(img, fileName)` → 导入到当前活动组 |
| 存储 | Image 对象及位图数据存储在 IndexedDB 缓存（不写入 `.json` 文件） |

关键文件：[canvas_io_service.js](./js/canvas/services/canvas_io_service.js)

编码规范类规则详见 [CODEGUIDE.md](CODEGUIDE.md) 对应章节（所有规则 ID 已统一为 G 系列）。

---

## Appendix: Functional Deviation Checklist

> **单一入口**：此清单是 AI 修改后验证功能合规的唯一权威检查项。AGENTS.md 中的修改流程直接引用此清单。每次修改后必须逐条核对。

AI MUST check each item after completing modifications:

```
[ ] Modified files stay within allowed layers (no S001 dependency violation)
[ ] Selection changes call syncTreeSelectionFromCanvas (if S003 involved)
[ ] Sequence changes call updateSequenceParsing (if S005 involved)
[ ] Command commits history on completion (if S006 involved)
[ ] New UI text has i18n translations (if S009 involved)
[ ] No hardcoded colors (if CSS/Canvas rendering involved)
[ ] No new npm dependencies introduced
[ ] Union operation applies expand stroke to all selected objects first (if S011b involved)
[ ] Expand stroke replacement commits to history (if S011c involved)
[ ] Snapping implements axis lock / angle constraint logic (see node_tool.js JSDoc)
[ ] File save format matches project_schema.json (if S014 involved)
[ ] Ctrl+Z in DRAW tool calls undoDrawingStep, not undo (see draw_tool.js JSDoc)
```
