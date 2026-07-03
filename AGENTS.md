# InkShader — AI Knowledge Base Root

## Project

InkShader is a Web-based font editor that uses Paper.js for Bezier curve rendering. Pure frontend (no backend dependency).

## Quick Start

Before modifying any code, AI **MUST** read:

1. **[SPECIFICATION.md](SPECIFICATION.md)** — Functional spec (architecture, constraints, invariants)
2. **[CODEGUIDE.md](CODEGUIDE.md)** — Coding standards
3. Module-level `AGENTS.md` files (if any exist under `js/` subdirectories)

All three documents referenced above are injected as system instructions (via `opencode.jsonc`).

---

## Repository Map

### Top-Level Entry Points

| Path | Role |
|------|------|
| `index.html` | Application entry point (loads ESM modules, vendor libs) |
| `css/style.css` | All styles (CSS variables, light/dark theme) |
| `js/` | All source code (ES modules, no frameworks) |
| `start_server.py` | Dev HTTP server |
| `assets/icons/` | SVG tool icons |
| `js/schemas/project_schema.json` | File save format spec (authoritative, referenced by S014) |

---

### Module Map (by architecture layer)

#### `core/` — 几何 + 领域协调（零 DOM）

> 可被所有层引用。可引用 `domain/` 的事件常量、接口定义、纯数据结构。**禁止**引用 `domain/` 的业务逻辑。

| File | Responsibility |
|------|---------------|
| `core/bezier/curve.js` | `Curve` class — path geometry (points, closed, stroke, group) |
| `core/bezier/node.js` | `Node` class — on-curve point with control handles |
| `core/bezier/manager.js` | `CurveManager` — runtime state hub (curves, tree, clipboard, tokens) |
| `core/bezier/curve_store.js` | Curve storage / indexing / CRUD |
| `core/bezier/tree_store.js` | Tree structure storage (group hierarchy) |
| `core/bezier/sequence_service.js` | Sequence text tokenization + glyph rebuild |
| `core/bezier/snapshot_serializer.js` | Serialize/deserialize runtime state to snapshot |
| `core/bezier/path_emitter.js` | Path-level event emission for domain events |
| `core/bezier/utils.js` | Bezier math utilities |
| `core/boolean.js` | Boolean operations (union, expand stroke) |
| `core/boolean_geometry_cache.js` | Cached boolean geometry segments |
| `core/transform_engine.js` | Transform computation (affine matrix ops) |
| `core/paper_scope.js` | Paper.js project/scope management |
| `core/index.js` | Core module barrel export |

---

#### `domain/` — 命令 / 选择 / 历史 / 序列 / 事件

> 可引用 `core/`。**禁止**引用 `ui/`、`presentation/`、`canvas/`。

| Subdirectory | Responsibility |
|---|---|
| `domain/events/` | `DOMAIN_EVENTS` constant definitions |
| `domain/commands/` | Command implementations (`canvas_commands.js`, `command_runtime.js`, wiring) |
| `domain/selection/` | Selection state, marker resolution, bounds, tree fields, snapshots |
| `domain/history/` | Snapshot patch, command commit, runtime applier |
| `domain/curves/` | Curve read snapshot |
| `domain/tree/` | Tree snapshot |
| `domain/sequence/` | Sequence active indices, display, tokenizer, text ops, menus |
| `domain/actions/` | Editor action definitions |
| `domain/editor/` | Interaction reducer |
| `domain/ports/` | Port interfaces for canvas/curve manager host adapters |

Key files:
- `domain/events/domain_events.js` — `DOMAIN_EVENTS` (all domain event constants)
- `domain/commands/canvas_commands.js` — Command entry points (called by dispatcher)
- `domain/selection/selection_state.js` — `SelectionState` (unified selection model)

---

#### `app/` — Store / Dispatcher / EventBus（胶水层）

> 可引用 `core/` 和 `domain/`。**禁止**引用 `ui/`、`presentation/`、`canvas/`。

| File | Responsibility |
|------|---------------|
| `app/editor_store.js` | SSOT — unified application state |
| `app/editor_store_bootstrap.js` | Store initialization |
| `app/editor_store_projection.js` | State derivation / computed fields |
| `app/editor_store_snapshot.js` | Snapshot creation for history |
| `app/editor_interaction_state.js` | Interaction state tracking |
| `app/editor_model_sync.js` | Model synchronization |
| `app/editor_read_facade.js` | Read-only query facade |
| `app/editor_command_log.js` | Command logging |
| `app/editor_history_state.js` | History stack state |
| `app/canvas_dispatcher.js` | Write intent dispatcher (`REQUEST_*` → commands) |
| `app/canvas_events.js` | `CANVAS_EVENTS` constants (all UI-level events) |
| `app/canvas_request_routes.js` | Request routing |
| `app/event_bus.js` | EventBus (CustomEvent on window) |
| `app/domain_event_bridge.js` | Bridges domain events → EventBus |
| `app/canvas_command_host_adapter.js` | Adapter: commands → canvas host |
| `app/curve_manager_host_adapter.js` | Adapter: commands → CurveManager |
| `app/curve_manager_access.js` | CurveManager access facade |
| `app/canvas_access.js` | Canvas access facade |
| `app/canvas_host_wiring.js` | Canvas host wiring |
| `app/bootstrap.js` | Application bootstrap sequence |
| `app/editor_store_bootstrap.js` | Store bootstrap |
| `app/selection_geometry.js` | Selection geometry utils |
| `app/sequence_preview_facade.js` | Sequence preview facade |
| `app/layout_metrics_service.js` | Layout metrics |
| `app/history_patch_policy.js` | History patch merge policy |

---

#### `presentation/` — Canvas 控制器 / 工具 / 序列预览

