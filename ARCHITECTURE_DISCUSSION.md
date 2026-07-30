# InkShader 架构讨论记录

> 临时文档，记录 2026-07-29 关于后端架构、字体编译和文件存储方案的讨论。

---

## 一、背景

InkShader 是纯前端字体编辑器，使用 Paper.js 做贝塞尔曲线渲染。当前的能力边界：

- **已有**：字形编辑、历史系统、i18n、kerning 管理、字体元数据管理、UFO 导出（JSZip）、IndexedDB auto-save
- **缺失**：TTF/OTF 编译、WOFF2 读写、字体文件导入解析、OpenType layout 特性支持

浏览器 JS 环境没有完整的字体处理库，因此需要引入后端或 WASM 来补充这些能力。

---

## 二、架构选型：fonttools WASM vs 后端服务 vs 纯前端

### 方案一：fonttools 编译为 WASM

**结论：不可行。**

| 问题 | 细节 |
|------|------|
| 体积 | fonttools ~3MB+ Python 代码 + 依赖，Pyodide 运行时 ~10MB+ 压缩，合计 ~15MB+ |
| C 扩展 | `cu2qu`、二进制表解析器等依赖 C 扩展，需 Emscripten 额外编译 |
| 启动时间 | Pyodide 冷启动 2-5s，加上 fonttools import 时间 |
| 维护成本 | 每次 fonttools 升级需重新编译整个 WASM 包 |
| 浏览器体验 | 编辑器场景要求即时响应，15MB+ 下载 + 数秒冷启动不可接受 |

fonttools → WASM 是把 Python 生态硬塞进浏览器的思路，体积和启动成本远超收益。

### 方案二：opentype.js（纯 JS）+ 可选后端

**这是核心推荐方案。**

opentype.js 覆盖一个字体编辑器约 80% 的编译需求，纯 JS、零依赖、零冷启动：

| 功能 | opentype.js | wawoff2 | 后端 (fonttools) |
|------|:---:|:---:|:---:|
| TTF/OTF 解析 | ✅ | — | — |
| TTF/OTF 生成 | ✅ | — | — |
| WOFF 解析 | ✅ | — | — |
| WOFF2 解析 | — | ✅ | ✅ |
| WOFF2 压缩 | — | — | ✅ |
| name table 读写 | ✅ | — | — |
| cmap / glyf / hmtx 读写 | ✅ | — | — |
| CFF 解析 | ✅ | — | — |
| **GPOS (kerning)** | **❌** | — | ✅ |
| **GSUB (features)** | **❌** | — | ✅ |
| Variable font | ❌ | — | ✅ |
| 字体验证 | ❌ | — | ✅ |
| 子集化 | ❌ | — | ✅ |
| Bundle 体积 | ~100KB gzip | ~100KB gzip | N/A |

### 关键发现：opentype.js 不能处理 OpenType feature

opentype.js 不写入以下关键 OpenType 表：

| 表 | opentype.js | InkShader 依赖 |
|---|---|---|
| `GPOS` | ❌ 不写入 | ✅ kerning 数据（已有 kerning_manager.js） |
| `GSUB` | ❌ 不写入 | 将来需要 |
| `GDEF` | ❌ 不写入 | 将来需要 |
| `kern` (legacy) | ❌ 不写入 | 备选 |

InkShader 已有完整的 `kerning_manager.js`（支持 pair 和 class-based kerning），UFO 导出已经在写 `kerning.plist` + `groups.plist`。如果只用 opentype.js 编译，生成的 TTF 会丢失所有 kerning 数据——对于一个字体编辑器来说，这是不可接受的。

**因此后端不是锦上添花，而是几乎必需。** 前端独立编译在丢掉 kerning 和 feature 后，价值大打折扣。

---

## 三、最终推荐架构：渐进式增强

