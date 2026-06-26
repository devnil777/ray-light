import os
import argparse
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import List
import uvicorn

app = FastAPI()

# Global variable to store the images directory
IMG_DIR = ""

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
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(file_path)

def main():
    parser = argparse.ArgumentParser(description="Ray-Light Backend")
    parser.add_argument("img_dir", help="Directory containing JPG images")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    args = parser.parse_args()

    global IMG_DIR
    IMG_DIR = os.path.abspath(args.img_dir)

    if not os.path.exists(IMG_DIR):
        print(f"Error: Directory {IMG_DIR} does not exist.")
        return

    # Serve static files from 'static' directory
    if os.path.exists("static"):
        app.mount("/js", StaticFiles(directory="static/js"), name="js")
        app.mount("/css", StaticFiles(directory="static/css"), name="css")

        @app.get("/")
        async def read_index():
            return FileResponse("static/index.html")

    print(f"Serving images from: {IMG_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=args.port)

if __name__ == "__main__":
    main()
