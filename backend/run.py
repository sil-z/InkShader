"""InkShader 开发运行脚本。

用法：
    python backend/run.py                       # 场景3：托盘 + 浏览器（默认）
    python backend/run.py --mode desktop        # 场景2：pywebview 窗口直接跑编辑器
    python backend/run.py --no-browser --port 9000
"""
import argparse
import sys
from pathlib import Path

# 保证 backend/src 可导入（开发模式）
SRC_DIR = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(SRC_DIR))

from inkshader.server import DEFAULT_PORT  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="InkShader local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"starting port (auto +1 when taken, default {DEFAULT_PORT})")
    parser.add_argument("--mode", choices=["web", "desktop"], default=None,
                        help="runtime mode (default: from build config; "
                             "web = console backend + system browser, "
                             "desktop = pywebview window editor)")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open the browser on startup (development only)")
    args = parser.parse_args()

    import inkshader.build_info as build_info
    import inkshader.server as server_mod

    if args.mode:
        build_info.MODE = args.mode
    server_mod.DEFAULT_PORT = args.port

    import main as app_main

    if args.no_browser:
        app_main.OPEN_BROWSER = False

    return app_main.main()


if __name__ == "__main__":
    raise SystemExit(main())