| Path | Responsibility |
|------|---------------|
| `presentation/canvas/canvas_controller.js` | Central canvas controller |
| `presentation/canvas/canvas_input_controller.js` | Keyboard input + shortcuts |
| `presentation/canvas/canvas_interaction_controller.js` | Hover detection, cursor feedback |
| `presentation/canvas/canvas_view.js` | Canvas view management |
| `presentation/canvas/tools/` | Tool implementations |
| `presentation/canvas/tools/base_tool.js` | Abstract base tool |
| `presentation/canvas/tools/select_tool.js` | Select / transform tool |
| `presentation/canvas/tools/node_tool.js` | Node edit tool |
| `presentation/canvas/tools/draw_tool.js` | Pen / draw tool |
| `presentation/canvas/tools/ellipse_tool.js` | Ellipse tool |
| `presentation/canvas/tools/measure_tool.js` | Measure tool |
| `presentation/canvas/tools/transform_tool.js` | Transform (drag/scale/rotate) |
| `presentation/canvas/tools/index.js` | Tool barrel export |
| `presentation/layout/layout_controller.js` | Layout controller |
| `presentation/sequence/sequence_group_preview.js` | Sequence group preview |

---

#### `canvas/` — 渲染 / 视口 / 服务

| Path | Responsibility |
|------|---------------|
| `canvas/main_canvas.js` | Main canvas wrapper |
| `canvas/canvas_host_access.js` | Canvas host access |
| `canvas/environment_adapter.js` | Environment adapter |
| `canvas/rendering/canvas_theme.js` | Canvas theme variables |
| `canvas/rendering/curve_renderer.js` | Curve rendering |
| `canvas/rendering/node_renderer.js` | Node rendering |
| `canvas/rendering/viewport_transform.js` | Viewport transform |
| `canvas/services/canvas_viewport_service.js` | Zoom/pan viewport |
| `canvas/services/canvas_renderer_service.js` | Render coordination |
| `canvas/services/canvas_render_runtime_service.js` | Runtime render |
| `canvas/services/canvas_io_service.js` | File IO (load/save/export/import) |
| `canvas/services/canvas_history_service.js` | Canvas history rendering |
| `canvas/services/canvas_utils_service.js` | Canvas utilities |
| `canvas/services/canvas_services.js` | Services barrel |

---

#### `ui/` — Web Components

> All UI components as vanilla Web Components. No framework. No Shadow DOM (default).

| File | Component |
|------|-----------|
| `ui/layout_shell.js` | Shell layout |
| `ui/dock_layout.js` | Dock panel system |
| `ui/object_tree.js` | Object tree panel |
| `ui/property_panel.js` | Property panel container |
| `ui/node_property_popup.js` | Node property editor |
| `ui/path_property_popup.js` | Path property editor |
| `ui/bounding_box_popup.js` | Bounding box editor |
| `ui/group_settings_popup.js` | Group settings |
| `ui/pen_tool_popup.js` | Pen tool settings |
| `ui/ellipse_tool_popup.js` | Ellipse tool settings |
| `ui/glyph_sequence_bar.js` | Sequence bar |
| `ui/glyph_sequence_editor.js` | Sequence text editor |
| `ui/font_popup.js` | Font settings modal |
| `ui/preferences_modal.js` | Preferences modal |
| `ui/help_modal.js` | Help modal |
| `ui/dropdown_menu.js` | Dropdown menu |
| `ui/logger_panel.js` | Console log panel |
| `ui/popup_utils.js` | Popup utilities |

---

#### `services/` — i18n / 主题 / 存储 / 项目管理

> 被所有层引用（无反向引用）。可引用 Web API（DOM/localStorage/IndexedDB），**禁止**直接操作 UI 组件。

| File | Responsibility |
|------|---------------|
| `services/i18n.js` | Internationalization (`I18nManager.t()`) |
| `services/theme.js` | Theme management (light/dark) |
| `services/storage.js` | IndexedDB key-value storage |
| `services/project_manager.js` | Project lifecycle management |
| `services/scrollbar_visibility.js` | Scrollbar visibility control |

---

## Key Architecture Decisions (summary)

| ADR | Rule | Source |
|-----|------|--------|
| 3-tier write path: UI event → Dispatcher → Commands → CurveManager → Store | S002a | SPEC.md |
| EditorStore = SSOT, CurveManager = projection (no reverse absorb) | S002d | SPEC.md |
| Snapshot-patch history model (diff-based undo/redo) | S006a | SPEC.md |
| Selection: node ↔ object mutually exclusive | S003c | SPEC.md |
| Paper.js managed via `paper_scope.js` (scoped project lifecycle) | S001h | SPEC.md |
| CSS variables for all colors, light + dark theme | G008 | CODEGUIDE.md |
| Constraints labeled `[MUST]`/`[SHOULD]`/`[MAY]`/`[ASPIRATIONAL]` | Preamble | SPEC.md |

---

## Rule Index

| Prefix | Domain | Document |
|--------|--------|----------|
| S001–S016 | Functional specification | [SPECIFICATION.md](SPECIFICATION.md) |
| G001–G010 | Coding standards | [CODEGUIDE.md](CODEGUIDE.md) |

---

## Modification Workflow

Every AI modification **MUST** follow this process:

1. **Read** SPECIFICATION.md and CODEGUIDE.md — understand the functional and coding rules
2. **Read** the files to be modified — understand current implementation
3. **Locate** the files in the [Module Map](#module-map-by-architecture-layer) above to verify layer compliance (S001)
4. **Implement** changes (follow CODEGUIDE.md rules)
5. **Verify** — run the [Functional Deviation Checklist](SPECIFICATION.md#appendix-functional-deviation-checklist) in SPECIFICATION.md Appendix and check CODEGUIDE.md compliance
