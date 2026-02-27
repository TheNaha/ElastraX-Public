import { describe, test, expect, mock, afterEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: () => {},
        }),
      }),
    }),
  },
}));

import { Scheduler } from '../src/utils/Scheduler';

describe('Scheduler', () => {
  afterEach(() => {
    Scheduler.stop();
  });

  test('registerSender does not throw', () => {
    expect(() => Scheduler.registerSender('whatsapp', async () => {})).not.toThrow();
  });

  test('start does not throw', () => {
    expect(() => Scheduler.start()).not.toThrow();
  });

  test('start is idempotent (calling twice is safe)', () => {
    Scheduler.start();
    expect(() => Scheduler.start()).not.toThrow();
  });

  test('stop does not throw', () => {
    Scheduler.start();
    expect(() => Scheduler.stop()).not.toThrow();
  });

  test('stop is idempotent', () => {
    Scheduler.start();
    Scheduler.stop();
    expect(() => Scheduler.stop()).not.toThrow();
  });
});
