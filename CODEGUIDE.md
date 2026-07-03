# InkShader 编码规范

> 本文档定义所有 InkShader 代码必须遵守的编码约定。AI 每次生成/修改代码时必须逐条检查。
> 你可以修改此文件来调整规范 — AI 会自动使用最新版本进行代码审查。

---

> **文档语言说明**：本文档使用中文书写以便阅读。G005a 规则仅约束**代码中的注释**必须为英文，文档本身的说明文字不受此限。

## G001. JavaScript 语言版本

- **目标**: ES2022 (ES13) 模块
- **模块系统**: ES Module (`import`/`export`)，**不要**使用 CommonJS (`require`/`module.exports`)
- **严格模式**: 所有模块默认严格模式（ESM 自动启用）


> **检查路径**: `js/`（排除 `js/vendor/`）| **禁止模式**: `require()` 和 `module.exports`

---

## G002. 命名规范

### G002a. 标识符命名

| 类别 | 风格 | 示例 |
|------|------|------|
| 类名 | PascalCase | `CanvasCommands`, `SelectionState`, `EventBus` |
| 函数/方法 | camelCase | `changeObjectSelection()`, `syncTreeFromCanvas()` |
| 变量 | camelCase | `selectedTreeIds`, `activeGroupId` |
| 常量 | UPPER_SNAKE_CASE | `DOMAIN_EVENTS`, `CANVAS_EVENTS` |
| 私有（模块内） | 下划线前缀 | `_commitHistory()`, `_resolveRefIdForMarker()` |
| 事件名 | kebab-case（字符串） | `"tree-updated"`, `"request-save"` |
| 枚举键 | UPPER_SNAKE | `SELECTION_CHANGED`, `REQUEST_UNDO` |
| 文件命名 | snake_case | `selection_state.js`, `canvas_commands.js` |

### G002b. 事件名规范

所有自定义事件名必须使用常量引用，禁止直接写字符串（原生 DOM 事件如 `click`/`mousedown` 等除外）。

```js
// ✅ 正确
appEventBus.emit(DOMAIN_EVENTS.MODEL_UPDATED, { ... });

// ❌ 错误
appEventBus.emit('model-updated', { ... });
```

事件类型前缀约定：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `REQUEST_*` | 写意图派发 | `REQUEST_CHANGE_OBJECT_SELECTION` |
| `STATE_CHANGED` | 状态变更通知 | `STATE_CHANGED` |
| `*_UPDATED` | 数据更新通知 | `TREE_UPDATED`, `MODEL_UPDATED` |
| `domain:*` | 领域层内部事件 | `domain:selection-changed` |

常量定义位置：

- 领域层事件：`js/domain/events/domain_events.js` 中的 `DOMAIN_EVENTS`
- 应用层事件：`js/app/canvas_events.js` 中的 `CANVAS_EVENTS`

---

## G003. 导入/导出规范

### G003a. 导入顺序

按以下顺序分组，组间空行分隔：

```js
// 1. 外部库（npm 依赖）
import paper from 'paper';

// 2. 项目内部模块（按层级从低到高）
import { generateMarker } from '../../core/bezier/utils.js';
import { DOMAIN_EVENTS } from '../events/domain_events.js';

// 3. 同层模块
import { CanvasDispatcher } from './canvas_dispatcher.js';
```

### G003b. 导出风格

```js
// ✅ 正确：命名导出（推荐）
export function validateSelection() { ... }
export class SelectionState { ... }

// ✅ 正确：多个导出合并
export { DOMAIN_EVENTS } from './domain_events.js';

// ❌ 避免：export default（优先使用命名导出）
export default class Foo { }  // 不推荐
```

> **推荐**: 优先使用命名导出（`export function` / `export class`），避免 `export default`

> **建议**: 文件名应与主要导出内容的名称对应（如 `selection_state.js` 导出 `SelectionState` 类或相关函数集），便于按文件名定位模块。

### G003c. 路径规则

- 导入必须使用**相对路径**（从当前文件出发）
- 导入路径必须包含**文件扩展名** `.js`
- 不允许循环导入（A → B → A）

> **强制**: import 路径必须包含 `.js` 后缀

---

## G004. 代码格式

使用统一代码格式，当前约定：

- 缩进：**4 空格**（不是 tab）
- 行最大长度：**120 字符**
- 花括号：**K&R 风格**（左括号在行尾）
- 语句结束使用**分号**