```
┌──────────────────────────────────────────┐
│  Browser（独立可用，功能有限）              │
├──────────────────────────────────────────┤
│                                          │
│  opentype.js                             │
│  └── TTF 编译 (NO GPOS/GSUB/kern)       │
│      用途：glyph 形状预览、开发快速检查    │
│      缺陷：无 kerning，无 feature          │
│      缺陷说明：导出时 UI 提示该限制        │
│                                          │
│  wawoff2 (WASM)                          │
│  └── WOFF2 → TTF 解压缩                 │
│      用途：导入字体文件                    │
│                                          │
│  UFO 导出（已有）                         │
│  └── 包含完整 kerning 数据               │
│      用途：与 fonttools 互通             │
│                                          │
│  FileStorage (适配层)                    │
│  ├── BrowserFileStorage                  │
│  │   └── File System Access API + fallback│
│  └── IndexedDB auto-save（始终运行）      │
│                                          │
└──────────────┬───────────────────────────┘
               │ 启动时自动检测
               │ GET /api/health (500ms timeout)
               │
┌──────────────▼───────────────────────────┐
│  Backend Service（可选，但强烈推荐）        │
│  (Python + fonttools + FastAPI)          │
├──────────────────────────────────────────┤
│                                          │
│  POST /api/font/compile                  │
│   └── JSON/UFO → TTF/OTF/WOFF2          │
│       包含 GPOS (kerning)               │
│       包含 GSUB (.fea)                  │
│                                          │
│  POST /api/font/import                   │
│   └── TTF/OTF/WOFF2 → 解析             │
│       返回到 .json 项目格式              │
│                                          │
│  POST /api/font/validate                 │
│  POST /api/font/subset                   │
│  POST /api/font/export-feature           │
│   └── Kerning classes → .fea            │
│                                          │
│  FileStorage (适配层)                    │
│  └── ServerFileStorage                   │
│      └── POST /api/file/save → 直接写磁盘 │
│                                          │
└──────────────────────────────────────────┘
```

---

## 四、文件存储方案：FileStorage 适配层

### 4.1 问题描述

当前 `triggerSave()` 使用 `<a download>` 方式——每次 Ctrl+S 都弹"另存为"对话框，每次都生成新文件名。

期望行为：
- 首次保存（Save As）：选择文件位置
- 后续 Ctrl+S（Quick Save）：不弹对话框，直接写入同一文件
- IndexedDB auto-save 作为崩溃恢复的兜底，两种模式下都运行

阻碍因素：
- File System Access API 在 Chrome 上权限行为极不稳定（`requestPermission` 经常自动拒绝）
- Firefox 表现正常
- `navigator.storage.persist()` 在 Chrome 上成功率随机

### 4.2 统一状态机

两种模式共享同一保存状态机：

```
状态          Ctrl+S 行为            UI 提示
─────────────────────────────────────────────
NEW           触发 Save As           显示 "未保存"
SAVED         直接 Quick Save        显示文件名 + "已保存"
MODIFIED      直接 Quick Save        显示文件名 + "已修改"
```

### 4.3 FileStorage 接口

```js
interface FileStorage {
  mode: 'browser' | 'server'

  // 是否有已建立的文件位置
  hasActiveFile(): boolean

  // 当前文件元信息
  getFileInfo(): { name: string, path?: string } | null

  // "另存为"
  saveAs(data: string, suggestedName: string): Promise<{ ok: boolean, fileInfo: FileInfo }>

  // "快速保存"——Ctrl+S，不弹对话框
  quickSave(data: string): Promise<{ ok: boolean, fileInfo: FileInfo, fallback?: boolean }>

  // 打开文件
  open(): Promise<{ data: string, fileInfo: FileInfo } | null>
}
```

### 4.4 BrowserFileStorage（前端独立模式）

| 操作 | 主路径 | 回退链 |
|------|--------|--------|
| `saveAs()` | `showSaveFilePicker()` → handle → 写入 → 存 handle 到 IndexedDB | API 不支持 → `<a download>` |
| `quickSave()` | 从 IndexedDB 取 handle → `requestPermission()` → `createWritable()` → 写入 | 权限拒绝 → `showSaveFilePicker()` 重新获取 → 用户取消 → `<a download>` |
| `open()` | `showOpenFilePicker()` → 读文件 → 存 handle | API 不支持 → `<input type=file>` |

Chrome 不可靠的缓解策略：
- `requestPermission()` 返回 `denied` 后不自降为 `<a download>`，而是重新调用 `showSaveFilePicker()`（用户手势触发的 picker 通常能返回新 handle）
- 连续 2 次用户取消 picker，才退到 `<a download>`（使用一致文件名而非时间戳）
- handle 序列化存入 IndexedDB，与项目绑定

Quick Save 完整流程：

```
quickSave (BrowserFileStorage):
  ┌─ IndexedDB 有 handle? ──→ No ──→ showSaveFilePicker()
  │                                       ├─ 用户选文件 → 写入 + 存 handle
  │                                       └─ 用户取消 → <a download>
  │
  ├─ Yes → requestPermission('readwrite')
  │         ├─ 'granted' → createWritable() → 写入 ✓
  │         ├─ 'denied'  → showSaveFilePicker() (重获新 handle)
  │         │               ├─ 用户选文件 → 写入 + 更新 handle ✓
  │         │               └─ 用户取消 → <a download> 回退 (fallback)
  │         └─ 'prompt' → Chrome 弹权限确认 → 用户确认 → 写入
```

