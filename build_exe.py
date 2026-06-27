"""
Build Ray-Light Desktop EXE with PyInstaller.

Usage:
    python build_exe.py
    python build_exe.py --add-data-option  # если нужна доп. настройка

Requires PyInstaller installed (pip install PyInstaller).
"""
import PyInstaller.__main__
import os
import shutil

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

DIST_DIR = os.path.join(SCRIPT_DIR, "dist")
BUILD_DIR = os.path.join(SCRIPT_DIR, "build")
SPEC_FILE = os.path.join(SCRIPT_DIR, "RayLight.spec")

for d in [DIST_DIR, BUILD_DIR]:
    if os.path.exists(d):
        shutil.rmtree(d)
for f in [SPEC_FILE]:
    if os.path.exists(f):
        os.remove(f)

static_src = os.path.join(SCRIPT_DIR, "static")
sep = os.pathsep  # ";" on Windows

PyInstaller.__main__.run([
    os.path.join(SCRIPT_DIR, "server.py"),
    "--onefile",
    "--windowed",
    "--name=RayLight",
    f"--add-data={static_src}{sep}static",
    "--hidden-import=uvicorn.logging",
    "--hidden-import=uvicorn.loops.auto",
    "--hidden-import=uvicorn.protocols.http.auto",
    "--hidden-import=fastapi",
    "--distpath=" + DIST_DIR,
    "--workpath=" + BUILD_DIR,
    "--specpath=" + SCRIPT_DIR,
])

print(f"\nDone! EXE created at: {os.path.join(DIST_DIR, 'RayLight.exe')}")
print("Run: dist\\RayLight.exe [путь_к_фотографиям]")