手动格式化时遵守上述约定。

---

## G005. 注释与文档（全英文）

### G005a. 注释语言

**所有注释必须使用英文。** 不允许使用中文或其他语言写注释。

> **过渡条款**：存量代码中的中文注释，修改该文件时须一并转换为英文（遵循 G005d）。

```js
// ✅ Correct (English)
// Resolve the root group ID for the given group, walking up the tree.

// ❌ Forbidden (Chinese)
// 解析给定组的根组ID，向上遍历树
```

### G005b. 函数/方法注释

**每个导出/公开函数必须有注释**，描述功能、参数和返回值：

```js
/**
 * Change the object selection state.
 *
 * @param {string} strategy - "replace" | "add" | "remove" | "toggle" | "clear"
 * @param {{ curves?: Curve[], refs?: RefItem[] }} payload - Selection target
 * @returns {boolean} Whether any actual change occurred
 */
changeObjectSelection(strategy, payload) { ... }
```

私有方法（`_` 前缀）建议写行注释：

```js
// Resolve ref context for a marker from the given refContext parameter
_resolveRefIdForMarker(markers, refContext, index, marker) { ... }
```

### G005c. 实现注释（何时需要）

- 复杂算法（贝塞尔曲线插值、布尔运算）必须包含英文算法说明
- Magic number 必须注释含义
- 边界条件处理必须注释原因

```js
// Cap dt to avoid spiral-of-death on tab-away
if (dt > 0.1) dt = 0.1;
// Guard division by zero
if (dt <= 0) dt = 0.001;
```

### G005d. 修改时注释维护

**修改代码行为时，必须同步更新相关注释：**

如果修改了某个模块的交互行为（如工具的点击策略、拖拽逻辑、快捷键等），必须同步更新该文件**顶部的类级 JSDoc**，确保注释描述与实际行为一致。行为描述注释是 AI 修改代码时的主要参考来源，过时的注释比没有注释更有害。

**修改文件时，如果遇到以下情况的注释，必须删除：**
- 注释语言不是英文
- 注释与代码实际行为不符（过时/错误）
- 注释明显是自动生成的无意义内容
- 不必要的逐行注释（如 `i++ // increment i`）

删除后如果需要，用正确的英文重新注释。

---

## G006. 类型安全

> **前瞻性规则**：本项目为纯 JavaScript（未启用 TypeScript 检查），以下规则在当前阶段无法被工具强制验证，但 AI 必须遵守以保持代码质量。这些规则面向未来迁移 TypeScript 时不会隐藏类型错误。

### G006a. 硬性禁止

```js
// ❌ 严格禁止（JSDoc 标注中）
/** @type {any} */              // 禁止 —— 应用 @type {unknown} 代替
// @ts-ignore                   // 禁止 —— 当前不生效但表示不良意图
// @ts-expect-error             // 禁止
```

> **⚠️ 注意事项（本项目为纯 JavaScript，未使用 TypeScript）：**
> - JSDoc 中禁止标注 `@type {any}`——`any` 会完全禁用该变量的类型检查。对于不确定的类型，应使用 `@type {unknown}` 并通过类型收窄（typeof 检查等）处理。
> - `@ts-ignore` / `@ts-expect-error`：本项目虽未启用 TypeScript 检查，但禁止这些标注以保持代码意图清晰，避免未来启用 TS 时隐藏真实类型错误。
> - 如确实需要绕过类型检查，必须在注释中显式说明理由并提供替代方案。

### G006b. 类型标注（JSDoc）

由于项目不使用 TypeScript，建议在导出函数和关键数据结构上使用 JSDoc 标注类型信息：

```js
/** @type {Set<string>} */
this.selectedTreeIds = new Set();

/** @param {import('../core/bezier/curve.js').Curve} curve */
function processCurve(curve) { ... }
```

### G006c. 可选链与空值合并

```js
// ✅ 正确
let name = item?.name ?? 'unnamed';

// ❌ 避免
let name = item ? item.name : 'unnamed';
```

---

## G007. 错误处理与返回值契约

### G007a. 错误处理

