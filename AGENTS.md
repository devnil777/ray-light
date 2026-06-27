# AGENTS.md — Ray-Light

## What this is

Professional photo analysis web app (for checking retouch artifacts before publication).
SPA frontend (vanilla JS/HTML/CSS) + minimal Python FastAPI backend. UI is in Russian.

## Run

```bash
pip install fastapi uvicorn Pillow
python server.py ./path/to/photos
# Opens http://localhost:8000 automatically
```

No build step. No npm. No bundler. Static files are served directly from `static/`.

## Verify

```bash
pip install playwright
playwright install chromium
# Start server first, then:
python final_verify.py
```

Takes a screenshot to `final_result.png`. Requires the server running on port 8000.

## Architecture

- `server.py` — FastAPI backend. Serves static files + `/api/images` and `/api/image/{filename}` endpoints. Only serves `.jpg`/`.jpeg`.
- `static/js/app.js` — Main SPA class `RayLightApp`. Grid, zoom/pan, navigation, effect management, caching, settings (localStorage).
- `static/js/effects.js` — Effect definitions as ES module. Each effect: `{ name, params[], apply(imageData, params) }`.
- `static/js/worker.js` — Web Worker that duplicates all effect logic (workers can't use ESM imports).
- `static/css/style.css` — All styles, dark theme, grid layouts.

## Critical: Adding/modifying effects

**Effects are duplicated.** Every effect implementation exists in both `static/js/effects.js` (ES module for palette/UI metadata) AND `static/js/worker.js` (standalone for Worker thread). When adding or changing an effect, you must update **both files** with matching logic.

To add a new effect:
1. Add entry to `effects` object in `static/js/effects.js` (with `name`, `params[]`, and `apply`)
2. Add matching function in `static/js/worker.js` `effects` object (same logic, standalone)
3. No registration step — `app.js` auto-discovers effects from `effects.js` keys

## Grid/effect constraint

Number of active effects is limited to grid cell count (1, 4, 6, or 9). Each cell gets exactly one effect.

## Settings persistence

User preferences (grid type, active effects list, fit-to-aspect toggle) are saved to `localStorage` under key `ray_light_settings`.
