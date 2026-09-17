// js/services/error_log.js
//
// 显式错误上报通道。
//
// 约定：破坏不变量（例如 smart expand 的布尔合并失败、缓存为空）时必须
// “可见 + 可追查”，不允许静默兜底 —— 兜底会让渲染结果和 Expand Stroke 的
// 真实结果不一致，也会把缺陷藏起来。因此这类故障统一走这里：
//   1. console.error（开发/探针最先看到）
//   2. POST /api/log_error → 后端追加写 <log_dir>/error.log（场景2 pywebview、
//      场景3 后端窗口+浏览器都有本地 FastAPI，所以两种桌面模式都能落盘）
//   3. localStorage 环形缓冲 __ink_error_log（纯前端静态部署：没有后端可写，
//      错误仍然留在本机可查，不丢）
//   4. 弹出可复制的错误对话框（见下）
//
// 对话框：原生 alert 的内容无法选中复制，而故障报告需要原文（几何哈希、
// patch 路径等）。所有报错都走 showErrorDialog：标题 + 说明 + 一个只读
// textarea（内含完整文本与 JSON 诊断），可全选/复制，带“复制”按钮。
// installCopyableAlert() 把 window.alert 也接到同一个对话框，于是全项目
// 现存的 alert(...) 调用点（保存/导出/加载失败等）自动变成可复制 ——
// 不需要逐个改写调用点，也不会漏掉将来新增的调用点。
//
// 弹窗按 scope|message 去重：渲染循环里同一个故障会反复触发（每帧一次），
// 只弹一次；日志则每次都记（含次数累计）。options.alwaysShow=true 用于
// “每次都必须让人看见”的故障（例如历史栈损坏、已丢弃 history entry）。
//
// 对话框是纯 DOM，不依赖任何 UI 框架，也不受 body{pointer-events:none}
// 影响（overlay 自己声明 pointer-events:auto）。

const LS_KEY = "__ink_error_log";
const MAX_ENTRIES = 80;
const MAX_DIALOG_TEXT = 40000;
const _entries = [];
const _alertedKeys = new Set();
const _openDialogs = new Map();
let _loadedFromStorage = false;
let _alertInstalled = false;

// 运行环境指纹：这条故障是哪个构建在跑？
//
// 排查时第一步必须确认“现象来自哪个构建”：旧 exe/旧静态包里的现象，在新源码
// 里往往早已修掉，拿旧现象去查新代码只会白费功夫（本会话已经因此绕过一次）。
//   - server：托管本页面的本地后端（/api/meta → mode/version/gitSha/buildTime）。
//     两种桌面模式（场景2/3）都有它；纯前端静态部署拿不到，为 null。
//   - origin/href：页面自身的来源，用于区分静态包/不同端口。
const _env = {
    origin: typeof location !== "undefined" ? location.origin : null,
    href: typeof location !== "undefined" ? location.href : null,
    server: null
};
let _envPromise = null;

function _ensureServerMeta() {
    if (_envPromise) return _envPromise;
    if (typeof fetch !== "function") { _envPromise = Promise.resolve(null); return _envPromise; }
    _envPromise = fetch("/api/meta")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((meta) => {
            _env.server = meta || null;
            // 补写已经记录过的条目：故障常常发生在 meta 返回之前（启动阶段）
            if (meta) for (const e of _entries) if (!e.server) e.server = meta;
            return meta;
        });
    return _envPromise;
}
_ensureServerMeta();

// 暴露给探针/控制台排查
if (typeof globalThis !== "undefined") {
    globalThis.__inkErrorLog = _entries;
}

function _loadFromStorage() {
    if (_loadedFromStorage) return;
    _loadedFromStorage = true;
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) _entries.push(...parsed.slice(-MAX_ENTRIES));
    } catch (_) { /* 私有模式 / 损坏内容 — 忽略 */ }
}

function _persistToStorage() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(_entries.slice(-MAX_ENTRIES)));
    } catch (_) { /* 配额 / 私有模式 — 忽略；内存与后端仍然是记录 */ }
}

