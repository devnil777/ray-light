/**
 * Web Worker for off-main-thread image processing
 */

// We can't use ESM in workers easily without more setup,
// so we'll embed or fetch the effects.
// For simplicity in this task, I'll copy the logic or use importScripts if I had a non-ESM version.
// But since I have ESM, let's use a trick or just redefine the effects here.

const effects = {
    original: (imageData, params) => ({ imageData, status: "Original" }),

    channels: (imageData, params) => {
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
    },

    grayscale_channel: (imageData, params) => {
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
    },

    invert: (imageData, params) => {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
        }
        return { imageData, status: "Inverted" };
    },

    exposure: (imageData, params) => {
        const data = imageData.data;
        const stops = parseFloat(params.stops || 0);
        const factor = Math.pow(2, stops);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, data[i] * factor);
            data[i + 1] = Math.min(255, data[i + 1] * factor);
            data[i + 2] = Math.min(255, data[i + 2] * factor);
        }
        return { imageData, status: `Exposure: ${stops > 0 ? '+' : ''}${stops} EV` };
    },

    clipping: (imageData, params) => {
        const data = imageData.data;
        const high = parseInt(params.high ?? 254);
        const low = parseInt(params.low ?? 1);
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            if (max >= high) {
                data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
            } else if (min <= low) {
                data[i] = 0; data[i + 1] = 0; data[i + 2] = 255;
            }
        }
        return { imageData, status: "Clipping (R:High, B:Low)" };
    }
};

self.onmessage = function(e) {
    const { imageData, effectType, params, taskId } = e.data;

    const startTime = performance.now();

    let result;
    if (effects[effectType]) {
        result = effects[effectType](imageData, params);
    } else {
        result = { imageData, status: "Unknown effect" };
    }

    const endTime = performance.now();
    const processingTime = (endTime - startTime).toFixed(1);

    result.status += ` (${processingTime}ms)`;

    self.postMessage({
        imageData: result.imageData,
        status: result.status,
        taskId: taskId
    }, [result.imageData.data.buffer]);
};
