class VertexQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        // 2000ms delay ensures max ~30 requests per minute.
        // Google free tier is typically 15 RPM for some models, or 50 RPM. 
        // 2000ms is a safe baseline. If we hit 429, we auto-retry.
        this.delayMs = 2000; 
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
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;
        
        const { apiCallFunction, resolve, reject } = this.queue.shift();

        let success = false;
        let attempts = 0;
        const maxAttempts = 3;
        // FIX: Circuit Breaker timeout — Vertex AI must respond within 30 seconds
        const VERTEX_TIMEOUT_MS = 30000;

        while (!success && attempts < maxAttempts) {
            attempts++;
            try {
                // Execute the API call with a 30-second timeout (circuit breaker)
                const timeoutPromise = new Promise((_, rejectTimeout) =>
                    setTimeout(() => rejectTimeout(new Error('VertexAI timeout after 30s')), VERTEX_TIMEOUT_MS)
                );
                const result = await Promise.race([apiCallFunction(), timeoutPromise]);
                resolve(result);
                success = true;
            } catch (error) {
                // Check if it's a timeout
                if (error.message && error.message.includes('timeout')) {
                    console.error(`[VertexQueue] ⏱️ Timeout on attempt ${attempts}/${maxAttempts}. Failing fast.`);
                    reject(error);
                    break;
                }
                // Check if it's a 429 Error
                if (error.message && error.message.includes('429')) {
                    console.warn(`[VertexQueue] ⚠️ 429 Resource Exhausted. Retrying attempt ${attempts}/${maxAttempts} after 5 seconds...`);
                    await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds before retry
                    if (attempts >= maxAttempts) {
                        console.error(`[VertexQueue] ❌ Max retries reached for 429 error.`);
                        reject(error);
                    }
                } else {
                    // Other error (e.g., 500, parsing error), fail immediately
                    console.error(`[VertexQueue] ❌ Vertex API Error:`, error.message);
                    reject(error);
                    break;
                }
            }
        }

        // Enforce delay before processing the next request in the queue
        await new Promise(r => setTimeout(r, this.delayMs));
        
        this.isProcessing = false;
        
        // Process next item recursively
        this.process();
    }
}

export const vertexQueue = new VertexQueue();
