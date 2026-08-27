# InkShader 后端与打包调研

> 2026-08-26 · 分析文档（仅调研，未实现）。配套：[ARCHITECTURE_DISCUSSION.md](ARCHITECTURE_DISCUSSION.md)（2026-07-29 的架构讨论，本调研与其结论一致并补充打包方案）。
> 所有关键管线已用本应用真实导出的 UFO 夹具（`test/InkShader_export_2026-08-02T16-27-30.ufo.zip`）实测通过，耗时数据见文末。

---

## 0. 结论先行

| 问题 | 结论 |
|------|------|
| 后端框架 | **FastAPI + uvicorn**（与既有讨论一致、环境已装；Flask 为降级备选） |
| 单 exe（浏览器模式） | **PyInstaller `--onefile --windowed`**：启动本地服务器 → `webbrowser.open` 唤起浏览器 |
| 类 Electron 选项 | **pywebview + 同一 PyInstaller 产物**：OS 原生 webview 窗口（Win = WebView2），同份前端代码 |
| 条件编译 | 构建期（双 spec + 生成的 `build_info.py`）+ 运行期（`sys.frozen`/`sys._MEIPASS`/`/api/meta` 能力协商）；**前端零构建，JS 侧用运行时特性检测而非编译期 ifdef** |
| UFO→OTF/TTF | `ufoLib2` 直接读 UFO zip → `ufo2ft.compileTTF/compileOTF` |
| remove overlap | 三层可选：编译期 `ufo2ft(removeOverlaps=True)` / 成品期 `ttLib.removeOverlaps`（skia-pathops）/ 源字形期 `booleanOperations` |
| FEA 解析 | `fontTools.feaLib.parser.Parser`（解析即校验，错误带行列号）+ `feaLib.builder` 编译 |

**为什么这三个结论：**
1. **FastAPI**：API 面会持续增长（export / import / validate / subset / fea / storage），pydantic 契约 + 自动 OpenAPI 文档值得；与 ARCHITECTURE_DISCUSSION 既定方向一致；PyInstaller 生态（`pyinstaller-hooks-contrib`）对 fastapi/pydantic/uvicorn 都有现成 hook。
2. **PyInstaller**：Python 打包单 exe 的绝对主流，`--onefile` 一把出单文件；配合 spec 文件天然支持"按目标产不同产物"。
3. **pywebview**：Python 生态里"类 Electron"的标准答案——不捆绑 Chromium，用系统 WebView2，PyInstaller 单文件可包，前后端仍是同一个 HTTP 服务，前端代码 100% 复用。

---

## 1. 目标与现状

- 现状：纯前端（vanilla ESM，无构建步骤），`start_server.py`（Python）做静态开发服务器；`js/canvas/services/canvas_io_service.js` 已能导出 **UFO zip**（含 `fontinfo.plist` / `glyphs/*.glif` / `kerning.plist` / `groups.plist` / `features.fea`）。
- 目标产物：
  1. **单 exe**：双击运行 → 本地起 web 服务 → 唤起浏览器打开编辑器，无需用户装 Python。
  2. **可选桌面形态**：单 exe 以原生窗口运行（类 Electron 的整体文件）。
  3. 两种产物按构建配置区分功能（条件编译）。
  4. 后端承载 fonttools 三件事：**OTF/TTF 导出（UFO 为输入源）**、**质量保证（remove overlap）**、**FEA 解析**。

---

## 2. 后端框架选型

### 2.1 本场景的特殊性

- **本地单用户**：无并发压力、无鉴权/多租户需求，`127.0.0.1` 绑定即可。
- **静态托管 + JSON API**：前端已存在，后端要做的是"托管静态文件 + 一组调 fonttools 的 RPC 式端点"。
- **CPU 密集任务**：fonttools 编译是纯计算（实测 10 字形 TTF 编译 0.38s，大字体可达数秒~数十秒）——async/event-loop 本身不带来收益，重要的是**不要让请求阻塞服务器响应**（用后台任务）。
- **打包约束**：产物必须能被 PyInstaller 干净地收进去。

### 2.2 FastAPI vs Flask

