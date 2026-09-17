"""pytest 配置：让 backend/src 下的 inkshader 包可直接导入。

src 布局下不安装也能测试（`pip install -e ./backend` 之后这行是无害的冗余）。
"""
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
