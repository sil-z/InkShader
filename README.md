# InkShader

Web 字体编辑器。前端是零构建步骤的 ES module 应用；可选后端（FastAPI）提供
fonttools 字体运算与桌面外壳。

## 运行形态

| 形态 | 前端 | 后端 | 产物 |
|------|------|------|------|
| 1. 纯前端 | 静态托管，浏览器直接访问 | 无（相关菜单项置灰） | 静态目录 |
| 2. 桌面编辑器 | pywebview 窗口内加载本地服务 | 同进程 | 单文件可执行程序（`--runtime desktop`） |
| 3. 后端 + 浏览器 | 浏览器访问 `http://127.0.0.1:<port>` | 纯命令行后端（无 GUI 依赖） | 单文件可执行程序（`--runtime web`） |

形态 2、3 的后端为同一份代码，仅运行模式不同（`INKSHADER_RUNTIME` /
`--mode`）。形态 3 不创建任何窗口，也不链接 GUI 库：启动后在控制台打印访问
地址、唤起系统浏览器，`Ctrl+C`（或关闭控制台窗口）退出。

## 环境要求

- Python 3.11+
- 打包需 PyInstaller（`backend/pyproject.toml` 的 `build` extra）
- 运行探针需 Node.js 18+；依赖 `ws`（`npm install`），无需构建前端
- 只有 desktop 形态需要额外的系统包：pywebview 依赖 WebKitGTK（pip 无法安装）。
  纯命令行后端（形态 3）不链接任何 GUI 库，无需系统包。Debian/Ubuntu 示例：
  `libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 python3-gi`

## 安装与运行

```bash
python -m venv .venv
. .venv/bin/activate                 # Windows: .\.venv\Scripts\Activate.ps1
./dev.ps1 install                    # Windows；Linux/macOS 用 ./dev.sh install
./dev.ps1 run                        # 默认 web 模式（命令行后端 + 浏览器）
./dev.ps1 run --mode desktop         # desktop 模式（原生窗口编辑器）
./dev.ps1 run --no-browser --port 9000
```

`dev.ps1` / `dev.sh` 只做参数转接，实际命令是：

| 命令 | 等价于 |
|------|--------|
| `./dev.ps1 install` | `python -m pip install -e ./backend` |
| `./dev.ps1 install-dev` | `python -m pip install -e "./backend[build,test,lint]"` |
| `./dev.ps1 install-lock` | `python -m pip install -r backend/requirements.lock.txt` |
| `./dev.ps1 run [args]` | `python backend/run.py [args]` |
| `./dev.ps1 build [args]` | `python backend/build.py [args]` |
| `./dev.ps1 test` | `python -m pytest backend/tests` |
| `./dev.ps1 lint` | `python -m ruff check backend` |

依赖声明的唯一来源是 `backend/pyproject.toml`（运行依赖在 `[project.dependencies]`，
`build` / `test` / `lint` 分组在 extras）；已验证的精确版本见
`backend/requirements.lock.txt`。前端不使用 npm 构建；根目录 `package.json`
只声明探针与静态检查所需的开发依赖。

## 打包

```bash
./dev.ps1 build frontend             # 纯前端静态包 -> backend/dist/frontend/ + InkShader-frontend-<平台>.zip
./dev.ps1 build exe                  # 单文件可执行程序（默认 desktop）
./dev.ps1 build exe --runtime web    # 形态 3 的变体
./dev.ps1 build exe --no-upx         # 禁用 UPX 压缩（杀软误报时）
```

两个 exe 的差别只在构建期写入的 `MODE` 与是否携带 GUI 栈：`desktop` 为 windowed
且包含 pywebview；`web` 保留控制台，并在打包时排除 webview / pythonnet / pystray /
PIL 与各平台 GUI 绑定。

产物输出到 `backend/dist/`，zip 名中的平台为构建主机（`windows` / `linux` /
`macos`）。PyInstaller 不支持交叉编译：Windows 产物在 Windows 构建，Linux 产物在
Linux 构建。

## 目录结构

```
index.html  css/  js/  assets/   前端（仓库根即 web root，无构建步骤）
  js/vendor/                     第三方库本地副本（见 js/vendor/README.md）
  js/schemas/project_schema.json 项目文件格式定义
backend/                         后端
  src/inkshader/                 api/、desktop/、font_ops.py、config.py、server.py
  src/main.py                    进程入口（模式分发 / 持久化目录 / 端口分配）
  tests/                         单元测试（pytest）
  run.py                         开发运行入口
  build.py + packaging/web.spec  打包入口与 PyInstaller 配置
  pyproject.toml                 依赖与工具配置（唯一来源）
dev.ps1  dev.sh                  一键脚本（run / install / build / test / lint）
test/                            回归探针（probe_*.mjs）与 fixture（fixtures/）
```

## 测试

**前端探针**（`test/probe_*.mjs`）：CDP 驱动的端到端测试——起静态服务器与无头
浏览器，派发真实鼠标/键盘事件，再读回应用状态与画布像素做断言。

```bash
npm install                 # 只需一次：安装 ws
npm test                    # 串行跑全部回归套件，输出汇总
npm run test:all            # 连同历史 driver 一起跑
npm run test:list           # 列出会跑哪些文件
npm test -- --only rotation # 只跑文件名含 rotation 的
```

运行入口 `test/run_probes.mjs` 负责服务器、浏览器、端口与临时目录，探针自身
不再需要手工准备环境。串行执行是刻意的：多个探针共用同一 origin，并行会互相污染。
退出码非 0 表示有断言失败；没有断言汇总的（纯诊断）探针标记为 `warn`，不参与判定。

单个探针也可以直接运行：设 `PROBE_SRV` / `PROBE_PORT` 指向已启动的服务器与
浏览器调试端口即可。样例工程由 `test/probe_env.mjs` 解析（优先 `test/fixtures/`，
可用 `PROBE_EXAMPLE` 覆盖）。

**后端单元测试**（`backend/tests/`）：pytest。

```bash
./dev.ps1 test              # python -m pytest backend/tests
```

**静态检查**：`./dev.ps1 lint`（后端 ruff）、`npm run lint`（前端与探针 ESLint，
并附带 `npm run check:i18n`）。
格式化配置为 Prettier（`npm run format`），尚未对全量文件执行过。

**UI 文案表**：全部用户可见字符串定义在 `js/services/i18n.js` 的 `en` 表里，
标记（`data-i18n` / `data-i18n-tip` / `data-i18n-placeholder`）与 JS（`t('key', 'Fallback')`）
都按键引用它；查不到键时回退到调用方给的兜底文案，不会把键名写进界面。
`npm run check:i18n` 静态校验两个方向：引用而缺失（DANGLING）与定义而无人引用
（ORPHANED），后者是文案悄悄失效的典型原因。`test/probe_i18n_runtime.mjs` 在真实
浏览器里复核这套回退约定、以及表中取值确实覆盖到了 DOM。

## 文档

| 文件 | 内容 |
|------|------|
| `SPECIFICATION.md` | 功能规约（架构、约束、不变量） |
| `CODEGUIDE.md` | 编码与文档规范 |
| `AGENTS.md` | 模块索引与仓库地图 |
| `BACKEND_RESEARCH.md` | 后端方案研究与依赖选型 |
| `ARCHITECTURE_DISCUSSION.md` | 前后端模式与文件存储方案讨论记录 |
| `js/vendor/README.md` | 第三方库清单与升级步骤 |
| `test/fixtures/README.md` | 探针输入 fixture 的来源 |

## 许可

见 `LICENSE`。`js/vendor/` 下第三方库的许可见 `js/vendor/README.md`。