| 维度 | FastAPI + uvicorn | Flask |
|------|------------------|-------|
| API 契约 | pydantic 模型 + 自动 OpenAPI/文档 | 手写校验 |
| 打包 | 成熟（hooks-contrib 有 fastapi/uvicorn/pydantic hook），但依赖树稍重（pydantic-core 二进制 + uvicorn） | 最成熟，`app.run()` 一行，依赖最少 |
| 文件上传 | `UploadFile` 需 `python-multipart` | `request.files` 内置 |
| 与既有讨论一致性 | ✅ ARCHITECTURE_DISCUSSION 已定为 FastAPI | 与文档冲突 |
| 当前环境 | **已安装**（fastapi 0.136.3 / uvicorn 0.49.0 / pydantic 2.12.5） | 未安装 |

**建议：FastAPI 为主选。** 唯一实质代价是打包体积略大（pydantic-core、uvicorn 共 ~20MB），对单 exe 方案可接受。若打包阶段遇到不可解的 hook 问题，可平移至 Flask——把路由层与 `services/`/`core/` 解耦后，切换成本仅是路由层重写。

### 2.3 uvicorn 打包要点（提前避坑）

- **程序化运行**：`config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info"); server = uvicorn.Server(config); server.run()`（在后台线程）。
- 禁用 `--reload` / `--workers`（打包产物中无子进程/文件监视语义）。
- PyInstaller 产物里静态文件路径用 `sys._MEIPASS` 解析（见 §4.3）。

---

## 3. 打包方案

### 3.1 方案 A：单 exe + 浏览器（主方案）

**运行时流程：**

```
InkShader.exe（--onefile --windowed）
  ├─ 解析配置（构建模式、端口策略）
  ├─ 获取空闲端口（默认 8123，占用则 +1 或绑定 0 随机）
  ├─ 单实例锁（防止双击开两个服务器）
  ├─ 后台线程：uvicorn 起 FastAPI（托管前端静态文件 + /api/*）
  ├─ 就绪探测（GET /api/health 成功）后 webbrowser.open(http://127.0.0.1:PORT)
  └─ 常驻；退出途径：UI 的「退出」按钮 → POST /api/shutdown → server.should_exit=True → 进程退出
```

**PyInstaller 命令：**

```bash
pyinstaller packaging/web.spec
# web.spec 关键内容：
#   a = Analysis(['src/main_web.py'], datas=[('frontend', 'frontend'), ...])
#   exe = EXE(a, name='InkShader', console=False, onefile 语义)
```

要点：
- `console=False`（`--windowed`）：Windows 下不弹黑色控制台窗口；调试构建另出 `console=True` 的版本。
- **退出机制**：`--windowed` 下没有 stdin，`webbrowser.open` 后进程无法感知浏览器关闭，必须提供应用内退出入口（`/api/shutdown`）+ 可选托盘图标。这是"浏览器模式"的固有代价，桌面模式（方案 B）天然规避。

### 3.2 方案 B：类 Electron（pywebview 桌面窗口）

**pywebview = Python 生态的"Electron"**：把前端渲染进 OS 原生 webview（Windows=Edge WebView2、macOS=WKWebView、Linux=WebKitGTK），Python 与 JS 双向往来（`window.pywebview.api` 桥）。它**不捆绑 Chromium**，体积和内存远小于 Electron。

| 对比 | pywebview（推荐） | Electron | Tauri |
|------|------------------|----------|-------|
| 运行时 | 系统 WebView2（Win10/11 预装） | 自带 Chromium ~200MB | 自带 WebView2 |
| 与 Python 后端 | 同进程，直接 import | 需 sidecar 进程 | 需 sidecar |
| 单文件 exe | ✅ PyInstaller onefile | ❌ 是目录/安装包 | 可但 Rust 工具链 |
| 前端代码复用 | 100%（同一 HTTP 服务） | 100% | 100% |

**运行时流程：**

```
InkShader.exe（--onefile --windowed，desktop 模式）
  ├─ 后台线程：uvicorn 起 FastAPI（与方案 A 完全相同的 app）
  ├─ 主线程：webview.create_window("InkShader", url=f"http://127.0.0.1:{PORT}", ...)
  └─ webview.start() 阻塞至窗口关闭 → 停服务器 → 退出
```

要点：
- `webview.start()` 必须在**主线程**调用（Windows 下尤其如此）；uvicorn 放后台线程。
- 前端**不变**：仍通过 `fetch` 访问同源 API。pywebview 额外注入 `window.pywebview` JS 对象——这就是桌面模式差异化功能的挂载点（原生文件对话框、菜单、关闭事件）。
- 依赖：Win10/11 的 WebView2 Runtime（实测本机已有 143.0.3650.96）；无 Chromium 打包负担，exe 仍是一个文件。
- 也可让 pywebview 直接加载本地目录（不走 HTTP），但既然后端 API 必须走 HTTP，统一走 `http://127.0.0.1` 最简单，且规避 `file://` 下 ES module 的 CORS 限制（本项目是 ESM，必须 HTTP 服务，正好由服务器承担）。

