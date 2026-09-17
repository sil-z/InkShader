"""构建期生成的信息（MODE / VERSION / GIT_SHA）。

打包脚本（backend/build.py）会覆盖此文件中的构建期字段；
开发模式下使用这里的默认值。
"""
import sys

APP_NAME = "InkShader"

# MODE: "web"（浏览器+托盘场景3）| "desktop"（pywebview 原生窗口，场景2）
MODE = "web"

VERSION = "0.1.0"

GIT_SHA = "dev"

# 打包时刻（UTC ISO）。用途：error.log 里的每条前端故障都会带上“是哪个构建
# 在跑”，避免拿旧 exe 的现象去查新代码（反之亦然）。开发模式为 "dev"。
BUILD_TIME = "dev"

# 打包时（backend/build.py）生成的覆盖值；仅打包产物（sys.frozen）使用，
# 开发模式（python run.py）必须忽略，否则残留的生成文件会覆盖 run.py --mode。
try:
    if getattr(sys, "frozen", False):
        from ._build_info_generated import MODE as _MODE, VERSION as _VERSION, GIT_SHA as _GIT_SHA  # noqa: E402
        MODE, VERSION, GIT_SHA = _MODE, _VERSION, _GIT_SHA
        try:
            from ._build_info_generated import BUILD_TIME as _BUILD_TIME  # noqa: E402
            BUILD_TIME = _BUILD_TIME
        except ImportError:
            pass
except ImportError:
    pass


def as_dict() -> dict:
    return {
        "app": APP_NAME,
        "mode": MODE,
        "version": VERSION,
        "gitSha": GIT_SHA,
        "buildTime": BUILD_TIME,
    }