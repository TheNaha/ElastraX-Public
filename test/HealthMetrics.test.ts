import { describe, test, expect, mock } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { HealthMetricsCollector } from '../src/utils/HealthMetrics';
import type { MetricsSnapshot } from '../src/utils/HealthMetrics';

describe('HealthMetrics', () => {
  const healthMetrics = new HealthMetricsCollector();

  test('getMetrics returns proper MetricsSnapshot structure', () => {
    const m: MetricsSnapshot = healthMetrics.getMetrics();
    expect(m).toHaveProperty('uptime');
    expect(m).toHaveProperty('messages');
    expect(m).toHaveProperty('llm');
    expect(m).toHaveProperty('providers');
    expect(m).toHaveProperty('tools');
    expect(m).toHaveProperty('queue');
    expect(typeof m.messages.received).toBe('number');
    expect(typeof m.messages.processed).toBe('number');
    expect(typeof m.messages.errors).toBe('number');
  });

  test('recordMessageReceived increments counter', () => {
    const before = healthMetrics.getMetrics().messages.received;
    healthMetrics.recordMessageReceived();
    healthMetrics.recordMessageReceived();
    healthMetrics.recordMessageReceived();
    const after = healthMetrics.getMetrics().messages.received;
    expect(after - before).toBe(3);
  });

  test('recordMessageProcessed increments counter', () => {
    const before = healthMetrics.getMetrics().messages.processed;
    healthMetrics.recordMessageProcessed();
    const after = healthMetrics.getMetrics().messages.processed;
    expect(after - before).toBe(1);
  });

  test('recordMessageError increments counter', () => {
    const before = healthMetrics.getMetrics().messages.errors;
    healthMetrics.recordMessageError();
    const after = healthMetrics.getMetrics().messages.errors;
    expect(after - before).toBe(1);
  });

  test('recordLLMRequest increments llm.requests and tracks provider', () => {
    const before = healthMetrics.getMetrics().llm.requests;
    healthMetrics.recordLLMRequest('test-provider', 200, true);
    const after = healthMetrics.getMetrics();
    expect(after.llm.requests - before).toBe(1);
    expect(after.providers['test-provider']).toBeDefined();
    expect(after.providers['test-provider'].success).toBeGreaterThanOrEqual(1);
  });

  test('recordLLMRequest with failure increments failures', () => {
    const before = healthMetrics.getMetrics().llm.failures;
    healthMetrics.recordLLMRequest('fail-provider', 500, false);
    const after = healthMetrics.getMetrics();
    expect(after.llm.failures - before).toBe(1);
    expect(after.providers['fail-provider'].failures).toBeGreaterThanOrEqual(1);
  });

  test('recordToolInvocation increments tool counter', () => {
    healthMetrics.recordToolInvocation('test_tool');
    const m = healthMetrics.getMetrics();
    expect(m.tools['test_tool'].invocations).toBeGreaterThanOrEqual(1);
  });

  test('recordToolError increments tool error counter', () => {
    const before = healthMetrics.getMetrics().tools['test_tool']?.errors || 0;
    healthMetrics.recordToolError('test_tool');
    const after = healthMetrics.getMetrics().tools['test_tool'].errors;
    expect(after - before).toBe(1);
  });

  test('recordToolDuration tracks tool execution latency', () => {
    healthMetrics.recordToolDuration('test_tool', 100);
    healthMetrics.recordToolDuration('test_tool', 200);
    healthMetrics.recordToolDuration('test_tool', 300);
    const m = healthMetrics.getMetrics();
    expect(m.tools['test_tool'].durationP50).toBe(200);
  });

  test('recordTokenUsage tracks prompt and completion tokens', () => {
    healthMetrics.recordTokenUsage('test_model', 10, 20);
    const m = healthMetrics.getMetrics();
    expect(m.tokens['test_model'].prompt).toBeGreaterThanOrEqual(10);
    expect(m.tokens['test_model'].completion).toBeGreaterThanOrEqual(20);
  });

  test('recordMessageDuration tracks message processing latency', () => {
    healthMetrics.recordMessageDuration(150);
    const m = healthMetrics.getMetrics();
    expect(m.messageDuration.latencyP50).toBeGreaterThan(0);
  });

  test('percentile calculation with multiple latencies', () => {
    // Record enough latencies to test percentiles
    for (let i = 1; i <= 100; i++) {
      healthMetrics.recordLLMRequest('perc-provider', i * 10, true);
    }
    const m = healthMetrics.getMetrics();
    expect(m.llm.latencyP50).toBeGreaterThan(0);
    expect(m.llm.latencyP95).toBeGreaterThan(m.llm.latencyP50);
    expect(m.llm.latencyP99).toBeGreaterThanOrEqual(m.llm.latencyP95);
  });

  test('getPrometheusMetrics returns properly formatted text', () => {
    const text = healthMetrics.getPrometheusMetrics();
    expect(typeof text).toBe('string');
    expect(text).toContain('elastrax_uptime_seconds');
    expect(text).toContain('elastrax_messages_total');
    expect(text).toContain('elastrax_llm_requests_total');
    expect(text).toContain('elastrax_llm_latency_ms');
    expect(text).toContain('elastrax_queue_rooms');
    expect(text).toContain('# HELP');
    expect(text).toContain('# TYPE');
  });

  test('registerQueueStats integrates queue data into metrics', () => {
    healthMetrics.registerQueueStats(() => ({
      totalRooms: 5,
      totalPending: 10,
      totalRunning: 2,
    }));
    const m = healthMetrics.getMetrics();
    expect(m.queue.totalRooms).toBe(5);
    expect(m.queue.totalPending).toBe(10);
    expect(m.queue.totalRunning).toBe(2);
  });
});
