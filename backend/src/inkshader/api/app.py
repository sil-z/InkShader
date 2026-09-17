"""InkShader FastAPI 应用工厂。

- /api/health   健康探测（托盘壳就绪判定、前端能力协商）
- /api/meta     能力协商（模式 / 版本 / 特性清单）
- /api/shutdown 优雅退出（供启动器/脚本调用）
- /api/new_project_number  新建项目编号（桌面多窗口唯一命名，Inkscape 式）
- /api/open_new_window     第二个实例的「新建窗口」转发入口
- /api/pending_import      窗口间文件交接（打开/导入到新窗口时的临时文件）
- 静态托管前端（index.html / css / js / assets）
"""
import json
import logging
import threading
import webbrowser
from pathlib import Path

from fastapi import Body, FastAPI
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .. import build_info, font_ops
from ..config import frontend_dir, log_dir, profile_dir

log = logging.getLogger("inkshader.api")

# 新建项目编号：进程内计数（单实例 + 二次启动转发 => 同一进程只有一个服务器，
# 编号对所有窗口唯一；应用重启后重置，与 Inkscape 的 Untitled-N 行为一致）
_new_project_counter = 0
_new_project_lock = threading.Lock()

_pending_lock = threading.Lock()


def _run_shutdown_hook(hook) -> None:
    try:
        hook()
    except Exception as e:  # noqa: BLE001
        log.warning("shutdown hook failed: %s", e)

_FALLBACK_FEATURES = {
    "export": True,          # fonttools 导出（OTF/TTF）
    "correctDirection": True,
    "removeOverlap": True,
    "fea": False,
    "serverFileStorage": False,
}

# 由 server.py 在启动时注入，供 /api/shutdown 触发优雅退出
_current_server = None

# 进程级退出钩子，由 main.py 按模式注入：web = 置停机事件，desktop = 销毁全部窗口。
# 没有它，/api/shutdown 只能停掉 uvicorn，进程会继续挂着（没有窗口也没有服务）。
_shutdown_hook = None


def _set_server(server):
    global _current_server
    _current_server = server


def _set_shutdown_hook(fn):
    global _shutdown_hook
    _shutdown_hook = fn


