# InkShader JS 模块 — AI 知识库

## 模块总览

```
core/       (纯几何数学，零 DOM)
domain/     (命令、选择、历史、序列、事件)
app/        (Store、Dispatcher、EventBus)
presentation/ (Canvas 控制器、工具)
canvas/     (渲染、视口、服务)
ui/         (Web Component)
services/   (跨切面服务)
```

## 各模块 AI 向导

### core/ — 纯几何层

- 无 DOM / window / document
- 无 CSS 变量引用
- 数据格式见 SPEC S004
- 修改后检查：`node check_spec.js --changed=js/core/xxx.js`

### domain/ — 领域逻辑层

- 无 DOM / window / document
- 命令模式：每个操作是 CanvasCommands 的一个方法
- 选择状态见 SPEC S003
- 历史系统见 SPEC S006
- 修改后检查：`node check_spec.js --changed=js/domain/xxx.js`

### app/ — 胶水层

- 数据流见 SPEC S002
- 事件常量定义在 `canvas_events.js` 和 `domain_events.js`
- 修改后检查：`node check_spec.js --changed=js/app/xxx.js`

### ui/ — UI 组件

- 全部是自定义 Web Component
- 样式必须使用 CSS 变量
- 用户文本必须 i18n
- 修改后检查：`node check_spec.js --changed=js/ui/xxx.js`
