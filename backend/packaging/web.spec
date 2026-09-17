# -*- mode: python ; coding: utf-8 -*-
"""InkShader 打包配置（单 spec 覆盖 desktop / web 两种运行时模式）。

产出：单文件可执行文件。前端静态文件（index.html/css/js/assets）以数据形式打入，
config.frontend_dir() 在 sys._MEIPASS 下解析。

运行时模式由环境变量 INKSHADER_RUNTIME 决定（backend/build.py 注入）：
  desktop -> InkShader-desktop(.exe)：pywebview 原生窗口编辑器（场景2），
             windowed（无控制台），携带 pywebview / pythonnet
  web     -> InkShader(.exe)：纯命令行本地后端 + 系统浏览器（场景3），
             带控制台，且排除整个 GUI 栈（不依赖 WebView2 运行时）

构建：python backend/build.py --runtime desktop|web（自动生成 build_info 覆盖 + 图标）
"""
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

RUNTIME = os.environ.get("INKSHADER_RUNTIME", "web")
IS_DESKTOP = RUNTIME == "desktop"
BINARY_NAME = "InkShader-desktop" if IS_DESKTOP else "InkShader"

# spec 所在目录 = backend/packaging（PyInstaller 的 SPEC 全局变量是 spec 文件路径，取 .parent）
SPEC_DIR = Path(SPEC).parent if "SPEC" in globals() else Path(__file__).parent
BACKEND_DIR = SPEC_DIR.parent
PROJECT_ROOT = BACKEND_DIR.parent
SRC_DIR = BACKEND_DIR / "src"

block_cipher = None

# ---- 前端静态文件 ----
datas = [
    (str(PROJECT_ROOT / "index.html"), "."),
    (str(PROJECT_ROOT / "css"), "css"),
    (str(PROJECT_ROOT / "js"), "js"),
    (str(PROJECT_ROOT / "assets"), "assets"),
]
# cffsubr 的 tx(.exe) 可执行文件是 importlib.resources 数据资源，ufo2ft OTF 编译的
# CFF 子例程化（SubroutinizePostProcessor）通过 subprocess 调用它；PyInstaller 静态
# 分析只收集 Python 模块，必须显式收集该二进制，否则打包版导出 OTF 时报
# [WinError 2] The system cannot find the file specified。
datas += collect_data_files("cffsubr")

# ---- 隐藏导入：uvicorn 子模块按需加载，PyInstaller 静态分析抓不到 ----
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "fastapi",
    "starlette",
]
if IS_DESKTOP:
    # pywebview 在运行期动态选择平台后端，静态分析抓不到；
    # pythonnet(clr) 的收集由 pyinstaller-hooks-contrib 的 hook-clr.py /
    # hook-webview.py 自动处理（stdhooks）。
    hiddenimports += [
        "webview",
        "webview.platforms.edgechromium",
        "clr",
        "pythonnet",
    ]

# ---- 排除项 ----
# desktop：tkinter（控制窗口已被 pywebview 取代）、pystray/PIL（托盘已移除，
# 现仅由构建脚本生成图标时使用，不进产物）。
excludes = ["tkinter", "unittest", "pystray", "PIL"]
if not IS_DESKTOP:
    # web（控制台后端）不创建任何窗口，因此整个 GUI 栈都不该进包：
    # webview/clr/pythonnet 是 pywebview+pythonnet；gi/objc/AppKit/PySide/PyQt
    # 是各平台 GUI 绑定；一并排除后该产物不再依赖 WebView2 运行时。
    excludes += [
        "webview", "clr", "pythonnet",
        "gi", "objc", "AppKit",
        "PySide6", "PyQt6", "PyQt5", "PySide2",
    ]

a = Analysis(
    [str(SRC_DIR / "main.py")],
    pathex=[str(SRC_DIR)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=BINARY_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # desktop：无控制台窗口（GUI 应用，关键）；
    # web：保留控制台——它就是这一版的「界面」（打印地址、退出提示、日志）。
    console=not IS_DESKTOP,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(BACKEND_DIR / "packaging" / "inkshader.ico") if (BACKEND_DIR / "packaging" / "inkshader.ico").exists() else None,
)