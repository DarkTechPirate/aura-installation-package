import { createLogger } from './logger.js';

const logger = createLogger('RetryQueue');

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]; // 1 s → 5 s → 30 s
const MAX_QUEUE_SIZE  = 200;                      // per node_id cap

interface QueuedItem<T> {
  payload:   T;
  attempts:  number;
  nextRetry: number;
}

/**
 * Per-node in-memory retry queue.
 *
 * Usage:
 *   const q = new RetryQueue<MyEvent>(async (item) => { await process(item); });
 *   q.enqueue('node_id', event);
 *
 * The handler is called immediately for the first attempt. On failure,
 * the item is re-queued with exponential back-off (1s / 5s / 30s).
 * After 3 failures the item is dropped and the error is logged.
 */
export class RetryQueue<T> {
  private queues  = new Map<string, QueuedItem<T>[]>();
  private timers  = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly handler: (payload: T) => Promise<void>) {}

  enqueue(nodeId: string, payload: T): void {
    const q = this.queues.get(nodeId) ?? [];
    if (q.length >= MAX_QUEUE_SIZE) {
      logger.warn('Queue full, dropping oldest item', { node_id: nodeId });
      q.shift();
    }
    q.push({ payload, attempts: 0, nextRetry: Date.now() });
    this.queues.set(nodeId, q);
    this.scheduleNext(nodeId, 0);
  }

  private scheduleNext(nodeId: string, delayMs: number): void {
    if (this.timers.has(nodeId)) return; // already scheduled
    const timer = setTimeout(() => {
      this.timers.delete(nodeId);
      this.processNext(nodeId).catch(() => {});
    }, delayMs);
    this.timers.set(nodeId, timer);
  }

  private async processNext(nodeId: string): Promise<void> {
    const q = this.queues.get(nodeId);
    if (!q || q.length === 0) return;

    const item = q[0]!;
    if (Date.now() < item.nextRetry) {
      this.scheduleNext(nodeId, item.nextRetry - Date.now());
      return;
    }

    try {
      await this.handler(item.payload);
      q.shift(); // success — remove from queue
      logger.debug('Item processed', { node_id: nodeId, attempt: item.attempts + 1 });
    } catch (err) {
      item.attempts++;
      if (item.attempts >= RETRY_DELAYS_MS.length) {
        q.shift(); // exhausted retries — drop
        logger.error('Item dropped after max retries', { node_id: nodeId, error: String(err) });
      } else {
        const delay      = RETRY_DELAYS_MS[item.attempts]!;
        item.nextRetry   = Date.now() + delay;
        logger.warn('Item failed, will retry', {
          node_id: nodeId, attempt: item.attempts, retry_in_ms: delay, error: String(err),
        });
        this.scheduleNext(nodeId, delay);
      }
    }

    // Process next item if queue still has items
    if ((this.queues.get(nodeId)?.length ?? 0) > 0) {
      this.scheduleNext(nodeId, 0);
    }
  }

  /** Cancel all pending retries (e.g. on shutdown). */
  destroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queues.clear();
  }
}