def create_app() -> FastAPI:
    app = FastAPI(title=f"{build_info.APP_NAME} Backend", version=build_info.VERSION,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "app": build_info.APP_NAME, "version": build_info.VERSION}

    @app.get("/api/meta")
    async def meta():
        return {
            **build_info.as_dict(),
            "features": _FALLBACK_FEATURES,
        }

    # ---- 前端错误上报（error.log）----
    # 前端破坏不变量时（例如 smart expand 布尔合并失败、缓存为空）必须“可见 +
    # 可追查”：可见由前端原生弹窗负责，可追查落在这里 —— 追加写
    # <log_dir>/error.log（打包后用户数据目录，开发时 backend/logs）。
    # 桌面两种模式（场景2 pywebview / 场景3 后端窗口+浏览器）前端都由本地
    # FastAPI 托管，所以相对路径 /api/log_error 都能命中；纯前端静态部署没有
    # 后端，前端会退回 localStorage 环形缓冲，不丢记录。
    _error_log_lock = threading.Lock()

    @app.post("/api/log_error")
    async def log_error(payload: dict = Body(...)):
        try:
            entry = dict(payload or {})
            # 每条故障都带上“是哪个构建在处理它”（后端构建期信息）。排查时
            # 第一件事就是确认现象来自哪个 exe：旧构建的现象在新代码里往往
            # 早已修掉，没有这个字段就会拿旧现象去查新源码。
            entry["build"] = build_info.as_dict()
            path = log_dir() / "error.log"
            line = json.dumps(entry, ensure_ascii=False)
            with _error_log_lock:
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            log.error("frontend error: %s", line[:2000])
        except Exception as e:  # noqa: BLE001
            # 写日志失败绝不能反向影响前端（也不能再报错，否则递归）
            log.warning("log_error failed: %s", e)
            return JSONResponse({"ok": False}, status_code=500)
        return {"ok": True}

    # ---- 字体操作（correct direction / remove overlap / OTF/TTF 导出）----
    # correct_direction / remove_overlap 作用于「选中的路径列表」：前端把选中
    # 路径的顶点 JSON 发来，后端只处理这些路径并逐条返回结果，绝不做整文件
    # 往返。导出以 UFO 为输入（ufo2ft 编译）。

    @app.post("/api/font/paths/correct_direction")
    async def api_paths_correct_direction(payload: dict = Body(...)):
        try:
            paths = payload.get("paths") or []
            result = font_ops.correct_direction_paths(paths)
        except Exception as e:  # noqa: BLE001
            log.warning("paths correct_direction failed: %s", e)
            return JSONResponse({"error": str(e)}, status_code=400)
        return JSONResponse({"paths": result})

    @app.post("/api/font/paths/remove_overlap")
    async def api_paths_remove_overlap(payload: dict = Body(...)):
        try:
            paths = payload.get("paths") or []
            result = font_ops.remove_overlap_paths(paths)
        except Exception as e:  # noqa: BLE001
            log.warning("paths remove_overlap failed: %s", e)
            return JSONResponse({"error": str(e)}, status_code=400)
        return JSONResponse({"paths": result})

    @app.post("/api/font/export")
    async def api_font_export(fmt: str, payload: bytes = Body(...)):
        if fmt not in ("otf", "ttf"):
            return JSONResponse({"error": f"unsupported format: {fmt}"}, status_code=400)
        try:
            font = font_ops.load_ufo_zip(payload)
            data = font_ops.export_font(font, fmt)
        except Exception as e:  # noqa: BLE001
            log.warning("export %s failed: %s", fmt, e)
            return JSONResponse({"error": str(e)}, status_code=400)
        return Response(content=data, media_type="application/octet-stream")

    @app.post("/api/shutdown")
    async def shutdown():
        """Request a graceful shutdown of the local server.

        Launchers and scripts can call this instead of signalling the process;
        the console (web) build normally just uses Ctrl+C.
        """
        log.info("/api/shutdown called")
        srv = _current_server
        if srv is not None:
            srv.should_exit = True
        hook = _shutdown_hook
        if hook is not None:
            # 必须离开事件循环线程：desktop 的钩子会 join uvicorn 线程并销毁
            # 窗口，在请求里同步执行会自己 join 自己（RuntimeError）
            threading.Thread(target=_run_shutdown_hook, args=(hook,),
                             daemon=True, name="shutdown-hook").start()
        return {"status": "shutting down"}

    @app.post("/api/new_project_number")
    async def new_project_number():
        """返回下一个新建项目编号（"New Font N" 的 N）。所有窗口共用一个
        进程内计数器，保证多窗口/多标签的新项目名互不冲突。"""
        global _new_project_counter
        with _new_project_lock:
            _new_project_counter += 1
            return {"number": _new_project_counter}

    @app.post("/api/open_new_window")
    async def open_new_window():
        """第二个实例的转发入口（Inkscape 式单实例）：请求已运行实例新建一个
        编辑器窗口。desktop 模式创建新 pywebview 窗口；web 模式唤起浏览器。"""
        if build_info.MODE == "desktop":
            try:
                from ..desktop.editor_window import open_new_editor_window
                open_new_editor_window()
                return {"status": "opened"}
            except Exception as e:  # noqa: BLE001
                log.warning("open_new_window failed: %s", e)
                return JSONResponse({"status": "error"}, status_code=500)
        from ..server import read_last_port
        port = read_last_port() or 8123
        webbrowser.open(f"http://127.0.0.1:{port}")
        return {"status": "opened"}

    # ---- 窗口间文件交接（打开/导入需要新窗口时，把文件内容暂存到服务端）----

    def _pending_meta_file() -> Path:
        return profile_dir() / "pending_import.json"

    def _pending_data_file() -> Path:
        return profile_dir() / "pending_import.bin"

    @app.post("/api/pending_import")
    async def pending_import(import_type: str, name: str = "", path: str = "",
                             payload: bytes = Body(...)):
        """暂存待导入内容：新窗口启动时经 /api/pending_import 取回。"""
        with _pending_lock:
            _pending_data_file().write_bytes(payload)
            _pending_meta_file().write_text(json.dumps({
                "type": import_type, "name": name, "path": path,
            }, ensure_ascii=False), encoding="utf-8")
        return {"ok": True}

    @app.get("/api/pending_import")
    async def get_pending_import():
        meta = _pending_meta_file()
        if not meta.exists():
            return {"exists": False}
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            return {"exists": True, **data}
        except (OSError, ValueError):
            return {"exists": False}

    @app.get("/api/pending_import/data")
    async def get_pending_import_data():
        data = _pending_data_file()
        if not data.exists():
            return JSONResponse({"error": "no pending import"}, status_code=404)
        return Response(content=data.read_bytes(), media_type="application/octet-stream")

    @app.delete("/api/pending_import")
    async def clear_pending_import():
        with _pending_lock:
            for f in (_pending_meta_file(), _pending_data_file()):
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass
        return {"ok": True}

    # 静态托管：必须最后 mount（路由优先级在 mount 之上）
    # 前端是“随应用整体更新”的代码，不是可长期缓存的内容。不带缓存头时
    # WebView2/浏览器会按启发式缓存 ES 模块——应用更新后桌面窗口仍运行
    # 旧 JS（属性面板、渲染逻辑表现新旧混杂，且无法用刷新恢复）。
    # no-cache 强制每次协商校验（本地回环，开销可忽略），更新即生效。
    class _NoCacheStaticFiles(StaticFiles):
        def file_response(self, *args, **kwargs):
            resp = super().file_response(*args, **kwargs)
            resp.headers["Cache-Control"] = "no-cache"
            return resp

    fdir = frontend_dir()
    if (fdir / "index.html").exists():
        app.mount("/", _NoCacheStaticFiles(directory=str(fdir), html=True), name="frontend")
        log.info("frontend mounted from %s", fdir)
    else:
        log.warning("frontend index.html not found at %s", fdir)

        @app.get("/")
        async def no_frontend():
            return JSONResponse({"error": "frontend not bundled"}, status_code=404)

    return app