import { effects } from './effects.js';

class RayLightApp {
    constructor() {
        this.images = [];
        this.currentIndex = 0;
        this.zoom = 1;
        this.pan = { x: 0, y: 0 };
        this.zoomMode = 'auto'; // 'auto' or 'manual'
        this.rotation = 0;
        this.flipH = 1;
        this.flipV = 1;
        this.gridType = '1';
        this.fitGridToAspect = true;
        this.activeEffects = [];
        this.overlayGridType = 'none';
        this.overlayGridSize = 3;
        this.overlaySpiralCorner = 'bottom-right';
        this.cache = new Map(); // filename_effectIdx -> { canvas, status }
        this.blobCache = new Map(); // filename -> Blob (avoid re-fetch for worker)
        this.workers = [];
        this.workerCount = 1;
        this.workerBusy = false;
        this.pendingTask = null; // single next task (replaces queue)
        this.activeTasks = new Map();
        this.navigationGeneration = 0;
        this.lastNavigationDir = 1;

        this.init();
    }

    async init() {
        this.initWorkers();
        this.initElements();
        this.initEventListeners();
        this.initPalette();
        this.loadSettings();

        await this.fetchImages();
        this.renderGrid();
        this.updateUI();

        if (this.images.length > 0) {
            await this.updateCurrentImages();
        }
    }

    initWorkers() {
        for (let i = 0; i < this.workerCount; i++) {
            const worker = new Worker('js/worker.js');
            worker.onmessage = (e) => this.handleWorkerMessage(e.data);
            this.workers.push(worker);
        }
    }

