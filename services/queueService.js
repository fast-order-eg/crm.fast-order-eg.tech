class VertexQueue {
    constructor(concurrency = 3) {
        this.queue = [];
        this.activeCount = 0;
        this.concurrency = concurrency;
        this.delayMs = 150; // Minimal pacing between requests
    }

    /**
     * Add an API call to the queue.
     * @param {Function} apiCallFunction - A function that returns a Promise resolving to the API response.
     * @returns {Promise} Resolves with the API response or rejects after max retries.
     */
    async add(apiCallFunction) {
        return new Promise((resolve, reject) => {
            this.queue.push({ apiCallFunction, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.activeCount >= this.concurrency) return;
        if (this.queue.length === 0) return;

        this.activeCount++;
        const { apiCallFunction, resolve, reject } = this.queue.shift();

        let success = false;
        let attempts = 0;
        const maxAttempts = 2;
        const VERTEX_TIMEOUT_MS = 45000;

        try {
            while (!success && attempts < maxAttempts) {
                attempts++;
                try {
                    const timeoutPromise = new Promise((_, rejectTimeout) =>
                        setTimeout(() => rejectTimeout(new Error('VertexAI timeout after 45s')), VERTEX_TIMEOUT_MS)
                    );
                    const result = await Promise.race([apiCallFunction(), timeoutPromise]);
                    resolve(result);
                    success = true;
                } catch (error) {
                    const isRetryable = error.message && (
                        error.message.includes('429') ||
                        error.message.includes('500') ||
                        error.message.includes('503') ||
                        error.message.includes('timeout') ||
                        error.message.includes('ECONNRESET') ||
                        error.message.includes('ETIMEDOUT')
                    );

                    if (isRetryable && attempts < maxAttempts) {
                        const waitTime = error.message.includes('429') ? 3000 : 1200;
                        console.warn(`[VertexQueue] ⚠️ Transient error (${error.message}). Retrying attempt ${attempts}/${maxAttempts} after ${waitTime}ms...`);
                        await new Promise(r => setTimeout(r, waitTime));
                    } else {
                        console.error(`[VertexQueue] ❌ Vertex API Error after ${attempts} attempts:`, error.message);
                        reject(error);
                        break;
                    }
                }
            }
        } finally {
            if (this.delayMs > 0) {
                await new Promise(r => setTimeout(r, this.delayMs));
            }
            this.activeCount--;
            this.process();
        }
    }
}

export const vertexQueue = new VertexQueue(3);
