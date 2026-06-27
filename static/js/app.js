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
        this.activeEffects = [];
        this.cache = new Map(); // filename_effectIdx -> { canvas, status }
        this.blobCache = new Map(); // filename -> Blob (avoid re-fetch for worker)
        this.workers = [];
        this.workerCount = 1;
        this.workerBusy = false;
        this.pendingTask = null; // single next task (replaces queue)
        this.activeTasks = new Map();
        this.navigationGeneration = 0;
        this.lastNavigationDir = 1;
        this._prevLayout = null;
        this.originalAspect = null;
        this.favorites = new Set();
 
        this.init();
    }

    async saveSettingsToApi(settings) {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
        } catch (e) {
            // API unavailable — localStorage fallback handles it
        }
    }

    async loadSettingsFromApi() {
        try {
            const resp = await fetch('/api/settings');
            if (resp.ok) {
                return await resp.json();
            }
        } catch (e) {}
        return null;
    }

    async init() {
        this.initWorkers();
        this.initElements();
        this.initEventListeners();
        this.initPalette();
        await this.loadSettings();

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
        this.els.sidebarPrevBtn.addEventListener('click', () => this.navigate(-1));
        this.els.sidebarNextBtn.addEventListener('click', () => this.navigate(1));
        this.els.favBtn.addEventListener('click', () => this.toggleFavorite());
        document.getElementById('copy-fav-btn').addEventListener('click', () => this.copyFavorites());
        window.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') this.navigate(-1);
            if (e.key === 'ArrowRight') this.navigate(1);
            if (e.code === 'Backquote') this.toggleFavorite();
        });

        // View controls
        document.getElementById('rotate-90').addEventListener('click', () => {
            this.rotation = (this.rotation + 90) % 360;
            this.updateRotateUI();
            const isFlipped = this.rotation % 180 !== 0;
            this.currentImageAspect = isFlipped && this.originalAspect ? 1 / this.originalAspect : this.originalAspect;
            this.zoomMode = 'auto';
            this.zoom = 1;
            this.pan = { x: 0, y: 0 };
            this.cancelPending();
            this.clearCache();
            this.recomputeLayout();
            this.updateCurrentImages();
        });
        document.getElementById('flip-h').addEventListener('click', () => {
            this.flipH *= -1;
            this.updateFlipUI();
            this.applyTransform();
        });
        document.getElementById('flip-v').addEventListener('click', () => {
            this.flipV *= -1;
            this.updateFlipUI();
            this.applyTransform();
        });
        document.getElementById('reset-view').addEventListener('click', () => {
            this.zoom = 1;
            this.pan = { x: 0, y: 0 };
            this.rotation = 0;
            this.flipH = 1;
            this.flipV = 1;
            this.currentImageAspect = this.originalAspect;
            this.cancelPending();
            this.clearCache();
            this.recomputeLayout();
            this.updateCurrentImages();
            this.updateFlipUI();
            this.updateRotateUI();
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
            if (this.recomputeLayout()) {
                this.cancelPending();
                this.clearCache();
                this.updateCurrentImages();
            }
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
            activeEffectsList: document.getElementById('active-effects'),
            palette: document.getElementById('available-effects'),
            filenameInfo: document.getElementById('current-filename'),
            zoomInfo: document.getElementById('zoom-info'),
            indexInfo: document.getElementById('index-info'),
            favBtn: document.getElementById('fav-btn'),
            favCount: document.getElementById('fav-count'),
            sidebarPrevBtn: document.getElementById('sidebar-prev-btn'),
            sidebarNextBtn: document.getElementById('sidebar-next-btn'),
            effectLimitMsg: document.getElementById('effect-limit-msg')
        };
        this.createHeartOverlay();
    }

    createHeartOverlay() {
        this.els.heartOverlay = document.createElement('div');
        this.els.heartOverlay.id = 'heart-overlay';
        this.els.heartOverlay.innerHTML = '<i class="fas fa-heart"></i>';
        this.els.workspace.appendChild(this.els.heartOverlay);
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

    computeGridLayout() {
        const n = this.activeEffects.length;
        if (n <= 0) return { cols: 1, rows: 1, total: 1 };
        if (n === 1) return { cols: 1, rows: 1, total: 1 };

        const ar = this.currentImageAspect;
        if (!ar) {
            let best = null;
            for (let cols = 1; cols <= 9; cols++) {
                for (let rows = 1; rows <= 9; rows++) {
                    if (cols * rows < n || cols * rows > 9) continue;
                    const waste = cols * rows - n;
                    const balanced = Math.abs(cols - rows);
                    const preferCols = cols >= rows;
                    if (!best || waste < best.waste ||
                        (waste === best.waste && preferCols && !best.preferCols) ||
                        (waste === best.waste && preferCols === best.preferCols && balanced < best.balanced)) {
                        best = { cols, rows, total: cols * rows, waste, balanced, preferCols };
                    }
                }
            }
            return best || { cols: 1, rows: 1, total: 1 };
        }

        const availW = this.els.workspace.clientWidth - 20;
        const statusBar = document.getElementById('status-bar');
        const availH = this.els.workspace.clientHeight - statusBar.clientHeight - 20;
        const wsAr = availW / availH;

        let best = null;
        let bestCoverage = -1;

        for (let cols = 1; cols <= 9; cols++) {
            for (let rows = 1; rows <= 9; rows++) {
                if (cols * rows < n || cols * rows > 9) continue;

                const gridAr = (ar * cols) / rows;
                let gridW, gridH;
                if (gridAr > wsAr) {
                    gridW = availW;
                    gridH = availW / gridAr;
                } else {
                    gridH = availH;
                    gridW = availH * gridAr;
                }

                const cellW = gridW / cols;
                const cellH = gridH / rows;
                const scale = Math.min(cellW / ar, cellH);
                const coverage = n * ar * scale * scale;

                if (coverage > bestCoverage) {
                    bestCoverage = coverage;
                    best = { cols, rows, total: cols * rows };
                }
            }
        }

        return best || { cols: 1, rows: 1, total: 1 };
    }

    renderGrid() {
        this.els.gridContainer.innerHTML = '';
        const layout = this.computeGridLayout();
        const count = Math.max(this.activeEffects.length, 1);
        const gap = 10;

        const cellWidth = `calc((100% - ${(layout.cols - 1) * gap}px) / ${layout.cols})`;
        const cellHeight = `calc((100% - ${(layout.rows - 1) * gap}px) / ${layout.rows})`;

        for (let i = 0; i < count; i++) {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.style.width = cellWidth;
            cell.style.height = cellHeight;
            cell.innerHTML = `
                <div class="canvas-container" id="container-${i}">
                    <canvas id="canvas-${i}"></canvas>
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

    recomputeLayout() {
        const layout = this.computeGridLayout();
        const count = Math.max(this.activeEffects.length, 1);
        const currentCells = this.els.gridContainer.children.length;
        const sameGrid = this._prevLayout && this._prevLayout.cols === layout.cols && this._prevLayout.rows === layout.rows;
        const sameCount = currentCells === count;

        if (sameGrid && sameCount) {
            this.updateGridSize();
            this.applyTransform();
            return false;
        } else {
            this.renderGrid();
            this._prevLayout = { cols: layout.cols, rows: layout.rows };
            return true;
        }
    }

    addEffect(type) {
        if (this.activeEffects.length >= 9) {
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
        this.recomputeLayout();
        this.renderActiveEffects();
        this.cancelPending();
        this.clearCache();
        this.updateCurrentImages();
        this.saveSettings();
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
                    <label>${p.label || p.name}</label>
                    ${p.type === 'select'
                        ? `<select data-param="${p.name}">${p.options.map(o => `<option value="${o.value || o}" ${(eff.params[p.name] === (o.value || o)) ? 'selected' : ''}>${o.label || o}</option>`).join('')}</select>`
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
                this.recomputeLayout();
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
        const count = Math.max(this.activeEffects.length, 1);
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
                this.originalAspect = imgBitmap.width / imgBitmap.height;
                this.currentImageAspect = (this.rotation % 180 !== 0) ? 1 / this.originalAspect : this.originalAspect;
                imgBitmap.close();
                this.recomputeLayout();
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
            const task = { blob, effectType, params, taskId, resolve, generation, rotation: this.rotation };

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
            taskId: task.taskId,
            rotation: task.rotation
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

        if (!this.currentImageAspect) {
            this.els.gridContainer.style.width = '100%';
            this.els.gridContainer.style.height = '100%';
            this.els.gridContainer.style.flex = '1';
            this.els.gridContainer.style.margin = '0';
            return;
        }

        const layout = this.computeGridLayout();
        const cols = layout.cols;
        const rows = layout.rows;
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
        const count = Math.max(this.activeEffects.length, 1);
        const container = document.querySelector('.canvas-container');
        if (!container) return;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        for (let i = 0; i < count; i++) {
            const canvas = document.getElementById(`canvas-${i}`);
            if (canvas) {
                const effect = this.activeEffects[i];
                const isAnalysis = effect && effects[effect.type]?.analysis;

                if (isAnalysis || this.zoomMode === 'auto') {
                    const scaleX = containerWidth / canvas.width;
                    const scaleY = containerHeight / canvas.height;
                    const scale = Math.min(scaleX, scaleY);

                    if (isAnalysis) {
                        canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
                    } else {
                        this.zoom = scale;
                        this.pan = { x: 0, y: 0 };
                        const t = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
                        canvas.style.transform = t;
                    }
                } else {
                    const t = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
                    canvas.style.transform = t;
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
        this.updateFavUI();

        document.title = filename !== '-' ? `${filename} (${indexStr}) | Ray-Light` : 'Ray-Light';
    }

    updateRotateUI() {
        document.getElementById('rotate-90').classList.toggle('active', this.rotation !== 0);
    }

    updateFlipUI() {
        document.getElementById('flip-h').classList.toggle('active', this.flipH === -1);
        document.getElementById('flip-v').classList.toggle('active', this.flipV === -1);
    }

    clearCache() {
        this.cache.clear();
        this.blobCache.clear();
    }

    toggleFavorite() {
        const filename = this.images[this.currentIndex];
        if (!filename) return;
        if (this.favorites.has(filename)) {
            this.favorites.delete(filename);
        } else {
            this.favorites.add(filename);
        }
        this.updateFavUI();
        this.saveSettings();
    }

    updateFavUI() {
        const filename = this.images[this.currentIndex];
        const isFav = filename && this.favorites.has(filename);
        this.els.favBtn.classList.toggle('active', isFav);
        this.els.favBtn.innerHTML = isFav ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>';
        this.els.heartOverlay.classList.toggle('visible', isFav);
        const count = this.favorites.size;
        if (count > 0) {
            this.els.favCount.textContent = `❤ ${count}`;
            this.els.favCount.classList.remove('hidden');
        } else {
            this.els.favCount.classList.add('hidden');
        }
    }

    copyFavorites() {
        const names = Array.from(this.favorites);
        if (names.length === 0) return;
        navigator.clipboard.writeText(names.join('\n')).catch(() => {});
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
            activeEffects: this.activeEffects.map(e => ({ type: e.type, params: e.params })),
            favorites: Array.from(this.favorites)
        };
        localStorage.setItem('ray_light_settings', JSON.stringify(settings));
        this.saveSettingsToApi(settings);
    }

    async loadSettings() {
        let settings = await this.loadSettingsFromApi();

        if (!settings) {
            const saved = localStorage.getItem('ray_light_settings');
            if (saved) {
                try { settings = JSON.parse(saved); } catch (e) {}
            }
        }

        if (!settings) return;

        try {
            this.activeEffects = (settings.activeEffects || []).map(e => ({
                id: Math.random(),
                type: e.type,
                params: e.params
            }));
            this.favorites = new Set(settings.favorites || []);
            this.renderActiveEffects();
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new RayLightApp();
});
