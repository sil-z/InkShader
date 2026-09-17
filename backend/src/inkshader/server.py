"""uvicorn 后台服务线程。

- 程序化启动 uvicorn（禁 reload/workers，打包产物兼容）
- 线程内运行，主线程留给窗口事件循环
- /api/health 就绪探测（窗口壳等待就绪后再开浏览器）
- 端口策略：优先复用上次使用的端口（保证 WebView2/浏览器 origin 稳定，
  localStorage/IndexedDB 按 origin 隔离，端口一变数据就“消失”）；
  上次端口被占用则退回默认 8123 起 +1 探测
"""
import logging
import socket
import threading
import time
import urllib.request
from typing import Optional

import uvicorn

from .api.app import _set_server
from .config import profile_dir

log = logging.getLogger("inkshader.server")

DEFAULT_PORT = 8123
PORT_TRIES = 20


def _last_port_file():
    return profile_dir() / "last_port"


def read_last_port() -> Optional[int]:
    """上次成功启动时使用的端口（origin 稳定的关键）。"""
    try:
        return int(_last_port_file().read_text().strip())
    except (OSError, ValueError):
        return None


def write_last_port(port: int) -> None:
    try:
        _last_port_file().write_text(str(port))
    except OSError:
        pass


def pick_port() -> int:
    """优先复用上次端口；否则 8123 起探测；再退回上次端口附近探测。"""
    last = read_last_port()
    if last is not None and _port_free(last):
        return last
    try:
        return pick_free_port(DEFAULT_PORT)
    except RuntimeError:
        if last is not None:
            return pick_free_port(last)
        raise


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_free_port(start: int = None, tries: int = PORT_TRIES) -> int:
    if start is None:
        start = DEFAULT_PORT
    for port in range(start, start + tries):
        if _port_free(port):
            return port
    raise RuntimeError(f"no free port in [{start}, {start + tries})")


class ServerThread:
    """在后台线程中运行 uvicorn 服务。"""

    def __init__(self, app, host: str = "127.0.0.1", port: Optional[int] = None):
        self.app = app
        self.host = host
        self.port = port or pick_port()
        self._server: Optional[uvicorn.Server] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> None:
        config = uvicorn.Config(self.app, host=self.host, port=self.port,
                                log_level="warning", access_log=False)
        self._server = uvicorn.Server(config)
        _set_server(self._server)
        self._thread = threading.Thread(target=self._server.run,
                                        name="inkshader-uvicorn", daemon=True)
        self._thread.start()
        write_last_port(self.port)
        log.info("server thread started on %s", self.url)

    def wait_ready(self, timeout: float = 15.0) -> bool:
        """轮询 /api/health 直至就绪或超时。"""
        deadline = time.monotonic() + timeout
        url = self.url + "/api/health"
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=1) as resp:
                    if resp.status == 200:
                        log.info("server ready at %s", self.url)
                        return True
            except Exception:
                pass
            time.sleep(0.1)
        log.error("server did not become ready within %.1fs", timeout)
        return False

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)