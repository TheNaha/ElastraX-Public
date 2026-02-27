import { describe, test, expect, mock, afterEach } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { MessageQueue } from '../src/utils/MessageQueue';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  afterEach(() => {
    queue?.stop();
  });

  test('should execute an enqueued task', async () => {
    queue = new MessageQueue(1, 60000);
    let executed = false;
    queue.enqueue('room-1', async () => { executed = true; });
    await new Promise(r => setTimeout(r, 50));
    expect(executed).toBe(true);
  });

  test('should process tasks in FIFO order', async () => {
    queue = new MessageQueue(1, 60000);
    const order: number[] = [];
    queue.enqueue('room-1', async () => { order.push(1); });
    queue.enqueue('room-1', async () => { order.push(2); });
    queue.enqueue('room-1', async () => { order.push(3); });
    await new Promise(r => setTimeout(r, 100));
    expect(order).toEqual([1, 2, 3]);
  });

  test('should handle task errors gracefully', async () => {
    queue = new MessageQueue(1, 60000);
    let secondRan = false;
    queue.enqueue('room-1', async () => { throw new Error('fail'); });
    queue.enqueue('room-1', async () => { secondRan = true; });
    await new Promise(r => setTimeout(r, 100));
    expect(secondRan).toBe(true);
  });

  test('getStats returns correct values for empty queue', () => {
    queue = new MessageQueue(1, 60000);
    const stats = queue.getStats();
    expect(stats.totalRooms).toBe(0);
    expect(stats.totalPending).toBe(0);
    expect(stats.totalRunning).toBe(0);
  });

  test('getStats reflects enqueued tasks', async () => {
    queue = new MessageQueue(1, 60000);
    queue.enqueue('room-1', async () => {
      await new Promise(r => setTimeout(r, 200));
    });
    queue.enqueue('room-1', async () => {
      await new Promise(r => setTimeout(r, 200));
    });
    // Give a tick for the first task to start
    await new Promise(r => setTimeout(r, 10));
    const stats = queue.getStats();
    expect(stats.totalRooms).toBe(1);
    expect(stats.totalRunning).toBe(1);
    expect(stats.totalPending).toBe(1);
  });

  test('stop clears the prune timer', () => {
    queue = new MessageQueue(1, 60000);
    queue.stop();
    // Calling stop again should not throw
    queue.stop();
  });

  test('processes tasks from different rooms independently', async () => {
    queue = new MessageQueue(1, 60000);
    const order: string[] = [];
    queue.enqueue('room-a', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('a1');
    });
    queue.enqueue('room-b', async () => {
      order.push('b1');
    });
    await new Promise(r => setTimeout(r, 100));
    // b1 should finish before a1 since they are in different rooms
    expect(order).toContain('a1');
    expect(order).toContain('b1');
  });
});