function _postToBackend(entry) {
    try {
        // 相对 URL：三种模式下前端都由本地服务托管（或静态部署时直接失败）
        fetch("/api/log_error", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry)
        }).catch(() => { /* 纯前端模式：没有后端，静默失败 */ });
    } catch (_) { /* 无 fetch — 忽略 */ }
}

function _safeStringify(value) {
    if (value === undefined) return "";
    try {
        return JSON.stringify(value, null, 2);
    } catch (_) {
        try { return String(value); } catch (_) { return "[unserializable]"; }
    }
}

/**
 * 可复制的错误对话框。
 *
 * @param {string} title 标题行（一般写故障位置/来源）
 * @param {string} body 正文（完整故障说明）
 * @param {object|null} detail 诊断数据（会以 JSON 追加在正文之后）
 * @param {object} [options]
 * @param {string|null} [options.key] 去重/复用键：同一键的对话框只保留一个，
 *        重复触发时更新内容并追加“已发生 N 次”，不会叠一屏窗口。
 * @param {boolean} [options.silent] 只登记不显示（探针/后台场景）。
 * @returns {HTMLElement|null} 对话框根元素
 */
export function showErrorDialog(title, body, detail = null, options = {}) {
    const opts = options || {};
    if (typeof document === "undefined") return null;
    if (opts.silent) return null;

    const detailText = detail == null ? "" : `\n\n${_safeStringify(detail)}`;
    const fullText = `${title}\n${body}${detailText}`;
    const clipped = fullText.length > MAX_DIALOG_TEXT
        ? `${fullText.slice(0, MAX_DIALOG_TEXT)}\n… (diagnostic text truncated; full content in error.log)`
        : fullText;
    const key = opts.key || null;

    // 同一故障重复触发：复用已有对话框，更新正文（含次数），不叠窗口
    if (key && _openDialogs.has(key)) {
        const existing = _openDialogs.get(key);
        if (existing.root.isConnected) {
            existing.count += 1;
            existing.textarea.value = `${clipped}\n\n(this failure has occurred ${existing.count} times; merged into this window for this session)`;
            return existing.root;
        }
        _openDialogs.delete(key);
    }

    const overlay = document.createElement("div");
    overlay.className = "ink-error-overlay";

    const panel = document.createElement("div");
    panel.className = "ink-error-panel";
    overlay.appendChild(panel);

    const head = document.createElement("div");
    head.className = "ink-error-head";
    head.textContent = title;
    panel.appendChild(head);

    const msg = document.createElement("div");
    msg.className = "ink-error-message";
    msg.textContent = body;
    panel.appendChild(msg);

    const textarea = document.createElement("textarea");
    textarea.className = "ink-error-text";
    textarea.readOnly = true;
    textarea.spellcheck = false;
    textarea.wrap = "off";
    textarea.value = clipped;
    // 点击即全选：鼠标路径也能直接 Ctrl+C
    textarea.addEventListener("focus", () => textarea.select());
    panel.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "ink-error-actions";
    panel.appendChild(actions);

    const hint = document.createElement("span");
    hint.className = "ink-error-hint";
    hint.textContent = "Select all to copy (Ctrl+A / Ctrl+C), or use the button on the right";
    actions.appendChild(hint);

    const copyBtn = document.createElement("button");
    copyBtn.className = "ink-error-btn ink-error-btn-primary";
    copyBtn.textContent = "Copy";
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "ink-error-btn";
    closeBtn.textContent = "Close";
    actions.appendChild(closeBtn);

    // Esc 关闭：注册在 window 的捕获阶段。放到 document 上会被应用自己的
    // window 级快捷键处理提前 stopPropagation 掉，事件根本到不了 document。
    const close = () => {
        overlay.remove();
        if (key) _openDialogs.delete(key);
        window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    };

    copyBtn.addEventListener("click", async () => {
        const text = textarea.value;
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (_) { /* 无剪贴板权限 → 走 execCommand */ }
        if (!ok) {
            try {
                textarea.select();
                ok = document.execCommand("copy");
            } catch (_) { ok = false; }
        }
        copyBtn.textContent = ok ? "Copied" : "Press Ctrl+C to copy";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400);
    });
    closeBtn.addEventListener("click", close);
    // 点面板外部关闭（面板内交互不关闭，方便选中文本）
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    window.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    textarea.focus();

    const record = { root: overlay, textarea, count: 1 };
    if (key) _openDialogs.set(key, record);
    return overlay;
}

