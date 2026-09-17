"""桌面模式（场景2）主窗口：pywebview 窗口直接承载完整前端编辑器。

与场景3（web：控制窗口 + 托盘 + 系统浏览器）不同，desktop 模式下：
- 窗口加载的是完整编辑器 URL（http://127.0.0.1:PORT/），而不是状态页
- 窗口可缩放/最大化，关闭（X）即退出程序（有未保存更改时弹原生警告）
- js_api 桥暴露：set_dirty / set_title / file_open / file_save / file_save_as /
  open_new_project / request_quit —— 供前端实现「直接保存到磁盘」「原生文件对话框」
  「新建项目开新窗口」「未保存关闭警告」等桌面能力

多窗口说明（pywebview 6.x 实测确认）：
- webview.start() 之后，从非主线程调用 webview.create_window() 会立即初始化并
  创建新窗口（winforms 后端非 master 分支等待主窗口出现后 Invoke 到 GUI 线程）。
- js_api 回调运行在 WebView2 的 GUI 线程，因此 open_new_project 必须再派发到
  后台线程调用 create_window，否则 guilib.create_window 内部 Invoke 会死锁。
"""
import ctypes
import logging
import sys
import threading
import time
from pathlib import Path

import webview

from .. import build_info


def _patch_webview2_disable_autofill() -> None:
    """在 pywebview 的 EdgeChromium 就绪回调里禁用 WebView2 自动填充。

    属性面板的数字/文本输入会被 WebView2 当成表单，弹出「saved info」
    自动填充提示。本应用没有需要保存的表单数据，直接在 WebView2 Settings
    层禁用（比逐个 input 加 autocomplete=off 更彻底）。属性是否存在取决于
    WebView2 Runtime 版本，因此逐个 try/except。
    """
    try:
        import webview.platforms.edgechromium as _ec

        _orig_ready = _ec.EdgeChrome.on_webview_ready

        def _ready_with_autofill_off(self, sender, args):
            _orig_ready(self, sender, args)
            try:
                if not args.IsSuccess:
                    return
                settings = sender.CoreWebView2.Settings
                for prop in ('IsGeneralAutofillEnabled', 'IsPasswordAutosaveDataEnabled'):
                    if hasattr(settings, prop):
                        try:
                            setattr(settings, prop, False)
                        except Exception as e:  # noqa: BLE001
                            log.debug("webview setting %s unavailable: %s", prop, e)
            except Exception as e:  # noqa: BLE001
                log.debug("disable autofill failed: %s", e)

        _ec.EdgeChrome.on_webview_ready = _ready_with_autofill_off
        log.info("WebView2 autofill disabled via on_webview_ready patch")
    except Exception as e:  # noqa: BLE001
        log.warning("could not patch WebView2 autofill: %s", e)

log = logging.getLogger("inkshader.editor_window")

# 与 css/style.css :root light 主题一致（避免白屏/闪色）
_THEME = {
    "bg": "#f8fafc",
    "panel": "#ffffff",
}

# 全部打开的编辑器窗口（含「新建项目」子窗口）——全局退出时必须逐一销毁，
# 否则 winforms 主线程会因残留窗口而不退出。
_INSTANCES: list = []
_INSTANCES_LOCK = threading.Lock()


def _register(win: "EditorWindow") -> None:
    with _INSTANCES_LOCK:
        _INSTANCES.append(win)


def _unregister(win: "EditorWindow") -> None:
    with _INSTANCES_LOCK:
        if win in _INSTANCES:
            _INSTANCES.remove(win)


def quit_all_windows() -> None:
    """销毁全部编辑器窗口（退出统一入口）。幂等。"""
    with _INSTANCES_LOCK:
        wins = list(_INSTANCES)
    for w in wins:
        try:
            w.quit()
        except Exception:  # noqa: BLE001
            log.exception("quit window failed")


def active_window_count() -> int:
    with _INSTANCES_LOCK:
        return len(_INSTANCES)


def open_new_editor_window() -> None:
    """新建编辑器窗口（统一入口，js_api 与 /api/open_new_window 共用）。

    以当前已注册窗口为模板（url / storage_path / on_quit_request 与主窗口一致），
    从后台线程创建窗口——pywebview 6.x 实测支持 start() 后从非主线程创建。
    """
    with _INSTANCES_LOCK:
        template = _INSTANCES[0] if _INSTANCES else None
    if template is None:
        log.warning("open_new_editor_window: no running editor window")
        return
    threading.Thread(
        target=_spawn_window,
        args=(template.url, template.storage_path, template.on_quit_request),
        daemon=True, name="open-new-editor-window",
    ).start()


