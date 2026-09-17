#!/usr/bin/env bash
# InkShader 一键脚本（Linux/macOS）。在仓库根目录执行，接口同 dev.ps1。
#
#   ./dev.sh install                 安装运行依赖（pip install -e ./backend）
#   ./dev.sh install-dev             安装测试/打包依赖（[build,test,lint] extras）
#   ./dev.sh install-lock            按已验证的精确版本安装（requirements.lock.txt）
#   ./dev.sh run                     开发运行：web 模式（托盘 + 浏览器）
#   ./dev.sh run --mode desktop      开发运行：desktop 模式（原生窗口编辑器）
#   ./dev.sh run --no-browser --port 9000
#   ./dev.sh build frontend          纯前端静态包 -> backend/dist/frontend/ + zip
#   ./dev.sh build exe               可执行文件（desktop）-> backend/dist/
#   ./dev.sh build exe --runtime web 可执行文件（web 模式）
#   ./dev.sh test                    后端单元测试（pytest）
#   ./dev.sh lint                    静态检查（ruff）
#
# 前置：python3 3.11+ 在 PATH；用虚拟环境时先激活（source .venv/bin/activate）。
# 实际工作都在 Python 里：backend/run.py（运行）与 backend/build.py（构建）。
# 依赖声明在 backend/pyproject.toml（唯一来源）。

set -euo pipefail

case "${1:-}" in
    install)       python3 -m pip install -e ./backend ;;
    install-dev)   python3 -m pip install -e "./backend[build,test,lint]" ;;
    install-lock)  python3 -m pip install -r backend/requirements.lock.txt ;;
    build)         shift; python3 backend/build.py "$@" ;;
    run)           shift; python3 backend/run.py "$@" ;;
    test)          python3 -m pytest backend/tests ;;
    lint)          python3 -m ruff check backend ;;
    help)          sed -n '1,20p' "$0" ;;
    "")            python3 backend/run.py ;;
    *)             python3 backend/run.py "$@" ;;
esac