### 3.3 备选（记录但不推荐立即用）

- **Nuitka `--onefile`**：编译为 C，启动更快、体积略小，但构建时间显著更长、第三方库偶发不兼容。适合作为后续优化项。
- **Briefcase（BeeWare）**：产出安装器/应用目录，不是单 exe，且 GUI 栈是 Toga。不匹配"整体单文件"诉求。
- **flaskwebgui**：与本需求最接近的现成库（Flask + 自动开浏览器 + PyInstaller），但①绑定 Flask；②开的是真浏览器不是原生窗口；③维护活跃度一般。可作为方案 A 的参考实现，不建议直接依赖。

### 3.4 体积与启动预估

- 依赖栈：Python 3.11 运行时 + FastAPI/uvicorn/pydantic + fonttools 全家（含 ufo2ft/booleanOperations/skia-pathops/brotli）+ 前端静态文件 ≈ **60–120MB**（onefile 压缩后）。
- `--onefile` 首次运行需解压到临时目录，**冷启动 5–15s**（机械盘更久）。若不能接受，后续可换 Nuitka onefile 或 "onedir + 安装器"（解压省去，启动 <1s）。

---

## 4. 条件编译 / 差异化功能

### 4.1 Python 没有 `#ifdef`，用"构建期配置 + 运行期检测"组合

| 时机 | 机制 | 作用 |
|------|------|------|
| 构建期 | **PyInstaller spec 本身是 Python 代码**：`web.spec` / `desktop.spec` 各自指定入口脚本与 `--add-data` 集合 → 产出 `InkShader-web.exe` / `InkShader-desktop.exe`（或单 spec 加 `--name` 参数） | 真正的"按目标裁剪"：desktop 入口 `import pywebview`，web 入口不 import → PyInstaller 静态分析按入口打包，**pywebview 不会进 web 产物** |
| 构建期 | spec 内生成 `build_info.py`（`MODE="desktop"|"web"`、版本、构建时间、`GIT_SHA`），随 `--add-data` 打入 | 运行期唯一事实来源 |
| 运行期 | `sys.frozen`（PyInstaller）、`sys._MEIPASS`（打包数据目录）、`build_info.MODE`、环境变量 `INKSHADER_MODE` 覆盖 | 路径解析、模式分支 |
| 运行期（JS） | `GET /api/meta` 返回 `{mode, version, features:{...}}`；`window.pywebview?.api` 探测原生桥 | **前端零构建步骤 → 用能力协商代替编译期 ifdef** |

### 4.2 前端为什么不做编译期 ifdef

当前前端是**无构建步骤的原生 ESM**（`index.html` 直接 `<script type="module">`）。引入 esbuild 等 bundler 才能做真死代码消除（`define: {__DESKTOP__: true}`），但这会给项目增加 Node 工具链。更契合现状的是：

```js
// js/services/backend_client.js（示意，沿用 ARCHITECTURE_DISCUSSION 的 detectBackend 思路）
const meta = await fetch('/api/meta', { timeout: 500 }).then(r => r.json()).catch(() => null);
const nativeBridge = window.pywebview?.api;      // 桌面模式注入
export const env = {
  mode: meta?.mode ?? (nativeBridge ? 'desktop' : 'browser'),
  features: meta?.features ?? FALLBACK_FEATURES,  // 无后端 → 降级 opentype.js
  hasNativeDialogs: !!nativeBridge,
};
```

### 4.3 差异功能清单（示例）

| 功能 | 浏览器模式（web） | 桌面模式（desktop） |
|------|-------------------|---------------------|
| 前端宿主 | 系统默认浏览器 | 原生窗口（WebView2） |
| 退出 | UI「退出」→ `/api/shutdown` | 关闭窗口即退出（pywebview 事件） |
| 文件对话框 | `<input type=file>` / `<a download>`（现状） | pywebview 原生对话框（`window.pywebview.api.file_dialog`） |
| 快速保存（Ctrl+S） | 现状下载流 / File System Access API | 后端直接写磁盘（ARCHITECTURE_DISCUSSION §4.5 的 ServerFileStorage） |
| 打包内容 | 无 pywebview | 含 pywebview + WebView2 运行时检测 |

