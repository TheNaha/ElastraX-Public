/**
 * @file src/utils/HealthMetrics.ts
 * @description In-memory health metrics collector for ElastraX monitoring.
 *
 * Tracks key operational metrics:
 *  - Message throughput (received, processed, errors)
 *  - LLM latency percentiles (P50, P95, P99)
 *  - Provider success/failure counts
 *  - Active rooms and queue depth
 *  - Tool invocation counts
 *
 * Exposes:
 *  - `getMetrics()` — JSON snapshot for the /health endpoint
 *  - `getPrometheusMetrics()` — Prometheus-compatible text exposition
 *
 * Usage:
 * ```ts
 * import { healthMetrics } from './HealthMetrics';
 * healthMetrics.recordMessageReceived();
 * healthMetrics.recordLLMRequest('modal', 250, true);
 * ```
 */

import { logger } from './logger';

interface LatencyWindow {
  values: number[];
  maxSize: number;
}

export interface MetricsSnapshot {
  uptime: number;
  messages: {
    received: number;
    processed: number;
    errors: number;
  };
  llm: {
    requests: number;
    failures: number;
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
    avgLatency: number;
  };
  providers: Record<string, { success: number; failures: number }>;
  tools: Record<string, number>;
  queue: {
    totalRooms: number;
    totalPending: number;
    totalRunning: number;
  };
}

class HealthMetricsCollector {
  private messagesReceived = 0;
  private messagesProcessed = 0;
  private messageErrors = 0;

  private llmRequests = 0;
  private llmFailures = 0;
  private llmLatency: LatencyWindow = { values: [], maxSize: 1000 };

  private providerStats = new Map<string, { success: number; failures: number }>();
  private toolInvocations = new Map<string, number>();

  private queueStatsGetter: (() => { totalRooms: number; totalPending: number; totalRunning: number }) | null = null;

  /** Register the queue stats provider (called once during init). */
  registerQueueStats(getter: () => { totalRooms: number; totalPending: number; totalRunning: number }): void {
    this.queueStatsGetter = getter;
  }

  recordMessageReceived(): void {
    this.messagesReceived++;
  }

  recordMessageProcessed(): void {
    this.messagesProcessed++;
  }

  recordMessageError(): void {
    this.messageErrors++;
  }

  /** Record an LLM request completion with latency in milliseconds. */
  recordLLMRequest(providerName: string, latencyMs: number, success: boolean): void {
    this.llmRequests++;
    if (!success) this.llmFailures++;

    if (this.llmLatency.values.length >= this.llmLatency.maxSize) {
      this.llmLatency.values.shift();
    }
    this.llmLatency.values.push(latencyMs);

    if (!this.providerStats.has(providerName)) {
      this.providerStats.set(providerName, { success: 0, failures: 0 });
    }
    const stats = this.providerStats.get(providerName)!;
    if (success) stats.success++;
    else stats.failures++;
  }

  recordToolInvocation(toolName: string): void {
    this.toolInvocations.set(toolName, (this.toolInvocations.get(toolName) || 0) + 1);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getMetrics(): MetricsSnapshot {
    const sorted = [...this.llmLatency.values].sort((a, b) => a - b);
    const avg = sorted.length > 0
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0;

    const providers: Record<string, { success: number; failures: number }> = {};
    for (const [name, stats] of this.providerStats) {
      providers[name] = { ...stats };
    }

    const tools: Record<string, number> = {};
    for (const [name, count] of this.toolInvocations) {
      tools[name] = count;
    }

    const queueStats = this.queueStatsGetter?.() ?? { totalRooms: 0, totalPending: 0, totalRunning: 0 };

    return {
      uptime: process.uptime(),
      messages: {
        received: this.messagesReceived,
        processed: this.messagesProcessed,
        errors: this.messageErrors,
      },
      llm: {
        requests: this.llmRequests,
        failures: this.llmFailures,
        latencyP50: this.percentile(sorted, 50),
        latencyP95: this.percentile(sorted, 95),
        latencyP99: this.percentile(sorted, 99),
        avgLatency: avg,
      },
      providers,
      tools,
      queue: queueStats,
    };
  }

  /** Get Prometheus-compatible text exposition format. */
  getPrometheusMetrics(): string {
    const m = this.getMetrics();
    const lines: string[] = [];

    lines.push('# HELP elastrax_uptime_seconds Bot uptime in seconds');
    lines.push('# TYPE elastrax_uptime_seconds gauge');
    lines.push(`elastrax_uptime_seconds ${Math.floor(m.uptime)}`);

    lines.push('# HELP elastrax_messages_total Total messages by status');
    lines.push('# TYPE elastrax_messages_total counter');
    lines.push(`elastrax_messages_total{status="received"} ${m.messages.received}`);
    lines.push(`elastrax_messages_total{status="processed"} ${m.messages.processed}`);
    lines.push(`elastrax_messages_total{status="error"} ${m.messages.errors}`);

    lines.push('# HELP elastrax_llm_requests_total Total LLM requests');
    lines.push('# TYPE elastrax_llm_requests_total counter');
    lines.push(`elastrax_llm_requests_total ${m.llm.requests}`);

    lines.push('# HELP elastrax_llm_failures_total Failed LLM requests');
    lines.push('# TYPE elastrax_llm_failures_total counter');
    lines.push(`elastrax_llm_failures_total ${m.llm.failures}`);

    lines.push('# HELP elastrax_llm_latency_ms LLM latency percentiles');
    lines.push('# TYPE elastrax_llm_latency_ms gauge');
    lines.push(`elastrax_llm_latency_ms{quantile="0.5"} ${m.llm.latencyP50}`);
    lines.push(`elastrax_llm_latency_ms{quantile="0.95"} ${m.llm.latencyP95}`);
    lines.push(`elastrax_llm_latency_ms{quantile="0.99"} ${m.llm.latencyP99}`);

    lines.push('# HELP elastrax_provider_requests_total Provider requests by status');
    lines.push('# TYPE elastrax_provider_requests_total counter');
    for (const [name, stats] of Object.entries(m.providers)) {
      lines.push(`elastrax_provider_requests_total{provider="${name}",status="success"} ${stats.success}`);
      lines.push(`elastrax_provider_requests_total{provider="${name}",status="failure"} ${stats.failures}`);
    }

    lines.push('# HELP elastrax_queue_rooms Active room queues');
    lines.push('# TYPE elastrax_queue_rooms gauge');
    lines.push(`elastrax_queue_rooms ${m.queue.totalRooms}`);

    lines.push('# HELP elastrax_queue_pending Pending tasks in queue');
    lines.push('# TYPE elastrax_queue_pending gauge');
    lines.push(`elastrax_queue_pending ${m.queue.totalPending}`);

    lines.push('# HELP elastrax_queue_running Running tasks in queue');
    lines.push('# TYPE elastrax_queue_running gauge');
    lines.push(`elastrax_queue_running ${m.queue.totalRunning}`);

    lines.push('# HELP elastrax_tool_invocations_total Tool invocations');
    lines.push('# TYPE elastrax_tool_invocations_total counter');
    for (const [name, count] of Object.entries(m.tools)) {
      lines.push(`elastrax_tool_invocations_total{tool="${name}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}

/** Singleton metrics instance. Import and use directly. */
export const healthMetrics = new HealthMetricsCollector();
