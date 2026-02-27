/**
 * @file src/utils/MessageQueue.ts
 * @description Per-room asynchronous message queue with concurrency control.
 *
 * Prevents the bot from being overwhelmed when multiple messages arrive
 * simultaneously in a busy group chat. Each room gets its own queue with
 * configurable concurrency (default: 1 — process one message at a time per room).
 *
 * Messages are processed in FIFO order within each room. Idle queues are
 * automatically pruned to prevent unbounded memory growth.
 *
 * Usage:
 * ```ts
 * const queue = new MessageQueue(1);
 * queue.enqueue(chatId, () => handleIncomingMessage(ctx));
 * ```
 */

import { logger } from './logger';

type Task = () => Promise<void>;

interface RoomQueue {
  tasks: Task[];
  running: number;
  lastActivity: number;
}

export class MessageQueue {
  private queues = new Map<string, RoomQueue>();
  private readonly concurrency: number;
  private readonly idleTimeoutMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param concurrency    Max concurrent tasks per room (default: 1).
   * @param idleTimeoutMs  Remove idle queues after this duration (default: 5 minutes).
   */
  constructor(concurrency: number = 1, idleTimeoutMs: number = 5 * 60 * 1000) {
    this.concurrency = concurrency;
    this.idleTimeoutMs = idleTimeoutMs;
    this.pruneTimer = setInterval(() => this.prune(), 2 * 60 * 1000);
  }

  /**
   * Enqueue a message-processing task for a specific room.
   * The task will execute when the room's concurrency slot is available.
   *
   * @param roomId - Unique room identifier (chatId).
   * @param task   - Async function to execute (typically the agent handler).
   */
  enqueue(roomId: string, task: Task): void {
    let queue = this.queues.get(roomId);
    if (!queue) {
      queue = { tasks: [], running: 0, lastActivity: Date.now() };
      this.queues.set(roomId, queue);
    }

    queue.tasks.push(task);
    queue.lastActivity = Date.now();
    this.processNext(roomId);
  }

  private processNext(roomId: string): void {
    const queue = this.queues.get(roomId);
    if (!queue) return;

    if (queue.running >= this.concurrency || queue.tasks.length === 0) {
      return;
    }

    const task = queue.tasks.shift()!;
    queue.running++;

    task()
      .catch((err) => {
        logger.error({ err, roomId }, '[MessageQueue] Task failed');
      })
      .finally(() => {
        queue.running--;
        queue.lastActivity = Date.now();
        this.processNext(roomId);
      });
  }

  /** Remove queues that have been idle beyond the timeout. */
  private prune(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [roomId, queue] of this.queues) {
      if (queue.running === 0 && queue.tasks.length === 0 && queue.lastActivity < cutoff) {
        this.queues.delete(roomId);
      }
    }
  }

  /** Get current queue stats (for health metrics). */
  getStats(): { totalRooms: number; totalPending: number; totalRunning: number } {
    let totalPending = 0;
    let totalRunning = 0;
    for (const queue of this.queues.values()) {
      totalPending += queue.tasks.length;
      totalRunning += queue.running;
    }
    return { totalRooms: this.queues.size, totalPending, totalRunning };
  }

  /** Clean up timers on shutdown. */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
