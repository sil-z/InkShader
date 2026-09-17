"""InkShader 构建脚本（两个目标的所有实际工作都在这里，dev.ps1 / dev.sh 只负责转接）。

用法：
    python backend/build.py frontend                # 纯前端静态包 + 部署 zip
    python backend/build.py exe                     # 可执行文件（默认 desktop 模式）
    python backend/build.py exe --runtime web        # 可执行文件（托盘 + 浏览器模式）
    python backend/build.py exe --no-upx            # 不压缩（杀软误报时用）

产物：
    frontend -> backend/dist/frontend/ 与 backend/dist/InkShader-frontend-<平台>.zip
    exe web     -> backend/dist/InkShader(.exe)
    exe desktop -> backend/dist/InkShader-desktop(.exe)

exe 流程：
1. 生成 exe 图标（backend/packaging/inkshader.ico）
2. 生成构建期信息覆盖（backend/src/inkshader/_build_info_generated.py，MODE=runtime）
3. 调用 PyInstaller 执行 packaging/web.spec（spec 通过环境变量读取 runtime）

PyInstaller 不支持交叉编译：Windows 产物在 Windows 构建，Linux 产物在 Linux 构建。
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# PyInstaller（子进程）直接写 stdout；把本脚本的输出改成行缓冲，保证日志按发生顺序显示。
sys.stdout.reconfigure(line_buffering=True)

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
SRC_DIR = BACKEND_DIR / "src"
SPEC = BACKEND_DIR / "packaging" / "web.spec"
ICO_PATH = BACKEND_DIR / "packaging" / "inkshader.ico"
DIST_DIR = BACKEND_DIR / "dist"
FRONTEND_ITEMS = ("index.html", "css", "js", "assets")

sys.path.insert(0, str(SRC_DIR))

VERSION = "0.1.0"


def git_sha() -> str:
    try:
        out = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                      cwd=BACKEND_DIR.parent, stderr=subprocess.DEVNULL)
        return out.decode().strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def generate_icon() -> None:
    from inkshader.desktop.icons import save_icon_ico
    save_icon_ico(ICO_PATH)
    print(f"[build] icon -> {ICO_PATH}")


def generate_build_info(runtime: str) -> None:
    target = SRC_DIR / "inkshader" / "_build_info_generated.py"
    build_time = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    content = (
        "# 构建期自动生成（backend/build.py），开发模式不使用此文件。\n"
        f"MODE = \"{runtime}\"\n"
        f"VERSION = \"{VERSION}\"\n"
        f"GIT_SHA = \"{git_sha()}\"\n"
        f"BUILD_TIME = \"{build_time}\"\n"
    )
    target.write_text(content, encoding="utf-8")
    print(f"[build] build_info -> {target} (MODE={runtime}, BUILD_TIME={build_time})")


def build_frontend() -> int:
    """拷贝前端静态资源到 backend/dist/frontend/，并打一个部署用 zip。"""
    out = DIST_DIR / "frontend"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in FRONTEND_ITEMS:
        src = PROJECT_ROOT / name
        if src.is_dir():
            shutil.copytree(src, out / name)
        elif src.is_file():
            shutil.copy2(src, out / name)
    host = {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}.get(
        platform.system(), platform.system().lower())
    zip_path = DIST_DIR / f"InkShader-frontend-{host}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(out.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(out))
    print(f"[build] frontend -> {out}")
    print(f"[build] zip -> {zip_path}")
    return 0


def build_exe(runtime: str, no_upx: bool) -> int:
    generate_icon()
    generate_build_info(runtime)

    pyinstaller = shutil.which("pyinstaller")
    if pyinstaller is None:
        print("[build] pyinstaller not found; run: pip install -e \"./backend[build]\"")
        return 1

    env = dict(os.environ)
    env["INKSHADER_RUNTIME"] = runtime

    cmd = [pyinstaller, "--noconfirm", "--clean", str(SPEC)]
    if no_upx:
        cmd.append("--noupx")
    print("[build] running:", " ".join(cmd))
    subprocess.check_call(cmd, cwd=BACKEND_DIR, env=env)

    suffix = "" if runtime == "web" else "-desktop"
    print(f"[build] done -> {DIST_DIR / f'InkShader{suffix}'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="InkShader build")
    parser.add_argument("target", choices=["frontend", "exe"],
                        help="frontend: static frontend package; exe: single-file executable")
    parser.add_argument("--runtime", choices=["desktop", "web"], default="desktop",
                        help="exe runtime: desktop = pywebview window editor; "
                             "web = tray + browser (default: desktop)")
    parser.add_argument("--no-upx", action="store_true", help="exe: disable UPX compression")
    args = parser.parse_args()

    if args.target == "frontend":
        return build_frontend()
    return build_exe(args.runtime, args.no_upx)


if __name__ == "__main__":
    raise SystemExit(main())