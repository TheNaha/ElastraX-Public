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
  /** Maximum number of tasks executing concurrently across all rooms. */
  maxRunning?: number;
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
  /**
   * Maximum number of tasks executing at the same time, across all rooms.
   *
   * `globalLimit` is the *backlog* cap — how many tasks may be waiting. The
   * running cap is a separate, much smaller number: each running task is a
   * full agent turn with an LLM stream, a set of tool calls and its own
   * database writes.
   */
  private readonly maxRunning: number;
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
    const configuredGlobalLimit = options.globalLimit ?? 500;
    this.globalLimit = Math.max(this.perRoomLimit, configuredGlobalLimit);
    if (configuredGlobalLimit < this.perRoomLimit) {
      // A global backlog cap below the per-room cap cannot be honoured (a single
      // room may queue up to `perRoomLimit`); say so instead of silently raising
      // the operator's value.
      logger.warn(
        { configuredGlobalLimit, usingGlobalLimit: this.globalLimit, perRoomLimit: this.perRoomLimit },
        '[MessageQueue] MESSAGE_QUEUE_GLOBAL_LIMIT is below the per-room limit; raising it',
      );
    }
    this.maxRunning = Math.max(1, Math.floor(options.maxRunning ?? 8));
    this.maxAgeMs = Math.max(10_000, options.maxAgeMs ?? 5 * 60_000);
    this.shutdownGraceMs = Math.max(1_000, options.shutdownGraceMs ?? 15_000);
    this.pruneTimer = setInterval(() => this.prune(), Math.min(2 * 60_000, this.idleTimeoutMs));
    this.pruneTimer.unref?.();
  }

  /**
   * @param options.silent - do not count or log a rejection. The runtime's
   *   backpressure loop retries `enqueue` up to 80 times for one message; counting
   *   each attempt inflated `droppedTasks` by 80 and emitted 80 warnings for a
   *   single drop, corrupting the metric that distinguishes a real drop from
   *   backpressure. The caller logs and counts once when it gives up.
   */
  enqueue(roomId: string, task: Task, options: { silent?: boolean } = {}): boolean {
    if (this.stopped) {
      if (!options.silent) this.droppedTasks++;
      return false;
    }

    let queue = this.queues.get(roomId);
    if (!queue) {
      queue = { tasks: [], running: 0, lastActivity: Date.now() };
      this.queues.set(roomId, queue);
    }

    this.dropStale(queue);
    if (queue.tasks.length >= this.perRoomLimit || this.getPendingCount() >= this.globalLimit) {
      if (!options.silent) {
        this.droppedTasks++;
        logger.warn(
          { roomId, perRoomPending: queue.tasks.length, globalPending: this.getPendingCount() },
          '[MessageQueue] Admission rejected',
        );
      }
      return false;
    }

    const now = Date.now();
    queue.tasks.push({ task, enqueuedAt: now, controller: new AbortController() });
    queue.lastActivity = now;
    this.processNext(roomId);
    // A different room may have a free global slot while this one is at its
    // per-room concurrency limit.
    this.pumpAll();
    return true;
  }

  private processNext(roomId: string): void {
    if (this.stopped) return;
    const queue = this.queues.get(roomId);
    if (!queue || queue.running >= this.concurrency) return;

    this.dropStale(queue);
    const entry = queue.tasks.shift();
    if (!entry) return;

    // The global cap counts *running* tasks, not just pending ones. The
    // per-room concurrency limit only bounds how many turns run at once in
    // one room, so without this a message from each of N rooms produced N
    // concurrent agent turns — N LLM streams, N sets of tool calls, N
    // concurrent SQLite writers — with nothing anywhere throttling it.
    // `globalLimit` read like a global cap but only ever bounded the backlog.
    if (this.getRunningCount() >= this.maxRunning) {
      // Put the task back: it has not been started, so it must not be lost.
      queue.tasks.unshift(entry);
      return;
    }

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
        // A slot may have freed up in another room; let those queues advance.
        this.pumpAll();
      });

    this.runningTasks.set(entry.controller, promise);
  }

  /** Let every room with a pending task start one, if the global cap allows. */
  private pumpAll(): void {
    for (const roomId of this.queues.keys()) {
      if (this.getRunningCount() >= this.maxRunning) return;
      this.processNext(roomId);
    }
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

  /** How many tasks are executing right now, across every room. */
  private getRunningCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.running;
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

  stop(): void {
    this.beginStop();
  }

  /**
   * Re-arm a stopped queue.
   *
   * `stop()` is permanent by design — it aborts queued and running work — but
   * `AppRuntime` explicitly supports a stop/start cycle in one process (it
   * resets its own flags and rebuilds every hook). The queue kept
   * `stopped = true` for the life of the process after the first shutdown, so a
   * restart refused every inbound message (80 × 25 ms of backpressure, then a
   * drop) and `/ready` answered 503 forever. `resume()` puts the queue back in
   * the state its constructor produces.
   */
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.prune(), Math.min(2 * 60_000, this.idleTimeoutMs));
      this.pruneTimer.unref?.();
    }
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
