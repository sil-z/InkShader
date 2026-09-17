"""InkShader 路径与运行环境解析。

开发模式（python run.py / uvicorn 直接跑）与 PyInstaller 打包产物
（sys.frozen / sys._MEIPASS）统一从这里解析路径，业务代码不感知差异。
"""
import os
import sys
from pathlib import Path

# src/inkshader/config.py -> backend/ -> 项目根
_SRC_DIR = Path(__file__).resolve().parent.parent
_BACKEND_DIR = _SRC_DIR.parent
PROJECT_ROOT = _BACKEND_DIR.parent


def is_frozen() -> bool:
    """PyInstaller 打包后 sys.frozen 为 True。"""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """打包产物中的数据目录（--add-data 挂载点）；开发模式为项目根。"""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", PROJECT_ROOT))
    return PROJECT_ROOT


def frontend_dir() -> Path:
    """前端静态文件根目录（index.html 所在目录）。"""
    return bundle_dir()


def backend_src_dir() -> Path:
    """后端源码目录（模式分发、build_info 等）。"""
    if is_frozen():
        return bundle_dir()
    return _SRC_DIR


def _system() -> str:
    import platform
    return platform.system()


def _app_data_dir() -> Path:
    """打包后跨平台用户数据目录：
    Windows  %LOCALAPPDATA%/InkShader
    macOS    ~/Library/Application Support/InkShader
    Linux    $XDG_DATA_HOME/InkShader（缺省 ~/.local/share/InkShader）
    """
    home = Path.home()
    sysname = _system()
    if sysname == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", home)) / "InkShader"
    if sysname == "Darwin":
        return home / "Library" / "Application Support" / "InkShader"
    xdg_data = os.environ.get("XDG_DATA_HOME")
    if xdg_data:
        return Path(xdg_data) / "InkShader"
    return home / ".local" / "share" / "InkShader"


def _app_config_dir() -> Path:
    """打包后跨平台应用配置目录（预留给非数据类配置；macOS 惯例不区分
    数据/配置，与数据目录一致）：
    Windows  %APPDATA%/InkShader
    macOS    ~/Library/Application Support/InkShader
    Linux    $XDG_CONFIG_HOME/InkShader（缺省 ~/.config/InkShader）
    """
    home = Path.home()
    sysname = _system()
    if sysname == "Windows":
        return Path(os.environ.get("APPDATA", home)) / "InkShader"
    if sysname == "Darwin":
        return home / "Library" / "Application Support" / "InkShader"
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config:
        return Path(xdg_config) / "InkShader"
    return home / ".config" / "InkShader"


def profile_dir() -> Path:
    """用户数据目录（WebView2 profile、last_port、窗口交接文件等）。
    打包后按平台标准目录（Windows %LOCALAPPDATA%、macOS Application Support、
    Linux XDG 数据目录），开发模式 backend/.profile。必须落在磁盘固定位置——
    桌面模式 WebView2 的 localStorage/IndexedDB（页面设置、视图状态等）依赖它持久化。"""
    if is_frozen():
        base = _app_data_dir()
    else:
        base = _BACKEND_DIR / ".profile"
    base.mkdir(parents=True, exist_ok=True)
    return base


def config_dir() -> Path:
    """应用配置目录（预留给非数据类配置；当前尚无写入方）。开发模式与数据目录
    同目录（backend/.profile），打包后按平台配置目录（Linux ~/.config/InkShader 等）。"""
    if is_frozen():
        base = _app_config_dir()
    else:
        base = _BACKEND_DIR / ".profile"
    base.mkdir(parents=True, exist_ok=True)
    return base


def log_dir() -> Path:
    """日志目录：打包后放用户数据目录，开发模式放 backend/logs。"""
    if is_frozen():
        base = _app_data_dir()
    else:
        base = _BACKEND_DIR / "logs"
    base.mkdir(parents=True, exist_ok=True)
    return base