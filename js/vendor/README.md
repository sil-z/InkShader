# js/vendor — 第三方库本地副本

本项目没有构建步骤：页面直接加载这些文件，因此这里保存的是上游发布产物本身，
不做改写、不重新打包。业务代码不直接引用 `<名称>.min.js`，统一从
`js/vendor/<名称>.js`（ESM 适配器）导入，见下方「加载约定」。

## 清单

| 文件 | 包 | 版本 | 许可 | 上游 | 模块形式 | 加载方式 |
|------|----|------|------|------|----------|----------|
| `jszip.min.js` | [jszip](https://www.npmjs.com/package/jszip) | 3.10.1 | MIT 或 GPL-3.0-or-later（双许可，见文件头） | https://github.com/Stuk/jszip | UMD（设置全局 `JSZip`） | `index.html` 的 `<script src>` |
| `paper-full.min.js` | [paper](https://www.npmjs.com/package/paper) | 文件内自述 0.12.17 | MIT | https://github.com/paperjs/paper.js | UMD（顶层 `var paper` 建立全局 `paper`） | `index.html` 的 `<script src>` |
| `svgpath.min.js` | [svgpath](https://www.npmjs.com/package/svgpath) | 未在文件内声明 | MIT | https://github.com/fontello/svgpath | ESM（`export default`） | ES 模块导入 |

校验值（`sha256sum js/vendor/*.js`，2026-09-16）：

```
f12f367798e35ee2d9993dba6167fc61ddb52fb89880f5a99fbb606335188410  jszip.min.js      97642 B
e984608dd2c0c80d2ec3da46513b561f13ace5505527e4b31940421901661134  paper-full.min.js 234982 B
faf5209facccdb33b33db7f538e6e5e0fcdced9a9a9d68f4a55a3cce17cd3fc9  svgpath.min.js    13014 B
```

## 加载约定

- **UMD/全局构建**（jszip、paper）：由 `index.html` 的 `<script src>` 同步加载，
  模块脚本执行前全局已存在。`js/vendor/jszip.js`、`js/vendor/paper.js` 是 ESM
  适配器，导出对应全局对象。
- **ESM 构建**（svgpath）：`js/vendor/svgpath.js` 重新导出其默认导出。
- 结果：三种依赖的消费方式一致 —— `import paper from '../../vendor/paper.js'`。
  适配器不改变加载时机，全局对象仍然由 `index.html` 提供。

## 升级步骤

1. 按上表「上游」下载目标版本的发布产物，替换同名文件（保持文件名不变）。
2. 若新版本的文件内版本号或模块形式发生变化，更新本文件与 `index.html`、适配器。
3. 更新本文件中的 `sha256` 与字节数。
4. 运行 `test/probe_*.mjs` 中涉及导出/导入的回归（UFO 导出依赖 JSZip，画布渲染
   依赖 paper，SVG 路径规范化依赖 svgpath）。

## 待核对事项

- `paper-full.min.js` 文件内声明 `0.12.17`；仓库内 `AGENTS.md` 记录该文件的哈希
  与 npm 发布的 0.12.x 产物不一致（来源为 develop 分支构建）。升级时应以上游
  发布产物为基准重新核对，而不是以本文件的版本号推断 API 行为。
- `svgpath.min.js` 内无版本号。npm 上游 svgpath 只发布 CommonJS（`lib/` +
  `index.js`），不含浏览器打包，因此该文件来自第三方 ESM 打包（例如 CDN 的
  `+esm` 产物）。如需确认版本，用同一个打包服务重新生成并比对哈希。
