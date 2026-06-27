# AGENTS.md — Ray-Light

## What this is

Professional photo analysis desktop app (for checking retouch artifacts before publication).
SPA frontend (vanilla JS/HTML/CSS) + Python FastAPI backend wrapped in pywebview. UI is in Russian.

## Run (development)

```bash
pip install -r requirements.txt
python server.py ./path/to/photos
# Opens a pywebview desktop window
```

Without a path argument, a folder picker dialog appears.

## Build EXE

```bash
pip install PyInstaller
python build_exe.py
# Produces dist/RayLight.exe (onefile, windowed)
```

Run the EXE: `dist\RayLight.exe [путь_к_фотографиям]`.

## Verify

```bash
pip install playwright
playwright install chromium
# Start server first, then:
python final_verify.py
```

Takes a screenshot to `final_result.png`. Requires the server running on port 8000.

## Architecture

- `server.py` — FastAPI backend. Serves static files + `/api/images`, `/api/image/{filename}`, and `/api/settings` endpoints. Only serves `.jpg`/`.jpeg`. Launches pywebview window instead of browser.
- `static/js/app.js` — Main SPA class `RayLightApp`. Grid, zoom/pan, navigation, effect management, caching, settings (API + localStorage fallback).
- `static/js/effects.js` — Effect definitions as ES module. Each effect: `{ name, params[], apply(imageData, params) }`.
- `static/js/worker.js` — Web Worker that duplicates all effect logic (workers can't use ESM imports).
- `static/css/style.css` — All styles, dark theme, grid layouts.
- `build_exe.py` — PyInstaller one-file build script.

## Critical: Adding/modifying effects

**Effects are duplicated.** Every effect implementation exists in both `static/js/effects.js` (ES module for palette/UI metadata) AND `static/js/worker.js` (standalone for Worker thread). When adding or changing an effect, you must update **both files** with matching logic.

To add a new effect:
1. Add entry to `effects` object in `static/js/effects.js` (with `name`, `params[]`, and `apply`)
2. Add matching function in `static/js/worker.js` `effects` object (same logic, standalone)
3. No registration step — `app.js` auto-discovers effects from `effects.js` keys

## Grid/effect constraint

Number of active effects is limited to grid cell count (1, 4, 6, or 9). Each cell gets exactly one effect.

## Settings persistence

User preferences (grid type, active effects list, fit-to-aspect toggle, overlay grid type/size, overlay spiral corner) are saved to `<image_dir>/ray-light-settings.json` via `/api/settings` endpoints. Falls back to `localStorage` (`ray_light_settings`) when the API is unavailable.

## Overlay composition grids

Compositional grid overlays can be drawn on top of image cells (but not on histogram/itten_circle analysis effects). Configured via "Наложение сетки" dropdown in the sidebar.

Types: `none`, `rule-of-thirds`, `grid` (configurable cell size), `golden-ratio`, `diagonal`, `triangle`, `golden-spiral`.

Overlay is implemented via a second `<canvas class="grid-overlay">` per cell, positioned identically to the main canvas with `pointer-events: none`. Drawing methods are in `app.js`: `drawOverlay`, `drawRuleOfThirds`, `drawGridLines`, `drawGoldenRatio`, `drawDiagonal`, `drawTriangle`, `drawGoldenSpiral`.

### Golden Spiral (drawGoldenSpiral)

Implemented as a Fibonacci-numbers-based spiral (sequence 1,1,2,3,5,8,13…). The spiral is auto-positioned to snap to the selected side of the image via a transform chain (translate → rotate 270° → flip). Bounding box in Fibonacci units: 13×21 (LEFT=-4, RIGHT=9, TOP=-6, BOTTOM=15).

Side selection (`overlaySpiralSide`): `left`, `right`, `top`, `bottom`. Default: `left`. Controls shown when `golden-spiral` is selected in the overlay type dropdown.
