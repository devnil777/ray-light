import os
import sys
import json
import argparse
import threading
import time
from tkinter import Tk, filedialog
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.requests import Request
from typing import List
import uvicorn
import webview

app = FastAPI()

IMG_DIR = ""
SETTINGS_FILE = ".ray-light.json"

@app.get("/api/images")
async def list_images() -> List[str]:
    if not IMG_DIR or not os.path.exists(IMG_DIR):
        return []
    files = [f for f in os.listdir(IMG_DIR) if f.lower().endswith(('.jpg', '.jpeg'))]
    files.sort()
    return files

@app.get("/api/image/{filename}")
async def get_image(filename: str):
    file_path = os.path.join(IMG_DIR, filename)
    if not os.path.exists(file_path):
        return JSONResponse({"error": "Image not found"}, status_code=404)
    return FileResponse(file_path)

@app.get("/api/settings")
async def get_settings():
    if not IMG_DIR:
        return {}
    settings_path = os.path.join(IMG_DIR, SETTINGS_FILE)
    if not os.path.exists(settings_path):
        return {}
    try:
        with open(settings_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

@app.post("/api/settings")
async def save_settings(request: Request):
    if not IMG_DIR:
        return JSONResponse({"error": "No image directory"}, status_code=400)
    try:
        body = await request.json()
        settings_path = os.path.join(IMG_DIR, SETTINGS_FILE)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

def resolve_static_dir():
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'static')
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

def pick_folder():
    root = Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    folder = filedialog.askdirectory(title="Выберите папку с изображениями")
    root.destroy()
    return folder

def main():
    parser = argparse.ArgumentParser(description="Ray-Light Desktop")
    parser.add_argument("img_dir", nargs="?", help="Directory containing JPG images")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    args = parser.parse_args()

    global IMG_DIR

    if args.img_dir:
        IMG_DIR = os.path.abspath(args.img_dir)
        if not os.path.exists(IMG_DIR):
            print(f"Error: Directory {IMG_DIR} does not exist.")
            sys.exit(1)
    else:
        picked = pick_folder()
        if not picked:
            print("No folder selected. Exiting.")
            sys.exit(0)
        IMG_DIR = picked

    static_dir = resolve_static_dir()

    if os.path.exists(static_dir):
        app.mount("/js", StaticFiles(directory=os.path.join(static_dir, "js")), name="js")
        app.mount("/css", StaticFiles(directory=os.path.join(static_dir, "css")), name="css")

        @app.get("/")
        async def read_index():
            return FileResponse(os.path.join(static_dir, "index.html"))

    print(f"Serving images from: {IMG_DIR}")

    def run_server():
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(1.5)

    folder_name = os.path.basename(IMG_DIR.rstrip(os.sep))
    webview.create_window(
        f"Ray-Light | Аудит фото — {folder_name}",
        f"http://127.0.0.1:{args.port}",
        width=1400,
        height=900,
        resizable=True,
    )
    webview.start()

if __name__ == "__main__":
    main()