    initEventListeners() {
        // Grid resize
        this.els.gridSelect.addEventListener('change', (e) => {
            this.gridType = e.target.value;
            this.renderGrid();
            this.limitEffects();
            this.cancelPending();
            this.updateCurrentImages();
            this.saveSettings();
        });

        this.els.fitAspectToggle.addEventListener('change', (e) => {
            this.fitGridToAspect = e.target.checked;
            this.updateGridSize();
            this.applyTransform();
            this.saveSettings();
        });

        // Overlay grid
        this.els.overlayGridSelect.addEventListener('change', (e) => {
            this.overlayGridType = e.target.value;
            this.els.overlayGridSizeGroup.style.display = this.overlayGridType === 'grid' ? '' : 'none';
            this.els.overlaySpiralCornerGroup.style.display = this.overlayGridType === 'golden-spiral' ? '' : 'none';
            this.redrawOverlays();
            this.saveSettings();
        });

        this.els.overlayGridSize.addEventListener('change', (e) => {
            this.overlayGridSize = parseInt(e.target.value);
            this.redrawOverlays();
            this.saveSettings();
        });

        this.els.overlaySpiralCorner.addEventListener('change', (e) => {
            this.overlaySpiralCorner = e.target.value;
            this.redrawOverlays();
            this.saveSettings();
        });

        // Background picker
        document.querySelectorAll('.bg-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                const bg = swatch.dataset.bg;
                document.body.className = `theme-dark bg-${bg}`;
                document.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
            });
        });

        // Navigation
        this.els.prevBtn.addEventListener('click', () => this.navigate(-1));
        this.els.nextBtn.addEventListener('click', () => this.navigate(1));
        window.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') this.navigate(-1);
            if (e.key === 'ArrowRight') this.navigate(1);
        });

        // View controls
        document.getElementById('rotate-90').addEventListener('click', () => {
            this.rotation = (this.rotation + 90) % 360;
            this.applyTransform();
        });
        document.getElementById('flip-h').addEventListener('click', () => {
            this.flipH *= -1;
            this.applyTransform();
        });
        document.getElementById('flip-v').addEventListener('click', () => {
            this.flipV *= -1;
            this.applyTransform();
        });
        document.getElementById('reset-view').addEventListener('click', () => {
            this.zoom = 1;
            this.pan = { x: 0, y: 0 };
            this.rotation = 0;
            this.flipH = 1;
            this.flipV = 1;
            this.applyTransform();
            this.updateUI();
        });

        // Splitter
        let isResizing = false;
        this.els.resizer.addEventListener('mousedown', () => isResizing = true);
        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const width = window.innerWidth - e.clientX;
            if (width > 150 && width < 600) {
                document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
            }
        });
        window.addEventListener('mouseup', () => isResizing = false);

        // Window resize
        window.addEventListener('resize', () => {
            this.updateGridSize();
            this.applyTransform();
        });

        // Zoom & Pan
        this.els.gridContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.zoomMode = 'manual';
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom *= delta;
            this.zoom = Math.max(0.1, Math.min(10, this.zoom));
            this.applyTransform();
            this.updateUI();
        }, { passive: false });

        let isPanning = false;
        let startPan = { x: 0, y: 0 };
        this.els.gridContainer.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                isPanning = true;
                startPan = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            this.zoomMode = 'manual';
            this.pan.x = e.clientX - startPan.x;
            this.pan.y = e.clientY - startPan.y;
            this.applyTransform();
            this.updateUI();
        });
        window.addEventListener('mouseup', () => isPanning = false);

        // Double click to reset to auto
        this.els.gridContainer.addEventListener('dblclick', () => {
            this.zoomMode = 'auto';
            this.applyTransform();
            this.updateUI();
        });

        // Sortable
        new Sortable(this.els.activeEffectsList, {
            animation: 150,
            handle: '.effect-header',
            onEnd: () => {
                this.updateEffectsFromDOM();
                this.cancelPending();
                this.clearCache();
                this.updateCurrentImages();
                this.saveSettings();
            }
        });
    }

    initElements() {
        this.els = {
            workspace: document.getElementById('workspace'),
            gridContainer: document.getElementById('grid-container'),
            sidebar: document.getElementById('sidebar'),
            resizer: document.getElementById('resizer'),
            gridSelect: document.getElementById('grid-select'),
            activeEffectsList: document.getElementById('active-effects'),
            palette: document.getElementById('available-effects'),
            filenameInfo: document.getElementById('current-filename'),
            zoomInfo: document.getElementById('zoom-info'),
            indexInfo: document.getElementById('index-info'),
            prevBtn: document.getElementById('prev-btn'),
            nextBtn: document.getElementById('next-btn'),
            effectLimitMsg: document.getElementById('effect-limit-msg'),
            fitAspectToggle: document.getElementById('fit-aspect-toggle'),
            overlayGridSelect: document.getElementById('overlay-grid-select'),
            overlayGridSize: document.getElementById('overlay-grid-size'),
            overlayGridSizeGroup: document.getElementById('overlay-grid-size-group'),
            overlaySpiralCorner: document.getElementById('overlay-spiral-corner'),
            overlaySpiralCornerGroup: document.getElementById('overlay-spiral-corner-group')
        };
    }

    initPalette() {
        Object.keys(effects).forEach(type => {
            const effect = effects[type];
            const item = document.createElement('div');
            item.className = 'palette-item';
            item.textContent = effect.name;
            item.onclick = () => this.addEffect(type);
            this.els.palette.appendChild(item);
        });
    }

    async fetchImages() {
        try {
            const resp = await fetch('/api/images');
            this.images = await resp.json();
        } catch (e) {
            console.error("Failed to fetch images", e);
        }
    }

    renderGrid() {
        this.els.gridContainer.innerHTML = '';
        const count = this.getGridCount();
        this.els.gridContainer.className = `grid-${this.gridType}`;

        for (let i = 0; i < count; i++) {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.innerHTML = `
                <div class="canvas-container" id="container-${i}">
                    <canvas id="canvas-${i}"></canvas>
                    <canvas id="overlay-${i}" class="grid-overlay"></canvas>
                </div>
                <div class="cell-status" id="status-${i}">
                    <span class="effect-name">-</span>
                    <span class="process-info"></span>
                </div>
            `;
            this.els.gridContainer.appendChild(cell);
        }
        this.updateGridSize();
        this.applyTransform();
    }

    getGridCount() {
        if (this.gridType === '1') return 1;
        const [w, h] = this.gridType.split('x').map(Number);
        return w * h;
    }

    getGridDimensions() {
        if (this.gridType === '1') return [1, 1];
        return this.gridType.split('x').map(Number);
    }

    addEffect(type) {
        const count = this.getGridCount();
        if (this.activeEffects.length >= count) {
            this.els.effectLimitMsg.style.display = 'block';
            setTimeout(() => this.els.effectLimitMsg.style.display = 'none', 3000);
            return;
        }

        const effectDef = effects[type];
        const effectInstance = {
            id: Date.now() + Math.random(),
            type: type,
            params: {}
        };
        effectDef.params.forEach(p => effectInstance.params[p.name] = p.default);

        this.activeEffects.push(effectInstance);
        this.renderActiveEffects();
        this.cancelPending();
        this.clearCache();
        this.updateCurrentImages();
        this.saveSettings();
    }

    limitEffects() {
        const count = this.getGridCount();
        if (this.activeEffects.length > count) {
            this.activeEffects = this.activeEffects.slice(0, count);
            this.renderActiveEffects();
        }
    }

    renderActiveEffects() {
        this.els.activeEffectsList.innerHTML = '';
        this.activeEffects.forEach((eff, index) => {
            const def = effects[eff.type];
            const li = document.createElement('li');
            li.className = 'effect-item';
            li.dataset.id = eff.id;

            let paramsHtml = '';
            def.params.forEach(p => {
                paramsHtml += `
                    <label>${p.name}</label>
                    ${p.type === 'select'
                        ? `<select data-param="${p.name}">${p.options.map(o => `<option value="${o}" ${eff.params[p.name] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
                        : `<input type="${p.type}" data-param="${p.name}" value="${eff.params[p.name]}" step="${p.step || 1}">`
                    }
                `;
            });

            li.innerHTML = `
                <div class="effect-header">
                    <span>${index + 1}. ${def.name}</span>
                    <button class="remove-eff" title="Удалить"><i class="fas fa-times"></i></button>
                </div>
                ${paramsHtml ? `<div class="effect-params">${paramsHtml}</div>` : ''}
            `;

            li.querySelector('.remove-eff').onclick = () => {
                this.activeEffects = this.activeEffects.filter(e => e.id !== eff.id);
                this.renderActiveEffects();
                this.cancelPending();
                this.clearCache();
                this.updateCurrentImages();
                this.saveSettings();
            };

            li.querySelectorAll('input, select').forEach(input => {
                input.onchange = (e) => {
                    eff.params[e.target.dataset.param] = e.target.value;
                    this.cancelPending();
                    this.clearCache();
                    this.updateCurrentImages();
                    this.saveSettings();
                };
            });

            this.els.activeEffectsList.appendChild(li);
        });
    }

    updateEffectsFromDOM() {
        const newOrder = [];
        this.els.activeEffectsList.querySelectorAll('.effect-item').forEach(li => {
            const id = parseFloat(li.dataset.id);
            const eff = this.activeEffects.find(e => e.id === id);
            if (eff) newOrder.push(eff);
        });
        this.activeEffects = newOrder;
        this.renderActiveEffects();
    }

    cancelPending() {
        this.navigationGeneration++;
        if (this.pendingTask) {
            this.pendingTask.resolve(null);
            this.pendingTask = null;
        }
        this.blobCache.clear();
    }

    async navigate(dir) {
        const newIndex = this.currentIndex + dir;
        if (newIndex >= 0 && newIndex < this.images.length) {
            this.navigationGeneration++;
            this.lastNavigationDir = dir;
            if (this.pendingTask) {
                this.pendingTask.resolve(null);
                this.pendingTask = null;
            }
            this.currentIndex = newIndex;
            this.updateUI();
            await this.updateCurrentImages();
            this.preloadAround(dir);
        }
    }

    async updateCurrentImages() {
        const count = this.getGridCount();
        const filename = this.images[this.currentIndex];
        if (!filename) return;

        const generation = this.navigationGeneration;

        let blob = null;
        if (this.images.length > 0) {
            try {
                blob = await this.loadImageBlob(filename);
                if (generation !== this.navigationGeneration) return;
                this.blobCache.set(filename, blob);
                const imgBitmap = await createImageBitmap(blob);
                this.currentImageAspect = imgBitmap.width / imgBitmap.height;
                imgBitmap.close();
                this.updateGridSize();
            } catch (e) {
                console.error("Failed to load image aspect ratio", e);
            }
        }

        for (let i = 0; i < count; i++) {
            if (generation !== this.navigationGeneration) return;

            const canvas = document.getElementById(`canvas-${i}`);
            const status = document.getElementById(`status-${i}`);
            if (!canvas) continue;

            const effect = this.activeEffects[i];
            if (!effect) {
                canvas.style.display = 'none';
                status.querySelector('.effect-name').textContent = 'Нет эффекта';
                status.querySelector('.process-info').textContent = '';
                continue;
            }

            canvas.style.display = 'block';
            status.querySelector('.effect-name').textContent = effects[effect.type].name;

            await this.processImage(filename, i, effect, canvas, status.querySelector('.process-info'), generation);
        }
    }

    async processImage(filename, effectIdx, effect, targetCanvas, statusEl, generation) {
        if (generation === undefined) generation = this.navigationGeneration;

        // Check cache
        const cacheKey = `${filename}_${effectIdx}`;
        if (this.cache.has(cacheKey)) {
            if (generation !== this.navigationGeneration) return;
            const cached = this.cache.get(cacheKey);
            this.copyCanvas(cached.canvas, targetCanvas);
            if (statusEl) statusEl.textContent = cached.status + ' (кэш)';

            if (effect.type === 'itten_circle' && (cached.status.includes('Круг Иттена:') || cached.status.includes('Itten Circle:'))) {
                this.drawIttenPercentages(targetCanvas, cached.status);
            }

            this.drawOverlay(effectIdx);
            this.applyTransform();
            this.updateUI();
            return;
        }

        if (statusEl) statusEl.textContent = 'обработка...';

        try {
            // Reuse blob from blobCache or fetch fresh
            let blob = this.blobCache.get(filename);
            if (!blob) {
                blob = await this.loadImageBlob(filename);
                if (generation !== this.navigationGeneration) return;
                this.blobCache.set(filename, blob);
            }

            const result = await this.runWorker(blob, effect.type, effect.params, generation);
            if (!result || generation !== this.navigationGeneration) return;

            const offscreen = document.createElement('canvas');
            offscreen.width = result.imageData.width;
            offscreen.height = result.imageData.height;
            offscreen.getContext('2d').putImageData(result.imageData, 0, 0);

            const cached = this.downscaleToDisplay(offscreen);
            this.cache.set(cacheKey, { canvas: cached, status: result.status });
            this.pruneCache();

            if (generation !== this.navigationGeneration) return;
            this.copyCanvas(cached, targetCanvas);
            if (statusEl) statusEl.textContent = result.status;

            if (effect.type === 'itten_circle' && result.status.includes('Круг Иттена:')) {
                this.drawIttenPercentages(targetCanvas, result.status);
            }

            this.drawOverlay(effectIdx);
            this.applyTransform();
            this.updateUI();
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.textContent = 'ошибка';
        }
    }

    pruneCache() {
        const allowedFilenames = new Set();
        for (let i = -2; i <= 2; i++) {
            const idx = this.currentIndex + i;
            if (idx >= 0 && idx < this.images.length) {
                allowedFilenames.add(this.images[idx]);
            }
        }
        for (const key of this.cache.keys()) {
            const filename = key.substring(0, key.lastIndexOf('_'));
            if (!allowedFilenames.has(filename)) {
                this.cache.delete(key);
            }
        }
        for (const filename of this.blobCache.keys()) {
            if (!allowedFilenames.has(filename)) {
                this.blobCache.delete(filename);
            }
        }
    }

    async loadImageBlob(filename) {
        const resp = await fetch(`/api/image/${filename}`);
        if (!resp.ok) throw new Error(`Failed to fetch image ${filename}`);
        return await resp.blob();
    }

    runWorker(blob, effectType, params, generation) {
        if (generation === undefined) generation = this.navigationGeneration;
        return new Promise((resolve) => {
            const taskId = Math.random();
            const task = { blob, effectType, params, taskId, resolve, generation };

            if (this.workerBusy) {
                // Replace pending: only the latest task matters
                if (this.pendingTask) {
                    this.pendingTask.resolve(null);
                }
                this.pendingTask = task;
            } else {
                this.sendToWorker(task);
            }
        });
    }

    sendToWorker(task) {
        this.workerBusy = true;
        this.activeTasks.set(task.taskId, { resolve: task.resolve, generation: task.generation });
        this.workers[0].postMessage({
            imageBlob: task.blob,
            effectType: task.effectType,
            params: task.params,
            taskId: task.taskId
        });
    }

    handleWorkerMessage(data) {
        const { imageData, status, taskId, error } = data;
        const task = this.activeTasks.get(taskId);
        if (!task) return;

        this.activeTasks.delete(taskId);
        this.workerBusy = false;

        if (error || !imageData || task.generation !== this.navigationGeneration) {
            task.resolve(null);
        } else {
            task.resolve({ imageData, status });
        }

        // Process pending task if still current
        if (this.pendingTask && this.pendingTask.generation === this.navigationGeneration) {
            const next = this.pendingTask;
            this.pendingTask = null;
            this.sendToWorker(next);
        }
    }

    updateGridSize() {
        const workspace = this.els.workspace;
        const statusBar = document.getElementById('status-bar');
        const availableWidth = workspace.clientWidth - 20;
        const availableHeight = workspace.clientHeight - statusBar.clientHeight - 20;

        if (!this.currentImageAspect || !this.fitGridToAspect) {
            this.els.gridContainer.style.width = '100%';
            this.els.gridContainer.style.height = '100%';
            this.els.gridContainer.style.flex = '1';
            this.els.gridContainer.style.margin = '0';
            return;
        }

        const [cols, rows] = this.getGridDimensions();
        const gridAspect = (this.currentImageAspect * cols) / rows;

        const workspaceAspect = availableWidth / availableHeight;

        let gridWidth, gridHeight;

        if (gridAspect > workspaceAspect) {
            gridWidth = availableWidth;
            gridHeight = availableWidth / gridAspect;
        } else {
            gridHeight = availableHeight;
            gridWidth = availableHeight * gridAspect;
        }

        this.els.gridContainer.style.width = `${gridWidth}px`;
        this.els.gridContainer.style.height = `${gridHeight}px`;
        this.els.gridContainer.style.flex = 'none';
        this.els.gridContainer.style.margin = 'auto';
    }

    // === Overlay Grid Drawing ===

    redrawOverlays() {
        const count = this.getGridCount();
        for (let i = 0; i < count; i++) {
            this.drawOverlay(i);
        }
    }

    drawOverlay(cellIndex) {
        const overlay = document.getElementById(`overlay-${cellIndex}`);
        const canvas = document.getElementById(`canvas-${cellIndex}`);
        if (!overlay || !canvas) return;

        const ctx = overlay.getContext('2d');

        if (this.overlayGridType === 'none' || !canvas.width || !canvas.height) {
            overlay.width = 0;
            overlay.height = 0;
            return;
        }

        const effect = this.activeEffects[cellIndex];
        if (effect && (effect.type === 'histogram' || effect.type === 'itten_circle')) {
            overlay.width = 0;
            overlay.height = 0;
            return;
        }

        overlay.width = canvas.width;
        overlay.height = canvas.height;

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        const w = overlay.width;
        const h = overlay.height;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = Math.max(1, Math.min(w, h) / 400);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = `bold ${Math.max(10, Math.min(w, h) / 40)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        switch (this.overlayGridType) {
            case 'rule-of-thirds': this.drawRuleOfThirds(ctx, w, h); break;
            case 'grid': this.drawGridLines(ctx, w, h, this.overlayGridSize); break;
            case 'golden-ratio': this.drawGoldenRatio(ctx, w, h); break;
            case 'diagonal': this.drawDiagonal(ctx, w, h); break;
            case 'triangle': this.drawTriangle(ctx, w, h); break;
            case 'golden-spiral': this.drawGoldenSpiral(ctx, w, h, this.overlaySpiralCorner); break;
        }
    }

    drawRuleOfThirds(ctx, w, h) {
        ctx.beginPath();
        ctx.moveTo(w / 3, 0); ctx.lineTo(w / 3, h);
        ctx.moveTo(2 * w / 3, 0); ctx.lineTo(2 * w / 3, h);
        ctx.moveTo(0, h / 3); ctx.lineTo(w, h / 3);
        ctx.moveTo(0, 2 * h / 3); ctx.lineTo(w, 2 * h / 3);
        ctx.stroke();
    }

    drawGridLines(ctx, w, h, n) {
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
            ctx.moveTo(w * i / n, 0); ctx.lineTo(w * i / n, h);
            ctx.moveTo(0, h * i / n); ctx.lineTo(w, h * i / n);
        }
        ctx.stroke();
    }

    drawGoldenRatio(ctx, w, h) {
        const phi = 1.618;
        const a = 1 / (phi * phi);
        const b = 1 / phi;

        ctx.beginPath();
        // Vertical
        ctx.moveTo(w * a, 0); ctx.lineTo(w * a, h);
        ctx.moveTo(w * b, 0); ctx.lineTo(w * b, h);
        // Horizontal
        ctx.moveTo(0, h * a); ctx.lineTo(w, h * a);
        ctx.moveTo(0, h * b); ctx.lineTo(w, h * b);
        ctx.stroke();
    }

    drawDiagonal(ctx, w, h) {
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(w, h);
        ctx.moveTo(w, 0); ctx.lineTo(0, h);
        ctx.stroke();
    }

    drawTriangle(ctx, w, h) {
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(w, h);
        ctx.moveTo(w, 0); ctx.lineTo(0, h);
        // Lines from bottom corners to top midpoint
        ctx.moveTo(0, h); ctx.lineTo(w / 2, 0);
        ctx.moveTo(w, h); ctx.lineTo(w / 2, 0);
        ctx.stroke();
    }

    drawGoldenSpiral(ctx, w, h, corner) {
        const n = 11;

        const fibs = [1, 1];
        for (let i = 2; i < n; i++) fibs.push(fibs[i - 1] + fibs[i - 2]);

        const scale = Math.min(w, h) * 0.8 / fibs[n - 1];

        let eyeX, eyeY;
        switch (corner) {
            case 'top-left':
                eyeX = w * 0.618; eyeY = h * 0.618;
                break;
            case 'top-right':
                eyeX = w * 0.382; eyeY = h * 0.618;
                break;
            case 'bottom-left':
                eyeX = w * 0.618; eyeY = h * 0.382;
                break;
            case 'bottom-right':
            default:
                eyeX = w * 0.382; eyeY = h * 0.382;
                break;
        }

        const squares = [];
        let size = fibs[0] * scale;
        let x = eyeX - size / 2;
        let y = eyeY - size / 2;
        squares.push({ x, y, size });

        let minX = x, minY = y, maxX = x + size, maxY = y + size;

        for (let i = 1; i < n; i++) {
            size = fibs[i] * scale;
            const pDir = (i - 1) % 4;
            let nx, ny;

            if (pDir === 0) {
                nx = maxX; ny = maxY - size; maxX = nx + size;
            } else if (pDir === 1) {
                nx = maxX - size; ny = minY - size; minY = ny;
            } else if (pDir === 2) {
                nx = minX - size; ny = minY; minX = nx;
            } else {
                nx = minX; ny = maxY; maxY = ny + size;
            }

            squares.push({ x: nx, y: ny, size });
        }

        ctx.save();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        for (const s of squares) {
            const right = s.x + s.size;
            const bottom = s.y + s.size;
            if (right < 0 || s.x > w || bottom < 0 || s.y > h) continue;
            ctx.strokeRect(
                Math.max(s.x, 0), Math.max(s.y, 0),
                Math.min(s.size, w - Math.max(s.x, 0)),
                Math.min(s.size, h - Math.max(s.y, 0))
            );
        }

        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = Math.max(2, Math.min(4, Math.min(w, h) / 200));
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = Math.max(4, Math.min(12, Math.min(w, h) / 80));
        ctx.beginPath();

        for (let i = 0; i < squares.length; i++) {
            const s = squares[i];
            const dir = i % 4;
            let cx, cy, start, end;

            if (dir === 0) {
                cx = s.x; cy = s.y + s.size; start = 1.5 * Math.PI; end = 2.0 * Math.PI;
            } else if (dir === 1) {
                cx = s.x + s.size; cy = s.y + s.size; start = Math.PI; end = 1.5 * Math.PI;
            } else if (dir === 2) {
                cx = s.x + s.size; cy = s.y; start = 0.5 * Math.PI; end = Math.PI;
            } else {
                cx = s.x; cy = s.y; start = 0; end = 0.5 * Math.PI;
            }

            if (i === 0) {
                ctx.moveTo(cx + s.size * Math.cos(start), cy + s.size * Math.sin(start));
            }
            ctx.arc(cx, cy, s.size, start, end, false);
        }

        ctx.stroke();
        ctx.restore();
    }

    // === End Overlay Grid Drawing ===

    drawIttenPercentages(canvas, status) {
        const ctx = canvas.getContext('2d');
        const statusPart = status.split(': ')[1].split(' (')[0].trim();
        const percents = statusPart.split('% ').map(s => s.replace('%', ''));
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(canvas.width, canvas.height) * 0.3;

        ctx.font = `bold ${Math.max(14, canvas.width / 35)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const ittenColors = [
            [255, 255, 0], [255, 200, 0], [255, 150, 0], [255, 80, 0],
            [255, 0, 0], [200, 0, 100], [130, 0, 200], [80, 0, 255],
            [0, 0, 255], [0, 150, 200], [0, 255, 0], [150, 255, 0]
        ];

        for (let i = 0; i < 12; i++) {
            const angle = (i * 30 + 15) * Math.PI / 180 - Math.PI / 2;
            const x = centerX + Math.cos(angle) * radius;
            const y = centerY + Math.sin(angle) * radius;

            const bg = ittenColors[i];
            const invR = 255 - bg[0], invG = 255 - bg[1], invB = 255 - bg[2];
            ctx.fillStyle = `rgb(${invR}, ${invG}, ${invB})`;

            ctx.fillText(`${percents[i]}%`, x, y);
        }
    }

    copyCanvas(src, dest) {
        dest.width = src.width;
        dest.height = src.height;
        const ctx = dest.getContext('2d');
        ctx.drawImage(src, 0, 0);
    }

    downscaleToDisplay(fullResCanvas) {
        return fullResCanvas;
    }

    applyTransform() {
        const count = this.getGridCount();
        const container = document.querySelector('.canvas-container');
        if (!container) return;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        for (let i = 0; i < count; i++) {
            const canvas = document.getElementById(`canvas-${i}`);
            const overlay = document.getElementById(`overlay-${i}`);
            if (canvas) {
                const effect = this.activeEffects[i];
                const isAnalysis = effect && (effect.type === 'histogram' || effect.type === 'itten_circle');

                if (isAnalysis || this.zoomMode === 'auto') {
                    const scaleX = containerWidth / canvas.width;
                    const scaleY = containerHeight / canvas.height;
                    const scale = Math.min(scaleX, scaleY);

                    if (isAnalysis) {
                        canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
                        if (overlay) overlay.style.transform = canvas.style.transform;
                    } else {
                        this.zoom = scale;
                        this.pan = { x: 0, y: 0 };
                        const t = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) rotate(${this.rotation}deg) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
                        canvas.style.transform = t;
                        if (overlay) overlay.style.transform = t;
                    }
                } else {
                    const t = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) rotate(${this.rotation}deg) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
                    canvas.style.transform = t;
                    if (overlay) overlay.style.transform = t;
                }
            }
        }
    }

    updateUI() {
        const filename = this.images[this.currentIndex] || '-';
        const indexStr = `${this.currentIndex + 1} / ${this.images.length}`;

        this.els.filenameInfo.textContent = filename;
        this.els.indexInfo.textContent = indexStr;
        const modeRu = this.zoomMode === 'auto' ? 'авто' : 'ручной';
        this.els.zoomInfo.textContent = `Масштаб: ${Math.round(this.zoom * 100)}% (${modeRu})`;

        document.title = filename !== '-' ? `${filename} (${indexStr}) | Ray-Light` : 'Ray-Light';
    }

    clearCache() {
        this.cache.clear();
        this.blobCache.clear();
    }

    preloadAround(dir) {
        const start = dir > 0 ? this.currentIndex + 1 : this.currentIndex - 1;
        const step = dir > 0 ? 1 : -1;
        (async () => {
            for (let offset = 0; offset < 2; offset++) {
                const idx = start + step * offset;
                if (idx < 0 || idx >= this.images.length) break;
                await this.preloadImage(idx);
            }
        })();
    }

    async preloadImage(idx) {
        if (idx < 0 || idx >= this.images.length) return;
        const filename = this.images[idx];
        const generation = this.navigationGeneration;

        for (let i = 0; i < this.activeEffects.length; i++) {
            if (generation !== this.navigationGeneration) return;
            const cacheKey = `${filename}_${i}`;
            if (!this.cache.has(cacheKey)) {
                const effect = this.activeEffects[i];
                await this.processImage(filename, i, effect, document.createElement('canvas'), null, generation);
            }
        }
    }

    saveSettings() {
        const settings = {
            gridType: this.gridType,
            fitGridToAspect: this.fitGridToAspect,
            overlayGridType: this.overlayGridType,
            overlayGridSize: this.overlayGridSize,
            overlaySpiralCorner: this.overlaySpiralCorner,
            activeEffects: this.activeEffects.map(e => ({ type: e.type, params: e.params }))
        };
        localStorage.setItem('ray_light_settings', JSON.stringify(settings));
    }

    loadSettings() {
        const saved = localStorage.getItem('ray_light_settings');
        if (saved) {
            try {
                const settings = JSON.parse(saved);
                this.gridType = settings.gridType || '1';
                this.els.gridSelect.value = this.gridType;

                this.fitGridToAspect = settings.fitGridToAspect ?? true;
                this.els.fitAspectToggle.checked = this.fitGridToAspect;

                this.overlayGridType = settings.overlayGridType || 'none';
                this.els.overlayGridSelect.value = this.overlayGridType;
                this.els.overlayGridSizeGroup.style.display = this.overlayGridType === 'grid' ? '' : 'none';
                this.els.overlaySpiralCornerGroup.style.display = this.overlayGridType === 'golden-spiral' ? '' : 'none';

                this.overlayGridSize = settings.overlayGridSize || 3;
                this.els.overlayGridSize.value = this.overlayGridSize;

                this.overlaySpiralCorner = settings.overlaySpiralCorner || 'bottom-right';
                this.els.overlaySpiralCorner.value = this.overlaySpiralCorner;

                this.activeEffects = (settings.activeEffects || []).map(e => ({
                    id: Math.random(),
                    type: e.type,
                    params: e.params
                }));
                this.renderActiveEffects();
            } catch (e) {
                console.error("Failed to load settings", e);
            }
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new RayLightApp();
});
