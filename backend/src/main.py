"""InkShader 入口：按构建模式分发。

web（场景3，默认）：
  纯命令行后端——只有本地 FastAPI（+ 静态托管前端），没有任何 GUI 依赖
  （不 import pywebview / pystray，构建时也不打包它们）。启动后打印访问地址、
  唤起系统浏览器打开编辑器，之后驻留到 Ctrl+C（或关闭控制台窗口）。

desktop（场景2）：
  本地 FastAPI + pywebview 窗口直接承载完整编辑器（可缩放/最大化）。
  窗口 X -> 有未保存更改时弹原生警告（保存/不保存/取消），否则直接退出。

共用流程：
1. 单实例锁（防双击开两个服务器）
2. 后台线程启动 uvicorn（127.0.0.1:8123 起，占用则 +1）
3. 等待 /api/health 就绪
4. 按 MODE 进入对应前端宿主：web = 系统浏览器；desktop = pywebview 窗口
5. 退出 -> 优雅停机
"""
import logging
import os
import signal
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from inkshader import build_info
from inkshader.api.app import create_app
from inkshader.config import log_dir, profile_dir
from inkshader.server import ServerThread, read_last_port

log = logging.getLogger("inkshader.main")

# 启动后自动打开浏览器（run.py --no-browser 可关闭，供开发调试）
OPEN_BROWSER = True

def _lock_file() -> Path:
    """单实例锁文件：用户数据目录（与 last_port 同处，按用户隔离）。

    不放在 exe 旁边：exe 可能位于只读目录（Program Files 等），锁会写不进去，
    单实例静默失效；也不放系统临时目录：/tmp 全局可写（跨用户互相干扰/伪造）、
    会被系统定期清理（进程还活着锁却没了）、有符号链接攻击面。
    用户数据目录必定可写、按用户隔离、不会被清理——是这类运行时状态的标准位置。
    仅当用户数据目录不可用时退回 exe 目录。"""
    try:
        return profile_dir() / "inkshader.lock"
    except Exception:  # noqa: BLE001
        return Path(sys.argv[0]).resolve().parent / "inkshader.lock"


def _setup_logging() -> None:
    log_file = log_dir() / "inkshader.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )
    log.info("log file: %s", log_file)


def _pid_alive(pid: int) -> bool:
    # Windows 上绝不能用 os.kill(pid, 0) 探测存活：非 CTRL 信号会走
    # TerminateProcess，sig=0 会直接**杀掉目标进程**（实测：打包后的子进程
    # 被 B 实例的锁检查当场杀死），同时抛 SystemError（"returned a result
    # with an exception set"），导致 _pid_alive 返回 False、误判"无实例"。
    # 改用 OpenProcess 纯探测：句柄非空即存活，不产生任何副作用。
    if sys.platform == "win32":
        try:
            import ctypes
            # PROCESS_QUERY_LIMITED_INFORMATION (0x1000)：最低权限的存活探测
            kernel32 = ctypes.windll.kernel32
            OpenProcess = kernel32.OpenProcess
            OpenProcess.restype = ctypes.c_void_p  # 64 位 HANDLE，防截断
            OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            h = OpenProcess(0x1000, False, pid)
            if not h:
                return False
            kernel32.CloseHandle(ctypes.c_void_p(h))
            return True
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:  # noqa: BLE001
        return False


def _acquire_single_instance() -> bool:
    """单实例锁：锁文件存在且 PID 存活 -> 已有实例在跑。"""
    try:
        lock = _lock_file()
        if lock.exists():
            pid = int(lock.read_text().strip())
            if _pid_alive(pid):
                return False
            lock.unlink(missing_ok=True)
        lock.write_text(str(os.getpid()))
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("single-instance lock failed (%s); continuing", e)
        return True


def _release_single_instance() -> None:
    try:
        _lock_file().unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def _forward_to_running_instance() -> bool:
    """二次启动转发（Inkscape 式单实例）：已有一个实例在运行时，第二个实例
    通过 HTTP 请求它新建一个编辑器窗口，然后自己退出。

    返回 True = 转发成功（本进程应静默退出）；False = 失败（退回旧行为）。
    """
    try:
        port = read_last_port()
        if port is None:
            return False
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/open_new_window", method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception as e:  # noqa: BLE001
        log.warning("forward to running instance failed: %s", e)
        return False


def _start_server() -> ServerThread:
    server = ServerThread(create_app())
    server.start()
    if not server.wait_ready(timeout=15):
        log.error("server failed to become ready; exiting")
        raise SystemExit(2)
    return server


def _run_desktop_mode() -> int:
    """场景2：pywebview 窗口 = 编辑器本体。关闭窗口即退出（未保存弹警告）。"""
    from inkshader.api.app import _set_shutdown_hook
    from inkshader.desktop.editor_window import EditorWindow, quit_all_windows

    server = _start_server()
    # 固定 WebView2 profile：桌面模式的 localStorage/IndexedDB（页面设置、
    # dock 布局、视图状态）持久化到用户数据目录，而不是 pywebview 默认临时目录
    webview_profile = profile_dir() / "webview"
    # 旧版 exe 无 no-cache 头时 WebView2 可能缓存了旧 ES 模块：升级后清一次
    _purge_webview_http_cache(webview_profile)

    def quit_all() -> None:
        """退出统一入口（任一窗口「退出」请求触发），幂等。"""
        log.info("quit requested (desktop)")
        server.stop()
        # 逐一销毁全部窗口（含新建项目的子窗口），否则 GUI 循环不会结束
        quit_all_windows()

    # /api/shutdown 与窗口关闭走同一条退出路径
    _set_shutdown_hook(quit_all)

    try:
        win = EditorWindow(url=server.url, on_quit_request=quit_all,
                           storage_path=str(webview_profile))
        # 阻塞：webview.start() 直到所有窗口关闭
        win.run()
        return 0
    finally:
        server.stop()
        _release_single_instance()


