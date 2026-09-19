// js/app/app_mode.js
//
// 运行时模式检测：
//   desktop —— pywebview 窗口（场景2，单 exe 原生窗口编辑器）。前端运行在
//              WebView2 中，window.pywebview.api 由 pywebview 注入。
//   browser —— 浏览器（场景1 纯前端静态部署 / 场景3 后端窗口+系统浏览器）。
//
// 注意：window.pywebview 是页面加载完成后由 pywebview 注入的（inject_pywebview
// 在 NavigationCompleted 之后异步执行），模块求值时刻可能尚未存在，因此：
//   - isDesktop() 每次调用实时探测（菜单/快捷键等交互时必然已注入）
//   - isDesktopAsync() 供启动期决策（如 restoreState 是否恢复缓存），监听
//     'pywebviewready' 事件，带超时兜底（浏览器模式 1500ms 内必然 resolve false）

const _g = typeof window !== "undefined" ? window : null;

function _hasBridge() {
    return !!( _g && _g.pywebview && _g.pywebview.api );
}

export function isDesktop() {
    return _hasBridge();
}

export function desktopApi() {
    return _hasBridge() ? _g.pywebview.api : null;
}

/**
 * Open a URL outside the app. Inside the desktop shell the bridge hands it to the OS
 * (the link must not replace the editor), while a browser opens a new tab.
 */
export function openExternalUrl(url) {
    const api = desktopApi();
    if (api && typeof api.open_external === "function") {
        api.open_external(url);
        return;
    }
    if (_g) _g.open(url, "_blank", "noopener");
}

let _resolved = null;
let _desktopPromise = null;

export function isDesktopAsync() {
    if (_desktopPromise) return _desktopPromise;
    if (_hasBridge()) {
        _resolved = true;
        _desktopPromise = Promise.resolve(true);
        return _desktopPromise;
    }
    if (!_g) {
        _desktopPromise = Promise.resolve(false);
        return _desktopPromise;
    }
    _desktopPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            _resolved = v;
            resolve(v);
        };
        _g.addEventListener("pywebviewready", () => finish(_hasBridge()), { once: true });
        // 浏览器模式没有 pywebviewready 事件，超时后按浏览器处理
        setTimeout(() => finish(_hasBridge()), 1500);
    });
    return _desktopPromise;
}

_g && (_g.__APP_MODE = isDesktop() ? "desktop" : "browser");