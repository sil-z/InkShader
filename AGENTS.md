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

---

## Session Progress — Sisyphus

### Session 1 (previous)

**Objective**: Fix rotation crash; unify handle colors; rotate shear diamonds 45° on horizontal edges.

**Changes**:
- `js/core/transform_engine.js` — Added `isRotateAction()` to handle all rotation handle types (fixes rotation crash → NaN on `rot_tl`/`tr`/`bl`/`br`)
- `js/services/theme.js` — Removed `rot_handle_*`, `shear_handle_*`, `pivot_handle_*` color entries
- `js/canvas/services/canvas_renderer_service.js` — All handles use `p.select_handle_*` colors

### Session 2 (current)

**Objective**: Fix drag-broken (mode toggle on mousedown prevented drag); fix horizontal shear diamond being a square; make all handles transparent-bg (stroke only).

**Changes**:

1. **`select_tool.js`** — Mode toggle moved from mousedown to mouseup. Already-selected branches now set `c.pending_mode_toggle = true` and call `startTransform('drag', ...)` immediately, instead of returning early. Drag works again.

2. **`transform_tool.js`** — `handleMouseUp` checks `c.pending_mode_toggle && !hasChanged` to toggle transform mode only on click (no drag). Resets `c.pending_mode_toggle = false`.

3. **`canvas_renderer_service.js`** —
   - Horizontal edge shear handles: left/right-pointing diamond (`moveTo(x-5,y)→(x,y-4)→(x+5,y)→(x,y+4)`) instead of axis-aligned square.
   - All handles (scale squares, rot circles, shear diamonds, pivot crosshair+circle) now stroke-only — no `fillStyle`/`fill()` calls. Transparent background, hit testing unaffected (bounding-box math in `canvas_utils_service.js`).

**Verification**: LSP diagnostics = 0 errors across all changed files.

**Architecture notes**:
- `c.pending_mode_toggle` is a transient flag set by `SelectTool.handleMouseDown` and consumed/cleared by `TransformTool.handleMouseUp`. It lives on the canvas object for cross-tool communication.
- Handle hit testing (`canvas_utils_service.js`) uses `Math.abs(mouseX - h.x) <= size` bounding boxes, independent of canvas fill/stroke rendering — safe to remove fill.

### Session 3 (current)

**Objective**: Fix UFO/SVG export→import round-trip data loss: rotated ref glyphs (test2) disappearing from the canvas sequence and sequence changing after import.

**Changes**:
1. **`canvas_io_service.js`** — Sequence rebuild in both `_importSVGFontFromString` (~L1125) and `_importUFOFromZip` (~L1350) now keeps non-character glyphs (charCode == null, e.g. test/test1/test2) in the rebuilt sequence as `\name\` tokens, matching the JSON project format (`ABCDE\test\test1\test2\A_D\`). Previously only charCode-bearing glyphs were collected, so name-only glyphs were dropped from the sequence on import (`ABCDEGAD`), making test2 vanish from the canvas/sequence bar.
2. **`canvas_io_service.js`** (earlier in session, already verified) — UFO `<component>` export precision: `Math.round(comp.e/f)` → `parseFloat(comp.e.toFixed(5))` (~L353-354); `exportToSVG` emits `data-refs` JSON; `exportToUFO` emits `data-refs` in layer plist; both import paths resolve refs AFTER sequence initialization but BEFORE final `updateSequenceParsing` (ref-only glyphs like test1 would otherwise be cleaned up as empty), then re-unhide all root groups.

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=20260802d`):
- Baseline JSON `InkShader_project_2026-08-02T16-27-25.json`: editor_sequence `ABCDE\test\test1\test2\A_D\`, root order A,B,C,D,E,G,test,test1,test2,A_D; test2 = [test_Ref_12 matrix [-1,0,0,-1,954.1005859375,965.8573608398438], Path_4].
- New-code UFO export: test2.glif contains `<component base="test" xScale="-1" yScale="-1" xOffset="954.10059" yOffset="634.14264"/>` (ref preserved).
- Import that UFO: 10 roots present, all unhidden, sequence now `ABCDEG\test\test1\test2\AD` (10 tokens — test/test1/test2 restored; G included because it has charCode, same as before the fix), refs restored: test1→test_Ref (identity), test2→test_Ref_1 matrix [-1,0,0,-1,954.10059,965.85736].
- New-code SVG export: `data-refs` attributes present (`[{&quot;base&quot;:&quot;test&quot;,&quot;m&quot;:[...]}]`); SVG glyph order is ligature-first (A_D before A — SVG 1.1 requires ligatures to precede components per L2209-2211 comment); import of that SVG: 10 roots, all unhidden, refs restored identically, sequence `ADABCDEG\test\test1\test2\` (A_D first, faithful to file order).
- Sequence bar renders all 10 tokens (lazy rendering: 3 visible slots + 7 in ellipsis popup — normal behavior at default width).
- User's ORIGINAL test files (`test/InkShader_export_2026-08-02T16-27-30.ufo.zip`, `InkShader_export_2026-08-02T16-27-33.svg`) were produced by OLD code: refs already inlined (test2.glif = 19 contours, 0 components), no data-refs — refs are NOT recoverable from those files; must re-export with new code.
- Console: 0 app errors (favicon 404 + injected blob:mock only).

**Known acceptable differences** (UFO/SVG formats carry no sequence data):
- G appears in rebuilt sequence (has charCode G) even though baseline JSON sequence omits it — same as pre-fix behavior, format cannot encode "removed from sequence".
- A_D token: represented by charCode `AD` (UFO path) or ligature-first order (SVG path) instead of `\A_D\` name token; both resolve to the A_D group.

### Session 4 (current)

**Objective**: Fix three issues: ① JSON load leaves ghost objects (object tree not synced with sequence); ② ref name `test_Ref_12` renumbered to `test_Ref_3` after UFO/SVG round-trip; ③ importing UFO/SVG must NOT populate the canvas sequence with every glyph (user: "留空就行了").

**Changes**:
1. **`snapshot_serializer.js`** (`loadFromSnapshotObject`, ~L62-70) — After `initTree()`, reset `_sequenceService._prevInTextIds = null` and `_prevRootIds = null`. Root cause of ghost objects: stale incremental-sync state from a previously loaded project (e.g. the project auto-loaded at startup) made `syncTreeWithSequence`'s incremental branch (sequence_service.js L303-360) never process root groups that exist in BOTH old and new trees but are absent from the new sequence text — so they were never hidden. Repro (pre-fix): load baseline JSON twice (createNewProject between) → `hiddenRoots: []`; post-fix: `hiddenRoots: [G]` (G omitted from baseline sequence), 9 tokens, 10 roots, no ghosts.
2. **`manager.js`** (`loadFromJSON` ~L966, `loadFromSnapshotObject` ~L975) — Both now call `this._glifExportCache.clear()` alongside the existing `_dirtyGlyphs.clear()`. `_glifExportCache` (L62) was only invalidated via `_markDirty` (L77), so a stale GLIF from project A could be reused when exporting project B if a same-id glyph had the same advance. `loadFromFile` passes a STRING → `loadSnapshotCommand(string)` → `loadFromJSON`; createNewProject/imports pass an object → `loadFromSnapshotObject`. Both paths verified: cache 10 after export → 0 after load via either path.
3. **`canvas_io_service.js`** (ref-name retention, from earlier in session, verified) — `GlifRecorder.addComponent(refName)` + GLIF `<component data-ref-name="...">` (L340-357); UFO export passes `child.name` (L415); `_collectGlyphRefs` returns `{base, name, m}` (L2014-2037); SVG import passes `ref.name||null` as preferredName (L1147); `tree_store.pasteGroupRef(srcGid, tgtGid, tx, preferredName=null)` prefers `ensureUniqueName(preferredName)` over `name+"_Ref"` (L1006-1033); `manager.pasteGroupRef` passes it through (L578).
4. **`canvas_io_service.js`** (empty sequence on import, verified) — Both `_importSVGFontFromString` (~L1124-1135) and `_importUFOFromZip` (~L1337-1348) set `sequenceText = ''` + `_prevInTextIds = null`, keep `rebuildDefaultGlyphs()`, and mark every imported root group `is_modified: true` so `cleanupUnusedEmptyGroups`/`syncTreeWithSequence` don't delete them. Final comments updated (L1154, L1363).

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=20260802g`, CDP `Network.clearBrowserCache` before reload — ES module cache otherwise serves stale code):
- Baseline JSON `test/InkShader_project_2026-08-02T16-27-25.json`: editor_sequence `ABCDE\test\test1\test2\A_D\`; test2 = [test_Ref_12 m [-1,0,0,-1,954.10059,965.85736], Path_4 (20-pt open curve)].
- UFO export: test2.glif = 16 contours + `<component base="test" xScale="-1" yScale="-1" xOffset="954.10059" yOffset="634.14264" data-ref-name="test_Ref_12"/>`. The 16 contours are CORRECT: Path_4 is `smart_stroke: true, stroke_width: 8` (open pen stroke), so `appendCurveFillPath` bakes the 8px stroke via boolean expansion into 16 fill contours. Old code flattened the ref: 19 contours + 0 components. New code = 16 contours + 1 component — strictly more faithful. NOT a bug; do not "fix" contour count.
- UFO import of that export: seqText `""`, 0 tokens, 10 roots, hiddenRoots `[]`, `_glifExportCache.size` 0, test2 children = 16 Path curves + `test_Ref_12` (isRef → test) — ref name AND geometry survive the round-trip.
- Cache-clear paths: export → cache 10 → `loadFromFile` (string path) → 0; export → cache 10 → `createNewProject` (object path) → 0. G still hidden after reload, 9 tokens, 10 roots (ghost fix has no regression).
- LSP diagnostics clean: `canvas_io_service.js`, `snapshot_serializer.js`, `manager.js`, `tree_store.js`.

**Notes for future sessions**:
- Playwright `browser_evaluate` runs in PAGE context (no `page`); use `browser_run_code_unsafe` with `code: "async (page) => {...}"` for CDP/Node-side work.
- `_importUFOFromZip(zip)` expects a JSZip instance (`JSZip.loadAsync(arrayBuffer)` first), not raw bytes — otherwise `zip.file is not a function`.
- Import tests must re-load the baseline JSON before each round-trip; a previous `createNewProject` leaves an empty project and the export yields "No valid glyphs found in the UFO file." (test-script sequencing, not a bug).
- `confirm` dialogs ("Project ... already exists in cache. Overwrite?") appear for loadFromFile/createNewProject/saveToCache — accept via `browser_handle_dialog`.

### Session 5 (current)

**Objective**: Fix expand-stroke swallowtail regression (self-intersection artifact): the old two-stage skeleton-corridor filter kept the inner offset self-intersection ring of a sharp turn as a reversed fill core, cancelling it into a hole under fill("nonzero"). Replace with winding-number classification + faithfulness guard.

**Changes**:
1. **`boolean_geometry_cache.js`** (`refreshCurveBooleanCache`, L136-230) — Replaced the old skeleton filter with:
   - **Capture raw outline BEFORE resolveCrossings** (`strokePathsRaw`, resolveCrossings:false) — resolveCrossings replaces the original path, so the raw self-intersecting ring must be captured first.
   - **Faithfulness guard**: for each CompoundPath with >1 children, compare `Σ(child.area)` vs raw `area`; if relative deviation ≥ 10% (resolveCrossings silently DROPPED lobes, e.g. 180° hairpin U-turn), fall back to the raw self-intersecting outline — canvas fill("nonzero") renders it correctly without splitting.
   - **Winding classification** per child: `rawPath.contains(interior)` (`ringInteriorPoint()` grid-scans 20 steps because `bounds.center` can fall in the notch of a non-convex ring like a "P" counter). wn==0 → genuine hole (KEEP, opposite winding); wn!=0 covered by another child → swallowtail (REMOVE); wn!=0 uncovered → stroke body (KEEP).
   - **Direction unification**: all fill rings (wn!=0) share one orientation, all hole rings (wn==0) the opposite, so CompoundPath's nonzero fill matches the raw ring (resolveCrossings only guarantees alternating winding for NESTED rings — separate swallowtail rings would otherwise turn into holes).
2. **`ringInteriorPoint()` helper** (L91-102) — Grid scan for first point inside a closed child; fallback to bounds.center.

**Verification**:
- **Semantics probe** (`test/classify_probe.js`): Paper.js `Path.contains` on self-intersecting paths == `windingAt != 0` (confirmed YES for all 3 cases) — production can use `contains` directly, no custom ray-cast needed.
- **Production entry probe** (`test/fix_verify_probe.js`, calls `refreshCurveBooleanCache` directly): all 4 cases STRUCTURE: PASS + CORE_DIFF=0.
  - L-shape: 1 subpath [10] (old code: 3 subpaths [10,3,3] — the buggy extra reversed rings).
  - Hairpin: 1 subpath [40], right band maxX=145 (old code: right band maxX=68.2, CORE_DIFF 594 → 0).
  - P-ring (closed): matches old behavior (fillArea ∪ raw semantics — closed smart stroke = solid shape, its fillArea is baked into the model).
  - Circle (closed): solid disk, fillArea effective.
  - **Ground truth correction**: P-ring's production output (fill counter, segs=[9]) is IDENTICAL in old code — this is the inherent closed-stroke model (skeleton polygon hasFillArea is unioned; closed smart stroke = solid shape). Correct truth = raw ∪ fillArea, NOT raw only.
- **L-shape sample-count note**: cache 821 filled vs truth 829, but CORE_DIFF=0 — the diff is boundary-only (1px offset in contains vs windingFromCache comparison, not fill errors). `onBoundary` check uses truth-neighbor determination.
- **Real-app E2E** (Playwright, `http://localhost:8123/?v=e2e-2`, baseline JSON, CDP `Network.clearBrowserCache`):
  - Project loads via `c.projectManager.loadFromFile(jsonStr)` (accept the "already exists in cache. Overwrite?" confirm dialog via `browser_handle_dialog`).
  - Curves are found by `cur.id` (name lives on tree item: `treeItems.set(curve.id, {name: curve.id})`), NOT `cur.name`.
  - Path_4 (8px open smart stroke) cache = **16 closed subpaths**, `_booleanPath2D` built, bounds x[958.6,2913.4] y[-476.0,1531.8]. This MATCHES Session 4's verified ground truth (UFO export test2.glif = 16 contours) — the new classifier does NOT fragment the real curve.
  - Offscreen Path2D fill renders (1156/36100 sampled px), main canvas non-bg px 7685, console 0 errors.
  - **UFO export regression check**: re-export after the fix → test2.glif still = 16 contours + 1 `<component base="test" xScale="-1" yScale="-1" xOffset="954.10059" yOffset="634.14264" data-ref-name="test_Ref_12"/>` — contour count AND ref-name retention identical to Session 4. No regression.
  - Note: `exportToUFO()` triggers a browser DOWNLOAD (returns null) — inspect the downloaded file from `C:\Users\z\.playwright-mcp\InkShader-export-*.ufo.zip`; glyphs live under `font.ufo/glyphs/` with UFO filename conventions (glyph `A` → `A_.glif`, `A_D` → `A__D_.glif`, plain names like `test2` → `test2.glif`).