### 4.4 共享代码策略

`src/main.py` 只做模式分发：

```python
# src/main.py
def main():
    mode = build_info.MODE  # or os.environ.get("INKSHADER_MODE")
    app = create_app()               # 与模式无关的 FastAPI app
    port = pick_free_port()
    start_server_thread(app, port)   # 共用
    if mode == "desktop":
        run_desktop(port)            # import pywebview 只在这里
    else:
        open_browser(port)
```

---

## 5. 字体功能架构

### 5.1 总览

```
前端（浏览器 / pywebview 窗口）
   │  fetch（同源 HTTP；前端导出 UFO zip 作为输入）
   ▼
FastAPI app（src/inkshader/api/）
   ├─ GET  /api/meta                能力协商（模式、版本、features）
   ├─ POST /api/font/export         UFO zip → TTF/OTF/WOFF2
   ├─ POST /api/font/qa/remove-overlap   → 去重叠文件 + 报告
   ├─ POST /api/fea/parse           校验/结构化 .fea（错误带行列号）
   ├─ POST /api/fea/compile         把 .fea 编译进字体（GSUB/GPOS）
   └─ GET  /api/health
   ▼
services/（编排层：bytes → bytes，无 FastAPI 依赖）
   ├─ export_service.py    UFO zip → 目标格式 bytes
   ├─ qa_service.py        remove overlap / （将来）fontbakery 校验
   └─ fea_service.py       parse / compile
   ▼
core/（纯 fonttools 函数，可独立单测）
   ├─ ufo_io.py      zip → ufoLib2.Font（含校验、损坏报告）
   ├─ ttf_compile.py ufo2ft 封装（TTF/OTF 选项透传）
   ├─ overlap.py     booleanOperations / ttLib.removeOverlaps 封装
   └─ fea_parser.py  feaLib 封装
```

- 分层刻意镜像前端风格（core 最纯 → services 编排 → api 暴露），`core/` 零 FastAPI 依赖，可直接 `pytest`。
- **UFO zip 即交换格式**：前端 `exportToUFO()` 的产物（实测 `ufoLib2.Font.open(zip)` 直接可读，0.07s），后端零格式转换。将来 TTF 导入则反向（TTF → 项目 JSON，属于后续里程碑）。

### 5.2 UFO → OTF/TTF 导出（已实测）

```python
font = ufoLib2.Font.open(ufo_zip)          # 直接读 zip
ttf  = ufo2ft.compileTTF(font,
                         removeOverlaps=True,
                         overlapsBackend="booleanOperations",  # 或 "pathops"(skia)
                         useProductionNames=True)
buf = io.BytesIO(); ttf.save(buf)
```

- **实测**（`test/InkShader_export_2026-08-02T16-27-30.ufo.zip`，10 字形）：compileTTF 0.38s（5.8KB）、compileOTF 0.13s（5.4KB，CFF）；`kerning.plist` 自动编译进 **GPOS**、`features.fea`（应用已写 `feature liga`）自动编译进 **GSUB** —— 直接验证了 ARCHITECTURE_DISCUSSION 的核心论断（前端 opentype.js 会丢 kerning，后端 fonttools 不会）。
- WOFF2：`font.flavor = "woff2"; font.save(buf)` + brotli（实测 0.03s）。
- 其他可用选项：`cubicConversionError`（TTF 三次→二次误差容忍）、`flattenComponents`、`featureWriters`（`KernFeatureWriter` 可从 groups/kerning 自动生成 kern 特性）。
- 注意 API 细节：参数名是 **`overlapsBackend`**（复数 s），ufo2ft 3.7.0 不是 `overlapBackend`。

### 5.3 质量保证：remove overlap（三种层次，均已实测）

| 层次 | 实现 | 适用 |
|------|------|------|
| a. 编译期 | `ufo2ft.compileTTF(..., removeOverlaps=True)`（默认 booleanOperations；`overlapsBackend="pathops"` 换 skia-pathops，更快但结果略不同） | 导出 TTF/OTF 时顺手去重叠，零额外成本 |
| b. 成品期 | `fontTools.ttLib.removeOverlaps.removeOverlaps(ttf)`（依赖 skia-pathops，实测 0.02s；会合并重叠轮廓/组件，**注意使 hinting 失效**，`removeHinting` 默认 True） | 对已编译字体做 QA 修复 |
| c. 源字形期 | `booleanOperations.BooleanGlyph(glyph).removeOverlap()`（无损、可回写 UFO 再编译） | 导出前对单个字形做"消毒"预览，前端可展示前后对比 |

