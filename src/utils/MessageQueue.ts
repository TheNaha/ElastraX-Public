import { logger } from './logger';

type Task = (signal: AbortSignal) => Promise<void>;

type QueueTask = {
  task: Task;
  enqueuedAt: number;
  controller: AbortController;
};

type RoomQueue = {
  tasks: QueueTask[];
  running: number;
  lastActivity: number;
};

export type MessageQueueOptions = {
  perRoomLimit?: number;
  globalLimit?: number;
  maxAgeMs?: number;
  shutdownGraceMs?: number;
};

export type MessageQueueStats = {
  totalRooms: number;
  totalPending: number;
  totalRunning: number;
  oldestPendingAgeMs: number;
  droppedTasks: number;
  stopped: boolean;
};

export class MessageQueue {
  private readonly queues = new Map<string, RoomQueue>();
  private readonly runningTasks = new Map<AbortController, Promise<void>>();
  private readonly concurrency: number;
  private readonly idleTimeoutMs: number;
  private readonly perRoomLimit: number;
  private readonly globalLimit: number;
  private readonly maxAgeMs: number;
  private readonly shutdownGraceMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private droppedTasks = 0;
  private stopped = false;

  constructor(
    concurrency: number = 1,
    idleTimeoutMs: number = 5 * 60 * 1000,
    options: MessageQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.idleTimeoutMs = Math.max(1_000, idleTimeoutMs);
    this.perRoomLimit = Math.max(1, options.perRoomLimit ?? 50);
    this.globalLimit = Math.max(this.perRoomLimit, options.globalLimit ?? 500);
    this.maxAgeMs = Math.max(10_000, options.maxAgeMs ?? 5 * 60_000);
    this.shutdownGraceMs = Math.max(1_000, options.shutdownGraceMs ?? 15_000);
    this.pruneTimer = setInterval(() => this.prune(), Math.min(2 * 60_000, this.idleTimeoutMs));
    this.pruneTimer.unref?.();
  }

  enqueue(roomId: string, task: Task): boolean {
    if (this.stopped) {
      this.droppedTasks++;
      return false;
    }

    let queue = this.queues.get(roomId);
    if (!queue) {
      queue = { tasks: [], running: 0, lastActivity: Date.now() };
      this.queues.set(roomId, queue);
    }

    this.dropStale(queue);
    if (queue.tasks.length >= this.perRoomLimit || this.getPendingCount() >= this.globalLimit) {
      this.droppedTasks++;
      logger.warn(
        { roomId, perRoomPending: queue.tasks.length, globalPending: this.getPendingCount() },
        '[MessageQueue] Admission rejected',
      );
      return false;
    }

    const now = Date.now();
    queue.tasks.push({ task, enqueuedAt: now, controller: new AbortController() });
    queue.lastActivity = now;
    this.processNext(roomId);
    return true;
  }

  private processNext(roomId: string): void {
    if (this.stopped) return;
    const queue = this.queues.get(roomId);
    if (!queue || queue.running >= this.concurrency) return;

    this.dropStale(queue);
    const entry = queue.tasks.shift();
    if (!entry) return;

    entry.controller.signal.throwIfAborted();
    queue.running++;
    queue.lastActivity = Date.now();

    const promise = Promise.resolve()
      .then(() => entry.task(entry.controller.signal))
      .catch((err) => {
        if (!entry.controller.signal.aborted) {
          logger.error({ err, roomId }, '[MessageQueue] Task failed');
        }
      })
      .finally(() => {
        this.runningTasks.delete(entry.controller);
        queue.running = Math.max(0, queue.running - 1);
        queue.lastActivity = Date.now();
        this.processNext(roomId);
      });

    this.runningTasks.set(entry.controller, promise);
  }

  private dropStale(queue: RoomQueue): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (queue.tasks[0] && queue.tasks[0].enqueuedAt < cutoff) {
      const entry = queue.tasks.shift();
      entry?.controller.abort();
      this.droppedTasks++;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    this.queues.forEach((queue, roomId) => {
      this.dropStale(queue);
      if (queue.running === 0 && queue.tasks.length === 0 && queue.lastActivity < cutoff) {
        this.queues.delete(roomId);
      }
    });
  }

  private getPendingCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.tasks.length;
    return count;
  }

  getStats(): MessageQueueStats {
    let totalPending = 0;
    let totalRunning = 0;
    let oldestPendingAgeMs = 0;
    const now = Date.now();
    for (const queue of this.queues.values()) {
      totalPending += queue.tasks.length;
      totalRunning += queue.running;
      const oldest = queue.tasks[0];
      if (oldest) oldestPendingAgeMs = Math.max(oldestPendingAgeMs, now - oldest.enqueuedAt);
    }
    return {
      totalRooms: this.queues.size,
      totalPending,
      totalRunning,
      oldestPendingAgeMs,
      droppedTasks: this.droppedTasks,
      stopped: this.stopped,
    };
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.beginStop();
  }

  async closeAndDrain(graceMs: number = this.shutdownGraceMs): Promise<void> {
    this.beginStop();
    const tasks = Array.from(this.runningTasks.values());
    if (tasks.length === 0) return;
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(1, graceMs));
        timer.unref?.();
      }),
    ]);
  }

  private beginStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const queue of this.queues.values()) {
      for (const entry of queue.tasks.splice(0)) {
        entry.controller.abort();
        this.droppedTasks++;
      }
    }
    for (const controller of this.runningTasks.keys()) {
      controller.abort();
    }
  }
}
