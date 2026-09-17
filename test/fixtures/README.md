# 测试 fixture

回归探针读取的输入文件。放在仓库内，保证换机器、换用户名、Linux 与 CI 上都能跑。

| 文件 | 用途 | 来源 |
|------|------|------|
| `InkShader_Roundhand.json` | 真实工程（曲线、节点、序列、引用对象），供绘制/命中/历史/旋转等探针加载 | 项目导出的工程文件副本，sha256 `4b6969da6c9c2e028213b2da17fc93f65d6af12652b8aa4e5de7655dc5fd4fa3` |

探针**只读**这些文件，绝不写回。需要落盘的中间产物写临时目录（`tmpFile()`）。

覆盖方式：设置 `PROBE_EXAMPLE` 指向别的工程文件即可，解析优先级见
`test/probe_env.mjs`。

替换 `InkShader_Roundhand.json` 时，部分探针断言的具体对象名、曲线数、节点数依赖
其内容，需同步更新断言。