def _spawn_window(url: str, storage_path, on_quit_request) -> None:
    try:
        EditorWindow(url, on_quit_request=on_quit_request, storage_path=storage_path)
        log.info("new editor window created")
    except Exception as e:  # noqa: BLE001
        log.exception("failed to create new window")
        _message_box(f"Could not create the new project window:\n\n{e}",
                     build_info.APP_NAME, 0x10)

# MessageBoxW 返回值
_IDYES = 6
_IDNO = 7
_IDCANCEL = 2
_IDOK = 1


def _message_box(text: str, title: str, buttons: int, owner=None) -> int:
    """原生模态消息框：所有平台行为一致，弹出期间**阻塞属主窗口**。

    - Windows：MessageBoxW（owner 为 HWND int）
    - Linux：  GTK MessageDialog（pywebview GTK/webkit2gtk 后端）或
               Qt QMessageBox（pywebview Qt 后端）
    - macOS：  AppKit NSAlert.runModal()（pywebview Cocoa 后端）

    owner：Windows 传 HWND(int)，其他平台传 native 窗口对象；None 也可。
    属主窗口被禁用后，警告框打开期间点击主窗口 X 不会再次触发关闭
    （owner 缺失时主窗口不被禁用，用户可反复点 X 嵌套弹出无数警告框）。
    没有任何可用 GUI 工具包时才退化为「不保存退出」（仅极端环境）。
    """
    if sys.platform == "win32":
        try:
            user32 = ctypes.windll.user32
            MessageBoxW = user32.MessageBoxW
            # HWND 是指针大小：必须显式声明 argtypes，否则 ctypes 按 c_int
            # 转换，64 位下句柄被截断（与 main.py OpenProcess 同一坑）
            MessageBoxW.argtypes = [
                ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
            MessageBoxW.restype = ctypes.c_int
            hwnd = int(owner) if owner else None
            return MessageBoxW(hwnd, text, title, buttons)
        except Exception as e:  # noqa: BLE001
            log.warning("MessageBoxW failed: %s", e)
            return _IDNO
    # ---- 非 Windows：按可用工具包选原生模态对话框（与 Windows 行为一致）----
    try:
        return _gtk_message_box(text, title, buttons, owner)
    except ImportError:
        pass
    try:
        return _qt_message_box(text, title, buttons, owner)
    except ImportError:
        pass
    try:
        return _appkit_message_box(text, title, buttons, owner)
    except ImportError:
        pass
    log.warning("no native GUI toolkit available for message box; "
                "falling back to 'discard changes'")
    return _IDNO


def _gtk_message_box(text: str, title: str, buttons: int, owner=None) -> int:
    """GTK 模态消息框（Linux webkit2gtk 后端）。run() 阻塞 GUI 线程，
    MODAL + 父窗口 = 主窗口被禁用，与 pywebview 自身确认框同一模式。"""
    from gi.repository import Gtk  # noqa: PLC0415
    parent = owner if isinstance(owner, Gtk.Window) else None
    dialog = Gtk.MessageDialog(
        parent=parent,
        flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        type=Gtk.MessageType.QUESTION,
        text=title,
        message_format=text,
        buttons=Gtk.ButtonsType.NONE,
    )
    try:
        if buttons & 0x03 == 0x03:  # MB_YESNOCANCEL
            dialog.add_buttons(
                "Save", Gtk.ResponseType.YES,
                "Don't Save", Gtk.ResponseType.NO,
                "Cancel", Gtk.ResponseType.CANCEL)
        elif buttons & 0x04:  # MB_YESNO
            dialog.add_buttons(
                "Save", Gtk.ResponseType.YES,
                "Don't Save", Gtk.ResponseType.NO)
        else:
            dialog.add_button("OK", Gtk.ResponseType.OK)
        response = dialog.run()
        if response == Gtk.ResponseType.YES:
            return _IDYES
        if response == Gtk.ResponseType.NO:
            return _IDNO
        if response == Gtk.ResponseType.OK:
            return _IDOK
        return _IDCANCEL
    finally:
        dialog.destroy()


def _qt_message_box(text: str, title: str, buttons: int, owner=None) -> int:
    """Qt 模态消息框（Linux Qt/pywebview[qt] 后端）。"""
    for mod_name in ("PySide6", "PyQt6", "PySide2", "PyQt5"):
        try:
            QtWidgets = __import__(
                f"{mod_name}.QtWidgets", fromlist=["QMessageBox"])
            QMB = QtWidgets.QMessageBox
            break
        except ImportError:
            continue
    else:
        raise ImportError("no Qt binding available")
    box = QMB()
    try:
        if owner is not None:
            box.setParent(owner)  # 模态挂到主窗口，阻塞主窗口
    except Exception:  # noqa: BLE001
        pass
    box.setWindowTitle(title)
    box.setText(text)
    box.setIcon(QMB.Icon.Warning)
    yes = no = cancel = ok = None
    if buttons & 0x03 == 0x03:
        yes = box.addButton("Save", QMB.ButtonRole.YesRole)
        no = box.addButton("Don't Save", QMB.ButtonRole.NoRole)
        cancel = box.addButton("Cancel", QMB.ButtonRole.RejectRole)
    elif buttons & 0x04:
        yes = box.addButton("Save", QMB.ButtonRole.YesRole)
        no = box.addButton("Don't Save", QMB.ButtonRole.NoRole)
    else:
        ok = box.addButton("OK", QMB.ButtonRole.AcceptRole)
    # PyQt5 只有 exec_()，PyQt6/PySide6 只有 exec()：两者兼容调用
    exec_fn = getattr(box, "exec", None) or getattr(box, "exec_", None)
    if exec_fn is None:
        raise ImportError("QMessageBox has neither exec() nor exec_()")
    exec_fn()
    clicked = box.clickedButton()
    if clicked is yes:
        return _IDYES
    if clicked is no:
        return _IDNO
    if clicked is ok:
        return _IDOK
    return _IDCANCEL


def _appkit_message_box(text: str, title: str, buttons: int, owner=None) -> int:
    """macOS 模态消息框（pywebview Cocoa 后端；runModal 阻塞整个应用）。"""
    from AppKit import NSAlert  # noqa: PLC0415
    alert = NSAlert.alloc().init()
    alert.setMessageText_(title)
    alert.setInformativeText_(text)
    if buttons & 0x03 == 0x03:
        alert.addButtonWithTitle_("Save")
        alert.addButtonWithTitle_("Don't Save")
        alert.addButtonWithTitle_("Cancel")
    elif buttons & 0x04:
        alert.addButtonWithTitle_("Save")
        alert.addButtonWithTitle_("Don't Save")
    else:
        alert.addButtonWithTitle_("OK")
    response = alert.runModal()
    first = getattr(NSAlert, "NSAlertFirstButtonReturn", 1000)
    second = getattr(NSAlert, "NSAlertSecondButtonReturn", 1001)
    if buttons & 0x03 == 0x03 or buttons & 0x04:
        if response == first:
            return _IDYES
        if response == second:
            return _IDNO
        return _IDCANCEL
    return _IDOK


def _save_dialog_filter():
    return ("JSON project (*.json)", "All files (*.*)")


class _EditorApi:
    """pywebview js_api：前端 -> Python 桥（回调运行于 GUI 线程，原生对话框安全）。"""

    def __init__(self, owner: "EditorWindow"):
        self._owner = owner

    # ---- 未保存状态 / 窗口标题 ----
    def set_dirty(self, dirty: bool) -> None:
        self._owner._dirty = bool(dirty)

    def set_title(self, title: str) -> None:
        self._owner.set_title(str(title))

    # ---- 文件操作（原生对话框）----
    def file_open(self):
        """打开对话框 -> 返回 {path, content}；取消/失败返回 None。"""
        return self._owner.file_open()

    def file_save(self, path: str, content: str) -> bool:
        """直接写回指定路径。"""
        return self._owner.file_save(path, content)

    def file_save_as(self, content: str, suggested_name: str = "project.json"):
        """另存为对话框 -> 写入 -> 返回 {ok, path}；取消返回 None。"""
        return self._owner.file_save_as(content, suggested_name)

    def file_save_binary(self, base64_content: str, suggested_name: str = "export.bin"):
        """另存二进制文件（OTF/TTF 导出）。返回 {ok} / {cancelled} / None。"""
        return self._owner.file_save_binary(base64_content, suggested_name)

    # ---- 新建项目：开新窗口 ----
    def open_new_project(self) -> None:
        self._owner.open_new_project()

    # ---- F11 全屏切换（前端快捷键触发）----
    def toggle_fullscreen(self) -> None:
        self._owner.toggle_fullscreen()

    # ---- 退出 ----
    def request_quit(self) -> None:
        self._owner.request_quit()


class EditorWindow:
    """桌面模式主窗口。可创建多个实例（新建项目时开新窗口）。

    storage_path：WebView2 持久 profile 目录。pywebview 默认 private_mode=True
    用临时目录，localStorage/IndexedDB（页面设置、视图状态、dock 布局等）重启即
    丢；传入固定目录 + private_mode=False 后这些设置才真正落盘（见 run()）。
    """

    def __init__(self, url: str, on_quit_request=None,
                 title: str = None, width: int = 1280, height: int = 800,
                 min_size=(900, 600), storage_path=None):
        self.url = url
        self.on_quit_request = on_quit_request or (lambda: None)
        self.storage_path = storage_path
        self._quitting = False
        self._dirty = False
        # 关闭警告框已打开标志：防御性防止关闭事件重入时嵌套弹出多个警告
        self._close_prompt_open = False
        self._api = _EditorApi(self)
        self.destroyed = threading.Event()
        # 禁用 WebView2 自动填充（属性面板「saved info」弹窗根治）
        _patch_webview2_disable_autofill()

        self.window = webview.create_window(
            title=title or f"{build_info.APP_NAME}",
            url=url,
            width=width,
            height=height,
            min_size=min_size,
            resizable=True,
            background_color=_THEME["bg"],
            text_select=True,
            js_api=self._api,
        )
        self.window.events.closing += self._on_closing
        self.window.events.closed += self._on_closed
        _register(self)

    # ---- pywebview 事件（GUI 线程回调）----
    def _owner_native(self):
        """属主窗口句柄/对象（供 _message_box 作模态属主）。

        Windows：pywebview 的 native 是 WinForms Form，返回 HWND(int)；
        其他平台：直接返回 native 窗口对象（GTK GtkWindow / Qt 窗口 /
        AppKit NSWindow），供各平台原生对话框作 parent。"""
        try:
            native = getattr(self.window, "native", None)
            if native is None:
                return None
            if sys.platform == "win32":
                handle = getattr(native, "Handle", None)
                return handle.ToInt64() if handle else None
            return native
        except Exception:  # noqa: BLE001
            return None

    def _on_closing(self):
        """关闭拦截：有未保存更改时弹原生警告。

        返回 None = 允许关闭；返回 False = 取消关闭。
        """
        if self._quitting:
            return None
        if not self._dirty:
            return None
        if self._close_prompt_open:
            # 警告框已打开时再次触发关闭：一律取消本次请求。
            # （owner 化后主窗口已被禁用、正常不会走到，纯防御）
            return False
        log.info("close requested with unsaved changes -> warning")
        self._close_prompt_open = True
        try:
            result = _message_box(
                "This project has unsaved changes. Quit anyway?\n\n"
                "Yes: save the changes, then quit\n"
                "No: quit without saving\n"
                "Cancel: stay in the editor",
                f"{build_info.APP_NAME} - Unsaved Changes",
                0x03,  # MB_YESNOCANCEL
                owner=self._owner_native(),
            )
        finally:
            self._close_prompt_open = False
        if result == _IDCANCEL:
            return False
        if result == _IDYES:
            # 取消关闭 -> 让前端执行保存流程，保存成功后再发起退出
            threading.Thread(target=self._save_then_quit, daemon=True).start()
            return False
        # IDNO：不保存，直接退出
        return None

    def _save_then_quit(self) -> None:
        """关闭警告选「保存并退出」：通知前端保存，成功后由前端调用 request_quit。"""
        time.sleep(0.15)  # 等 FormClosing 返回，避免与关闭流程竞争
        try:
            self.window.evaluate_js(
                "window.__inkshader_save_and_quit ? window.__inkshader_save_and_quit() : null"
            )
        except Exception as e:  # noqa: BLE001
            log.warning("save-then-quit evaluate_js failed: %s", e)

    def _on_closed(self) -> None:
        self.destroyed.set()
        _unregister(self)

    # ---- js_api 实现 ----
    def set_title(self, title: str) -> None:
        try:
            self.window.title = title
        except Exception as e:  # noqa: BLE001
            log.warning("set_title failed: %s", e)

    def toggle_fullscreen(self) -> None:
        """F11 全屏切换。pywebview 的 toggle_fullscreen 线程安全
        （内部投递到 GUI 线程），跨平台可用（WinForms/GTK/Qt/Cocoa）。"""
        try:
            self.window.toggle_fullscreen()
        except Exception as e:  # noqa: BLE001
            log.warning("toggle_fullscreen failed: %s", e)

    def file_open(self):
        path = None
        try:
            picked = self.window.create_file_dialog(
                webview.FileDialog.OPEN,
                file_types=_save_dialog_filter(),
            )
            if picked:
                path = picked[0] if isinstance(picked, (tuple, list)) else picked
        except Exception as e:  # noqa: BLE001
            log.exception("open dialog failed")
            _message_box(f"Could not open the file dialog:\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return None
        if not path:
            return None
        try:
            content = Path(path).read_text(encoding="utf-8-sig")
        except Exception as e:  # noqa: BLE001
            log.exception("read %s failed", path)
            _message_box(f"Could not read the file:\n{path}\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return None
        return {"path": str(path), "content": content}

    def file_save(self, path: str, content: str) -> bool:
        if not path or not content:
            return False
        try:
            Path(path).write_text(content, encoding="utf-8")
            log.info("saved project to %s", path)
            return True
        except Exception as e:  # noqa: BLE001
            log.exception("save to %s failed", path)
            _message_box(f"Save failed:\n{path}\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return False

    def file_save_as(self, content: str, suggested_name: str = "project.json"):
        path = None
        try:
            picked = self.window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=suggested_name or "project.json",
                file_types=_save_dialog_filter(),
            )
            if picked:
                path = picked[0] if isinstance(picked, (tuple, list)) else picked
        except Exception as e:  # noqa: BLE001
            log.exception("save-as dialog failed")
            _message_box(f"Could not open the save-as dialog:\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return None
        if not path:
            return None
        if self.file_save(path, content):
            return {"ok": True, "path": str(path)}
        return None

    def file_save_binary(self, base64_content: str, suggested_name: str = "export.bin"):
        """另存二进制文件（OTF/TTF 导出）：base64 经桥传输，原生另存对话框。

        返回 {"ok": True} 或 {"cancelled": True}；失败时弹窗并返回 None。
        """
        import base64 as _b64
        path = None
        try:
            picked = self.window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=suggested_name or "export.bin",
                file_types=_save_dialog_filter(),
            )
            if picked:
                path = picked[0] if isinstance(picked, (tuple, list)) else picked
        except Exception as e:  # noqa: BLE001
            log.exception("binary save dialog failed")
            _message_box(f"Could not open the save-as dialog:\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return None
        if not path:
            return {"cancelled": True}
        try:
            data = _b64.b64decode(base64_content)
            Path(path).write_bytes(data)
            log.info("saved binary to %s", path)
            return {"ok": True, "path": str(path)}
        except Exception as e:  # noqa: BLE001
            log.exception("binary save to %s failed", path)
            _message_box(f"Save failed:\n{path}\n\n{e}",
                         build_info.APP_NAME, 0x10)
            return None

    def open_new_project(self) -> None:
        """新建项目：从后台线程创建新窗口（GUI 线程直接调用会死锁）。"""
        open_new_editor_window()

    def request_quit(self) -> None:
        """前端「保存并退出」成功后调用；幂等。"""
        if self._quitting:
            return
        self._quitting = True
        self.on_quit_request()

    def quit(self) -> None:
        """程序退出路径：销毁窗口。必须在 request_quit()（置位）之后调用。"""
        self._quitting = True
        self.destroyed.set()
        try:
            self.window.destroy()
        except Exception as e:  # noqa: BLE001
            log.warning("destroy failed: %s", e)

    def run(self) -> None:
        """阻塞直到窗口被销毁（主线程调用一次）。

        private_mode=False + storage_path：让 WebView2 使用固定 UserDataFolder，
        localStorage/IndexedDB 持久化（桌面模式的页面设置保存接口因此有效）。
        未提供 storage_path 时退回 pywebview 默认（临时目录）。
        """
        if self.storage_path:
            webview.start(private_mode=False, storage_path=self.storage_path)
        else:
            webview.start()