- **Session 4 regression matrix** (all PASS — boolean-cache change causes NO regression in load/import/export paths; `http://localhost:8123/?v=reg-1`, CDP cache clear, baseline JSON loaded via `c.projectManager.loadFromFile`):
  - **Ghost / G hidden**: after load `roots=10`, `hiddenBySequence=[G]`, sequenceText `ABCDE\test\test1\test2\A_D\` — identical to Session 4 post-fix state (Session 4 expected `hiddenRoots: [G]`).
  - **Ref name retention**: re-export UFO → test2.glif = 16 contours + 1 component with `data-ref-name="test_Ref_12"` (see UFO export regression check above).
  - **Empty sequence import**: `_importUFOFromZip(JSZip)` (fetch `/test/InkShader_export_2026-08-02T16-27-30.ufo.zip` → `JSZip.loadAsync` → `c.io._importUFOFromZip(zip)`) → after import sequenceText `""`, tokens 0, roots 10, hiddenBySequence `[]`, glifExportCache.size 0.
  - **GLIF cache clear**: `_glifExportCache.size` = 0 after `loadFromFile` (string path) — Session 4 fix intact.
  - Probe accessor notes: manager uses `cm.seqService` (NOT `sequenceService`); hidden state is `treeItem.hidden_by_sequence === true` (NOT `is_hidden`); curves are found by `cur.id` (NOT `cur.name`). First probe attempt with wrong accessors showed `hidden=[]` — false negative, correct accessors show `hidden=[G]`.

**Notes for future sessions**:
- The raw self-intersecting stroke outline is CORRECT to keep for pathological cases (faithfulness guard falls back to it) — canvas `fill("nonzero")` handles self-intersecting paths natively; only resolveCrossings' splitting mis-handles them.
- `strokePathsRaw`/`strokePaths` are built from the SAME `strokeRec` — recorder must be replayed for each build (recorder.paths is consumed per buildPaperPaths call).
- Path_4's 16 subpaths = correct model output, not a bug (matches Session 4 verified export). Do not "fix" the contour count. — **SUPERSEDED by Session 6**: after the kept>1 removal fix, Path_4 cache = 4 subpaths [67,235,6,12] and UFO export test2.glif = 4 contours + 1 component. The 12 removed rings were same-direction overlap redundancy (fill-identical, CORE_DIFF=0). 4 subpaths is now the correct output.

### Session 6 (current)

**Objective**: Fix redundant same-direction overlap sub-paths when the skeleton itself loops over its own stroke (user: "描边自身绕圈重叠时，多出来的路径是同向的，属于 overlap，应移除；但含洞的反向路径必须保留"). The expand outline of a looping skeleton yields resolveCrossings children where several same-direction rings overlap one another — they leaked into the cached geometry.

**Root cause**: In `refreshCurveBooleanCache` (boolean_geometry_cache.js), the `kept.length === 1` branch cloned the single child, but the `kept.length > 1` branch kept the CompoundPath WITHOUT removing the rejected children (old comment "else keep CompoundPath with unified-winding children" had no actual filtering). Case B (X crossing) happened to take the `kept.length === 1` path, so all previous tests passed; the loop case (line+ring+line) kept 10 children (7 covered + body + 2 genuine hole rings).

**Changes**:
1. **`boolean_geometry_cache.js`** (`refreshCurveBooleanCache`, kept>1 branch ~L218-233) — When `kept.length > 1`, now ACTUALLY removes rejected children: `const keptSet = new Set(kept.map(m => m.child)); for (const child of [...p.children]) if (!keptSet.has(child)) child.remove();`. The classifier itself (winding + coverage + direction unification) was already correct — verified by `test/loop_diag_probe.js` (children #0..#3/#5/#6/#7 covered → keep=false; #4 body → keep; #8/#9 CW rawContains=false genuine hole rings → keep). The bug was purely in applying the classification.

**Verification**:
- **Loop overlap probe** (`test/loop_overlap_probe.js`, new): Case A line+ring+line open hw=10 → 3 subpaths: #0 body 12-seg CCW area -7797.1 bounds (0,-47)-(200,47); #1/#2 genuine hole rings 3-seg CW area 251.5 bounds (84,-26)-(116,-10)/(84,10)-(116,26). Case A2 (hw=8) → same 3-subpath structure. Case B X crossing → 1 subpath (unchanged). This is EXACTLY the user's requested semantics: hole rings kept reversed, same-direction overlap rings removed.
- **fix_verify_probe** (regression): all 4 cases still PASS (L-shape 1×[10] CORE_DIFF=0, Hairpin 1×[40] maxX=145 CORE_DIFF=0, P-ring 1×[9], Circle 1×[32]) — no swallowtail regression.
- **Path_4 real-curve mask** (`test/path4_mask_probe.js`, rewritten): cache = 4 subpaths [67,235,6,12]. Three-way comparison vs raw truth with UNIFIED 32 samples per curve AND dual-side (raw + geom) 0.01px boundary-neighbor checks:
  - POSTFIX-replica (kept-only): truthFill=3055 geomFill=3055 CORE_DIFF=0
  - PREFIX-replica (all 17 children): CORE_DIFF=0
  - PRODUCTION cache: CORE_DIFF=0 → **PASS: removed rings were pure redundancy, visual fill identical**.
  - **IMPORTANT probe lesson**: the FIRST probe run reported CORE_DIFF=8 (FAIL) — that was a PROBE ARTIFACT, not a real regression: raw side used 40 samples while cache used 24, and boundary-neighbor checks ran only on the raw side. With an 8px stroke + 6px sampling grid, the polygonization mismatch at stroke edges produced false "core" diffs. Always unify sampling density and check BOTH sides' 0.01px neighbors before declaring a core diff.
- **UFO export regression**: export after fix → test2.glif = **4 contours** + 1 `<component base="test" xScale="-1" yScale="-1" xOffset="954.10059" yOffset="634.14264" data-ref-name="test_Ref_12"/>` (was 16 contours in Sessions 4-5). Contour count 16→4 is the EXPECTED effect of removing the 12 redundant overlap rings; ref-name retention intact; export works (download at `C:\Users\z\Desktop\InkShader\.playwright-mcp\InkShader-export-2026-08-03T03-46-00-ufo.zip`).
- LSP diagnostics clean: `boolean_geometry_cache.js`.

**Notes for future sessions**:
- App accessors: `window.c` is NOT a global. Use `document.querySelector('main-canvas')` → `.curve_manager` (curves, seqService), `.io`, `.projectManager`, `.services`. Playwright download events save to `C:\Users\z\Desktop\InkShader\.playwright-mcp\InkShader-export-*.ufo.zip` (workspace-relative), NOT `C:\Users\z\.playwright-mcp\`.
- `confirm` dialogs during loadFromFile must be accepted via `browser_handle_dialog` — do NOT register `page.on('dialog')` handlers in `browser_run_code_unsafe` code, they conflict ("Cannot accept dialog which is already handled!").
- The classifier's coverage test uses a SINGLE interior point (`ringInteriorPoint` grid scan) — adequate for resolveCrossings' simple children (each child is a closed simple ring), as proven by loop_diag_probe and the CORE_DIFF=0 three-way comparison on the real curve. Do not replace with multi-point coverage unless a future case shows fill loss.
- Path_4 expected output is now 4 subpaths (segs=[67,235,6,12]) / 4 UFO contours — matches Session 6 export. Sessions 4-5's "16 contours correct" claims are superseded.

### Session 7 (current)

**Objective**: Fix ghost objects in the UFO/SVG import paths. JSON import already fixed (Session 4: non-sequence root groups hidden via `_prevInTextIds=null` full sweep). User: "json导入时objects中存在画布中不存在的幽灵对象的问题解决了，但导入ufo和svg时存在一样的问题".

**Root cause**: Both `_importSVGFontFromString` (~L1156) and `_importUFOFromZip` (~L1365) ended with a **re-unhide loop** that forced `hidden_by_sequence = false` on ALL root groups after import. Since import leaves the sequence EMPTY (`sequenceText=''`, per Session 4 requirement), this reverted the full-sweep hiding performed by the syncTreeWithSequence triggered via `manager.pasteGroupRef` (manager.js L578-587 → `updateSequenceParsing` → sync). Result: empty sequence but all 10 root groups shown in the object tree = ghost objects.

**Key insight**: `manager.pasteGroupRef` DOES trigger syncTreeWithSequence (via `updateSequenceParsing`), but `treeStore.pasteGroupRef` (tree_store.js L1006) does NOT. The import paths call `c.curve_manager.pasteGroupRef` (manager wrapper) for SVG data-refs (L1148) and `_applyGLIFComponents` for UFO components — so a font WITH refs got the full sweep during ref pasting, but a font WITHOUT refs (like Session 4's original export, refs already inlined) never synced at all. The re-unhide loop then masked the sweep's effect in the refs case AND showed everything in the no-refs case.

**Changes**:
1. **`canvas_io_service.js`** (both import paths, ~L1152-1162 SVG / ~L1360-1370 UFO) — Replaced the re-unhide loop with an EXPLICIT full-sweep call mirroring the JSON load path (snapshot_serializer.js L99): `seqService.syncTreeWithSequence(null, null, null, () => c.curve_manager.notifyTreeUpdate());`. `_prevInTextIds` was already reset to null before the final `updateSequenceParsing`, so this sync performs a full sweep: every root group NOT in the (empty) sequence gets `hidden_by_sequence=true`. Imported groups carry `is_modified: true` (set at group creation), so the sweep hides them but NEVER deletes them (delete requires `children.length===0 && !isRef && !is_modified`). Comment blocks updated to describe the no-ghost invariant.
2. **`test/ghost_repro_probe.js`** — Extended: JSON baseline → UFO import → JSON reload → SVG import, snapshotting roots/hidden/tokens/treeDOM rows at each step.
3. **`canvas_io_service.js`** (follow-up fix for mid-import flash, both group-creation sites) — Newly created imported root groups now set `hidden_by_sequence: true` AT CREATION (SVG path ~L1085-1098 and `_importGLIF` ~L1706-1720). Root cause of the flash: `commit_curve` (manager.js L335) fires `notifyTreeUpdate()` on EVERY `addPath`, and the UFO import loop awaits each glif file (`await glifFile.async("string")`), yielding to the event loop between glyphs — the object tree rendered the half-imported glyphs (hidden_by_sequence still undefined) and only the final sweep hid them. The SVG loop is synchronous (no awaits), so it never hit a mid-import render frame. Creating groups already-hidden means no render, at any point, ever shows them. JSON import was never affected (snapshot load builds the tree inside one sync call before the first notify).
4. **`test/flash_probe.js`** (new) — Polls treeDOM every 25ms during UFO import from a fresh empty project; any non-empty row is a flash. Also run against the SVG import path.

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=ghost-1`):
- AFTER JSON LOAD: roots=10 hidden=[G] tokens=[A,B,C,D,E,test,test1,test2,A_D] treeDOM shows 10 roots + children, G absent from DOM → JSON path unchanged (no regression).
- AFTER UFO IMPORT: roots=10 hidden=[A,B,C,D,E,G,test,test1,test2,A_D] (ALL hidden) tokens=[] treeDOM rows=[] → **ghost objects gone**, tree consistent with empty sequence.
- AFTER RELOAD JSON: identical to first JSON load (hidden=[G], 9 tokens) → reload consistency intact.
- AFTER SVG IMPORT: roots=10 hidden=[A_D,A,B,C,D,E,G,test,test1,test2] (all hidden) tokens=[] treeDOM rows=[] → **ghost objects gone**.
- **Positive control**: after UFO import (all hidden), `seqService.setSequence('ABC'); cm.updateSequenceParsing();` → A/B/C `hidden_by_sequence=false` (re-shown), G/test2 stay hidden, roots=10 → glyphs are only hidden, fully recoverable by typing in the sequence bar.
- **Flash probe** (`test/flash_probe.js`): UFO import from fresh empty project → `flashes during import=0` (treeDOM polled every 25ms, zero non-empty rows mid-import); final roots=10 hidden=10 tokens=0 treeDOM rows=0. Same probe against SVG import → flashes=0. **Mid-import flash eliminated**.
- **Full regression** (`test/ghost_repro_probe.js` re-run after the creation-time-hidden fix): JSON load hidden=[G] / 9 tokens (unchanged), UFO import all-hidden, JSON reload restores hidden=[G], SVG import all-hidden — no regression from the new creation-time `hidden_by_sequence: true`.
- LSP diagnostics clean: `canvas_io_service.js`.

**Notes for future sessions**:
- The no-ghost invariant is: **object tree visibility == sequence membership**. JSON load, UFO import, and SVG import now all converge: root groups not in the sequence text are `hidden_by_sequence=true` and absent from the tree DOM.
- UFO/SVG imports leave the sequence EMPTY (Session 4 requirement), so ALL imported root groups are hidden immediately after import — the object tree looks empty until the user types glyphs into the sequence bar. This is correct behavior, NOT an import failure.
- Do NOT re-add any "re-unhide all root groups" loop after import — it directly recreates the ghost-object bug. If a future requirement needs imported glyphs visible without a sequence, the fix must go through syncTreeWithSequence semantics (e.g., populate the sequence), not by force-unhiding.
- Ghost probe accessors (from Sessions 4-6, still valid): `document.querySelector('main-canvas')` → `.curve_manager` (`.rootChildren`, `.treeItems`, `.seqService`), `.io`, `.projectManager`; hidden state = `treeItem.hidden_by_sequence === true`; `window.confirm = () => true` patched inside page context before any loadFromFile/import (native confirm dialogs block).


### Session 8 (current)

**Objective**: Fix two bugs reported by the user: ? "??ufo?svg?????????symmetric,???????????,??????????????" (UFO/SVG import classifies every node as symmetric, causing serious errors after copying); ? "objects???????????,???????????????????????" (plain-clicking one item of a multi-selection in the object tree does not deselect the rest).

**Root cause ?**: `CurveNode` defaults to `control_mode = 2` (symmetric) (node.js L10). Both import paths set `control_mode = control_mode || 1` after attaching handles (GLIF PASS 2 in `_parseGLIFContour`, SVG `_svgAbsCmdsToCurves`) � since the default is already 2 (truthy), this no-op line left EVERY imported node classified symmetric regardless of actual handle geometry. The copy path (`cloneCurveToGroup`, manager.js L606-620) then called `changeSmoothModeOnSingleNode(marker, mode, true)` which force-created BOTH handles even when the source had only one (phantom mirrored handle on asymmetric/single-handle sources), and kept `control_mode=2` so later handle drags mirror non-symmetric handles via `set_both_control` (node.js L89-110) � "serious errors after copying".

**Root cause ?**: pointerdown handler (object_tree.js L59-77) deliberately skips selection-reset for already-selected items (so dragstart can drag the whole multi-selection). The follow-up `click` ? `handleLeftClick` had branches only for `.tree_right`, toggle, non-ref groups, and `.tree_select_btn` checkbox � a plain click on an already-selected curve/ref row fell through with NO action, so the multi-selection never collapsed.