- 与前端 `js/core/boolean.js` 的关系：前端布尔/展开描边用于**交互预览**；后端这套是**导出时的最终质量保证**，两者独立。
- 将来可扩展：`fontbakery`（完整 QA 报告）作为 `/api/font/validate` 的加强版。

### 5.4 FEA 解析（已实测）

```python
from fontTools.feaLib.parser import Parser
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

# 解析（即校验）：Parser 接受 file-like，不是字符串
doc = Parser(io.StringIO(fea_text), glyphNames=font.keys()).parse()
#   → doc.statements: FeatureBlock / LookupBlock / GlyphClassDefinition ...

# 错误带行列号（实测）：'<features>:1:19: Expected "by", "from" or explicit lookup references'

# 编译进字体
addOpenTypeFeaturesFromString(ttf, fea_text)   # 实测 GSUB/GPOS 生成
```

- **parse 端点**的产出：`{ok, features:[...], lookups:[...], errors:[{line, col, message}]}`——前端可据此做 .fea 编辑器的错误标注（行号列号齐全）。
- **compile 端点**：`POST /api/fea/compile {fea, font}` 返回带 GSUB/GPOS 的字体（或与 export 合并：UFO 的 `features.fea` 已在 ufo2ft 编译时自动处理，无需单独步骤）。
- 与 `kerning_manager.js` 的衔接：UFO 导出已写 `groups.plist`/`kerning.plist`，ufo2ft 的 `KernFeatureWriter` 负责生成 kern——前端无需手写 kern fea。

### 5.5 API 设计草案（同步优先，任务模式备用）

- 单用户本地工具：**先做同步端点 + 前端 spinner**（实测 10 字形 0.4s，常规字体秒级）。
- 大字体（几千字形）编译可达数十秒：升级为 **job 模式**——`POST /api/font/export` 立即返回 `job_id`，`GET /api/jobs/{id}` 轮询进度，`GET /api/jobs/{id}/download` 取结果。用 FastAPI `BackgroundTasks`（线程池）执行，HTTP 服务器保持响应；注意 CPU 密集任务线程间无并行（GIL），但响应性与"后台执行"语义是主要收益。
- 统一错误模型：`{"error": {"code": "FEA_PARSE_ERROR", "message": ..., "details": [...]}}`（fonttools 异常 → 结构化错误，避免把 Python traceback 直接给前端）。

### 5.6 目录结构草案

```
backend/
├─ pyproject.toml / requirements.txt
├─ src/
│  ├─ main.py                # 入口：模式分发（web/desktop）
│  ├─ build_info.py          # 构建期生成：MODE/VERSION/GIT_SHA
│  └─ inkshader/
│     ├─ config.py           # 路径解析（sys._MEIPASS / 开发目录）
│     ├─ api/                # FastAPI app + 路由
│     ├─ services/           # 编排（bytes → bytes）
│     └─ core/               # 纯 fonttools 函数（零框架依赖）
├─ packaging/
│  ├─ web.spec               # PyInstaller：浏览器模式
│  ├─ desktop.spec           # PyInstaller：pywebview 模式
│  └─ hooks/                 # 需要时补充 hook
└─ tests/                    # pytest：core/ 的 fonttools 单测
```

---

## 6. 已拉取的库（本机 Python 3.11.9，Windows）

**环境原本已有（字体栈 + API 栈）：**

| 包 | 版本 | 用途 |
|----|------|------|
| fonttools | 4.61.1 | 核心（含 feaLib、ttLib、cu2qu、WOFF2） |
| ufo2ft | 3.7.0 | UFO → OTF/TTF 编译 |
| booleanOperations | 0.9.0 | 源字形 remove overlap / 布尔运算 |
| ufoLib2 | 0.18.1 | UFO（含 zip）读取 |
| fontmake | 3.11.1 | 参考 CLI（应用内直接用 ufo2ft 库，不依赖它） |
| fontMath / compreffor / pyclipper | 0.9.4 / 0.6.0 / 1.4.0 | ufo2ft 依赖 |
| fastapi / uvicorn / pydantic / starlette | 0.136.3 / 0.49.0 / 2.12.5 / 1.2.1 | 后端框架 |

**本次新增：**