```js
// ✅ 正确：防御性检查 + 提前返回
function deleteSelectedNodes() {
    const markers = resolveMarkersFromCanvas(commandCanvas(this));
    if (markers.length === 0) return false;  // 无操作 → 提前返回
    // ...
}

// ✅ 正确：边界条件显式处理
if (dt > 0.1) dt = 0.1;   // 限制最大时间步长
if (dt <= 0) dt = 0.001;  // 避免除零

// ✅ 正确：外部数据验证
if (typeof jsonStr !== "string" || jsonStr.length === 0) return false;

// ❌ 错误：空的 catch 块
try { ... } catch(e) {}

// ❌ 错误：吞错误
try { ... } catch(e) { /* 什么都不做 */ }
```

> **强制**: 不允许空 `catch` 块（`catch(e) {}`）

### G007b. 状态修改方法布尔返回值

所有同步状态修改方法应返回 `boolean` 表示是否发生实际变更。

```js
// ✅ 正确
addNodeSelection(markers) {
    let changed = false;
    for (let marker of markers) {
        if (!this.node_selecting.has(marker)) {
            this.node_selecting.add(marker);
            changed = true;
        }
    }
    return changed;
}

// ❌ 错误：无返回值，调用者无法感知是否发生变更
addNodeSelection(markers) {
    this.node_selecting = new Set([...this.node_selecting, ...markers]);
}
```

**例外**：
- 异步方法（返回 `Promise`）应返回 `Promise<boolean>` 表示变更结果
- 纯查询方法（getter）返回查询数据本身，不强制此规则

---

## G008. CSS 规范

> **强制**: 颜色值必须使用 CSS 变量，禁止硬编码
> **过渡条款**：存量代码中的硬编码颜色值，修改该文件时须逐步迁移为 CSS 变量引用。

### G008a. 颜色

**所有颜色必须通过 CSS 变量引用**，不允许硬编码颜色值：

```css
/* ✅ 正确 */
.tool_button.active-tool {
    background-color: var(--ui-accent-bg);
    color: var(--ui-accent);
}

/* ❌ 错误 */
.tool_button.active-tool {
    background-color: #e6f3fa;
    color: #0284c7;
}
```

### G008b. 主题变量分类

| 命名空间 | 用途 | 示例 |
|----------|------|------|
| `--ui-*` | 通用 UI（面板、字体、边框） | `--ui-bg-panel`, `--ui-text-main` |
| `--cvs-*` | Canvas 渲染（路径、节点、参考线） | `--cvs-path-stroke`, `--cvs-grid-dot` |

### G008c. 暗色模式

暗色模式在 `[data-theme="dark"]` 选择器中覆盖变量。修改颜色时必须同时更新亮色和暗色模式的变量。

### G008d. 选择器规范

- 使用 class 选择器，**避免 ID 选择器**（除非是单例元素）
- 使用 flexbox/grid 布局，**避免 `float`**
- `!important` 仅在覆盖第三方样式时使用

### G008e. 命名规范

| 类别 | 风格 | 示例 |
|------|------|------|
| CSS 类名 | snake_case | `tool_button`, `prop_toggle_btn`, `core_canvas` |
| CSS 变量 | `--` + kebab-case | `--ui-bg-base`, `--cvs-path-stroke` |

---

## G009. Emoji 禁令

禁止在任何代码、注释、文档、commit 消息、日志中使用 emoji。使用文本标记替代（如 `[OK]`、`[ERROR]`、`[WARN]`）。

**唯一例外**：用户明确要求的 UI 内容（如字体预览面板显示 emoji 字符）。

```js
// ✅ Correct
console.warn("[OK] Server started on port 8765");

// ❌ Forbidden
// 🚀 Server started on port 8765
// Return the curve ✅
```

> 替代方案：使用 `[OK]`、`[ERROR]`、`[WARN]` 等文本标记

---

## G010. 禁止调试日志输出

禁止在提交的代码中残留 `console.log`、`console.debug`、`console.info`、`console.trace`、`console.table` 等调试输出。

```js
// ✅ 正确：正式日志（仅允许以下两种）
console.warn("[WARN] 非预期状态");
console.error("[ERROR] 操作失败");

// ❌ 错误：调试残留
console.log("markers:", markers);
console.debug("vertex data:", v);
console.info("selection changed");
console.trace("transform stack");
console.table(metrics);
```

> **允许**：`console.warn` 和 `console.error` 用于正式日志。
> **禁止**：`console.log`、`console.debug`、`console.info`、`console.trace`、`console.table`——仅限临时调试用，提交前必须清除。
```