**Changes**:
1. **`canvas_io_service.js`** � Added `_classifyControlModeFromGeometry(node)` + `_finalizeImportedControlModes(curve)`; called `_finalizeImportedControlModes(curve)` at the end of `_parseGLIFContour` (after PASS 2 loop, before `return curve`) and in `_svgAbsCmdsToCurves` (before `addPath`). Classification convention (matches curve_store handle-delete behavior L145-147): no handles ? 0 (corner); single handle ? 1 (smooth); both handles ? collinear-opposite (sin? = 1e-3, dot < 0) with equal length (rel diff = 1e-3) ? 2 (symmetric); collinear-opposite unequal ? 1 (smooth); else ? 0 (corner). Removed the misleading `|| 1` no-op lines (GLIF PASS 2 �3 sites, SVG �2 sites).
2. **`manager.js`** (`cloneCurveToGroup`, L606-632) � Replaced `changeSmoothModeOnSingleNode(marker, mode, true)` (force-creates BOTH handles + applies symmetric mirroring) with explicit per-handle creation: only create `control1`/`control2` if the source has them, at exact source positions, registered in `newCurve.domMap` + `this.domMap`. `control_mode` copied from source (`?? 0`). Added `import { CurveNode } from './node.js';`.
3. **`object_tree.js`** (`handleLeftClick`, after group branch before select_btn branch) � Added collapse branch: plain click (no shift/ctrl/meta, not on `.tree_select_btn`) on an item that is already selected AND the selection has >1 items ? `requestSetTreeSelection([id], activeGroupId)` (collapses multi-selection to just that item). HTML5 DnD suppresses `click` after dragend natively, so drag-multi-select is unaffected (the `dragPreventClick` flag remains inert; do not rely on it).

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=session8`, CDP `Network.clearBrowserCache` before reload � stale ES module cache served the old manager.js on first load, exactly as AGENTS.md Session 4 notes warned):
- **UFO import classification**: 779 nodes across 52 curves, `mismatch=0` against an independent geometric classifier; mode histogram {0:568, 1:205, 2:6} (pre-fix: 100% symmetric=2).
- **SVG import classification**: same 779 nodes, `mismatch=0`, histogram {0:568, 1:205, 2:6}; roots=10, hidden=10, sequence empty � Session 7 no-ghost invariant intact.
- **Copy parity** (`cloneCurveToGroup` on Path_38, 236 nodes � most single-handle nodes in file): `hMismatch=0 pMismatch=0 mMode=0 phantom=0` � every handle present iff source has it, exact positions, exact control_mode. Pre-fix run showed 14 phantom handles (details: source [true,false] ? clone [true,true] etc.).
- **Object tree** (`object-tree` element, real PointerEvent/MouseEvent dispatch on `.tree_item` rows): T1 plain click unselected ? selects only that; T2 ctrl+click ? adds to selection; T3 plain click on one of multi-selection [Path,Path_1,Path_2] ? collapses to [Path] (**the fix**); T4 plain click on single-selected ? stays single; T5 ctrl+click on selected ? toggles off. All 5 PASS.
- **Regression**: JSON reload after imports ? hidden=[G], sequence `ABCDE\test\test1\test2\A_D\` (Session 4/7 state intact); after UFO import all 10 roots hidden; positive control `setSequence('ABC')` + `updateSequenceParsing()` ? A/B/C re-shown, G/test2 stay hidden.
- LSP diagnostics clean: `canvas_io_service.js`, `manager.js`, `object_tree.js`.

**Notes for future sessions**:
- The import classification is geometry-based ONLY (UFO/SVG carry no handle-type metadata). JSON round-trip is unaffected (snapshot stores `control_mode` explicitly). The 6 symmetric nodes in the fixture are genuinely symmetric (test2's ref-transformed components produce exact mirrors).
- `_finalizeImportedControlModes` must run AFTER the full contour loop because a node's control1 and control2 are attached in different loop iterations (GLIF) / different C-segments (SVG).
- Do NOT reintroduce `changeSmoothModeOnSingleNode(marker, mode, true)` in the copy path � force=true synthesizes the missing opposite handle (phantom). If a future feature needs handle creation, create exactly the handles the source has, at source positions.
- Object-tree click flow is: pointerdown (selection for unselected/modifier clicks) ? click/handleLeftClick (collapse for already-selected plain clicks). Any new click behavior must respect this split, or drag-multi-select breaks.

### Session 9 (current)

**Objective**: User reported that after importing UFO/SVG, some smooth nodes were classified as corners ("????????????,????????????,????????????????,???????????????"). User directed: "??,svg?????????,ufo????????" � implement native GLIF smooth attribute for lossless smooth-type round-trip in the UFO path only; SVG path unchanged (geometry classification).

**Root cause (investigation)**: The importer already classified control_mode from geometry (Session 8), but the EXPORTER destroyed the information: GlifRecorder.getXML wrote Math.round() integer coordinates (fixture confirmed all-integer), so post-rounding handle angles were distorted. On lossless data, sin-angle distribution was bimodal (36/37 nodes < 1e-4, 1/37 > 0.3) � the 1e-3 tolerance itself was correct; rounding caused 18/37 true-smooth nodes to import as corners. Since all project curves are smart strokes (open-smart-w8), GLIF export goes through pass:"fill" ? expanded outline (generated geometry, no node refs) ? setSmoothMode never fires ? expanded outline points needed exact-coordinate classification at getXML time.

**Changes**:
1. **canvas_io_service.js GlifRecorder** � Added _smoothMode state + setSmoothMode(mode); moveTo/lineTo/bezierCurveTo on-curve points carry smooth: this._smoothMode; added _classifyPointSmooth(points, i) classifying on-curve smoothness from EXACT recorder coordinates (for expanded outline points); getXML rewritten as index loop � offcurve points never carry the attribute, others write p.smooth != null ? (p.smooth > 0) : _classifyPointSmooth(...) as smooth="yes"/"no" (explicit both ways, symmetric round-trip).
2. **canvas_io_service.js uildGlyphOutline** � ecorder.setSmoothMode(undefined) before each curve branch (expanded stroke outlines must not inherit a stale skeleton state).
3. **curve.js getSkeletonBezierSegments** � pushSeg appends 
ode/endNode refs so segments carry their source node's control_mode.
4. **path_emitter.js emitCubicBezierSegments** � calls setSmooth(segments[0].node?.control_mode) at start + endNode's mode per segment, guarded by 	ypeof recorder.setSmoothMode === "function" (canvas ctx etc. lack it � ignored).
5. **canvas_io_service.js GLIF import** � _parseGLIFContour reads the smooth attribute (yes?true / no?false / missing?null) into 
ode.importedSmooth; _finalizeImportedControlModes gives it priority: yes ? (no handles ? 0 : geometry==2 ? 2 : 1), no ? 0, null ? pure geometry classification. External-tool files (no attribute) still use geometry fallback.
6. **canvas_io_service.js _classifyPointSmooth round-trip guard** (final fix, this session) � The first full round-trip still had 2 mismatches of 581 nodes (B contour 2 node 3, test2 contour 2 node 6): GLIF wrote curve/yes on degenerate near-zero segments whose handles round ONTO the on-curve point ((594,367) off(594,367) off(594,367)). The importer's PASS 2 skips off-curves coincident with the node (zero-length handle ? no handle created), leaving no handles ? smooth=yes + no handles ? corner(0). Fix: _classifyPointSmooth now counts EFFECTIVE handles as the importer will reconstruct them � a handle that Math.rounds onto the on-curve point is dropped: 0 effective ? false, 1 ? true, 2 ? geometric collinearity check. Export and import now agree on degenerate segments.

**Verification** (browser E2E via Playwright, http://localhost:8123/?v=roundtrip4, CDP Network.clearBrowserCache before reload � ES module cache otherwise serves stale code):
- **Export**: exportToUFO() populates _glifExportCache (glyph ? [advance, glifXML]) � 10 glyphs; download landed at .playwright-mcp/InkShader-export-2026-08-03T16-29-02-ufo.zip, copied to 	est/roundtrip_smooth_v2.ufo.zip (new-code fixture).
- **Round-trip (in-memory, real code)**: baseline JSON ? export ? rebuild zip from _glifExportCache XML (JSZip, project_name t-probe to dodge the confirm dialog; window.confirm = () => true patched) ? _importUFOFromZip ? compare GLIF smooth flags vs imported control_mode (smooth=yes ? mode=1, no ? mode=0): **checkedNodes=581, mismatches=0** (pre-fix: 2 mismatches � both degenerate zero-length-handle nodes). Contour/curve counts match per glyph (A 3/3, B 4/4, C 3/3, D 4/4, E 3/3, test 2/2, test2 4/4; G/test1/A_D are ref-only or empty).
- **Degenerate-node behavior confirmed**: B c2 flags now 	rue,true,true,false,true,... and test2 c2 	rue,true,false,false,true,true,false � the formerly-mismatching nodes export as smooth="no" and import as corner, while single-effective-handle neighbors stay yes.
- **Import priority**: GLIF smooth attribute wins over geometry; smooth=yes with no handles stays corner (curve_store semantics); files without the attribute (pre-Session-9 exports, external tools) use geometry fallback � no behavior change for SVG.
- LSP diagnostics clean: canvas_io_service.js.

**Notes for future sessions**:
- **ES module cache**: after editing canvas_io_service.js (or any ESM module), the page serves stale code � must Network.clearBrowserCache via CDP (rowser_run_code_unsafe: 
ewCDPSession ? Network.clearBrowserCache ? page.reload) before re-testing.
- **In-memory round-trip pattern**: export ? read cm._glifExportCache ? rebuild a JSZip in page context ? _importUFOFromZip(zip) � no download-event handling needed, and it validates the real code paths end-to-end.
- **Probe gotchas**: c.projectManager.loadFromFile takes a JSON STRING (fetch text first); _importUFOFromZip takes a JSZip instance; import/loadFromFile trigger confirm dialogs ("Project ... already exists in cache. Overwrite?") � patch window.confirm = () => true inside the page BEFORE the call (native dialog blocks rowser_evaluate); UFO glyph file names follow _ufoFileName (A ? A_.glif, A_D ? A__D_.glif) � resolve names via glyphs/contents.plist, never by guessing.
- **Degenerate-segment semantics**: a segment whose handles round onto the on-curve point is a near-zero artifact of boolean stroke expansion; the importer treats it as corner (no handle) � the exporter now agrees. This is intentional, not a bug.
- GLIF smooth attr is per-point metadata (format 2 spec); off-curve points must NEVER carry it (spec: only on-curve points).
- **SVG no-regression (user: "svg?????????")**: new-code SVG export (	est/svg_session9_export.svg) contains NO smooth= attribute (SvgPathRecorder has no setSmoothMode ? the 	ypeof recorder.setSmoothMode === "function" guard skips it); importing it gives 581 nodes, mismatch=0 vs independent geometry classifier, roots=10, hidden=10, sequence empty, 2 refs retained. Importing the SESSION 8 baseline fixture (	est/InkShader_export_2026-08-02T16-27-33.svg, refs inlined) reproduces Session 8 results EXACTLY: 779 nodes, histogram {0:568, 1:205, 2:6}, mismatch=0 � SVG path unchanged (still pure geometry classification, no smooth metadata).

### Session 10 (current)

**Objective**: Fix undo wiping the project after UFO/SVG import + sequence add ("import UFO/SVG, add a glyph to the sequence, press undo - the file becomes empty"). Also finalize the SVG smooth-classification verdict from offline analysis (11/581 inherent divergence, superseding the earlier 389 figure).

**Root cause**: Both `_importSVGFontFromString` (~L1131-1134) and `_importUFOFromZip` (~L1368-1371) reset the canvas via `loadSnapshotCommand(emptySnapshot)` and set `c.currentStateObj = c.history.getHistoryState()` **BEFORE the glyph import loop** - capturing the EMPTY document (920 bytes, `glyphs: {}`) as the history baseline. The glyph loops then populate the live tree (~288KB, 10 roots) but `currentStateObj` is never refreshed after import. `recordHistory()` computes `snapshotPatches` as diff(`c.currentStateObj.snapshotObj`, live state) (canvas_history_service.js L479-480); the first recorded command after import (sequence add -> `CanvasDispatcher.requestSetSequenceEditorState(..., {recordHistory: true})`) therefore encoded "empty -> imported" patches; `undo()` applied them in reverse -> the imported project was wiped back to the empty template (roots 10->0, jsonLen 288359->920).

**Changes**:
1. **canvas_io_service.js** (both import paths) - Moved `c.currentStateObj = c.history.getHistoryState()` from before the glyph loop to AFTER the import completes (after the `if (glyphCount > 0)` block, before the ProjectManager registration block), with a comment explaining the baseline requirement. Side benefit: `_flushRuntimeStateSave` / `pm.saveToCache` (which run after the refresh) now persist the IMPORTED document as `latestSnapshot` instead of the empty template.

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=undo-2`, CDP Network.clearBrowserCache before goto; `window.confirm = () => true` patched):
- **UFO path** (`_importUFOFromZip` on `test/roundtrip_smooth_v2.ufo.zip`): post-import `currentStateObj.json` length = 288343 (pre-fix: 920). Add "A" via Add-Glyph UI (`.seq-bar-add-btn` -> `.seq-menu-char-item[title="A (65)"]`) -> seqText "A", commandStack=1. Ctrl+Z -> **roots=10, jsonLen=288343, seqText=""** (pre-fix: roots=0, jsonLen=920). Ctrl+Y -> seqText="A", roots=10. commandStack 1<->0, redoStack 0<->1 - normal undo/redo bookkeeping.
- **SVG path** (`_importSVGFontFromString` on `test/InkShader_export_2026-08-02T16-27-33.svg`): post-import baselineJsonLen=382019, roots=10, seqText="", hidden_by_sequence=10 (Session 7 invariant intact). Add "A" -> Ctrl+Z -> roots=10, jsonLen=382019, hidden=10. Ctrl+Y -> seqText="A", roots=10.
- **No UI regression**: `glyph-sequence-bar` element persists through undo/redo (selector gotcha: the element's className is EMPTY - query by TAG `glyph-sequence-bar`, NOT the class `.glyph-sequence-bar`; `.seq-bar-add-btn` only exists while the sequence is EMPTY - with tokens, adding happens via the per-token `.seq-bar-ins-btn`). Console: only the pre-existing favicon 404.
- LSP diagnostics clean: canvas_io_service.js.

**SVG classification verdict** (offline analysis, `C:\Users\z\AppData\Local\Temp\opencode\classify_offline.mjs`; truth = roundtrip_smooth_v2.ufo.zip GLIF smooth attrs vs exact replication of `_svgAbsCmdsToCurves` + `_classifyControlModeFromGeometry` on svg_session9_fixed.svg):
- **581 nodes, 11 mismatch (1.9%)** - the earlier "389 mismatch" was a probe artifact (rounding-join/topology mismatch) and is SUPERSEDED.
- Breakdown: 6 authorial-intent (GLIF attr != geometry classification: 4 at sinAng 0.003-0.005 rad, 2 at 0.16-0.91 rad - unrecoverable from pure geometry) + 5 near-zero-handle precision artifacts. test2 alone has 10 (8 truth=yes/svg=0, 2 reverse), B has 1.
- Threshold sweep (net = missed smooths - new false smooths): tol 1e-3 -> +8, 3e-3 -> +5, >=1e-2 -> -5 - **no clean tolerance exists**; histograms: truthSmooth2h=433 over bins [<1e-3,<3e-3,<1e-2,<3e-2,<1e-1,>=1e-1]=[424,2,4,0,3,0], truthCorner2h=68=[1,1,6,0,60,0].
- Conclusion: SVG path stays pure-geometry (user directive), 11/581 divergence is inherent to attribute-less SVG; UFO native path is the lossless answer (0/581).

**Notes for future sessions**:
- **History baseline invariant**: any code path that mutates the document outside the command/history system (load, import, createNewProject) MUST refresh `c.currentStateObj = c.history.getHistoryState()` AFTER the mutation completes - otherwise the next recorded command diffs against a stale baseline and undo restores the stale document.
- **Playwright MCP arg shapes** (discovered this session): `browser_evaluate` takes `{"function": "<expression>"}` - the script is wrapped in `() => (...)` so it MUST be a single expression (use IIFEs); `browser_click` takes `{"target": "<css selector>"}`; `browser_press_key` takes `{"key": "Control+z"}`; `browser_snapshot` takes `{"element": ...}` and returns the tree INLINE; `browser_run_code_unsafe` takes `{"code": "async (page) => {...}"}` for CDP (Network.clearBrowserCache) + real page operations.
- MCP snapshot/console files land in `C:\Users\z\.playwright-mcp\` (server cwd = HOME), not the workspace.
- App API root: `window.__canvas` (MainCanvas) - `.curve_manager` (`.rootChildren`, `.treeItems`, `.seqService`), `.history` (`recordHistory`, `undo`, `redo`, `getHistoryState`), `.io`, `.projectManager`, `.editorStore`; `commandStack`/`redoCommandStack` live on the canvas. `window.canvas` does NOT exist.
- The Add-Glyph UI flow: empty sequence -> `.seq-bar-add-btn` ("Click to add glyphs"); non-empty sequence -> `.seq-bar-ins-btn` inside each token slot. Both call `CanvasDispatcher.requestSetSequenceEditorState(..., {recordHistory: true})`.

### Session 11 (current)

**Objective**: User reported SVG import STILL misclassifies smooth points as corners, with a concrete case: two control points at angles -43.7 deg / +136.4 deg (a 0.1 deg deviation from a mirror pair) are detected smooth when importing the same content via UFO. Two root causes found and fixed:

**Root cause 1 - collinearity tolerance too tight**: `_classifyControlModeFromGeometry` (import) and `_classifyPointSmooth` (GLIF export for expanded outlines) used sinAng tol = 1e-3 (~0.057 deg). The user's case: sinAng = sin(0.1 deg) = 1.75e-3 -> corner. Offline corpus sweep (581 nodes, roundtrip_smooth_v2.ufo.zip GLIF truth vs svg_session9_fixed.svg geometry): tol 1e-3 -> miss 9 / false 1; 5e-3 -> miss 4 / false 4 (BREAK-EVEN); 6e-3 -> 3/7; 1e-2 -> 3/8. Decided: **5e-3 (~0.29 deg)** in BOTH classifiers (L380 `_classifyPointSmooth`, L2094 `_classifyControlModeFromGeometry`), comments documenting the tradeoff.

**Root cause 2 - SVG import rounded Y to integers (THE amplifier)**: `_svgAbsCmdsToCurves` L831-832: `flipY = (y) => Math.round(0.8 * canvasH - y)`. Measured: B s2[3] y 432.72 -> stored 433; ALL imported on-curve/control y values were integers while x kept full precision. The GLIF import path (L1878) flips WITHOUT rounding; the SVG exporter writes toFixed(5). The asymmetry injected 0.1-1.0 deg handle deviations (error = 0.5/handleLength; 0.5/300 = 1.7e-3 = 0.096 deg - EXACTLY the user's observed 0.1 deg; a drawn-smooth point was likely exactly collinear pre-rounding) which the old 1e-3 tolerance then read as corners. Fix: `flipY = (y) => 0.8 * canvasH - y` (no Math.round), comment explaining; the null-canvasH fallback (`Math.round(y)`, SVG "as image" import path L997) untouched.

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=smooth-2`, CDP Network.clearBrowserCache before goto; `window.confirm = () => true` patched):
- **Synthetic user case** (stored vectors v1=(724.2,-690) at -43.6 deg, v2=(-722,690) at 136.3 deg, sinAng 1.52e-3, equal lengths): control_mode = **1 (smooth)** - pre-fix corner. (SVG coordinate transform is EXACTLY x'=x, y'=800-y - a pure y-flip preserving angles; sine values slot-agnostic w.r.t. control1/control2 attribution.)
- **y precision restored**: B s2[3] stored y = 432.71971 (was 433); app-side sinAng values now match the offline analysis to the last digit (0.0029744 / 0.00400912 / 0.00335819 / 0.00233727 / 0.00430633 / 0.00555731).
- **Full 581-node recount vs GLIF truth (real code, node-by-node)**: mismatch **11 -> 9**. Remaining: 4 misses - test2 c1[54] 0.909, c1[166] 0.165, c2[5] 0.684 (authorial: GLIF smooth=yes from skeleton setSmooth while geometry diverges; unrecoverable) + c1[190] 0.005557 (just above 5e-3; documented residual); 5 falses - B c2[3] 0.000332 (pre-existing), test2 c1[191] 0.002563 / c1[205] 0.004073 / c1[208] 0.003798 (NEW: near-collinear corners <0.29 deg now classify smooth - visual shape unchanged, only handle-type semantics), c2[6] single-handle (pre-existing).
- **UFO round-trip (fresh export with new tol -> import)**: 581 nodes, mismatch = **0** (export-side 5e-3 attr writer and import-side agree; GLIF attr priority unchanged).
- Probe files kept: `test/smooth_tol_recount_probe.mjs` (full recount w/ GLIF truth from zip), `test/smooth_tol_ufo_roundtrip_probe.mjs` (in-memory export->zip->import consistency check).
- LSP diagnostics clean: canvas_io_service.js. Console: only pre-existing favicon 404.

**Notes for future sessions**:
- **SVG import coordinate transform**: x' = x, y' = 0.8 * canvasH - y (= 800 - y for the stock canvas), full float precision (as of Session 11). node.control1 = OUTGOING handle (next C segment's c1 point), node.control2 = INCOMING (prev C segment's c2) - verified empirically; sine-based classifiers are slot-insensitive.
- **Geometry tolerance ladder** (581-node corpus): smooth points deviate up to ~0.3 deg (rounding/drawing); corners below 0.29 deg also risk classification smooth - inherent ambiguity, 5e-3 chosen as break-even (4/4). Threshold sweep tool: offline script logic replicated inside `test/smooth_tol_recount_probe.mjs`.
- Curve-store accessors: `curveStore.curves` (Map, insertion order == contour order within a glyph), `curve.groupId` IS the glyph name (e.g. "A", "test2"); `treeStore.treeItems`/`groupFlatCache` are Maps (Object.keys returns []).
- UFO filename reverse mapping for truth files: `A_.glif` -> "A", `A__D_.glif` -> "A_D" (replace /__/g with '_', then strip trailing '_').
- GLIF truth alignment: per-glyph contours in file order align with curves in insertion order; skip on node-count mismatch.
- Downloaded exports land in `C:\Users\z\Desktop\InkShader\.playwright-mcp\InkShader-export-*.ufo.zip` (workspace-relative).
- Playwright MCP `browser_run_code_unsafe` `filename` param requires the file inside allowed roots: `C:\Users\z\Desktop\InkShader` or `C:\Users\z\Desktop\InkShader\.playwright-mcp` (temp dir NOT allowed; the MCP server enforces this after restart).

### Session 12 (current)

**Objective**: User reported the Smart Expand Direction setting is broken ("无论怎么调,expand 出来的方向都是自动的").

**Root cause**: `refreshCurveBooleanCache` (boolean_geometry_cache.js L291) only ran `resultPath.reorient(true, curve.smart_stroke_clockwise)` when `curve.closed === true`. All real user curves (A-E, Path_4) are OPEN smart strokes (open-smart-w8), so the reorient — the ONLY geometric consumer of `smart_stroke_clockwise` — never executed for them, and expand direction was always determined automatically by skeleton direction/resolveCrossings. The old comment's fear ("reorient may destroy the alternating winding") was based on the DOCUMENTED old Paper.js API; the ACTUAL bundled paper-full.min.js (custom/develop build — SHA256 `E984608...` matches NO npm release 0.12.0-0.12.17) implements the NEW containment-aware `reorient(nonZero, clockwise)` = `reorientPaths`: root rings get `clockwise` (the toggle), nested hole rings get the opposite — exactly the desired semantics, verified 1:1 against the minified fragment `reorient:function(e,t){...!!(e?t:1&t)...t!==R&&this.setClockwise(t)...}` and the develop-branch `src/path/PathItem.Boolean.js` source.

