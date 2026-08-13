class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    push(task) {
        this.queue.push(task);
        this.processNext();
    }

    async processNext() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const task = this.queue.shift();
        try {
            await task();
        } catch (err) {
            console.error('❌ [MESSAGE_QUEUE_ERROR]:', err);
        } finally {
            this.processing = false;
            setImmediate(() => this.processNext());
        }
    }
}

export const messageQueue = new MessageQueue();
