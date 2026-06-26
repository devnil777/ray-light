/**
 * Effects modules for Ray-Light
 * Every effect is a function that takes ImageData and params,
 * and returns modified ImageData and a status string.
 */

export const effects = {
    original: {
        name: "Оригинал",
        params: [],
        apply: (imageData, params) => {
            return { imageData, status: "Original" };
        }
    },

    channels: {
        name: "Каналы RGB",
        params: [
            { name: "channel", type: "select", options: ["R", "G", "B"], default: "R" }
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
            return { imageData, status: `Channel: ${channel}` };
        }
    },

    grayscale_channel: {
        name: "Канал (ЧБ)",
        params: [
            { name: "channel", type: "select", options: ["R", "G", "B"], default: "R" }
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
            return { imageData, status: `Grayscale ${channel}` };
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
            return { imageData, status: "Inverted" };
        }
    },

    exposure: {
        name: "Экспозиция",
        params: [
            { name: "stops", type: "number", default: 0, step: 0.1 }
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
            return { imageData, status: `Exposure: ${stops > 0 ? '+' : ''}${stops} EV` };
        }
    },

    clipping: {
        name: "Пересветы и тени",
        params: [
            { name: "high", type: "number", default: 254, min: 0, max: 255 },
            { name: "low", type: "number", default: 1, min: 0, max: 255 }
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
            return { imageData, status: "Clipping (R:High, B:Low)" };
        }
    }
};