### 4.5 ServerFileStorage（后端模式）

| 操作 | 实现 |
|------|------|
| `saveAs()` | POST `/api/file/save-as` → 返回 `{ path, name }` → 前端缓存 path |
| `quickSave()` | POST `/api/file/save`（带 path）→ 服务端直接覆盖写入 |
| `open()` | POST `/api/file/open`（带 path）→ 返回文件内容 |

后端模式下 Ctrl+S 永远不弹对话框。

### 4.6 模式选择逻辑

```js
// 启动时
const backendUrl = await detectBackend(); // GET /api/health, 500ms timeout

if (backendUrl) {
  fileStorage = new ServerFileStorage(backendUrl);
} else {
  fileStorage = new BrowserFileStorage();
}

// IndexedDB auto-save 始终独立运行
```

两种模式的切换不需要迁移项目数据——`fileLocation` 只是存储方式不同：

```js
// 每个项目在 IndexedDB 中的记录
{
  _signature: "InkShader V1 Project",
  latestSnapshot: { ... },   // 当前编辑状态（已有）
  commandStack: [...],        // 历史（已有）

  // 新增：文件位置跟踪
  fileLocation: {
    type: "browser" | "server" | null,
    // browser 模式: 序列化 FileSystemFileHandle
    browserHandle: FileSystemHandle,
    // server 模式: 后端文件路径
    serverPath: "/home/user/project.inkshader.json",
    // 通用
    fileName: "my_font.inkshader.json",
    lastSavedAt: 1700000000000,
  }
}
```

### 4.7 IndexedDB 定位不变

IndexedDB auto-save 在两种模式下保持一致，不受 FileStorage 影响：

```
任何变更 → 120ms 防抖 → StorageUtils.saveProject() → IndexedDB
页面关闭 → 最后一次状态 → IndexedDB
启动时 → 读 IndexedDB 恢复上次状态
```

IndexedDB 是**编辑状态的自动备份**，不是主存储。`navigator.storage.persist()` 申请了不保证成功，但不影响——用户的**主要文件**已通过 FileStorage 保存到可见位置。

### 4.8 两种模式对比

| | BrowserFileStorage | ServerFileStorage |
|---|---|---|
| Ctrl+S 无对话框 | 依赖 Chrome 权限，不稳定 | 100% 可靠 |
| 文件位置 | 浏览器沙箱或下载文件夹 | 用户指定的任意路径 |
| 离线 | 完全可用 | 不可用 |
| 代码复杂度 | 高（权限管理 + handle 序列化 + 多层回退） | 低（HTTP 调用） |

---

## 五、总结决策

1. **fonttools → WASM：排除。** 体积和启动成本过高，不值。
2. **opentype.js + wawoff2：前端引入。** 覆盖 TTF/OTF 编译和字体导入的基本能力，体积 ~200KB gzip。
3. **Python 后端（FastAPI + fonttools）：强烈推荐。** 负责完整 TTF/OTF 编译（含 GPOS kerning）、WOFF2 压缩、字体验证、子集化。前端通过 500ms 超时自动检测后端可用性。
4. **FileStorage 适配层：统一保存抽象。** 两种模式共享同一接口和状态机，前端模式通过 File System Access API + 多层回退尽可能实现无对话框保存，后端模式通过 HTTP API 直接写磁盘。
5. **IndexedDB auto-save：不变。** 始终运行，独立于 FileStorage。
6. **前端独立可用但有限制：** 无后端时，TTF 编译不含 kerning 和 feature，UI 中应提示该限制。

---

## 六、后续实施建议

1. 引入 `opentype.js` + `wawoff2` npm 包
2. 新建 `js/services/file_storage.js` — FileStorage 接口 + 两套实现
3. 修改 `canvas_io_service.js` — `triggerSave()` 改为使用 FileStorage
4. 新建 `js/services/backend_detector.js` — 后端检测逻辑
5. 新建 `js/services/backend_client.js` — 后端 HTTP API 调用封装
6. 新建 `js/font/ttf_compiler.js` — 基于 opentype.js 的前端 TTF 编译（不含 feature）
7. 新建 `js/font/font_importer.js` — 基于 opentype.js 的字体导入
8. 后端项目：FastAPI + fonttools + 上述 API 端点