| 包 | 版本 | 用途 |
|----|------|------|
| pyinstaller | 6.22.2 | 单 exe 打包（构建期） |
| pywebview | 6.2.1 | 类 Electron 桌面窗口（含 pythonnet/clr_loader，Win WebView2） |
| python-multipart | 0.0.32 | FastAPI 文件上传（UFO zip 上传必需） |
| brotli | 1.2.0 | WOFF2 压缩（fonttools woff2 依赖） |
| skia-pathops | 0.9.2 | remove overlap 的快速后端（`overlapsBackend="pathops"` / `ttLib.removeOverlaps`） |

**建议的 requirements 拆分**（详见 [backend/requirements.txt](backend/requirements.txt)）：

- `requirements.txt`（runtime）：fonttools、ufo2ft、booleanOperations、ufoLib2、fastapi、uvicorn、python-multipart、brotli、skia-pathops（pywebview 仅 desktop 模式，用 `requirements-desktop.txt` 或 extra）
- `requirements-build.txt`（构建期）：pyinstaller

> 注意：`.gitignore` 当前忽略 `*.py`（`start_server.py` 即因此未纳入版本控制）。**若开始实施后端，需先修改 `.gitignore` 放行 `backend/src/` 下的 `.py`**，否则后端源码不会被提交。

---

## 7. 风险与注意事项

1. **onefile 冷启动**：解压 5–15s；不可接受则换 Nuitka onefile 或 onedir+安装器。
2. **杀毒误报**：PyInstaller 单文件 exe 是常见误报对象（加签名可缓解）。
3. **pywebview 依赖 WebView2 Runtime**：Win10/11 预装（本机实测 143.0.3650.96）；极旧系统需分发 Evergreen 安装器。
4. **ESM + file://**：前端是 ES module，必须走 HTTP 服务——正好由内置服务器承担；这也意味着 pywebview 加载 `http://127.0.0.1` 而非本地文件最稳妥。
5. **uvicorn 打包**：程序化运行、禁 reload/workers；hook 由 pyinstaller-hooks-contrib 覆盖。
6. **安全**：仅绑定 `127.0.0.1`；同源无需 CORS；本地工具不考虑鉴权，但 `/api/shutdown` 等敏感端点保持仅本机可达即可。
7. **参数名陷阱**：ufo2ft `overlapsBackend`（带 s）；`Parser` 需 file-like 而非字符串（见 §5.2/§5.4）。
8. **前端能力协商**：无后端时保持现状可用（纯前端降级），后端出现后自动升级——与 ARCHITECTURE_DISCUSSION 的 `detectBackend`（500ms 超时）一致。

---

## 8. 建议实施顺序（本次未实施）

1. 修改 `.gitignore` 放行后端源码；建 `backend/` 骨架（FastAPI + `/api/meta` + 静态托管）
2. `POST /api/font/export`（TTF/OTF/WOFF2，同步版）→ 前端「导出字体」菜单接入
3. `POST /api/font/qa/remove-overlap`（含报告）→ 前端 QA 面板
4. `POST /api/fea/parse` + `/api/fea/compile` → .fea 编辑/校验 UI
5. ServerFileStorage（Ctrl+S 直接写盘）
6. `packaging/web.spec` → 出 `InkShader-web.exe`（浏览器模式）
7. `packaging/desktop.spec` + pywebview → 出 `InkShader-desktop.exe`（窗口模式）
8. 需要时：job 化、Nuitka 优化、fontbakery QA 加强

---

## 附录：冒烟验证记录（2026-08-26，真实 UFO 夹具）

```
versions: fonttools 4.61.1 | ufo2ft 3.7.0 | booleanOperations 0.9.0
[1] ufoLib2 opened zip directly, 0.07s, glyphs=10 (family: Simple Script, upm 1000, kerning pairs 1)
[2] compileTTF 0.38s -> 5796 B, tables=[GPOS GSUB cmap glyf head hhea hmtx loca maxp name OS/2 post]  (kerning→GPOS, liga→GSUB ✓)
[3] compileOTF 0.13s -> 5408 B, CFF=True
[4] ttLib.removeOverlaps (skia-pathops) 0.02s ✓
[4b] booleanOperations BooleanGlyph.removeOverlap on 'A' ✓
[5] feaLib parsed 5 statements (features: liga, kern); compiled -> GSUB=True GPOS=True ✓
[5c] invalid fea error: '<features>:1:19: Expected "by", "from" or explicit lookup references' ✓
[6] WOFF2 compress (brotli) 0.03s -> 3448 B ✓
```
