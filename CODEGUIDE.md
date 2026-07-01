# InkShader 编码规范

> 本文档定义所有 InkShader 代码必须遵守的编码约定。AI 每次生成/修改代码时必须逐条检查。
> 你可以修改此文件来调整规范 — AI 会自动使用最新版本进行代码审查。

---

## G001. JavaScript 语言版本

- **目标**: ES2022 (ES13) 模块
- **模块系统**: ES Module (`import`/`export`)，**不要**使用 CommonJS (`require`/`module.exports`)
- **严格模式**: 所有模块默认严格模式（ESM 自动启用）

[RULE:G001]
type: pattern
path: js/ $exclude js/vendor/
forbid: \brequire\s*\(|module\.exports
message: G001: 使用 ES Module (import/export)，禁止使用 CommonJS
severity: error
spec-ref: G001
[ENDRULE]

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
| CSS 类名 | kebab-case | `tool_button`, `prop_toggle_btn`, `canvas-wrap` |
| CSS 变量 | `--` + kebab-case | `--ui-bg-base`, `--cvs-path-stroke` |

### G002b. 文件名对应规则

每个文件应默认导出（export）与其功能核心同名的 class 或函数集：

```js
// ✅ 正确
// selection_state.js → export class SelectionState { ... }

// ❌ 错误 — 文件名与导出名不匹配
// sel.js → export class Foo { ... }
```

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

// ❌ 避免：export default（除非是单 class 模块）
export default class Foo { }  // 不推荐
```

[RULE:G003b]
type: pattern
path: js/ $exclude js/vendor/
forbid: export\s+default\s+(class|function)
message: G003b: 优先使用命名导出，避免 export default
severity: warning
spec-ref: G003b
[ENDRULE]

### G003c. 路径规则

- 导入必须使用**相对路径**（从当前文件出发）
- 导入路径必须包含**文件扩展名** `.js`
- 不允许循环导入（A → B → A）

[RULE:G003c]
type: import-extension
path: js/ $exclude js/vendor/
message: G003c: import 路径必须包含 .js 后缀
severity: error
spec-ref: G003c
[ENDRULE]

---

## G004. 代码格式

### G004a. 缩进和括号

- 缩进：**4 空格**（不是 tab）
- 行最大长度：**120 字符**
- 花括号：**K&R 风格**（左括号在行尾）

[RULE:G004a]
type: no-tabs
path: js/
message: G004a: 缩进使用 4 空格，禁止制表符
severity: warning
spec-ref: G004a
[ENDRULE]

```js
// ✅ 正确
function changeObjectSelection(strategy, payload) {
    if (!strategy) return false;
    let changed = false;
    // ...
}

// ❌ 错误
function changeObjectSelection(strategy, payload)
{
    if (!strategy) return false;
}
```

### G004b. 分号

**必须使用分号**，即使 JavaScript 自动插入（ASI）可能避免：

```js
// ✅ 正确
let changed = false;
this.selected_curves.clear();
this._emitGlobalSelectionUpdated();

// ❌ 错误
let changed = false
this.selected_curves.clear()
```

### G004c. 空格

```js
// 操作符两侧空格
let sum = a + b;
if (x > 0) { ... }
for (let i = 0; i < n; i++) { ... }

// 逗号后空格
function foo(a, b, c) { ... }

// 对象解构空格
let { x, y } = point;

// ❌ 不允许
if(x>0){...
for (let i=0;i<n;i++){...
```

---

## G005. 注释与文档（全英文）

### G005a. 注释语言

**所有注释必须使用英文。** 不允许使用中文或其他语言写注释。

```js
// ✅ Correct (English)
// Resolve the root group ID for the given group, walking up the tree.

// ❌ Forbidden (Chinese)
// 解析给定组的根组ID，向上遍历树
```

### G005b. 文件头注释

**每个文件开头必须有简短文件头注释**，格式：

```js
// js/domain/selection/selection_state.js — Editor selection state management
```

[RULE:G005b]
type: file-header
path: js/ $exclude js/vendor/
message: G005b: 文件开头必须包含文件头注释
severity: warning
spec-ref: G005b
[ENDRULE]

### G005c. 函数/方法注释

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

### G005d. 实现注释（何时需要）

- 复杂算法（贝塞尔曲线插值、布尔运算）必须包含英文算法说明
- Magic number 必须注释含义
- 边界条件处理必须注释原因

```js
// Cap dt to avoid spiral-of-death on tab-away
if (dt > 0.1) dt = 0.1;
// Guard division by zero
if (dt <= 0) dt = 0.001;
```

### G005e. 修改时注释清理

**修改文件时，如果遇到以下情况的注释，必须删除：**
- 注释语言不是英文
- 注释与代码实际行为不符（过时/错误）
- 注释明显是自动生成的无意义内容
- 不必要的逐行注释（如 `i++ // increment i`）

删除后如果需要，用正确的英文重新注释。

---

## G006. 类型安全

### G006a. 硬性禁止

```js
// ❌ 严格禁止
let x: any = ...;
// @ts-ignore
// @ts-expect-error
```

### G006b. 类型标注（JSDoc）

由于项目不使用 TypeScript，所有类型信息通过 JSDoc 表达：

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

## G007. 状态管理

### G007a. 布尔返回值模式

所有状态修改方法必须返回 `boolean` 表示是否发生实际变更。修改 Set/Map 等集合内部时可直接调用 add/delete/clear 等方法，但必须跟踪并返回 changed 标识：

```js
// ✅ 正确：直接操作 Set 内部，跟踪并返回变更
addNodeSelection(markers) {
    let changed = false;
    for (let marker of markers) {
        if (!this.node_selecting.has(marker)) {
            this.node_selecting.add(marker);   // Set 内部维护
            changed = true;
        }
    }
    return changed;  // 返回是否变更
}

// ❌ 错误：无返回值，调用者无法感知是否发生变更
addNodeSelection(markers) {
    this.node_selecting = new Set([...this.node_selecting, ...markers]);
}
```

---

## G008. 事件系统

### G008a. 事件名常量

所有事件名必须使用常量，不允许直接写字符串：

```js
// ✅ 正确
appEventBus.emit(CANVAS_EVENTS.REQUEST_SAVE, { ... });

// ❌ 错误
appEventBus.emit('request-save', { ... });
```

[RULE:G008a]
type: event-literal
path: js/ $exclude js/vendor/ $exclude canvas_events.js $exclude domain_events.js
message: G008a: 事件名必须使用常量，禁止直接写字符串
severity: warning
spec-ref: G008a
[ENDRULE]

### G008b. 事件类型

| 前缀 | 用途 | 示例 |
|------|------|------|
| `REQUEST_*` | 写意图派发 | `REQUEST_CHANGE_OBJECT_SELECTION` |
| `STATE_CHANGED` | 状态变更通知 | `STATE_CHANGED` |
| `*_UPDATED` | 数据更新通知 | `TREE_UPDATED`, `MODEL_UPDATED` |
| `domain:*` | 领域层内部事件 | `domain:selection-changed` |

### G008c. 事件常量定义位置

- 领域层事件：`js/domain/events/domain_events.js` 中的 `DOMAIN_EVENTS`
- 应用层事件：`js/app/canvas_events.js` 中的 `CANVAS_EVENTS`

---

[RULE:G009]
type: pattern
path: js/
forbid: catch\s*\([^)]*\)\s*\{\s*\}
message: G009: 不允许空 catch 块
severity: warning
spec-ref: G009
[ENDRULE]

## G009. 错误处理

```js
// ✅ 正确：防御性检查 + 布尔返回值
function deleteSelectedNodes() {
    const markers = resolveMarkersFromCanvas(commandCanvas(this));
    if (markers.length === 0) return false;  // 无操作 → 提前返回
    
    let changed = false;
    for (let marker of markers) {
        if (this.curve_manager.deleteSingleNode(marker)) {
            changed = true;
        }
    }
    return changed;
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

---

## G010. CSS 规范

[RULE:G010a]
type: hardcoded-color
path: css/
message: G010a: 颜色值必须使用 CSS 变量，禁止硬编码
severity: warning
spec-ref: G010a
[ENDRULE]

### G010a. 颜色

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

### G010b. 主题变量分类

| 命名空间 | 用途 | 示例 |
|----------|------|------|
| `--ui-*` | 通用 UI（面板、字体、边框） | `--ui-bg-panel`, `--ui-text-main` |
| `--cvs-*` | Canvas 渲染（路径、节点、参考线） | `--cvs-path-stroke`, `--cvs-grid-dot` |

### G010c. 暗色模式

暗色模式在 `[data-theme="dark"]` 选择器中覆盖变量。修改颜色时必须同时更新亮色和暗色模式的变量。

### G010d. 选择器规范

- 使用 class 选择器，**避免 ID 选择器**（除非是单例元素）
- 使用 flexbox/grid 布局，**避免 `float`**
- `!important` 仅在覆盖第三方样式时使用

---

## G011. DOM 操作规范

### G011a. UI 组件

- 所有 UI 组件必须是**自定义 Web Component** (`class extends HTMLElement`)
- 不允许使用框架（React/Vue/Svelte）
- Shadow DOM 默认关闭（与全局 CSS 变量保持一致）

### G011b. DOM 访问限制

| 层 | 允许的 DOM 操作 |
|----|----------------|
| `core/` | **禁止**任何 DOM 访问 |
| `domain/` | **禁止**任何 DOM 访问 |
| `app/` | EventBus（通过 CustomEvent）、启动时初始化 |
| `canvas/` | Canvas 元素、Paper.js 作用域 |
| `ui/` | 完全 DOM 操作（组件自身元素） |
| `presentation/` | Canvas 交互事件监听 |

---

## G012. AI 代码生成检查清单

AI 在**每次修改后**必须逐项检查以下规则。每条规则在本文档中均有详细定义，此处仅引用 ID。

```
代码风格:
[ ] G004a — 缩进使用 4 空格，禁止制表符
[ ] G004a — 行长度不超过 120 字符
[ ] G004a — K&R 括号风格
[ ] G004b — 语句末尾有分号
[ ] G004c — 操作符两侧有空格
[ ] C008 — 无 emoji 出现在任何文件

类型安全:
[ ] C001 — 无 as any / @ts-ignore / @ts-expect-error
[ ] G006b — 导出函数有 JSDoc
[ ] C002 — 无 console.log 残留

注释:
[ ] G005b — 文件头有英文注释
[ ] G005c — 函数有英文注释（描述参数和返回值）
[ ] G005d — 复杂逻辑有英文注释
[ ] G005a — 无中文注释残留
[ ] G005e — 删除过时/错误的注释

设计规范:
[ ] G003c — 导入路径使用相对路径 + .js 后缀
[ ] S001 / G011b — 从正确的模块导入（不违反依赖方向）
[ ] G007a — 状态修改返回 boolean
[ ] G008a — 事件名使用常量而非字符串
[ ] G010a — 无硬编码颜色值
[ ] S009a — 新 UI 文本有对应 i18n 翻译
[ ] G009 — 空的 catch 块被移除

性能:
[ ] G012 — 无同步文件读写（此处为文档原则）
[ ] G012 — 无 O(n²) 或更差的算法在热点路径
[ ] G012 — rAF 不被不必要操作阻塞
```

---

## G013. Emoji 禁令

### G013a. 硬性规则

**除非是明确应该使用 emoji 的场景（如终端输出中需要跨语言识别的状态标记），禁止在任何文档、注释、代码、commit 消息、日志中使用 emoji。**

```js
// ✅ Correct — status symbols that are language-agnostic (explicitly allowed scenarios)
console.log("[OK] Server started on port 8765");

// ❌ Forbidden — decorative emoji in comments or logs
// 🚀 Server started on port 8765
// Return the curve ✅
```

### G013b. 允许的例外

- 用户明确要求的 UI 内容（如字体预览面板中显示 emoji 字符）
- 终端输出的跨语言状态符号（`[OK]`、`[ERROR]`、`[WARN]` 等文本标记）— 使用文本标记而非 emoji

### G013c. 规范文件中的 emoji

本文档中也不应包含 emoji。你正在阅读的这一条就是示例。<!-- 这条规则自我指涉 -->
