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
        this.cache = new Map(); // filename_effectIdx -> { canvas, status }
        this.workers = [];
        this.workerCount = 1; // Strictly sequential processing to save memory
        this.taskQueue = [];
        this.activeTasks = new Map();

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
            this.workers.push({ worker, busy: false });
        }
    }

    initEventListeners() {
        // Grid resize
        this.els.gridSelect.addEventListener('change', (e) => {
            this.gridType = e.target.value;
            this.renderGrid();
            this.limitEffects();
            this.updateCurrentImages();
            this.saveSettings();
        });

        this.els.fitAspectToggle.addEventListener('change', (e) => {
            this.fitGridToAspect = e.target.checked;
            this.updateGridSize();
            this.applyTransform();
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
            fitAspectToggle: document.getElementById('fit-aspect-toggle')
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
                this.clearCache();
                this.updateCurrentImages();
                this.saveSettings();
            };

            li.querySelectorAll('input, select').forEach(input => {
                input.onchange = (e) => {
                    eff.params[e.target.dataset.param] = e.target.value;
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

    async navigate(dir) {
        const newIndex = this.currentIndex + dir;
        if (newIndex >= 0 && newIndex < this.images.length) {
            this.currentIndex = newIndex;
            this.updateUI();
            await this.updateCurrentImages();
            this.preloadAround();
        }
    }

    async updateCurrentImages() {
        const count = this.getGridCount();
        const filename = this.images[this.currentIndex];
        if (!filename) return;

        // Load first image to get aspect ratio if needed
        if (this.images.length > 0) {
            const img = await this.loadImageFile(filename);
            this.currentImageAspect = img.width / img.height;
            this.updateGridSize();
        }

        for (let i = 0; i < count; i++) {
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

            await this.processImage(filename, i, effect, canvas, status.querySelector('.process-info'));
        }
    }

    async processImage(filename, effectIdx, effect, targetCanvas, statusEl) {
        // Check cache
        const cacheKey = `${filename}_${effectIdx}`;
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            this.copyCanvas(cached.canvas, targetCanvas);
            if (statusEl) statusEl.textContent = cached.status + ' (кэш)';

            if (effect.type === 'itten_circle' && (cached.status.includes('Круг Иттена:') || cached.status.includes('Itten Circle:'))) {
                this.drawIttenPercentages(targetCanvas, cached.status);
            }

            this.applyTransform();
            this.updateUI();
            return;
        }

        if (statusEl) statusEl.textContent = 'обработка...';

        try {
            const result = await this.runWorker(filename, effect.type, effect.params);
            if (!result) throw new Error("Processing failed");

            const offscreen = document.createElement('canvas');
            offscreen.width = result.imageData.width;
            offscreen.height = result.imageData.height;
            offscreen.getContext('2d').putImageData(result.imageData, 0, 0);

            this.cache.set(cacheKey, { canvas: offscreen, status: result.status });

            this.copyCanvas(offscreen, targetCanvas);
            if (statusEl) statusEl.textContent = result.status;

            if (effect.type === 'itten_circle' && result.status.includes('Круг Иттена:')) {
                this.drawIttenPercentages(targetCanvas, result.status);
            }

            this.applyTransform();
            this.updateUI();
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.textContent = 'ошибка';
        }
    }

    loadImageFile(filename) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `/api/image/${filename}`;
        });
    }

    runWorker(filename, effectType, params) {
        return new Promise((resolve) => {
            const taskId = Math.random();
            // Store request details instead of ImageData to prevent memory spikes
            this.taskQueue.push({ filename, effectType, params, taskId, resolve });
            this.processQueue();
        });
    }

    async processQueue() {
        const availableWorker = this.workers.find(w => !w.busy);
        if (availableWorker && this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            availableWorker.busy = true;

            try {
                // Load and prepare image data ONLY when worker is ready
                const img = await this.loadImageFile(task.filename);
                const offscreen = document.createElement('canvas');
                offscreen.width = img.width;
                offscreen.height = img.height;
                const ctx = offscreen.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const imageData = ctx.getImageData(0, 0, img.width, img.height);

                this.activeTasks.set(task.taskId, { resolve: task.resolve, worker: availableWorker });
                availableWorker.worker.postMessage({
                    imageData: imageData,
                    effectType: task.effectType,
                    params: task.params,
                    taskId: task.taskId
                }, [imageData.data.buffer]);
            } catch (e) {
                console.error("Task failed", e);
                availableWorker.busy = false;
                task.resolve(null);
                this.processQueue();
            }
        }
    }

    updateGridSize() {
        const workspace = this.els.workspace;
        const statusBar = document.getElementById('status-bar');
        const availableWidth = workspace.clientWidth - 20; // 10px padding * 2
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
            // Grid is wider than workspace -> side margins
            gridWidth = availableWidth;
            gridHeight = availableWidth / gridAspect;
        } else {
            // Grid is taller than workspace -> top/bottom margins
            gridHeight = availableHeight;
            gridWidth = availableHeight * gridAspect;
        }

        this.els.gridContainer.style.width = `${gridWidth}px`;
        this.els.gridContainer.style.height = `${gridHeight}px`;
        this.els.gridContainer.style.flex = 'none';
        this.els.gridContainer.style.margin = 'auto';
    }

    handleWorkerMessage(data) {
        const { imageData, status, taskId } = data;
        const task = this.activeTasks.get(taskId);
        if (task) {
            task.worker.busy = false;
            this.activeTasks.delete(taskId);
            task.resolve({ imageData, status });
            this.processQueue();
        }
    }

    drawIttenPercentages(canvas, status) {
        const ctx = canvas.getContext('2d');
        // Extract only the percentages part, ignoring the processing time in parentheses
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

            // Invert color logic
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

    applyTransform() {
        const count = this.getGridCount();
        const container = document.querySelector('.canvas-container');
        if (!container) return;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        for (let i = 0; i < count; i++) {
            const canvas = document.getElementById(`canvas-${i}`);
            if (canvas) {
                const effect = this.activeEffects[i];
                const isAnalysis = effect && (effect.type === 'histogram' || effect.type === 'itten_circle');

                if (isAnalysis || this.zoomMode === 'auto') {
                    const scaleX = containerWidth / canvas.width;
                    const scaleY = containerHeight / canvas.height;
                    const scale = Math.min(scaleX, scaleY);

                    if (isAnalysis) {
                        // Analysis effects are always centered and fitted, ignoring manual zoom/pan/rotation
                        canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
                    } else {
                        this.zoom = scale;
                        this.pan = { x: 0, y: 0 };
                        canvas.style.transform = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) rotate(${this.rotation}deg) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
                    }
                } else {
                    canvas.style.transform = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) rotate(${this.rotation}deg) scale(${this.zoom * this.flipH}, ${this.zoom * this.flipV})`;
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
    }

    preloadAround() {
        const range = 2;
        for (let i = 1; i <= range; i++) {
            this.preloadImage(this.currentIndex + i);
            this.preloadImage(this.currentIndex - i);
        }
    }

    async preloadImage(idx) {
        if (idx < 0 || idx >= this.images.length) return;
        const filename = this.images[idx];

        // Preload for all current effects
        for (let i = 0; i < this.activeEffects.length; i++) {
            const cacheKey = `${filename}_${i}`;
            if (!this.cache.has(cacheKey)) {
                const effect = this.activeEffects[i];
                // We don't need a canvas, just populate cache
                this.processImage(filename, i, effect, document.createElement('canvas'), null);
            }
        }
    }

    saveSettings() {
        const settings = {
            gridType: this.gridType,
            fitGridToAspect: this.fitGridToAspect,
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
