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

User preferences (grid type, active effects list, fit-to-aspect toggle, overlay grid type/size, overlay spiral corner) are saved to `localStorage` under key `ray_light_settings`.

## Overlay composition grids

Compositional grid overlays can be drawn on top of image cells (but not on histogram/itten_circle analysis effects). Configured via "Наложение сетки" dropdown in the sidebar.

Types: `none`, `rule-of-thirds`, `grid` (configurable cell size), `golden-ratio`, `diagonal`, `triangle`, `golden-spiral`.

Overlay is implemented via a second `<canvas class="grid-overlay">` per cell, positioned identically to the main canvas with `pointer-events: none`. Drawing methods are in `app.js`: `drawOverlay`, `drawRuleOfThirds`, `drawGridLines`, `drawGoldenRatio`, `drawDiagonal`, `drawTriangle`, `drawGoldenSpiral`.

### Golden Spiral (drawGoldenSpiral)

Implemented as a logarithmic spiral r(θ) = a·e^(b·θ) where b = ln(φ)/(π/2). The spiral starts from the selected corner and winds inward toward the φ-power point (the "eye") opposite the starting corner. The φ-power points (0.382 and 0.618 of w/h) are used as eye positions — matching `drawGoldenRatio` grid lines.

The spiral is drawn from ~2.5 turns before entering the frame (outside the canvas) inward to r ≈ 2px near the eye. Only visible segments are rendered.

Corner selection (`overlaySpiralCorner`): `bottom-right`, `top-right`, `top-left`, `bottom-left`. Default: `bottom-right`. Controls shown when `golden-spiral` is selected in the overlay type dropdown.