**Changes**:
1. **`boolean_geometry_cache.js`** (reorient block, L283-300) — Dropped the `curve.closed &&` guard; reorient now applies to ALL smart-stroke outlines (`curve.smart_stroke && curve.stroke_width > 0`). Comment rewritten (bundled paper.js reorientPaths is containment-aware and safe for open CompoundPath children; removed-rings semantics protected because the classifier already removes covered same-direction rings, and reorientPaths only excludes children whose winding insideness equals their container's — impossible for kept body/hole rings). `getGeometryHash` (curve.js L907) already folds `smart_stroke_clockwise` in, so toggling invalidates the cache and re-runs the reorient automatically.

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=direction-1` — server started with `python -m http.server 8123` since start_server.py does NOT exist in the repo; CDP Network.clearBrowserCache before reload; `window.confirm = () => true` patched; probe file `test/direction_flip_probe.js`):
- **Path_4 (open smart stroke w=8) baseline** (sw=false): 4 subpaths, signed areas `[+229550.7, -339625.8, +615.3, +6829]` (235-seg body ring CCW — reorient(true,false) = roots CCW; smaller rings CW = holes).
- **Direct toggle false→true** (cache layer): ALL FOUR areas flip sign exactly `[-229550.7, +339625.8, -615.3, -6829]` — **the fix works; pre-fix this was a permanent no-op**.
- **Real UI chain** (path-property-popup `_handleSmartWindingToggle` → `CanvasDispatcher.requestSetSingleObjectProperties([{toggle_smart_winding:true}], {recordHistory:true})` → command → tree_store): curve object identity preserved (`sameObj=true`), `sw` flipped to true, cached orientation flipped identically — the exact user click path is verified end-to-end.
- **Visual regression**: offscreen 2000×2000 Path2D fill (bezier curves from cached segments) — pixel diff vs baseline = **0** for both sw=true and sw=false (ring reversal is fill-identical under nonzero); also proves reorientPaths did NOT remove any ring.
- **Closed-path sanity**: Path_4 with closed=true → 2 subpaths `[-1873518.2, +70529.3]` ↔ `[+1873518.2, -70529.3]` toggles — closed behavior unchanged (was already covered pre-fix).
- **Restore**: sw=false/closed=false → orientation identical to baseline.
- **Expand command chain**: `canvas_commands.js` `expandSelectedStroke` (L988, L1014, L1022) consumes `curve.cached_boolean_geometry` directly → expand output direction follows the toggle (the user-visible behavior).
- **UFO export regression**: `exportToUFO()` → `_glifExportCache` size 10; test2.glif = **4 contours + 1 component** (Session 6 baseline intact — reorient adds/removes nothing); A.glif = 3 contours (Session 9 baseline).
- LSP diagnostics clean: boolean_geometry_cache.js. Console: only pre-existing favicon 404.

**Notes for future sessions**:
- **The bundled Paper.js is NOT an npm release** (hash differs from 0.12.0-0.12.17). It uses the develop-branch `reorient(nonZero, clockwise)` API (nonZero=fill-rule selector, clockwise=target root orientation) — NOT the old documented `reorient(clockwise, useCenter)`. When reasoning about paper API behavior, verify against the minified bundle + develop source, not the docs.
- `reorientPaths` can EXCLUDE children (removes rings whose winding-insideness equals their container's) — safe here because boolean_geometry_cache's classifier removes covered same-direction rings first; kept rings are bodies (roots) and holes (inside bodies) which reorientPaths keeps and orients alternately.
- `cached_boolean_geometry` structure = array of `{ closed, segments: [{x,y,inX,inY,outX,outY}] }` (NOT raw point arrays) — probes must use `geo[i].segments`.
- Direction convention in y-down screen coords: shoelace area > 0 = clockwise. `reorient(true,true)` = roots CW; `reorient(true,false)` = roots CCW.
- `browser_run_code_unsafe` filename resolution: relative paths resolve against the MCP server cwd (`C:\Users\z\.playwright-mcp`); pass the full workspace-absolute path for files in `C:\Users\z\Desktop\InkShader\.playwright-mcp\`; the code string itself is wrapped as an expression — NO trailing semicolon.
- Local dev server: `start_server.py` is absent from the repo; use `python -m http.server 8123` from `InkShader\` for manual/E2E testing.

### Session 13 (current)

**Objective**: User reported: "smart expand direction能控制方向了，但并没有正确和其他路径叠加" — after Session 12 fixed the direction toggle, expanded outputs no longer composite correctly with other paths (holes appear when overlapping).

**Root cause**: Two fill strategies coexisted in the renderer:
1. **Batch fill (shared path)** in `canvas_renderer_service.js` `forEachPathPass` fill pass: ONE `beginPath()` collected every curve's outline via `appendCurveFillPath`, then a SINGLE `ctx.fill("nonzero")`. Old design comments (L278/L407) explicitly said "non-zero winding fill composition against every other curve in same glyph". Consequence: when two curves have OPPOSITE winding, their overlap region gets winding +1 + (−1) = 0 → cancelled into a HOLE.
2. **Smart stroke (Path2D)** in `curve_renderer.js` L66-75: independent `fillSmartStrokePath2D` per curve — never interacts cross-curve.

`expandSelectedStroke` (canvas_commands.js L988) outputs closed curves (`closed=sub.closed`, `smart_stroke=true`, `stroke_width=0`) → `canFillSmartStrokeWithPath2D` returns false (stroke_width<=0) → **forced into the batch-fill path**; direction comes from `smart_stroke_clockwise` (Session 12). So toggling direction gave expanded curves opposite windings → shared-path nonzero fill cancelled their overlap into holes. `sequence_group_preview.js` (preview thumbnail) had the same shared-path + single `fill("nonzero")` bug.

**Changes**:
1. **`js/canvas/services/canvas_renderer_service.js`** (fill pass, old L1231-1257) — Removed the shared `beginPath()`/`hasFill` batching. Each curve now gets its own `beginPath()` + `appendCurveFillPath` + `fillStyle` + `fill("nonzero")` (union semantics: cross-curve winding never cancels). Path2D smart fills (`path2dFills`) unchanged (already per-curve). Comments rewritten (L1235-1238, L278-280, L407-409).
2. **`js/presentation/sequence/sequence_group_preview.js`** — Same per-curve `beginPath()` + `appendCurveFillPath` + `fill("nonzero")` fix for the preview thumbnail.

**Verification**:
- **Root-cause proof (offscreen, real production `appendCurveFillPath`)** — `test/semantic_probe3.js` renders Path_4's cached boolean geometry + a REAL reversed clone (clone + `smart_stroke_clockwise=true` + `updateBooleanCache`; clone IS required — a plain `{cached_boolean_geometry}` object has no `startNode`, `appendCurveFillPath` silently returns):
  - single `[p4]` = 109607 filled px; reversed alone = 109607 (direction doesn't change fill) ✓
  - **pair independent (post-fix per-curve fill) = 114689 → union, no cancellation** ✓
  - **pair SHARED path (pre-fix) = 0 → total cancellation into emptiness (the exact reported bug, reproduced in isolation)** ✓
  - hole centers (6-seg, 12-seg counter rings) alpha = **0 → single-curve holes still dig** ✓
  - `revAreas` = exact sign flip of `p4Areas` (direction retained in cache) ✓
- **Probe gotchas (learned the hard way)**: counting `alpha>128` on a WHITE-filled background counts everything (bg alpha is 255 too) → use transparent canvas + `alpha>0`; fake flip objects silently no-op → use real clones.
- **Real UI chain (main canvas)** — `CanvasDispatcher.requestSetTreeSelection([p4.id], parentGid)` → `requestExpandStroke()` → clear selection → sample canvas pixels:
  - phase1 (expand Path_4 → 4 CCW curves): `{filled:11489, hash:3396968955}`
  - phase2 (clone one expand output, `smart_stroke_clockwise=true`, expand at same position → opposite-winding curve added): `{filled:11489, hash:3396968955}` **identical — no hole when opposite-winding curves overlap** ✓
- **Render-trigger discovery**: direct `c.commands.expandSelectedStroke()` calls do NOT trigger the render pipeline (canvas pixels unchanged = stale frame). Only the full Dispatcher chain (request → command → commit → store → render) repaints. The earlier `11806 constant` readings in `expand_overlap_probe2.js` were this stale-frame artifact — DO NOT trust pixel numbers from direct command calls.
- **Render bistability**: two consecutive `renderCanvas()` of the SAME state can yield `11423/1179943855` vs `11389/2211407728` (~34px diff — stable-scene-cache blit vs live path pass, `_tryRenderFromStableScene` vs `_renderScene`). Relative comparisons under identical sampling (phase1 vs phase2) are valid; absolute counts are not reproducible frame-to-frame.
- **GLIF direction preserved** — `c.io.exportToUFO()` → `cm._glifExportCache.get('test2')` XML → contour shoelace areas `[-229750.5, +338865.5, -629, -6767.5]` match cache areas `[+229550.7, -339625.8, +615.3, +6829]` with y-flip sign inversion. Export direction intact. ✓
- LSP diagnostics clean: `canvas_renderer_service.js`, `sequence_group_preview.js`. Console: only pre-existing favicon 404.

**Notes for future sessions**:
- **Fill invariant**: every filled curve gets its own `beginPath()` + `fill("nonzero")`. NEVER reintroduce a shared path across multiple curves — cross-curve overlaps MUST composite as a union regardless of contour direction (single-curve counters/holes still work because they live inside one curve's own path).
- **Renderer access**: `c.services.renderer` exposes `renderCanvas()`, `_renderScene({clear:true})`, `invalidateStableSceneCache()`; canvas element also has `renderer` (plain object) and `renderRuntimeService`.
- Canonical probes for this bug: `test/semantic_probe3.js` (offscreen union-vs-shared proof), `test/dispatcher_expand_probe.js` + `test/expand_overlap_final_probe.js` (real-chain phase comparison), `test/glif_direction_probe.js` (export direction).

### Session 14 (current)

**Objective**: User requirement (follow-up to Session 13): an expand output with REVERSED winding (CW) overlapping a positively-wound (CCW) curve MUST dig a hole in it — Session 12's direction toggle exists precisely so the user can subtract one expanded stroke from another. Session 13's per-curve union fill made opposite-winding overlap inert. Restore cross-curve winding composition on the MAIN canvas and validate end-to-end through the UI dispatcher chain.

**Root cause (Session 13's over-correction)**: Session 13 gave every curve its own `beginPath()` + `fill("nonzero")`, making ALL cross-curve overlaps union — same AND opposite winding alike. But with the Session 12 direction toggle, opposite winding is a deliberate user choice meaning "subtract"; composition itself was never the bug (the Session 13 holes came from automatic direction, already fixed by Session 12). Removing composition made the toggle visually inert for overlaps.

**Changes**:
1. **`js/canvas/services/canvas_renderer_service.js`** (fill pass, L1231-1266) — Reintroduced ONE combined Path2D per glyph pass: every curve's outline goes into `combinedPath` (smart strokes via `addPath(curve._booleanPath2D, booleanViewportDOMMatrix(viewport))`; everything else via `appendCurveFillPath`), then a single `c.ctx.fill(combinedPath, "nonzero")`. Comments rewritten (L1235-1238) documenting the requirement: same-winding overlaps union; opposite-winding overlaps cancel into holes (nonzero rule). Session 13's "NEVER share a path" invariant is **SUPERSEDED** for the main canvas — union-only semantics now hold only within a single curve's own path.
2. **`js/presentation/sequence/sequence_group_preview.js`** — verified consistent: ONE shared path + one `fill("nonzero")` (L35-47); the preview composes windings within a group exactly like the main canvas. No change needed.

**Verification** (full chain, all green):
- **Offscreen semantics (diag-8)**: production `buildBooleanPath2D` + Path2D `fill("nonzero")` — Path_4 + reversed clone in ONE path = **0 filled px** (total cancellation; hole-digging geometry); separate fills > 0.
- **diag-13 — why every main-canvas phase comparison previously looked identical**: instrumented Path2D during forced full render → `moves:0, bzs:0, adds:4` — `addPath` fired but ZERO geometry emitted. Root cause: test2 (Path_4's group) = sequence token idx 7 with `seqOffsetX = 7000`; the DEFAULT viewport only spans `vpBounds.maxX ≈ 2013`, so `_isCurveInViewport` (canvas_renderer_service.js ~L1920, adds seqOffsetX to curve bounds) culled ALL test2 curves → earlier "identical pixels across phases" compared EMPTY frames.
- **On-canvas hole digging (diag-14, decisive)**: pan viewport to test2 world region → base `filled=27941` → expand Path_4 (sw=false, 4 CCW outputs) → expand a REVERSED clone (`smart_stroke_clockwise=true`) at the same position → `filled=25954` (−1987 px — hole dug through the full Dispatcher chain) → expand original again (sw=false) → `filled=25947` (hole refilled). Output count 4 per expand; kids `[test_Ref_12, Path_4, Path_10..13]`.
- **Delete-restore (diag-15)**: `requestDeleteSelectedObjects(ids)` (NOT `requestDeleteSelection`) on the 4 CW outputs → EXACT pre-delete fill/hash restored.
- **diag-16/17 — cache-explosion false alarm**: clone cache fragmenting into 27 subpaths was a PROBE artifact (probe shifted only anchors, not control points → distorted skeleton → `resolveCrossings` fragmentation). `cloneCurveToGroup` (manager.js L590) returns a DEEP copy (`sharedStartNode:false`).
- **Partial overlap (diag-18 → diag-19) — final resolution**: diag-18 reported `filled=220079` (≈98% of the 224,598-sample grid) after adding a shifted (−600) CW expand — alarming. diag-19 series via NEW pure-Node CDP driver `test/diag19_cdp_driver.mjs` (no Playwright MCP — Node built-in fetch + WebSocket; headless Chrome `--headless=new --remote-debugging-port=9222 --user-data-dir=…`; `Network.clearBrowserCache` before navigate):
  - shift integrity: all 20 nodes (anchors + controls) shifted exactly −600, `allClean:true`;
  - clone's boolean cache = exact translated sign-flipped copy of Path_4's ([67,235,6,12] segs; bounds −600; areas ±flipped; cloneSanity: sameSubpathCount 4/4, areaSignFlipped, xShifted600, ySame, segsMatch — upstream cache NOT stale);
  - expand outputs Path_10..13 bounds match the cache rings exactly (±0.05px) — expand pulls geometry straight from `cached_boolean_geometry`;
  - correct pan (`c.offset` object) at scale 0.3 centered on Path_4∪clone: base 9167 → afterCW 10314 → afterBoth 10314 (hash differs = AA-only). Bands (local x): left +295 (clone's non-overlap corridor added solid — no cancellation without an opposite-winding curve there), overlap +852 (bodies cancel ≈ −976px corridor; Path_4's two CW counter-rings + clone's two CCW counter-rings re-fill under the opposite body — exact nonzero semantics), right UNCHANGED 368 (no clone there).
  - **diag-18 verdict: probe artifact, NOT an app bug** — 220079 ≈ 98% with the 18px ruler strip unfilled = the alpha>0 sampler trap on the opaque main canvas (Session 13 documented gotcha); correct viewport + d>24-vs-corner sampler shows sane small deltas. afterBoth ≈ afterCW reproduces diag-14 on the headless canvas (543×375, dpr 1).
- Console: 0 app errors across all runs (favicon 404 + probe-time IDB PAGEERROR from storage-clear races only). LSP diagnostics clean on changed files.

**Notes for future sessions**:
- **Fill invariant (REPLACES Session 13 note)**: per-glyph single combined Path2D + one `fill("nonzero")`. Cross-curve winding composition is a REQUIREMENT: same winding unions, opposite winding cancels into holes. Session 13's union-only invariant is superseded — that bug was automatic direction, fixed by Session 12's toggle.
- **Viewport/pan probe recipe**: renderer reads `c.scale` + `c.utils.getLogicalOffset()` = `{x: c.ruler_size + c.offset.x, y: c.ruler_size + c.offset.y}` (canvas_utils_service.js L17-21). `c.offset` is an OBJECT — `c.offsetX/offsetY` scalars are DEAD fields (writes change nothing). Pan formula: `c.offset.x = logicalW/2 − worldCX*scale − ruler`; `logicalW = canvas.width / devicePixelRatio`; `worldCX = curveBoundsCenterX + seqOffset`.
- **Sequence accessors**: `cm.seqService.sequenceTokens` is a PROPERTY (no `getSequenceTokens()` method); `getSeqOffset(idx)` on seqService; token→groupId: `t.isChar ? getDefaultGroupForChar(t.value) : t.value`.
- **test2 (Path_4's group) is OFF-SCREEN by default**: world x ≈ 7958..9913 (local 958..2913 + seqOffset 7000, tokIdx 7). Any probe of it MUST pan the viewport first.
- **Pure-Node CDP probe pattern** (no Playwright MCP): `PUT http://localhost:9222/json/new?about:blank` + built-in WebSocket + `Runtime.evaluate({expression, awaitPromise:true, returnByValue:true})`. Headless canvas = 543×375 dpr 1 — NEVER hardcode logical dims; read them from the canvas.
- Canonical probes for this bug: `test/semantic_probe3.js` (offscreen union-vs-shared proof), `test/diag19_cdp_driver.mjs` (shift-integrity + partial-overlap end-to-end CDP probe), `test/hole_dig_probe.js` (earlier pan-based on-canvas probe), `test/expand_overlap_final_probe.js` + `test/glif_direction_probe.js`.

### Session 15 (current)

**Objective**: User reported 6 SVG-export issues when importing into FontForge: ① "there are multiple fonts in this file" (a nameless-font appears); ② object references are not expanded into pure path data, FontForge cannot read them; ③ SVG kerning sign is flipped (negative kerning INCREASES spacing, but UFO is correct); ④ after Inkscape open/save, glyph groups have random names instead of glyph names; ⑤ glyphs containing object references cannot be FontForge "Correct Direction"-ed; ⑥ SVG→OTF (18k) is much larger than UFO→OTF (10k).

**Root causes (all confirmed against FontForge 20251009 source fontforge/svg.c + empirical ffpython runs)**:
- ① _FindSVGFontNodes (svg.c:1193) matches ANY element whose LOCAL name is "font" (namespace-agnostic, xmlStrcmp(node->name,"font")); our export wrote <inkshader:font> metadata (no id) → FontForge collects it as a second font named "nameless-font" (svg.c:1238) → SVGPickFont picker. Fix: rename to <inkshader:font-meta> (local name != "font"). Nothing imports inkshader:font (grep-verified), so the rename is safe.
- ② FontForge reads ONLY the d attribute (svg.c:1590/2887); our custom data-refs is invisible. Ref-only glyphs (test1) exported with d="" → empty in FontForge. FontForge DOES support standard <use href="#id"> (svg.c:2735) but we never emitted it. Fix: _buildGlyphSVGPaths now expands ALL refs (root-glyph refs included) inline with accumulated transform; data-refs attribute and _collectGlyphRefs removed from SVG export (UFO <component> remains the structural format; _isRefToRootGlyph retained for UFO only). SVG data-refs IMPORT kept for backward compat with old files (old files have no inline ref geometry, so no double-render; new files have no data-refs).
- ③ SVG 1.1 spec + FontForge: SVGParseKern (svg.c:3167) does off = -strtod(k) — FontForge NEGATES k on import; its own dump writes k=-kp->off. Project kerning uses UFO/FontForge convention (negative = closer, baseline JSON: A→E = -500). Fix: export k = -Math.round(value) (all 4 buildKernElements sites). Result: SVG and UFO paths now BOTH land at FontForge GPOS -500.
- ④ Visual layer <g id="layer"> ids were layer numbers; Inkscape names groups from ids → "random" names. Fix: g ids = sanitized glyph names (deduped via usedGlyphIds Set, invalid id chars → '_', non-letter-leading → 'glyph-' prefix); outer wrapper id fixed to "glyph-layers".
- ⑤ Consequence of ②: ref-only glyphs had no contours in FontForge → nothing to Correct Direction. With refs flattened, test1/test2 have real contours and correctDirection() executes cleanly. NOT a FontForge bug.
- ⑥ NOT a FontForge bug — root cause found via CFF bytecode dump: FontForge preserves fractional SVG coordinates and its CFF writer stores them as 16.16 fixed-point (4 bytes/value; charstrings full of f 4-byte codes, e.g. 290.587→ff0122f165), while the GLIF path writes integer coords → compact delta encoding. CFF 16242 vs 3894 bytes; OTF 17756 vs 5388 on identical geometry (1642 vs 1651 pts). **Important: I first "fixed" this by rounding font-layer d to integers — it caused a CATASTROPHIC classification regression (118/257 nodes smooth→corner, sinAng up to 0.45: expanded stroke outlines have short handles where 0.5-unit rounding distorts angles by degrees; GLIF survives only because it carries smooth attrs). REVERTED.** Full precision (toFixed(5)) stays — Session 11 requirement. FontForge-side remedy verified: glyph.round() (or GUI Element > Round To Int) before generate → 5560-byte OTF (vs 5572 UFO). Documented in code comment.

**Changes**: js/canvas/services/canvas_io_service.js only — metadata rename; refs expanded inline in _buildGlyphSVGPaths (skip branch removed, JSDoc updated); _collectGlyphRefs deleted; data-refs emission removed (comment documents UFO as structural format); kerning -Math.round(value) at 4 sites + SVG-convention comment; visual g ids = glyph names + dedupe; wrapper id "glyph-layers"; _isRefToRootGlyph/recorder/fyFont comments updated. NO coordinate rounding (see ⑥).

**Verification** (browser E2E via Playwright http://localhost:8123/?v=ff2..ff5, baseline 	est/InkShader_project_2026-08-02T16-27-25.json loaded via loadFromFile, window.confirm = () => true patched, CDP Network.clearBrowserCache; downloads land in C:\Users\z\.playwright-mcp\ (HOME, NOT workspace)):
- New export 	est/new_font_export.svg (kept as fixture): *:font count=1, inkshader:font-meta present, data-refs=0, <hkern g1="A" g2="E" k="500" /> (project -500), g ids = [A_D,A,B,C,D,E,G,test,test1,test2] + glyph-layers wrapper, test1 d=483 chars (ref expanded), fractions present (full precision).
- FontForge (ffpython 20251009) on new export: fontname Simple_Script (single font, no nameless-font); test1 contours=2 pts=56 (was missing); test2 contours=6 pts=1012 (2 test-geometry + 4 Path_4); correctDirection OK on test/test1/test2; full-precision OTF 19088 → after glyph.round() 5560 (UFO path: 5572); GPOS PairPos A-E = -500 in BOTH SVG and UFO OTFs.
- InkShader re-import of new export: roots=10 (all 10 names), hidden=10, seq="", test1/test2 kids = plain curves only (refsFound=[]), 0 console errors — Session 4/7 invariants intact; refs now arrive flattened (intended).
- Classification recount vs GLIF truth (ff_classify_probe.mjs, 257 comparable nodes A-E+test; test2 skipped — flattened refs change contour count/order vs truth): mismatch=1 (B c2[3] false, sinAng 0.00033 — the SAME pre-existing false from Session 11). NO regression from the export changes; the integer-rounding experiment measured 118/257 and was reverted.
- LSP diagnostics clean: canvas_io_service.js.

**Notes for future sessions**:
- **FontForge facts** (source fontforge/svg.c master): fonts are matched by LOCAL element name "font" regardless of namespace (_FindSVGFontNodes:1193, nameless-font at :1238); only d is read (no custom attrs); kerning is negated on import (SVGParseKern:3167 off=-strtod(k)) and on its own dump; <use href="#id"> is supported (svg.c:2735); fractional coords → 16.16 fixed CFF (4 bytes/value) → ~3x OTF; glyph.round() (GUI: Element > Round To Int) makes SVG-derived OTFs match UFO size. ffpython has NO ont.kerning() reader; verify kerning via fontTools GPOS PairPos dump (test/gpos_kern_dump-style) instead.
- **Do NOT round the SVG font-layer coordinates** — measured regression 118/257 smooth→corner on the real corpus (expanded outlines have short handles). Full precision is load-bearing for SVG re-import classification (Session 11). The UFO path is the compact/lossless interchange.
- **SVG refs are now flattened**: re-importing an InkShader SVG never restores group refs (pure path data by design, user request); structural round-trip goes through UFO <component>. Old data-refs SVGs still import (backward compat).
- New probes kept: 	est/ff_export_probe.mjs, 	est/ff_import_probe2.mjs (Map iteration — Object.values(treeItems) on a Map returns []), 	est/ff_classify_probe.mjs (GLIF-truth recount), fixture 	est/new_font_export.svg. Probe gotcha: window.confirm patch MUST be set inside page.evaluate before _importSVGFontFromString, else a cached project triggers a blocking native dialog.
- Playwright download path is C:\Users\z\.playwright-mcp\ (server cwd = HOME); workspace .playwright-mcp\ also exists but holds only logs/snapshots.
- **SVG font import CANNOT express cross-glyph refs (FontForge, source-proven)**: glyph bodies parse via SVGParseGlyphBody -> SVGParseSVG(glyph,...) -> _SVGParseSVG(svg=glyph, top=glyph) (svg.c:2892,2880); the <use> branch resolves XmlFindID(top,...) (svg.c:2735-2747) which searches only the SAME glyph element + descendants. Document-wide <use> works only in generic (non-font) SVG parsing. Custom attrs (data-refs) are never read (only d, svg.c:2887). => Inline expansion is the ONLY way SVG fonts can carry ref geometry to FontForge; ref structure lives in UFO (components). Verified: UFO roundtrip_smooth_v2 -> FontForge: test1 contours=0 (pure component), test2=4+ref; f.correctDirection() OK with composites intact; OTF 5388B with test1 geometry complete (2 contours, bounds==test).
- User policy (Session 15): font-layer coordinates must NEVER be auto-rounded in export - rounding is a user action (FontForge glyph.round()/Element > Round To Int only). Keep toFixed(5).
- **Correct Direction + UFO composites - mechanism verified (ffpython 20251009)**: ref-only glyphs (test1) have 0 contours; cd cannot and need not touch them - their output direction is inherited from the BASE glyph at generation. Controlled experiment: per-glyph g.correctDirection() on the UFO import normalized test (+222k/-205k -> -222k/+205k, containment-aware: outer=CW/hole=CCW in model; CFF output reverses to outer=CCW PS convention) and test2's own contours, while test1 stayed 0-contour; OTF output showed test1/test2-ref parts following the corrected base exactly. Reverse experiment (hand-flipped test.glif): cd correctly no-op'd (flip produced the canonical state). CRITICAL QUIRK: font-level f.correctDirection() is a SILENT NO-OP in this build - use per-glyph g.correctDirection() (GUI Element > Correct Direction works normally). Session 15's 'correctDirection OK' checks were false positives (exception-free no-op); direction-level verification done here. User workflow: UFO -> FF -> select all -> Correct Direction -> bases fixed, composites inherit - refs and cd coexist, no expansion needed.

### Session 16 (current)

**Objective**: Two UI issues: ① changing UPM in the font settings menu leaves the properties panel's Advance field (g_advance) stale (LSB/RSB refreshed but Advance did not); ② sequence/glyph menu thumbnails are centered on the convex-hull bbox of each glyph, making the row look ragged - center instead on the ASCENDER/DESCENDER + left/right side bearing as the four-edge frame (asc pinned to top of the preview square, desc to bottom, horizontally centered, overflow clipped).

**Root cause ①**: `patch('g_advance', item.advance)` in property_panel.js read `item` from `EditorModel.getTreeItem()` which prefers the **treeSnapshot** (editor_read_facade.js L90-95: snapshot entry wins over live treeItems). `setFontSettings` (canvas_commands.js L745) only fires `notifyPropertiesUpdate()` → MODEL_UPDATED → bumpModelRevision — it does NOT rebuild the tree snapshot (snapshot is rebuilt by TREE_UPDATED/bumpTreeRevision). So after UPM rescale the snapshot's advance stayed at the old value, and neither the panel nor a reselect refreshed it. LSB/RSB worked because `getGroupLsbRsb` reads LIVE curve extents + `EditorModel.getGroupAdvance` (live treeItems). Same stale-snapshot read existed in group_settings_popup.js `grp_advance`.

**Changes ①**: property_panel.js (both sites: selected-gas branch ~L1227 and activeGroup branch ~L1241) and group_settings_popup.js (L265) now read `EditorModel.getGroupAdvance(groupId) ?? 1000` (live treeItems path, same as LSB/RSB). Comments document the snapshot-lag rationale.

**Root cause ②**: sequence_group_preview.js `drawSequenceGroupPreview(ctx, curveManager, groupId)` computed scale = 100/max(w,h) and offset = 60 − bbox-center×scale — bbox centering. The preview canvas is 120×120 with content square (10,10)-(110,110).

**Changes ②**: sequence_group_preview.js — added optional `fontMetrics ({ascender, descender, canvasSizeHeight})` param. When valid (asc > desc, canvasH > 0): metric-frame layout `scale = 100/(asc − desc)`, `offsetX = 60 − (minX + w/2)×scale` (horizontal center of the side-bearing frame [lsb, advance−rsb] == [minX, maxX]), `offsetY = 10 − (0.8×canvasH − asc)×scale` (pins ascender line to y=10, descender to y=110; model space is y-flipped: fontY = 0.8×canvasH − modelY). Overflow beyond the 120×120 canvas is clipped naturally. Falls back to legacy bbox centering when metrics are missing/invalid. sequence_preview_facade.js now passes `{ascender, descender, canvasSizeHeight}` from canvas.fontSettings + canvas.canvas_size_height (UPM rescale scales metrics + canvas size by the same ratio in setFontSettings, so the frame stays consistent with scaled curves — preview pixels are IDENTICAL before/after UPM change).

**Verification** (browser E2E via Playwright, `http://localhost:8123/?v=preview-1`, CDP Network.clearBrowserCache before goto, baseline JSON loaded, `window.confirm = () => true` patched; probe kept as `test/upm_advance_preview_probe.js`):
- **Panel refresh**: A-group selected → `#g_advance` value "1000" → `c.commands.setFontSettings({upm: 2000})` → `#g_advance` **"2000"** immediately (pre-fix: stayed 1000 even after reselect); live treeItems advance = 2000.
- **Metric-frame preview (UPM 2000, asc 1600/desc −400/canvasH 2000)**: scale = 0.05, offsetY = 10; rendered ink bbox y∈[26,90] back-converts to model y∈[320,1600] vs curve bounds [330.3,1621.7] (≤0.5px antialias boundary); centerX = 59.5 ≈ 60 (horizontal centering OK); ascender line y=10, descender line y=110.
- **UPM invariance**: identical preview pixels (px=513, y∈[26,90]) at UPM 1000 and UPM 2000 — metrics and coordinates scale together.
- **Fallback**: calling `drawSequenceGroupPreview(ctx, cm, gid, null)` keeps bbox centering (filledTop 19 ≈ expected −1.98 top → clipped flush at 0-edge behavior preserved).
- LSP diagnostics clean: property_panel.js, group_settings_popup.js, sequence_group_preview.js, sequence_preview_facade.js. Console: only pre-existing favicon 404.

**Notes for future sessions**:
- **Snapshot-vs-live rule**: `EditorModel.getTreeItem()` prefers the treeSnapshot, which is rebuilt ONLY by TREE_UPDATED (bumpTreeRevision) — mutations that bypass tree events (in-place advance changes, UPM rescale) leave snapshot reads stale. Display code that must reflect in-place mutations should read LIVE (`EditorModel.getGroupAdvance` / getGroupCurveExtents / curve_manager.treeItems), exactly like getGroupLsbRsb does.
- **Preview y-flip**: model y is flipped from font y: fontY = 0.8×canvasH − modelY (canvas_size_height default 1000 → ascender 800 at modelY 0, descender −200 at modelY 1000). Metric-frame transform: scale = 100/(asc−desc), offsetY = 10 − (0.8×canvasH − asc)×scale.
- `browser_run_code_unsafe` code strings cannot contain double quotes mid-`await` sequences that break the `async (page) => {...}` wrapper — keep probe bodies minimal or use the `filename:` param (absolute path under `C:\Users\z\Desktop\InkShader`) to load multi-line probes (worked reliably this session).
- The three preview callers (glyph_popup.js L362/L459, glyph_sequence_bar.js L857/L977, glyph_sequence_editor.js L250) all route through `EditorModel.drawSequenceGroupPreview` → facade → presentation; metrics injection happens only in the facade, so all callers get the new layout automatically.

### Session 17 (current)

**Objective**: User reported the app freezes when changing UPM in the font settings popup. Root cause chain: a UPM change rescales EVERY coordinate in the document, so the generic snapshot-diff history path produced 10.6MB of patches and a 4.2s undo on a x500-amplified fixture. Fixed in two stages:

**Stage A - compact SET_FONT_SETTINGS history entry**:
- recordHistory (canvas_history_service.js) now branches on SET_FONT_SETTINGS -> `_recordFontSettingsHistory`: stores NO snapshot patches; records before/after font settings (via fontSettingsFromSnapshot), full before/after meta, `fontSettingsEntry: true`, `documentChanged: false`, `snapshotPatches: []`.
- undo()/redo() fontSettingsEntry branches: `c.commands.setFontSettings(before/afterSettings, {})` (re-executes the inverse UPM ratio) -> getHistoryState() full re-serialize baseline -> `_assignCurrentStateMeta` -> `_applyState` -> return (never touches the patch path).
- sanitizeCommandEntry (snapshot_patch_executor.js) whitelist extended to preserve the compact fields across save/load.
- Entry size: 1979 bytes vs 10,640,390 (0.02%). record 350-430ms; single undo/redo byte-exact (jsonLen 15768730 matches load, spot coords 439.9357355343625/112.98619409063548 exact).

**Stage B - single spatial-grid rebuild**:
- V8 CPU profile (test/upm_profile_probe.mjs): undo 3.44s total, `addCurve @ spatial_grid.js:222` = 1610ms (46.8%) - the curve-AABB index. GC only 215ms (the earlier "renderer-GC dominates" hypothesis from probe9 was WRONG).
- Instrumentation (test/upm_grid_probe.mjs): one FULL rebuildSpatialGrid = 1053ms, incremental = 1451ms (per-group removeGroup eviction + re-add is slower than grid.clear + re-add); 11022 addCurve calls, 5,445,870 cell insertions (2004 curves span 1025-4096 cells; MAX_CURVE_CELLS=4096 clamp).
- Root cause of the residual freeze: the grid was rebuilt TWICE per undo - scaleAllCoordinates (manager.js L177, full) AND notifyTreeUpdate (incremental via _syncUiAfterHistoryApply) with the same dirty roots. The record path relied on L177 alone (`_recordFontSettingsHistory` never calls _syncUiAfterHistoryApply).
- Fix (3 edits):
  1. manager.js scaleAllCoordinates: removed `this.rebuildSpatialGrid?.()` - grid rebuild ownership moves to notifyTreeUpdate (every setFontSettings caller reaches it: dispatcher record path via the new notify call, undo/redo via _applyState -> _syncUiAfterHistoryApply).
  2. manager.js notifyTreeUpdate: when dirtyIds.size >= rootChildren.length use the full rebuild (rebuildSpatialGrid(null)) instead of incremental - measured 1.05s vs 1.45s on x500; full is always a superset of incremental (both index only active sequence tokens), so safe.
  3. canvas_history_service.js `_recordFontSettingsHistory`: added `c.curve_manager.notifyTreeUpdate?.()` BEFORE clearDirtyGlyphs (it reads the dirty set; the whole doc is dirty after a UPM scale -> full-rebuild path). Also fixes the missing TREE_UPDATED emission after a UPM record.

**Verification**:
- test/upm_single_rebuild_probe.mjs: rebuildCalls=1 for record/undo/redo/chain-undo2 each; correctness: undo xExact/yExact/jsonLenExact, redo xDoubled, chain backTo1000, gridSanity 27555 entries all queryable; record 376ms, undo 2310ms, redo 1162ms.
- probe8 full regression: errors=[], alerts=0; p1_setFontSettingsMs 2064 -> 44ms (the full grid rebuild left setFontSettings); manual-undo sync block 3980 -> 1892ms; undo1Ms 2782 (was 6988); all correctness assertions pass (spot coords, jsonLen, family round-trip, sanitize, advance-after-compact baseline, 20-curve consistency 0 mismatch).
- Chain drift diagnosed (test/upm_chain_diff_probe.mjs): after 2000->undo->redo->3000->undo->undo, 33066 numeric leaves differ from the loaded snapshot at maxRel 2.11e-16 (ulp-level float drift from repeated non-power-of-2 ratio multiplications x2->x1.5->x(2/3)->x0.5). Single-step undo/redo is byte-exact; multi-step non-power-of-2 chains drift ~1e-13 in a 1000-unit design space - inherent to the re-execute-command mechanism, not a regression.
- LSP diagnostics clean: manager.js, canvas_history_service.js.

**Notes for future sessions**:
- Spatial grid (spatial_grid.js) rebuild cost scales with per-curve cell spans: a x500 fixture hits the 4096-cell clamp (2004 curves) -> 5.4M Map ops per rebuild (~1-1.5s). Real docs (tens of cells per curve) rebuild in ms. Grid rebuild ownership: notifyTreeUpdate ONLY - NEVER add a rebuildSpatialGrid call inside scaleAllCoordinates or other geometry-mutation primitives (double rebuild = 2x cost on the undo hot path).
- getHistoryState(clearDirty=true) CLEARS the dirty glyphs - any notifyTreeUpdate after it sees dirtyIds=null -> full-rebuild path (which the compact undo relies on; keep clearDirty=true).
- `_recordFontSettingsHistory` must call notifyTreeUpdate BEFORE clearDirtyGlyphs, or the dirty set is lost and the incremental decision (and TREE_UPDATED) never happens.
- Compact font-settings undo/redo re-executes the command: exact for single steps (ratio x2/x0.5), ulp-drift only in multi-step non-power-of-2 chains (x1.5/x(2/3)). If byte-exactness across arbitrary chains ever becomes a requirement, the compact entry would need to store the full snapshot - which defeats the optimization; do not "fix" this.
- Probes kept: test/upm_freeze_probe8.mjs (regression), test/upm_single_rebuild_probe.mjs (rebuild-count + correctness), test/upm_profile_probe.mjs / upm_grid_probe.mjs / upm_chain_diff_probe.mjs (diagnostics; evidence for the numbers above).

### Session 18 (current)

**Objective**: User rule - changing UPM must keep the canvas scale AND offset unchanged (the old behavior kept the VISUAL zoom constant via compensation). With the compensation, a small zoom + UPM x10 (or x2) either froze the app completely ("upm?*10???????") or killed wheel zoom until refresh ("??upm?????????????,??????").

**Root cause 1 - the freeze (scale < 0.01)**: setFontSettings (canvas_commands.js) applied zoom compensation `canvas.scaleBase = canvas.scale / ratio` WITHOUT the scale_min clamp (zoomTicksToScale clamps to [0.02, 50] but this direct assignment does not). At zoom 0.05 + upm 1000->10000, scaleBase became 0.005. The next ruler repaint then hung the main thread FOREVER: `getStepAndPrecision` computes roughStep = 50/scale = 10000, which EXCEEDS the step table max (5000) -> step falls back to 0.1 -> scale*step = 0.0005 -> `update_ruler_horizontal` tick loop (canvas_renderer_service.js L1981-1983) iterates ~10.9M times (end_i ~= 8.4M) creating one SVG <line> (+<text> every 10th) per iteration. Confirmed by Debugger.pause on the blocked thread: `update_ruler_horizontal <- update_ruler <- tick <- rAF`. The vertical ruler blows up identically (bounds divided by step only). This is why the freeze correlates EXACTLY with small-zoom + big-ratio: only the compensation could push scale below 0.01 (zoom UI clamps at scale_min 0.02).

**Root cause 2 - dead zoom (0.01 <= scale < 0.02)**: scaleBase 0.005 (or 0.015 at zoom 0.15 x10) sits below scale_min 0.02. First wheel zoom: clamp(scaleBase*1.1) = 0.02 != 0.005 -> applies once; second wheel zoom: clamp(0.005*1.1^2) = 0.02 === c.scale -> change_canvas_size clamp-revert (L2098-2100) -> zoomTicks reverts forever -> zoom dead until refresh (refresh re-inits scaleBase=0.4).

**Changes**:
1. **canvas_commands.js** setFontSettings - REMOVED the zoom compensation block entirely. UPM change now leaves scale/scaleBase/zoomTicks/offset untouched (comment documents the user rule + the two failure modes). This is the user's explicit requirement, and it eliminates BOTH root causes (scale can no longer drop below scale_min via UPM).
2. **canvas_renderer_service.js** getStepAndPrecision - defense-in-depth: when roughStep exceeds the table (scale < 50/5000 = 0.01), extend with powers of 10 (`step = Math.pow(10, Math.ceil(Math.log10(roughStep)))`) instead of falling back to 0.1. Rulers are now safe at ANY scale (verified at 0.005 and 0.002: 198/66 ticks vs ~10.9M pre-fix).

**Verification** (pure-Node CDP driver, headless Chrome :9222, http://localhost:8123, Network.clearBrowserCache, baseline JSON, probe test/upm_zoom_fix_probe.mjs - ALL PASS):
- UPM 1000->10000 at zoom 0.05 with recordHistory: COMPLETES (was: permanent main-thread block); post-state scale=0.05 scaleBase=0.05 ticks=0 offset={123,456} - all UNCHANGED (user requirement).
- Wheel zoom in/out x3 at 0.05: 0.055 -> 0.0605 -> 0.06655 -> back to 0.05 - no clamp death, ticks tracked.
- Compact undo -> upm 1000, scale+offset unchanged; redo -> upm 10000, unchanged. (Probe artifact note: undo/redo calls need ~150ms sleep between them - is_restoring resets via requestAnimationFrame(() => setTimeout(0)), the awaited _applyState resolves BEFORE the flag clears; immediate redo no-ops.)
- Ruler safety: update_ruler() at scales 0.05/0.005/0.002 completes in <20ms, tick counts 198/198/66 (pre-fix: 10.9M SVG nodes / freeze).
- Min-zoom edge: UPM 1000->2000 at 0.02 completes; zoom to 0.022 works after.
- **probe8 full regression**: errors=[], alerts=0; record 397ms; undo/redo byte-exact (spot 439.9357355343625, jsonLen 15768726); chain 1000->2000->3000->undo->undo->redo->redo exact; family/sanitize kept; SET_GROUP_ADVANCE after compact entries fine; 20-curve consistency 0 mismatches.

**Notes for future sessions**:
- **Viewport invariant (user rule)**: UPM changes never touch scale/scaleBase/zoomTicks/offset. Do NOT reintroduce any zoom compensation on font-settings changes - it bypasses the scale_min clamp and both freezes the rulers (step table) and kills wheel zoom (clamp-revert).
- **Ruler step table landmine**: getStepAndPrecision's table caps at 5000; roughStep = 50/scale exceeds it when scale < 0.01, and the OLD fallback (step stays 0.1) makes the tick loop iterate (w or h)/(scale*step) ~ millions of SVG nodes. The powers-of-10 extension is now load-bearing - keep it.
- **Debugging a blocked main thread**: CDP Debugger.pause on a hung page interrupts the running JS and Debugger.paused delivers the exact call stack (rAF loop frames included). Runtime.evaluate just queues forever on a blocked thread - pause first, evaluate later.
- Probe artifacts: zoom-in/out round-trips do NOT restore offset exactly (zoom-out pivots against the current scale - offset drift ~8px per 3-in/3-out cycle at 0.05 is expected zoom math, not a bug). Undo/redo back-to-back hit the is_restoring window - sleep ~150ms.
- Headless browser + python server die independently: browser ECONNREFUSED on 9222 -> restart chrome (--headless=new --remote-debugging-port=9222 --user-data-dir=...); server ERR_CONNECTION_REFUSED on 8123 -> python -m http.server 8123. Check both before blaming the app.
- New probes kept: test/upm_zoom_fix_probe.mjs (regression - viewport invariants + ruler safety), test/upm_zoom_stepped3.mjs (Debugger.pause stack capture).

### Session 19 (current)

**Objective**: User request: significantly widen the canvas zoom range ("目前项目对画布缩放的区间限制趋于保守，大幅提高允许的最小和最大缩放倍数").

**Changes**:
1. **js/canvas/main_canvas.js** (L50) - `this.scale_min = 0.02; this.scale_max = 50` -> `this.scale_min = 0.001; this.scale_max = 500` (0.1% ~ 50000%; min 20x wider, max 10x wider). zoomTicksToScale (L254-258) clamps via these constants - no other logic change needed.
2. **js/canvas/services/canvas_viewport_service.js** (L9) - doc comment updated: `Zoom range: 0.1% ~ 50000% (scale_min: 0.001, scale_max: 500)`.
3. **js/presentation/canvas/tools/node_tool.js** (L416-421) - comment updated: the 250-world-unit snap radius cap stays as a spatial-grid performance guard, now documented as independent of the new minimum zoom (was "5px at the minimum zoom of 0.02").

**Verification** (pure-Node CDP driver, headless Chrome :9222, http://localhost:8123, Network.clearBrowserCache, probe kept as test/zoom_range_probe.mjs - ALL PASS):
- Constants live on canvas: min=0.001, max=500.
- zoomTicksToScale clamps: -200 ticks -> 0.001, +200 ticks -> 500; base scale 0.4 intact; 100% snap still resolves to exactly 1.0.
- Real Ctrl+wheel zoom-OUT x160 from 0.4: scale stops at 0.001 (ticks -63), all state finite (clamp-revert, no NaN/Infinity).
- Ruler at 0.001: update_ruler ~0ms, 133 ticks (Session 18 powers-of-10 extension covers the new floor: roughStep = 50/0.001 = 50000 -> step 100000).
- Real Ctrl+wheel zoom-IN x200: scale stops at 500 (ticks +75), finite; renderCanvas at 500 completes in ~116ms.
- Ceiling escape: wheel-out x3 from 500 -> scale = 0.4*1.1^72 (ticks 72), zoom NOT stuck; zoom-IN at the ceiling staying clamped at 500 is the designed clamp-revert behavior, not a stall.
- No runtime exceptions. LSP diagnostics clean: main_canvas.js, canvas_viewport_service.js, node_tool.js.

**Notes for future sessions**:
- Zoom range is now 0.001 ~ 500, controlled ONLY by scale_min/scale_max in main_canvas.js. Do not hardcode 0.02/50 anywhere (canvas_commands.js L811 comment references the REMOVED zoom-compensation bug - historical, leave it).
- At the new extremes: ruler step logic verified safe below 0.01 (Session 18); node snap radius caps at 250 world units (0.25px visual) by design for spatial-grid performance; scene render verified at 500.
- Probe gotcha: the 100% snap window ([0.995, 1.005]) is unreachable from scaleBase 0.4 with integer ticks (nearest: tick 9 -> 0.943, tick 10 -> 1.037) - verify snap with scaleBase = 1.0, ticks = 0, then restore scaleBase.

### Session 20 (current)

**Objective**: Fix kerning edits not entering the undo/redo history stack ("kerning编辑不进历史栈"). The kern popup's add/remove/edit calls mutated `kerningManager` directly (km.setPair/km.removePair + `_markDirty()`), bypassing the dispatcher → command → commit → history pipeline, so Ctrl+Z could never revert a kerning change.

**Root cause**: No command existed for kerning pair mutation. The snapshot history system ALREADY supported kerning end-to-end (getHistoryState serializes `kerning`/`kerning_classes`; snapshot_runtime_applier.js L291-296 applies kerning patches; snapshot_serializer restores it on load) — only the write path was missing.

**Changes** (full dispatcher pipeline, matching setGroupAdvance conventions):
1. **`js/domain/actions/editor_actions.js`** — `SET_KERNING_PAIRS: "SET_KERNING_PAIRS"`.
2. **`js/app/canvas_events.js`** — `REQUEST_SET_KERNING_PAIRS: "request-set-kerning-pairs"`.
3. **`js/domain/commands/canvas_commands.js`** — `setKerningPairs(pairs, options)`: each entry `{left, right, value}` sets (via `km.setPair`), `{left, right, remove:true}` removes (via `km.removePair`); skips no-change entries (`km.getPair() !== value` guard); if NOTHING changed returns `options.recordHistory === true` (setGroupAdvance no-op convention — recordHistory's empty-diff guard then rejects the entry); else refreshes `cm.seqService.calculateSequenceOffsets()` + `renderer.invalidateStableSceneCache()` + `cm.notifyPropertiesUpdate()` + `c.is_dirty = true` and returns true.
4. **`js/app/canvas_request_routes.js`** — route REQUEST_SET_KERNING_PAIRS → CANVAS_ACTIONS.SET_KERNING_PAIRS, mapPayload → `{ pairs, options }`.
5. **`js/presentation/canvas/canvas_controller.js`** — `dispatchAction` case CANVAS_ACTIONS.SET_KERNING_PAIRS → `c.commands.setKerningPairs(action.payload.pairs, action.payload.options)`.
6. **`js/app/canvas_dispatcher.js`** — `requestSetKerningPairs(pairs = [], options = {})`.
7. **`js/domain/history/command_commit.js`** — `OPTIONS_GATED_COMMIT` += EDITOR_ACTIONS.SET_KERNING_PAIRS (commit only when `options.recordHistory === true`).
8. **`js/ui/kern_popup.js`** — `_addPair` (~L169), `_removeEntry` (~L174), inline edit (~L219) now call `CanvasDispatcher.requestSetKerningPairs(pairs, { recordHistory: true })`; `_markDirty` deleted (command owns the refresh now); CanvasDispatcher imported.

**Verification** (pure-Node CDP driver `test/kern_history_cdp_driver.mjs`, headless Chrome :9222, :8123, Network.clearBrowserCache, baseline `test/InkShader_project_2026-08-02T16-27-25.json` — ALL 19 checks PASS):
- Baseline facts: fixture carries its own A→E = -500; A→B absent. Kerning applies to sequence offsets ONLY for ADJACENT pairs (sequence_service.js L241-247: `getKerning(prevName, currName)`), so the sequence-offset test uses (A,B): set -250 → offsets [0,1000,...] become [0,750,1750,...] (B shifts -250, everything after too); undo → restored exactly; redo → reapplied.
- Set via dispatcher: pair value changed, commandStack 0→1, sequence offsets refreshed (preview follows kerning).
- Undo: pair removed (back to 0), offsets restored byte-exact, stack popped. Redo: pair + offsets restored.
- Remove path: `{remove:true}` → 0; undo restores -250; redo removes again.
- No-op set (same value): data unchanged AND **no empty history entry** (recordHistory L603 empty-diff guard returns false — the command returns `options.recordHistory === true` per setGroupAdvance convention, but the guard rejects zero-diff entries; undo after no-op pops the previous entry cleanly, no DEV-ALERT).
- `cv.io.save_file()` JSON export contains the kerning (A:{B:-250,E:-250}).
- STATE_CHANGED emitted (22 events) → kern popup refresh via store events works.
- LSP diagnostics clean: all 8 changed files. Probe first run FAILED for probe reasons only: (1) baseline assumed A→E absent (fixture has -500), (2) no-op was asserted to RECORD — actual convention is recordHistory guard rejects empty diffs; both corrected in the final probe.

**Notes for future sessions**:
- **Kerning write path**: ALWAYS route kerning mutations through `CanvasDispatcher.requestSetKerningPairs(pairs, { recordHistory: true })` — direct km.setPair/removePair bypasses history and leaves the popup's `_markDirty` refresh duplicated. The snapshot diff history handles kerning natively (no special-casing needed; SET_FONT_SETTINGS-style compact entries NOT required — kerning diffs are tiny).
- **No-op command convention**: commands return `options.recordHistory === true` when nothing changed (so callers don't need change-detection logic); `recordHistory`'s empty-diff guard (canvas_history_service.js L603: no patches + no tree change + meta same → return false) is the final arbiter — no empty entries ever land in the stack.
- **Sequence offsets + kerning**: only adjacent sequence pairs affect offsets (`prevName, currName` = neighboring tokens). Editing a pair that is not adjacent in the current sequence changes data + history but NOT the preview — expected, not a bug.
- Canonical probe: `test/kern_history_cdp_driver.mjs` (19 checks, all green — rerun for any future kern/history pipeline change).

### Session 21 (current)

**Objective**: Implement the "样张" (Sample Text) panel — a `sample-text-panel` dock component that renders `fontSettings.sample_text` using ACTUAL glyph outlines + advances + optional kerning (no OTF compilation), replacing the old sample rendering in the font info popup. UI-layer only reads (`editor_read_facade.js`), writes via `CanvasDispatcher.requestSetFontSettings`; presentation renderer lives in `sample_text_preview.js`.

**Changes** (5 new app files + 2 wiring edits, all LSP-clean):
1. **`js/presentation/sequence/sample_text_preview.js`** (new) — `drawSampleTextPreview(ctx, tokens, curveManager, fontMetrics, options)` + `buildSampleTokens(cm, text, upm)`. Tokenizer: `\name\` → named-group ref, plain chars → default groups (via `getDefaultGroupForChar`, auto-creates), space → 0.25em advance, unknown → 0.5em advance, `\n` → newline. Rendering: y-flip `fontY = 0.8*canvasH − modelY` (Session 16 convention), per-token transform via matrix, outline fill via `appendCurveFillPath(ctx, curve, viewport, {refId, strokePreview})`, kerning via `curveManager.kerningManager.getKerning(leftName, rightName)` (space/unknown/newline reset the kerning chain), metric guides use `--cvs-guideline`, glyph fill `--cvs-path-fill`.
2. **`js/presentation/sequence/sample_text_preview.js` — HORIZONTAL-FIT LAYOUT (added this session)**: scale = `min((height−2PAD)/lineH, (width−2PAD)/maxRowWidth)` where `maxRowWidth` is measured per line at scale 1 with kerning applied (lines split by `\n`). Without this, a 235px-wide canvas at the vertical-fit scale 0.247 fits only ONE 1000-unit advance per row — "AB" wrapped to two rows and kerning became a visual no-op. Short lines (single glyph) still get the big vertical-fit glyphs; long lines fit the full width.
3. **`js/ui/sample_text_panel.js`** (new) — Web component: textarea (`#sample_text_input`), kerning checkbox (`#sample_kerning`), guides checkbox (`#sample_guides`), canvas (`#sample_canvas`); default layout canvas ≈ 235×267 (diag verified). focusout → `CanvasDispatcher.requestSetFontSettings({ sample_text }, { recordHistory: true })`; kerning/guides are panel-local state; listens to STATE_CHANGED/SEQUENCE_CHANGED/COMMAND_COMMITTED; drag handle exposed on `.prop_panel_title_wrapper` (dock convention).
4. **`js/app/sequence_preview_facade.js`** — `drawSampleTextPreviewOnContext(ctx, text, options)` + `buildSampleTokens(cm, text, upm)`.
5. **`js/app/editor_read_facade.js`** — `drawSampleTextPreview` (delegates to facade) + `getSampleTextPanelState()` → live `{sampleText, ascender, descender, capHeight, xHeight, canvasSizeHeight, upm}` from canvas.fontSettings + canvas_size_height.
6. **`js/ui/dock_layout.js` + `js/ui/layout_shell.js`** — sample panel registered with the dock system; restoring an OLD saved layout (key `inkshader_dock_layout_v2`, no sample panel) automatically re-adds the panel (Phase B verified).
7. **`index.html` + `css/style.css` + `js/services/i18n.js`** — component mount, styles, "Sample Text" title translation (i18n.js is UTF-8 with BOM; the dock transparent-background selection list must include `sample-text-panel` in BOTH places).

**Defects found & fixed during E2E bring-up**:
- **Glyph ink = 0**: metric-frame layout `baseOffsetY = PAD − (0.8*canvasH − asc)*scale` uses `canvas_size_height`; the fixture JSON has NO `canvas_size_height` field (upm 1000, ascender 800, descender −200), so a stale IndexedDB project cache value (12000) leaked in and pushed every glyph off-canvas — guides rendered (864 px), glyphs did not (0 px). Control experiments (diag3): sequence-group bbox centering ink 745 ✓; metric-frame with canvasSizeHeight 12000 → 0 ✗; direct `appendCurveFillPath` with manual viewport (scale 0.247, offset 10) → 2157 ✓. Probes now calibrate `if (cv.canvas_size_height !== cv.fontSettings.upm) cv.canvas_size_height = cv.fontSettings.upm;` after loadFromFile.
- **focusout never fires in headless Chrome**: real `input.blur()` / focus-transfer to a checkbox produced 0 focusout events (headless does not synthesize focus). Probes dispatch `new FocusEvent('focusout', { bubbles: true })` explicitly; the save path itself is correct (persisted + history entry + undo/redo verified).
- **Kerning test semantics**: with horizontal-fit scale, the right-edge comparison is invalid (scale changes when the line shortens). Compare the inter-glyph EMPTY GAP instead (kerning ON gap < OFF gap).

**Verification** (pure-Node CDP driver `test/sample_panel_cdp_driver.mjs`, headless Chrome :9222, server :8123, Network.clearBrowserCache, baseline `test/InkShader_project_2026-08-02T16-27-25.json` — Phase A 22/22 + Phase B 5/5 ALL GREEN):
- Phase A: panel exists / dock leaf `data-panel-id="sample"` / inside `.dock-content` / title bar / textarea / kerning + guides checkboxes / canvas / toggles default ON / drag handle `_dragPid="sample"` / i18n title "Sample Text"; glyph render "AB" = 1938 non-empty px; guides toggle changes content (1938 vs 1212); kerning gap ON 112 < OFF 126 (A→B = −250 via `requestSetKerningPairs`); sample_text persisted "ABE" via dispatched focusout; history stack 1→2; undo restores "ABCDEFG" (the fixture value — "AB" was never saved, no focusout was dispatched for it); redo reapplies "ABE"; `\test\` ref token renders (1038 px); multi-line "A\nB" survives (1919 px).
- Phase B: old layout (v2 key, no sample panel) → panel re-added + re-mounted inside its leaf; legacy console/canvas panels intact.
- LSP diagnostics clean: all 6 changed files (sample_text_preview.js, sample_text_panel.js, sequence_preview_facade.js, editor_read_facade.js, dock_layout.js, layout_shell.js).
- Visual spot-check: `test/sample_panel_shot.mjs` captures `test/sample_panel_shot.png` (762×428); programmatic pixel sampling of the panel canvas region shows glyph ink present (13/400 grid samples non-bg — sparse at small scale, consistent with a 7-glyph line fit).

**Notes for future sessions**:
- **`\name\` escaping in template-literal probes**: the driver's PROBE string is a JS template literal — writing `'AB\\test\\'` yields probe code `'AB\test\'` = TAB escape + unterminated string (SyntaxError). Use `'AB\\\\test\\\\'` in the driver source so the probe sees `'AB\\test\\'`.
- **Headless focus**: never assert on real focus/blur events in headless Chrome; dispatch `FocusEvent('focusout', {bubbles:true})` to exercise component handlers.
- **canvas_size_height hygiene**: fixture projects may omit `canvas_size_height`; the app keeps whatever the cache/previous project left (12000 in our polluted profile). Sample-panel (and any metric-frame) probes MUST calibrate it to upm after loadFromFile. If this ever bites real users, the fix belongs in loadFromSnapshot (fall back to upm when the field is absent), not in the panel.
- **Horizontal-fit invariant**: the sample preview scale is `min(verticalFit, horizontalFit)` — do not revert to vertical-only fit, or multi-glyph lines wrap one-per-row and kerning (and the whole specimen look) breaks. **SUPERSEDED by Session 22**: scale is now the user-set fontSize/(asc−desc); canvas sized to content; wrap scrolls.
- Canonical probe: `test/sample_panel_cdp_driver.mjs` (34 checks — rerun for any sample-panel / dock / i18n change; **37 checks as of Session 22**). Diagnostics kept: `sample_panel_shot.mjs` (+ regenerable png). The one-off `sample_panel_diag*.mjs` diagnostics were REMOVED in the Session 22 follow-up 8 repo cleanup (their findings are captured in the session notes above; the driver supersedes them).

### Session 22 (current)

**Objective**: User requirement for the sample-text panel: "预览出来一个字母换一行，即使后面还有空位；预览组件应该加入纵向滚动条，且字号不应该和组件大小有任何关系，而应该是设定的值" — ① multi-char text must stay on ONE row (wrap only when genuinely overflowing); ② the panel needs a vertical scrollbar; ③ font size must be a user-SET value (px), fully decoupled from the component size.

**Root cause of "one letter per line"** (Session 21's horizontal-fit was NOT the real fix): the layout's wrap check compared UNSCALED model units (advance 1000/glyph) against a PIXEL threshold (`maxX = width − PAD` ≈ 225px) — every advance 1000 > 225, so EVERY character wrapped to a new line. The horizontal-fit scale only shrank glyphs; it never fixed the unit mismatch in the wrap comparison. (Session 21's kerning-gap E2E passed because B had wrapped onto a different row — a false positive.)

**Changes**:
1. **`js/presentation/sequence/sample_text_preview.js`** — exported `layoutSampleText(curveManager, tokens, options)` (pure layout, no drawing): `scale = fontSize/(asc−desc)` (default 48px — user-set, independent of component size), `maxX = (width−PAD)/scale` (wrap threshold in MODEL units, same units as the accumulated pen.x — fixes the one-letter-per-line bug), `contentHeight = rows*lineH*scale + 2*PAD` (drives the scroll container), `baseOffsetY = PAD − (0.8*canvasH − asc)*scale`. `drawSampleTextPreview` runs the layout twice (rows/guides + fresh draw walk). Horizontal-fit scale REMOVED (supersedes Session 21 item 2).
2. **`sample_text_preview.js` — pen-pollution fix (E2E reveal)**: the row-counting walk previously mutated the SAME pen object it returned — the returned `pen.x` was the walk's FINAL position (2000 for "AB"), and the draw pass's second call ALSO walked to its own final state. The draw loop then CONTINUED from x=2000 → the whole line shifted right ~101px at 48px (A ink at 111px instead of 15px); at fontSize 96 the ~192px shift pushed everything off-canvas → ZERO ink. Fix: the walk uses a PRIVATE pen; the returned `layout.pen` is PRISTINE ({x:0, row:0, prevGlyph:null}).
3. **`js/app/sequence_preview_facade.js`** — added `measureSampleTextPreview(text, options)` (layout-only pass so the panel can size the canvas BEFORE drawing); `drawSampleTextPreviewOnContext` now passes `fontSize` through.
4. **`js/app/editor_read_facade.js`** — exports `measureSampleTextPreview` (delegates to facade). **Naming-collision fix**: the export initially shared the import binding's name → `SyntaxError: Identifier 'measureSampleTextPreview' has already been declared` killed the ENTIRE bootstrap module graph (0 dock leaves, panel never upgraded; main-canvas.js loads via its own script tag, so the core looked alive). Import renamed to `measureSampleTextLayout`.
5. **`js/ui/sample_text_panel.js`** — added `#sample_font_size` number input (default 48, min 6 max 512, panel-local like kerning/guides); canvas sized to CONTENT height (ceil of measured contentHeight, min the wrap height); ResizeObserver observes the WRAP (`#sample_canvas_wrap`) — NOT the canvas (canvas height tracks content → observing it would loop); draw passes width/height/fontSize explicitly (ctx has no .width/.height).
6. **`css/style.css`** — `.sample-canvas-wrap` `overflow-y: auto` (was hidden); `.sample-canvas` height driven by content via inline style; number-input styling. **`js/services/i18n.js`** — `sample.fontSize` (en "Size" / zh "字号").
7. **Min canvas width = one full natural line** (user: "限制预览框最小宽度为至少一行预览，否则溢出并隐藏在滚动条后"): `layoutSampleText` now ALSO returns `maxRowWidthPx` = width of the widest `\n`-delimited natural line in px (kerning applied, NOT affected by the width-based wrap). Panel `_render` sets `contentW = max(wrapW, ceil(maxRowWidthPx))`, sizes the canvas to it AND passes `width: contentW` to draw/measure (drawing must re-measure at the SAME width or it re-wraps differently); `.sample-canvas-wrap` gets `overflow-x: auto` — a panel narrower than the line scrolls horizontally instead of squeezing. 'AB' at 48px/kerning-OFF = (1000+1000)*0.048 + 2*10 = **116px**.
8. **Panel settings persisted to localStorage** (user: "预览设置项应该在localstorage中持久化"): key `inkshader_sample_panel_state`; `loadPanelState()`/`savePanelState()` both try/catch; restored in connectedCallback on FIRST mount (fontSize clamped 6..512 & rounded); kerning/guides `change` and fontSize `change` call `persistState()`; the sample TEXT itself stays out of localStorage (still fontSettings via dispatcher on focusout — history participation).

**Verification** (pure-Node CDP driver `test/sample_panel_cdp_driver.mjs` — Phase A 45/45 + Phase B 6/6 ALL GREEN, 51 checks as of the min-height/scrollbar/guides-row follow-up; 54 checks as of the resizer/SCROLLABLE follow-up; **60 as of the trailing-newline follow-up**; originally Phase A 42/42 + Phase B 5/5, 47 checks):
- SAME-ROW regression (the user's exact complaint): "AB" → A ink 15..53, B ink 63..102, y-extents overlap (`sameRow: true`).
- Content-driven height: "AB" at 48 → canvas 68px (1 row = fontSize + 2*PAD); at 96 → 116px; wrap clientHeight UNCHANGED (255) — font size fully decoupled from component size.
- Same-row kerning: A→B −250 pulls B INTO A (single merged ink band, gap 0) vs gap 9 with kerning OFF.
- Scrollbar: 8-row text → scrollHeight 452 > clientHeight 255, computed overflow-y auto.
- **Unified styling** (user: "滚动条和文本框没有和现有对应元素统一样式"): font-size input now matches property-panel fields (height 22px, radius 3px, ui-monospace 11px, spin buttons hidden); textarea matches the unified input group (.pref_input: radius 6px, padding 6px 10px, hover border, focus bg-panel); `.sample-panel-body` + `.sample-canvas-wrap` scrollbars copy the shared scrollbar group (6px, transparent thumb, hover/data-scrollbar-visible show) — 3 new checks (37 total). Note: the taller field rows reflowed the options row, so wrap clientHeight is now 255 (was 248) — relative assertions are unaffected.
- **Min-width checks** (10c, user requirement): `measureSampleTextPreview('AB', {kerning:false, width:60, fontSize:48})` reports maxRowWidthPx 116; with the wrap forced to 60px the canvas stays 116px wide; `wrap.scrollWidth (116) > wrap.clientWidth (54)` — horizontal scroll, no squeeze.
- **Persistence checks** (10d + Phase B): set fontSize 72 + toggle kerning/guides OFF → localStorage `{fontSize:72, kerning:false, guides:false}`; after reload (Phase B) the panel restores 72/OFF/OFF.
- Guides toggle, focusout save + history + undo/redo ('ABE' ↔ 'ABCDEFG'), `\test\` ref token, multi-line render — all intact.
- Phase B: old v2 layout restore re-adds the panel; legacy panels intact.
- LSP clean: sample_text_preview.js, sample_text_panel.js, sequence_preview_facade.js, editor_read_facade.js.

**Probe artifacts (driver-side, not app bugs)**:
- Merged-band gap: when kerning overlaps glyphs there is NO second ink band — the row-scan's `b0` runs past the canvas end, "gap" = 235−90−1 = 144. Probe treats a missing second band as `merged` → gap 0, sameRow true.
- Ink comparisons must use a guides-OFF baseline: guides add ~1100px of dashed-line ink; comparing 96px glyph ink against a guides-ON baseline fails spuriously.
- **Stale localStorage pollutes the next run**: after a run leaves `{fontSize:72, kerning:false}` in `inkshader_sample_panel_state`, the NEXT run's panel restores it on mount → 4 spurious failures (defaults 48/ON, canvas height 92≠68, kerning gap comparison inverted: detail {on:14,off:0} meant OFF-state measured first). Driver now removes the key + resets controls to defaults at PROBE_A start (the panel never re-reads it afterwards). Symptom pattern: only default-state + kerning-order checks fail on repeat runs.
- **10d must toggle IDEMPOTENTLY**: the original unconditional `click()` on guides FAILED when the checkbox was already OFF (check 17 leaves guides OFF deliberately) — it flipped it back ON and persisted true. Diagnostic fields (`gBefore/gAfter/kBefore/kAfter`) in the check detail pinpoint whether a click actually toggled. Use `if (checked) click()` style toggles.
- **`ResizeObserver loop completed with undelivered notifications`** fires as a window error whenever an observed element resizes (benign Chrome artifact, e.g. the 10c narrow-wrap trick) — the driver's error collector filters it out; it is NOT an app error.

**Notes for future sessions**:
- **SUPERSEDES Session 21's horizontal-fit invariant**: preview scale = user-set fontSize/(asc−desc), NOT min(vertical,horizontal) fit. Canvas is sized to CONTENT; the wrap scrolls. Do not reintroduce fit-based scaling.
- **layoutSampleText pen contract**: returned `pen` is PRISTINE by design (row-counting uses a private pen). A draw walk MUST start from a pristine layout pen — a walked pen shifts the whole line by the walk's final x (larger font sizes push it fully off-canvas → zero ink).
- **Min-width contract**: `maxRowWidthPx` is measured on NATURAL lines (no width-wrap, kerning applied). The panel must size the canvas AND pass the same contentW as the draw width — measuring at wrapW and drawing at contentW re-wraps inconsistently.
- **Persistence contract**: `inkshader_sample_panel_state` holds ONLY panel-local options (fontSize/kerning/guides), never the sample text; text persistence goes through the dispatcher (history). Restore happens once on first mount; a stale value from a previous run breaks default-state E2E assumptions (driver clears the key at probe start).
- **Duplicate-identifier SyntaxError**: naming a local export the same as an import binding is a module-graph killer — LSP reported clean; only browser module instantiation caught it. Partial-boot signature: core canvas alive (own script tag) + 0 dock leaves + custom elements never upgraded. `Network.setCacheDisabled(true)` + console/exception capture is the fast way to diagnose.
- Canonical probe: `test/sample_panel_cdp_driver.mjs` (47 checks as of Session 22; **51 checks as of the min-height/scrollbar/guides-row follow-up; 54 checks as of the resizer/SCROLLABLE follow-up; 60 checks as of the trailing-newline follow-up** — rerun for any sample-panel / dock / i18n change; the driver is self-cleaning for the persistence key).

### Session 22 follow-up — cap_height corruption bug (user report: "多次发现文件中cap height不知何时变成了0，但其他metric guides没问题")

**Verdict: REAL bug, not user error.** The fixture `test/InkShader_project_2026-08-02T16-27-25.json` itself carries `"cap_height": 0` (upm 1000, asc 800, desc −200, x_height 500 all intact) — confirmed in-file, explicitly saved.

**Root cause chain** (all in `js/canvas/services/canvas_io_service.js`):
1. **SVG import** (~L1084): `parseInt(faceEl?.getAttribute('cap-height'), 10) || 0` — cap-height is OPTIONAL in SVG fonts (ascent/descent/units-per-em are required and had safe fallbacks 800/−200/1000; cap-height/x-height fell back to **0**). FontForge and most tools do not write it; our OWN old exporter wrote `cap-height="0"` when the project value was missing. Either case imported cap_height 0.
2. **SVG export** (~L2518): `cap_height || 0` — a missing value exported as `cap-height="0"`, which the importer then read back as 0 (round-trip corruption amplifier).
3. **Save/load are lossless**: `snapshotNumber` (canvas_commands.js) passes an explicit 0 through; the 700 fallback in `fontSettingsFromSnapshot` only fires when the KEY IS ABSENT — so a 0, once written, persists forever. UFO import was never affected (`num()` regex leaves the key absent on no-match → load-time default), matching the user's observation that only cap height broke.

**Changes**:
- Import (~L1079-1085): cap-height → `Math.round(upm * 0.7)`, x-height → `Math.round(upm * 0.5)` when missing OR 0 (0 is meaningless for a metric line — same `||` convention as ascender/descender; an explicit 0 also self-heals).
- Export (~L2518-2519): `?? Math.round(upm * 0.7)` / `?? Math.round(upm * 0.5)` — a MISSING value never exports as 0; an explicit 0 still exports as 0 (preserves a deliberate setting; the import side heals it on the way back in).
- Deliberately NOT touched: the JSON load path (an already-corrupted file keeps its 0 — users with damaged files must set the value once in the font popup; the fix stops NEW corruption, it does not migrate old files).

**Verification** (pure-Node CDP probe `test/cap_height_probe.mjs`, 10/10 green, `http://localhost:8123/?v=capheight-1`):
- Fixture baseline cap_height 0; `new_font_export.svg` (old exporter output) carries `cap-height="0"`.
- **A**: importing the old export AS-IS → cap_height **700** (self-heal), x_height 500 passthrough, saved JSON writes 700 — the full user chain (import → save) can no longer produce 0.
- **B**: explicit `cap-height="800"` → 800 (explicit wins).
- **C**: attribute removed (typical external tool) → 700/500 fallbacks.
- **D**: export with fontSettings.cap_height/x_height DELETED (missing-value scenario) → SVG contains `cap-height="700"` / `x-height="500"` (never "0"), captured by patching `c.env.createObjectURL` (blob.text()) + `createDOMElement` returning a REAL element with no-op click.
- LSP clean: canvas_io_service.js. Probe kept: `test/cap_height_probe.mjs` (regression); diagnostic `test/cap_height_diag.mjs` removed.

**Notes for future sessions**:
- **Metric-fallback rule**: any optional SVG font-face metric (cap-height, x-height) must fall back to OpenType-typical ratios (0.7em / 0.5em), never 0 — 0 is silently persisted forever by the lossless save/load.
- **save_file() output format**: `exportJSON` spreads font_settings to the TOP LEVEL of the JSON (fixture style: `cap_height` at root, NO `font_settings` object) — probe assertions must read `JSON.parse(save_file()).cap_height`, not `.font_settings.cap_height` (that access throws).
- **Export capture trick**: `exportToSVG()` downloads; to assert on its output, patch `c.env.createObjectURL` (capture blob.text()) AND `c.env.createDOMElement` (return `document.createElement(tag)` with overridden no-op `click` — a plain object breaks `appendChild` since it must be a real Node).

### Session 22 follow-up 2 — sample panel: min-HEIGHT / textarea horizontal scrollbar / guides row count (user report: "是限制最小高度而不是限制最小宽度" — shrinking the panel height collapsed the preview height to 0 (width was fine); "滚动的经典问题…移入 textarea 不显示横向滚动条，移到滚动条上才显示，移出 textarea 也不消失，只有从滚动条直接移出才消失" — the classic textarea horizontal scrollbar hover problem; "guides 行数不等于实际文本行数" — guide rows didn't match the actual drawn text rows)

**Root causes**:
1. **Min-height**: `.sample-canvas-wrap` was `flex:1; min-height:0` — when the panel body was squeezed (user shrinking the component), wrapH ≤ 0 made `_render` early-return (`if (wrapW <= 0 || wrapH <= 0) return`), so the preview VANISHED (height 0). Width was fine because `contentW = max(wrapW, ceil(maxRowWidthPx))` keeps the canvas at one full natural line even at wrapW 0... (actually wrapW 0 early-returns too, but the panel width rarely hits 0 in a dock; height collapses first).
2. **Textarea horizontal scrollbar**: `scrollbar_visibility.js` SCROLLABLE list lacked `.sample-text-input`, AND CSS had NO `::-webkit-scrollbar` rules for it — so the textarea used the OS DEFAULT scrollbar (Windows Chrome gives overlay scrollbars to unstyled textareas). Overlay scrollbar behavior = exactly the reported symptom: invisible until the pointer aims precisely at the scrollbar itself; doesn't hide on leave unless the pointer leaves via the scrollbar. When the vertical scrollbar is also visible, Chromium stops auto-hiding the horizontal one — matching "vertical visible → problem disappears". The styled scrollbars in the rest of the app (`.sample-canvas-wrap`, `.pref_modal_body`, …) never had this problem because custom `::-webkit-scrollbar` rules always render a track.
3. **Guides rows ≠ text rows**: the panel's `_render` MEASURED at `width: wrapW` (for sizing `contentH`/`contentW`) but the DRAW call re-measured internally at `width: contentW` (Session 22 item 7's "measure and draw must use the same width" lesson was NOT applied to the two-pass layout inside `drawSampleTextPreview`). When `contentW > wrapW`, the measure pass wrapped MORE rows than the draw pass — `contentH` (canvas height + scrollbar) implied rows that were never drawn; guides (drawn per `layout.rows` at the DRAW width) didn't line up with the row count the canvas height suggested.

**Changes**:
1. **`js/ui/sample_text_panel.js` `_render`** — TWO-PASS measure: pass 1 at `wrapW` learns `maxRowWidthPx` → `contentW = max(wrapW, ceil(maxRowWidthPx))` → pass 2 re-measures at `contentW` (only when different) so `rows`/`contentHeight`/guides agree with the draw pass. Early-return now only on `wrapW <= 0` (not wrapH). **Dynamic MIN-HEIGHT on the wrap**: `wrap.style.minHeight = Math.ceil(fontSize) + 2*pad + 'px'` — one full row at the current font size, so collapsing the panel can never zero the preview; the canvas is never shorter than one row.
2. **`js/services/scrollbar_visibility.js`** — SCROLLABLE list += `.sample-text-input` (hover/scroll now sets `data-scrollbar-visible`, Firefox gets thin/inline scrollbar-color too).
3. **`css/style.css`** — `.sample-text-input` added to every rule in the shared sample scrollbar group (3519-3558 block): 6px, transparent thumb, visible on `:hover`/`[data-scrollbar-visible]`, hover-thumb `--ui-text-muted`. Comment documents WHY unstyled textareas must be styled (OS overlay scrollbar = the classic hover-only-show problem).
4. **`test/sample_panel_cdp_driver.mjs`** — 4 new checks (10b2 textarea scrollbar CSS rule + hover sets data-scrollbar-visible; 10c2 narrow-wrap keeps ONE-row canvas height = 68 + guide-line cluster count; 10e min-height: body squeezed via `flex: 0 0 20px` (NOT `height` — a flex:1 child ignores inline height) → wrap keeps ≥68px, preview still renders, 96px tracks to ≥116).

**Verification** (driver re-run, Phase A 45/45 + Phase B 6/6, **51 checks ALL GREEN**):
- 10c2 (narrow wrap 60px, 'AB' at 48): canvas height = **68** (1 row at contentW 116 — pre-fix 116 = 2 rows at wrapW 60); guides = **4 clusters** (ascender / baseline==cap(0) / descender / xHeight) — no phantom rows. Antialiasing spreads each guide line over ~2 pixel rows (8 raw y rows → 4 clusters via gap>2 clustering).
- 10e (body squeezed to 30px): wrap clientHeight **68** (min-height holds), preview still renders (398 ink px), font size 96 → min-height **116** — shrinking the component no longer zeroes the preview.
- 10b2: `.sample-text-input::-webkit-scrollbar` rule present in stylesheets; synthetic `mouseover` on the textarea sets `data-scrollbar-visible` (the SCROLLABLE hover contract).
- Everything else intact (same-row, kerning gap, content-driven height, persistence, Phase B restore, cap-height probe unaffected).

**Notes for future sessions**:
- **Min-height contract**: the sample wrap's inline `min-height = fontSize + 2*PAD` is set in `_render` on every render — any future change to font-size handling must re-assert it, or panel collapse zeroes the preview again. NEVER early-return on `wrapH <= 0` for this panel.
- **Unstyled-scrollbar rule**: ANY new scrollable element (textarea especially — textareas are the classic offender on Windows Chrome) MUST get `::-webkit-scrollbar` rules + a SCROLLABLE-list entry. An unstyled scrollbar = OS overlay behavior = the endless "scrollbar only appears when I aim at it" complaints.
- **Measure/draw width contract (extends Session 22 item 7)**: every consumer of `measureSampleTextPreview` that ALSO draws must re-measure at the same width the draw uses. The panel's two-pass (`base` at wrapW → pass 2 at contentW) is the canonical pattern; do not collapse it back to a single wrapW measure.
- **Driver gotcha**: squeezing a flex child via `style.height` does NOTHING (flex-grow overrides it) — use `style.flex = '0 0 20px'` and restore with `flex = ''`.
- Driver check counts: Phase A 45 + Phase B 6 = 51.

### Session 22 follow-up 3 — textarea corner resizer + wrap SCROLLABLE entry (user report: "现在是文本框内横向和纵向滚动条都是错的了，只有组件那个滚动条是对的")

**Root cause (pixel forensics, not speculation)**:
1. **Default gray resizer**: `.sample-text-input` keeps `resize: vertical`, so Chrome paints its DEFAULT `::-webkit-resizer` grip (gray `#d9d9d9` block) at the bottom-right corner — a pseudo-element that got NO rule in the scrollbar group (only `::-webkit-scrollbar-corner` was transparent). The unstyled resizer sits ON TOP of the corner where the horizontal and vertical scrollbars meet: measured ~11px of `#d9d9d9` exactly over the h-bar's right end (inputH band 23) and the v-bar's bottom end (inputV bands 4-5). Result: BOTH textarea scrollbars look truncated by a gray square — "横竖滚动条都是错的". The wrap has no `resize`, no resizer → "组件那个滚动条是对的".
2. **Wrap thumb never engaged**: `.sample-canvas-wrap` was in the CSS scrollbar group but NOT in `scrollbar_visibility.js` SCROLLABLE — the mouseover/scroll listeners only set `data-scrollbar-visible` for SCROLLABLE members. Probe evidence (live computed style, headless): OVER-WRAP with `wrap.matches(':hover') === true` still left `wrap.thumbBg = rgba(0,0,0,0)` and `wrapAttr: null`; after a real `scrollTop` scroll, attr stayed null. The wrap's thumb rendering relied on the CSS `:hover` path alone, which reliably fired for the textarea but NOT for a container hovering a child canvas — exactly the app-wide rule violation from follow-up 2's note ("ANY new scrollable element MUST get a SCROLLABLE-list entry").

**Changes**:
1. **`css/style.css`** (after the scrollbar-corner group ~L3541) — `.sample-text-input::-webkit-resizer { background: transparent; border: none; }` (+ comment). `display: none` was tested (experiment state B) and is equivalent visually, but transparent keeps the resize hit-area; the grip disappears, the corner matches the wrap/panel-body.
2. **`js/services/scrollbar_visibility.js`** — SCROLLABLE += `.sample-panel-body, .sample-canvas-wrap` (hover and scroll now set `data-scrollbar-visible`; Firefox gets thin/inline colors too). The textarea entry (from follow-up 2) unchanged.
3. **`test/sample_panel_cdp_driver.mjs`** — 3 new checks: textarea resizer rule present (`.sample-text-input::-webkit-resizer` in stylesheets); wrap gets `data-scrollbar-visible` on synthetic mouseover; wrap gets it on synthetic scroll (scrollTop=50 + bubbles event).

**Verification** (driver re-run — **Phase A 48/48 + Phase B 6/6, 54 checks ALL GREEN**; experiment/live-style probes):
- Experiment probe (`test/scrollbar_experiment_probe.mjs`, 24×24 corner pixel counts): state A (current CSS) inputCorner = `[#f8fafc 525, #cbd5e1 36]` — **`#d9d9d9` completely gone** (pre-fix: 11px); state B (injected `::-webkit-resizer { display:none }`) now IDENTICAL to state A → the real CSS achieves the same result as display:none. inputV `[9,8,0,0,0,2]` / inputH `[9,8,...,2]`: thumb still visible at top/left on hover (scrollTop/Left=0).
- Live-style probe (`test/scrollbar_live_style_probe.mjs`): OVER-WRAP → `wrap.thumbBg = rgb(100,116,139)` (--ui-text-muted thumb) + `wrapAttr: ""` (was transparent/null pre-fix); AFTER-SCROLL-WRAP → attr `""` (was null). OVER-INPUT unchanged (textarea thumb visible + attr set).
- Hover probe (`test/scrollbar_hover_probe.mjs`): overInput inputV/inputH thumb runs `#cbd5e1` 15px (visible); neutral 4px non-bg only. Wrap now engages through the same attr mechanism.
- LSP clean: scrollbar_visibility.js (CSS/js change; no diagnostics). Driver Phase A 48 (was 45) + Phase B 6 = 54.

**Notes for future sessions**:
- **Resizer rule**: ANY element with `resize: vertical` (or any resize) that is part of a custom-scrollbar group MUST also style `::-webkit-resizer` — the default grip is a separate pseudo-element that Chrome paints over the h/v scrollbar junction, visually truncating both bars. Transparent background (not display:none) keeps the drag hit-area.
- **SCROLLABLE completeness (extends follow-up 2)**: CSS scrollbar rules alone are NOT enough — the element MUST also be in `scrollbar_visibility.js` SCROLLABLE for the mouseover/scroll `data-scrollbar-visible` contract. The CSS `:hover` path is unreliable in headless probes for elements whose hover target is a child (verified: wrap hovered via `:hover` truth but thumb stayed transparent).
- Driver check counts: Phase A 48 + Phase B 6 = 54.

### Session 22 follow-up 4 — trailing newline phantom row (user report: "metric 仍然比实际多一行，应该是把换行识别成了整行然后额外+1导致的")

**Root cause**: `layoutSampleText`'s row-counting walk (sample_text_preview.js) incremented `rows` for EVERY `newline` token unconditionally. A TRAILING newline ("AB\n" — the last token) therefore claimed a row that holds no content: guides are drawn per `layout.rows`, so a phantom guide line appeared, and `contentHeight = rows*lineH*scale + 2*PAD` made the canvas one row too tall. Semantics: a newline only starts a NEW row if content follows it; the textarea's trailing empty line is not a row.

**Changes**:
1. **`js/presentation/sequence/sample_text_preview.js`** (layoutSampleText row walk) — index loop `for (let i = 0; i < tokens.length; i++)`: `newline` increments rows only when `i < tokens.length - 1`. Middle newlines keep their rows ("A\nB\n" = 2 rows), lone "\n" = 1 empty row, "AB\n" = 1 row. The natural-line width walk (maxRowWidthPx) needed no change — `Math.max(maxRowModel, rowW)` already handles the trailing-newline reset.
2. **`test/sample_panel_cdp_driver.mjs`** — 6 new checks (10f): measure reports rows 1 / contentHeight 68 for 'AB\n'; typed 'AB\n' keeps canvas height 68; guide-line clustering still 4 (no phantom line); 'A\nB\n' = 2 rows / height 116; lone '\n' = 1 row (no crash).

**Verification** (driver re-run — **Phase A 54/54 + Phase B 6/6, 60 checks ALL GREEN**):
- All 6 new checks pass: trailing newline measure rows=1, contentHeight=68, canvas height=68 (pre-fix: 116), guides=4 clusters (pre-fix: 5 lines incl. phantom); middle newline rows=2/height=116 (row kept); lone newline rows=1 (no crash).
- Full prior suite intact: same-row, kerning gap, content-driven height, scrollbars (resizer/SCROLLABLE), min-width/min-height, persistence, undo/redo, Phase B restore.
- LSP clean: sample_text_preview.js. Driver gotcha hit: single-backslash `\n` inside the PROBE_A template literal becomes a REAL newline at template evaluation — in comments AND check names it silently terminated the string at EOF ("Unexpected end of input" at the last line on `node --check` of an extracted probe). Must write `\\n` everywhere inside the driver template (including prose comments), and `await type('AB\\n')` end-to-end (template → probe `'AB\n'` → textarea value with a real newline).

**Notes for future sessions**:
- **Trailing-newline rule (extends the row-count contract)**: `rows` counts content rows only — a trailing `newline` token NEVER increments it; only newlines followed by more tokens start a new row. Any future rework of the row walk must keep this, or guides/content height drift +1 again.
- **Driver template-literal escaping gotcha**: the PROBE_A template evaluates `\n` (single backslash) BEFORE the probe runs — a bare `\n` in ANY string or comment inside the template becomes a real line break in the probe source, silently breaking string literals at EOF. Always write `\\n` in driver source; the probe then sees `'\n'` and the runtime sees a real newline. Symptom fingerprint: runtime SyntaxError "Invalid or unexpected token" reported at the END of the probe body with no visible culprit line.
- Driver check counts: Phase A 54 + Phase B 6 = 60.

### Session 22 follow-up 5 — cross-newline pen leak = the REAL "metric still one row too many" (user report: "没有解决，仍然多一行… guides 参考线多一行… 多行无尾随回车… 硬刷新过仍是多一行")

**Root cause**: follow-up 4 fixed only TRAILING newlines. The persisted report was a DIFFERENT bug: `layoutSampleText`'s row-counting walk reset NOTHING on a `newline` token — `penX` and `prevGlyph` carried across the break, while the DRAW walk always reset both (`pen.row++/pen.x=0/prevGlyph=null`, sample_text_preview.js L97-101). With a line that nearly fills the row, the NEXT line's first glyph immediately exceeded the wrap threshold (`nextX > maxX && penX > 0` → phantom wrap), and subsequent lines kept accumulating from the stray pen position and wrapped again. Guides were drawn per the BUGGY `layout.rows` while the actual text drew fewer rows → extra guide lines + canvas one row too tall. Simple short-line cases ('AB\nCD' etc.) never tripped it because stray pen 2000 « maxX; only lines ≥ maxX − nextLineWidth expose it — exactly the user's multi-line real-world text WITHOUT a trailing newline.

**Forensic evidence** (test/nl_sight_probe.mjs — guide-line cluster scan + two-pass measure dump): 'The quick brown fox\nJumps over\nThe lazy dog' at fontSize 48: m2 (pass @ contentW 932) rows=**5**, canvasH 260, 16 guide clusters (pre-fix) — manual arithmetic reproduced 5 = 1 (line 1, 19000 < maxX 19208) + phantom wrap at 'J' (19000+1000 > 19208) + newline + newline + phantom wrap at 'g' (9250+1000… accumulating 19750 > 19208). 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' (26 chars) m2 rows=1 ✓ — single line never leaks.

**Changes**:
1. **`js/presentation/sequence/sample_text_preview.js`** (layoutSampleText row walk, newline branch) — `penX = 0; prevGlyph = null;` on EVERY newline (plus the follow-up-4 trailing guard). The measure walk now resets the pen exactly like the draw walk → rows/contentHeight/guides agree with drawn rows for ANY text. The natural-line width walk (maxRowWidthPx) already reset on newline — unchanged.
2. **`test/sample_panel_cdp_driver.mjs`** — 6 new checks (10g): measure reports rows 3 / contentHeight 164 / maxRowWidthPx ≈932 for the fox text; typed fox text → canvas height 164, canvas width 932 (one natural line); guides = 10 clusters (3 rows: 4 lines row 1 + 3 each subsequent — desc/asc lines merge across rows).

**Verification** (driver re-run — **Phase A 60/60 + Phase B 6/6, 66 checks ALL GREEN**):
- 10g all pass: pre-fix rows 5/canvasH 260/16 clusters → post-fix rows 3/164/10.
- Sight-probe re-run confirms: fox text canvasH 164 (was 260), 10 clusters (was 16); m2 rows 3; 'AB'/'AB\nCD'/'AB\nCD\n'/'AB\n\nCD'/26-char cases unchanged.
- Full prior suite intact (trailing newline, same-row, kerning, min-width/min-height, scrollbars, persistence, undo/redo, Phase B).
- LSP clean: sample_text_preview.js.

**Notes for future sessions**:
- **Cross-newline pen rule (extends the row-count contract)**: the row-counting walk MUST mirror the draw walk token-for-token — newline resets pen x AND the kerning chain. Any future rework of either walk that resets only one side re-introduces phantom wraps on multi-line text whose lines are near full width.
- **Wrap-threshold physics**: phantom wraps appear only when a line's pen-x ≥ maxX − (next glyph advance + kerning); tests must therefore use a line long enough to fill the canvas, not just 2-char lines ('A\nB' with pen 2000 vs maxX 5645 at wrapW and 19208 at contentW never trips).
- The two-pass panel measure (wrapW → contentW) is independent of this bug (both passes shared the same broken walk); keep it.
- Probe kept: test/nl_sight_probe.mjs (guide-cluster scan + measure dump per text; also saves screenshot). Driver check counts: Phase A 60 + Phase B 6 = 66.

### Session 22 follow-up 6 — sample panel supersampling (user: "渲染有明显的锯齿感… 亚像素的细线… 有没有办法优化让锯齿感没那么强")

**Root cause of the jaggies**: the preview scales 1000-upm curves down to the user-set font size (scale ≈ 0.048 at 48px), so strokes a few model units wide are sub-pixel (< 1px). The panel drew directly onto the dpr-sized canvas, and single-sample canvas AA quantizes sub-pixel coverage to hard on/off staircases — diagonal strokes (A's arms etc.) showed 1px steps, and thin strokes partially vanished.

**Changes**:
1. **`js/ui/sample_text_panel.js`** (`_render`) — offscreen-cache supersampling: render the preview into a lazily-created offscreen canvas at `SUPERSAMPLE = 4 ×` (canvas.width = ceil(contentW*4), ctx transform 4x → all drawing stays in logical coords, options unchanged), then blit down to the visible canvas with `ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(ss, 0, 0, contentW, contentH)`. The visible backing store stays dpr-sized; only the offscreen source is larger. Offscreen canvas is reused across renders (resize only when contentW/H change). Guides render through the same path (their 1px logical lines become 4px source → 1px downscaled, smoother too).

**Verification**:
- **`test/ss_probe.mjs`** (old-path 1x direct draw vs new-path 4x+downscale, same logical canvas 281×68, text 'ABCDE' — NOTE: the fox text renders ZERO ink in the fixture because only A–E have outlines; auto-created groups are empty): staircase jumps (boundary x-shifts >1px between consecutive ink rows) **12 → 7**; ink pixels **911 → 1014** (sub-pixel strokes preserved instead of aliased away); ASCII-art crop of A's left diagonal shows graded alpha ramps instead of isolated hard step dots.
- **Driver re-run — Phase A 60/60 + Phase B 6/6, 66 checks ALL GREEN** (guide-line detection unaffected: downscaling over a TRANSPARENT background preserves the rgb (r>200,g<180,b<120) — only alpha attenuates; ink thresholds are generous).
- LSP clean: sample_text_panel.js. PNG evidence kept: test/ss_old.png, test/ss_new.png.

**Notes for future sessions**:
- **Supersampling pattern**: offscreen canvas at N× + `setTransform(N,…)` on its ctx (draw code unchanged, still logical coords) + high-quality drawImage downscale. The 4× factor smooths sub-pixel strokes; higher factors yield diminishing returns and cost fill-rate (~2.4M source px worst case here — trivial).
- **Over-transparent downscale**: canvas blending over a transparent background keeps source RGB (premultiplied alpha only attenuates alpha), so color-threshold pixel scans (guide clusters) survive downscaling unchanged; alpha-threshold scans (ink counts) shift — use generous thresholds or relative comparisons.
- **Fixture gotcha (again)**: only A–E have outlines in the baseline JSON; any probe text must stay within those glyphs (or use `\test\` refs) or it silently renders zero ink.
- Probe kept: test/ss_probe.mjs (metrics + ASCII + PNGs). Driver check counts: Phase A 60 + Phase B 6 = 66.

### Session 22 follow-up 7 — sample text backslash syntax (user: "如果解析到两个反斜杠，即\xxx\，则整个子串表示名称为xxx的这个glyph，而不是\xxx\这连续的5个字符；同时，\\表示单个反斜杠字符。从前往后解释，孤立的反斜杠直接忽略")

**Semantics (user-confirmed)**: `\xxx\` = the WHOLE substring is a glyph ref for the named group (NOT 5 literal characters); `\\` (two consecutive backslashes) = ONE literal backslash character (user later approved "\\当成普通反斜杠字符没问题"); an isolated `\` (no closing, not doubled) is IGNORED (user approved "孤立的\走普通字符和直接忽略都没问题" — ignore matches the original spec); parse left to right.

**Changes**:
1. **`js/app/sequence_preview_facade.js`** (`buildSampleTokens` rewritten) — parse loop: `\n` → newline token; `\\` (next char is also `\`) → ONE literal backslash glyph via `pushGlyphForChar('\\')` (default group for the backslash char, auto-created, advance 1000), consumes exactly 2 chars; else try `\name\` via `cm.getGroupByName(name)` (NON-EMPTY name required) → glyph token with the ref's advance, consumes the whole substring; unresolved name → THIS `\` is isolated (ignored, `i++`), the name chars process normally on subsequent iterations; trailing isolated `\` (no closing) → ignored. A `pushGlyphForChar` helper dedupes the original char/space/unknown branches.

**Verification** (driver re-run — **Phase A 66/66 + Phase B 6/6, 72 checks ALL GREEN**):
- 6 new checks (10h) via `measureSampleTextPreview` + typed end-to-end: `'A\\B'` (escaped) = A + `\` + B = 3 tokens = 164px; `'A\B'` (isolated dropped) = A+B = 116px; `'AB\'` (trailing isolated) = 116px; `'\nope\'` (no such group) = literal n,o,p,e = 4 tokens = 212px; typed `A\\B` → canvas width 164px; typed `A\B` → 116px (typed checks force kerning OFF — the driver's earlier A→B −250 pair would otherwise shrink plain 'AB' to 104px; saved `kernWasOn` restored after).
- LSP clean: sequence_preview_facade.js.

**Notes for future sessions**:
- **Driver template-literal backslash trap (2nd occurrence, sharper)**: the driver's PROBE is a JS template literal. A SINGLE backslash inside it is a template ESCAPE — `\x` and `\B` are invalid template escapes and kill the driver with `SyntaxError: Invalid or unexpected token` at PARSE time (first observed as `'A\B'` in a COMMENT — comment or not, the template still parses escapes). Rule: in template-literal comments/strings, every backslash that should REACH the probe must be written `\\` (doubled); a displayed `'A\\B'` probe example needs `'A\\\\B'` in the driver source. Prefer `String.fromCharCode(92)` (BSL) for building backslash INPUT strings — zero escape ambiguity.
- **Probe gotcha**: `mTrail` was already declared by check 10f in the same probe scope — 10h vars must be uniquely prefixed (`hEsc`/`hIso`/`hTrail`/`hUnk`).
- **Semantics contract**: `\name\` with a NON-EMPTY name takes precedence over `\\`-escaped... actually NO — `\\` is checked FIRST (two backslashes has an empty "name" — the name lookup requires `end > i + 1`, which a doubled backslash fails, so order works either way, but the `\\` branch is explicit). Unresolved names degrade to literal chars with both backslashes acting as isolated (ignored) — deterministic and tested.
- Probe kept: test/sample_panel_cdp_driver.mjs (72 checks). Driver check counts: Phase A 66 + Phase B 6 = 72.

### Session 22 follow-up 8 — repo cleanup (user: "清除项目中一大堆临时文件，调试信息，或者将它们加入gitignore")

**Executed** (no app code touched):
- **Deleted 32 unreferenced one-off diagnostics** from test/: old upm freeze/zoom diag chain (upm_freeze_probe.mjs–7/9/4h, upm_zoom_probe.mjs, upm_zoom_stepped.mjs/2), early scrollbar forensics (scrollbar_forensics/pixels/visual/wrap_hover_probe.mjs), sample_panel_diag.mjs–4, emit_route/expand_diag/preview_diag/verify_outline/winding/winding_render/shared_fill/trailing_nl probe files, plus dead fixtures (big_project.json — consumed only by the deleted probe4; roundtrip_fixed.svg/.ufo.zip, roundtrip_smooth_new.ufo.zip) and regenerable screenshots (nl_sight.png, seq-bar-active-state.png, textarea_scrollbar_shot.png). Kept EVERY probe/fixture referenced in these notes (drivers, regression probes, baseline/fixture zips/svgs, huge_project.json — still consumed by upm_freeze_probe8/upm_chain_diff/upm_grid/upm_profile/upm_single_rebuild).
- **Deleted __pycache__/** (start_server.pyc).
- **.gitignore** — added `__pycache__/`, `.playwright-mcp/`, `test/*.png`, `test/huge_project.json`, `test/big_project.json` (huge_project.json and the kept screenshots ss_old/ss_new/sample_panel_shot.png were `git rm --cached`'d — still on disk, just untracked). NOTE: `InkShader_project_2026-08-02T16-27-25.json` (the canonical baseline) stays tracked — do not blanket-ignore `test/*_project_*.json`.
- **AGENTS.md** — line 817's "Diagnostics kept: sample_panel_diag*.mjs" updated to reflect their removal (findings live in the session notes; the driver supersedes them).

**Current test/ inventory**: 49 files — 34 probes/drivers + 15 fixtures/inputs (driver check counts unchanged: 72).