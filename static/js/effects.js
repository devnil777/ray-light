/**
 * Effects modules for Ray-Light
 * Every effect is a function that takes ImageData and params,
 * and returns modified ImageData and a status string.
 */

export const effects = {
    original: {
        name: "Оригинал",
        params: [
            { name: "overlayType", label: "Наложение сетки", type: "select", options: [
                { value: "none", label: "Нет" },
                { value: "grid", label: "Сетка" },
                { value: "golden-ratio", label: "Золотое сечение" },
                { value: "diagonal", label: "Диагонали" },
                { value: "golden-spiral", label: "Золотая спираль" }
            ], default: "none" },
            { name: "overlayGridSize", label: "Размер сетки", type: "select", options: [
                { value: 3, label: "3×3" },
                { value: 4, label: "4×4" },
                { value: 5, label: "5×5" },
                { value: 6, label: "6×6" }
            ], default: 3 },
            { name: "overlaySpiralSide", label: "Сторона спирали", type: "select", options: [
                { value: "left", label: "Слева" },
                { value: "right", label: "Справа" },
                { value: "top", label: "Сверху" },
                { value: "bottom", label: "Снизу" }
            ], default: "left" }
        ],
        apply: (imageData, params) => {
            return { imageData, status: "Оригинал" };
        }
    },

    channels: {
        name: "Каналы RGB",
        params: [
            { name: "channel", label: "Канал", type: "select", options: [
                { value: "R", label: "Красный" },
                { value: "G", label: "Зелёный" },
                { value: "B", label: "Синий" }
            ], default: "R" }
        ],
        apply: (imageData, params) => {
            const data = imageData.data;
            const channel = (params.channel || "R").toUpperCase();
            const channelIdx = channel === "R" ? 0 : channel === "G" ? 1 : 2;

            for (let i = 0; i < data.length; i += 4) {
                const val = data[i + channelIdx];
                data[i] = channelIdx === 0 ? val : 0;
                data[i + 1] = channelIdx === 1 ? val : 0;
                data[i + 2] = channelIdx === 2 ? val : 0;
            }
            return { imageData, status: `Канал: ${channel}` };
        }
    },

    grayscale_channel: {
        name: "Канал (ЧБ)",
        params: [
            { name: "channel", label: "Канал", type: "select", options: [
                { value: "R", label: "Красный" },
                { value: "G", label: "Зелёный" },
                { value: "B", label: "Синий" }
            ], default: "R" }
        ],
        apply: (imageData, params) => {
            const data = imageData.data;
            const channel = (params.channel || "R").toUpperCase();
            const channelIdx = channel === "R" ? 0 : channel === "G" ? 1 : 2;

            for (let i = 0; i < data.length; i += 4) {
                const val = data[i + channelIdx];
                data[i] = val;
                data[i + 1] = val;
                data[i + 2] = val;
            }
            return { imageData, status: `ЧБ Канал: ${channel}` };
        }
    },

    invert: {
        name: "Инверсия",
        params: [],
        apply: (imageData, params) => {
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255 - data[i];
                data[i + 1] = 255 - data[i + 1];
                data[i + 2] = 255 - data[i + 2];
            }
            return { imageData, status: "Инверсия" };
        }
    },

    exposure: {
        name: "Экспозиция",
        params: [
            { name: "stops", label: "Ступени (EV)", type: "number", default: 0, step: 0.1 }
        ],
        apply: (imageData, params) => {
            const data = imageData.data;
            const stops = parseFloat(params.stops || 0);
            const factor = Math.pow(2, stops);

            for (let i = 0; i < data.length; i += 4) {
                data[i] = Math.min(255, data[i] * factor);
                data[i + 1] = Math.min(255, data[i + 1] * factor);
                data[i + 2] = Math.min(255, data[i + 2] * factor);
            }
            return { imageData, status: `Экспозиция: ${stops > 0 ? '+' : ''}${stops} EV` };
        }
    },

    clipping: {
        name: "Пересветы и тени",
        params: [
            { name: "high", label: "Порог верха", type: "number", default: 254, min: 0, max: 255 },
            { name: "low", label: "Порог низа", type: "number", default: 1, min: 0, max: 255 }
        ],
        apply: (imageData, params) => {
            const data = imageData.data;
            const high = parseInt(params.high ?? 254);
            const low = parseInt(params.low ?? 1);

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];

                // Max of channels for highlights, min or average?
                // Usually any channel clipping is important
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);

                if (max >= high) {
                    data[i] = 255;
                    data[i + 1] = 0;
                    data[i + 2] = 0;
                } else if (min <= low) {
                    data[i] = 0;
                    data[i + 1] = 0;
                    data[i + 2] = 255;
                }
                // else keep original
            }
            return { imageData, status: "Пересветы/тени (К:верх, С:низ)" };
        }
    },

    focus_peaking: {
        name: "Зоны фокуса",
        params: [
            { name: "threshold", label: "Порог", type: "number", default: 30, min: 0, max: 255 }
        ],
        apply: (imageData, params) => {
            // Logic moved to worker
            return { imageData, status: "Зоны фокуса" };
        }
    },

    histogram: {
        name: "Гистограмма",
        params: [],
        analysis: true,
        apply: (imageData, params) => {
            // Logic moved to worker
            return { imageData, status: "Гистограмма" };
        }
    },

    itten_circle: {
        name: "Круг Иттена",
        params: [],
        analysis: true,
        apply: (imageData, params) => {
            // Logic moved to worker
            return { imageData, status: "Круг Иттена" };
        }
    },

    texture_loss: {
        name: "Детектор текстур",
        params: [
            { name: "windowSize", label: "Размер окна", type: "number", default: 15, min: 3, max: 51, step: 2 }
        ],
        apply: (imageData, params) => {
            // Logic moved to worker
            return { imageData, status: "Детектор текстур" };
        }
    }
};