def _purge_webview_http_cache(profile_dir_path) -> None:
    """清理 WebView2 HTTP 缓存（保留 localStorage/IndexedDB）。

    背景：旧版本 exe 的静态服务不带 Cache-Control，WebView2 把 ES 模块按启发式
    缓存进 profile 的 HTTP 缓存目录。升级 exe 后旧 JS 仍被判定“新鲜”而不再回源
    ——应用更新后桌面窗口跑旧代码（且刷新无效）。服务端已改为 no-cache，但那只
    约束新缓存；这里在用新版启动时清一次旧缓存，之后 no-cache 头接管。

    实际布局（实测）：<profile>/EBWebView/Default/{Cache,Code Cache,...}。
    localStorage/IndexedDB 存放在 Default 同级的 Level-DB 文件中，不在下列
    清理范围内，页面设置/dock 布局不受影响。
    """
    import shutil
    profile = Path(profile_dir_path)
    candidates = [
        profile / "EBWebView" / "Default" / "Cache",
        profile / "EBWebView" / "Default" / "Code Cache",
        profile / "EBWebView" / "Default" / "Service Worker" / "CacheStorage",
        profile / "Data" / "Cache",          # 旧 pywebview 布局兜底
        profile / "Cache",                   # 平铺布局兜底
    ]
    removed = 0
    for p in candidates:
        if p.is_dir():
            try:
                shutil.rmtree(p)
                removed += 1
            except OSError:
                pass
    if removed:
        log.info("purged %d WebView2 cache folder(s) under %s", removed, profile)
    else:
        log.info("no WebView2 HTTP cache folders to purge under %s", profile)




def _run_web_mode() -> int:
    """场景3：纯命令行后端（编辑器在系统浏览器中，进程无任何 GUI）。

    为什么不再有控制窗口/托盘：这一版的目标是「后端只是一个本地服务」——
    去掉 pywebview/pystray 后，该 exe 不再需要 WebView2 运行时，也不再在
    系统托盘常驻，体积与依赖都随之下降。用户界面就是系统浏览器里的编辑器，
    命令行窗口本身提供地址、退出方式（Ctrl+C）与运行日志。
    """
    from inkshader.api.app import _set_shutdown_hook

    stop_event = threading.Event()
    server = _start_server()
    # /api/shutdown 是可脚本化的 Ctrl+C（launcher、服务管理器可调用）
    _set_shutdown_hook(stop_event.set)

    def _request_stop(_signum=None, _frame=None) -> None:
        """SIGTERM（`kill`、Linux 服务管理器、任务管理器结束进程）→ 优雅停机。"""
        stop_event.set()

    try:
        # SIGTERM 在 Windows 上不存在信号语义（只有 CTRL_CLOSE_EVENT 等），
        # 因此整段用 try 包起来，失败时退化为「只能 Ctrl+C」
        try:
            signal.signal(signal.SIGTERM, _request_stop)
        except (AttributeError, ValueError, OSError):
            log.debug("SIGTERM handler not installable on this platform")

        # 地址必须打在 stderr/stdout 上都可见：日志同时也写文件（见 _setup_logging）
        print()
        print(f"{build_info.APP_NAME} {build_info.VERSION} (web)")
        print(f"  local server : {server.url}")
        if OPEN_BROWSER:
            print("  editor       : opening in your default browser")
        else:
            print("  editor       : open the URL above in a browser")
        print("  stop         : press Ctrl+C")
        print()
        # stdout is block-buffered when redirected to a file/pipe; flush so the
        # address is visible immediately even when the output is captured.
        sys.stdout.flush()

        if OPEN_BROWSER:
            webbrowser.open(server.url)

        while not stop_event.is_set():
            stop_event.wait(0.25)
        log.info("stop requested (web)")
        return 0
    except KeyboardInterrupt:
        log.info("Ctrl+C (web)")
        print("\nshutting down ...")
        return 0
    finally:
        server.stop()
        _release_single_instance()


def main() -> int:
    _setup_logging()
    log.info("InkShader %s mode=%s", build_info.VERSION, build_info.MODE)

    if not _acquire_single_instance():
        log.warning("another InkShader instance is already running; "
                    "forwarding new-window request")
        print("InkShader is already running - opening a new editor window "
              "in your browser.")
        if _forward_to_running_instance():
            return 0
        log.warning("forward to running instance failed; exiting")
        print("Could not reach the running instance.")
        return 1

    if build_info.MODE == "desktop":
        # 高 DPI 感知必须在任何窗口创建前声明（否则系统按位图拉伸渲染模糊）。
        # 只在 desktop 分支导入：web 模式因此完全不触碰 webview，构建时可整体排除。
        from inkshader.desktop.dpi import enable_dpi_awareness
        enable_dpi_awareness()
        return _run_desktop_mode()
    return _run_web_mode()


if __name__ == "__main__":
    raise SystemExit(main())