# InkShader 一键脚本（Windows PowerShell）。在仓库根目录执行。
#
#   .\dev.ps1 install                  安装运行依赖（pip install -e ./backend）
#   .\dev.ps1 install-dev              安装测试/打包依赖（[build,test,lint] extras）
#   .\dev.ps1 install-lock             按已验证的精确版本安装（requirements.lock.txt）
#   .\dev.ps1 run                      开发运行：web 模式（托盘 + 浏览器）
#   .\dev.ps1 run --mode desktop       开发运行：desktop 模式（原生窗口编辑器）
#   .\dev.ps1 build frontend           纯前端静态包 -> backend\dist\frontend\ + zip
#   .\dev.ps1 build exe                可执行文件（desktop）-> backend\dist\
#   .\dev.ps1 build exe --runtime web  可执行文件（web 模式）
#   .\dev.ps1 test                     后端单元测试（pytest）
#   .\dev.ps1 lint                     静态检查（ruff）
#
# 前置：python 3.11+ 在 PATH；用虚拟环境时先激活（.\.venv\Scripts\Activate.ps1）。
# 实际工作都在 Python 里：backend/run.py（运行）与 backend/build.py（构建）。
# 依赖声明在 backend/pyproject.toml（唯一来源）。

$rest = @($args | Select-Object -Skip 1)

switch ($args[0]) {
    "install"       { python -m pip install -e "./backend" }
    "install-dev"   { python -m pip install -e "./backend[build,test,lint]" }
    "install-lock"  { python -m pip install -r backend/requirements.lock.txt }
    "build"         { python backend/build.py @rest }
    "run"           { python backend/run.py @rest }
    "test"          { python -m pytest backend/tests }
    "lint"          { python -m ruff check backend }
    "help"          { Get-Content $PSCommandPath | Select-Object -First 20 }
    default         { python backend/run.py @args }
}

# 把上一条命令的退出码传出去（命令失败时不静默返回 0）。
exit $LASTEXITCODE