/**
 * 用可复制对话框替换 window.alert。
 *
 * 为什么替换而不是逐个改写调用点：全项目有几十处 alert(...) 承担“操作失败/
 * 数据损坏”的提示，逐个改既容易漏，也会让将来新增的调用点重新变成不可复制
 * 的原生弹窗。替换后所有调用点（当前的和将来的）自动获得可复制文本。
 */
export function installCopyableAlert() {
    if (_alertInstalled || typeof window === "undefined") return;
    _alertInstalled = true;
    try {
        window.__inkNativeAlert = window.alert;
        window.alert = (message) => {
            const text = message === undefined || message === null ? "" : String(message);
            showErrorDialog("[InkShader]", text);
        };
    } catch (_) {
        _alertInstalled = false;
    }
}

/**
 * @param {string} scope 故障位置（模块/函数）
 * @param {string} message 人类可读的故障说明
 * @param {object|null} detail 诊断数据（会被序列化，写进 error.log）
 * @param {object} [options]
 * @param {boolean} [options.alwaysShow] 每次都弹（默认按 scope|message 每会话只弹一次）
 * @returns {object} 记录下来的条目
 */
export function reportFatalError(scope, message, detail = null, options = {}) {
    _loadFromStorage();
    const entry = {
        at: new Date().toISOString(),
        scope: String(scope || "unknown"),
        message: String(message || "unknown error"),
        detail: detail === undefined ? null : detail,
        count: 1,
        origin: _env.origin,
        server: _env.server
    };
    const key = `${entry.scope}|${entry.message}`;
    const prev = _entries.find((e) => `${e.scope}|${e.message}` === key);
    if (prev) {
        prev.count = (prev.count || 1) + 1;
        prev.at = entry.at;
        // 保留首个 detail（首发现场最有价值），并把后续不同现场的特征记下来：
        // 同一故障可能来自不同几何/对象，只看最后一条会丢信息。
        if (!prev.firstDetail) prev.firstDetail = prev.detail;
        prev.detail = entry.detail;
        const fp = entry.detail && (entry.detail.geometryHash ?? entry.detail.signature);
        if (fp !== undefined && fp !== null) {
            if (!Array.isArray(prev.geometryHashes)) prev.geometryHashes = [];
            if (!prev.geometryHashes.includes(fp)) {
                prev.geometryHashes.push(fp);
                if (prev.geometryHashes.length > 8) prev.geometryHashes.shift();
            }
        }
    } else {
        _entries.push(entry);
        if (_entries.length > MAX_ENTRIES) _entries.splice(0, _entries.length - MAX_ENTRIES);
    }

    try {
        if (entry.detail != null) console.error(`[InkShader:${entry.scope}] ${entry.message}`, entry.detail);
        else console.error(`[InkShader:${entry.scope}] ${entry.message}`);
    } catch (_) { /* 忽略 */ }

    _persistToStorage();
    _postToBackend(entry);

    const alreadyShown = _alertedKeys.has(key);
    if (!alreadyShown || options.alwaysShow === true) {
        _alertedKeys.add(key);
        const suffix = alreadyShown
            ? "\n\n(this failure already appeared in this session; the count in error.log keeps accumulating)"
            : "\n\nThis failure was written to the error log (error.log); the same failure will not pop up again in this session (the count keeps accumulating).";
        showErrorDialog(
            `[InkShader] ${entry.scope}`,
            `${entry.message}${suffix}`,
            entry.detail,
            options.alwaysShow === true ? { key: `error:${key}` } : null
        );
    }
    return entry;
}

/** 已记录的错误条目（最近 MAX_ENTRIES 条，最新在末尾） */
export function getErrorLog() {
    _loadFromStorage();
    return _entries.slice();
}
