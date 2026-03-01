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

interface ToolStats {
  invocations: number;
  errors: number;
  duration: LatencyWindow;
}

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
  tokens: Record<string, { prompt: number; completion: number }>;
  messageDuration: {
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
  };
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
  };
  providers: Record<string, { success: number; failures: number }>;
  tools: Record<string, {
    invocations: number;
    errors: number;
    durationP50: number;
    durationP95: number;
    durationP99: number;
  }>;
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

  private tokenStats = new Map<string, { prompt: number; completion: number }>();
  private messageDuration: LatencyWindow = { values: [], maxSize: 1000 };

  private providerStats = new Map<string, { success: number; failures: number }>();
  private toolStats = new Map<string, ToolStats>();

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

  recordMessageDuration(durationMs: number): void {
    if (this.messageDuration.values.length >= this.messageDuration.maxSize) {
      this.messageDuration.values.shift();
    }
    this.messageDuration.values.push(durationMs);
  }

  recordTokenUsage(model: string, promptTokens: number, completionTokens: number): void {
    if (!this.tokenStats.has(model)) {
      this.tokenStats.set(model, { prompt: 0, completion: 0 });
    }
    const stats = this.tokenStats.get(model)!;
    stats.prompt += promptTokens;
    stats.completion += completionTokens;
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

  private getToolStats(toolName: string): ToolStats {
    if (!this.toolStats.has(toolName)) {
      this.toolStats.set(toolName, { invocations: 0, errors: 0, duration: { values: [], maxSize: 100 } });
    }
    return this.toolStats.get(toolName)!;
  }

  recordToolInvocation(toolName: string): void {
    this.getToolStats(toolName).invocations++;
  }

  recordToolError(toolName: string): void {
    this.getToolStats(toolName).errors++;
  }

  recordToolDuration(toolName: string, durationMs: number): void {
    const stats = this.getToolStats(toolName);
    if (stats.duration.values.length >= stats.duration.maxSize) {
      stats.duration.values.shift();
    }
    stats.duration.values.push(durationMs);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getMetrics(): MetricsSnapshot {
    const sortedLLM = [...this.llmLatency.values].sort((a, b) => a - b);
    const avgLLM = sortedLLM.length > 0
      ? Math.round(sortedLLM.reduce((a, b) => a + b, 0) / sortedLLM.length)
      : 0;

    const sortedMsg = [...this.messageDuration.values].sort((a, b) => a - b);

    const providers: Record<string, { success: number; failures: number }> = {};
    for (const [name, stats] of this.providerStats) {
      providers[name] = { ...stats };
    }

    const tools: Record<string, { invocations: number; errors: number; durationP50: number; durationP95: number; durationP99: number }> = {};
    for (const [name, stats] of this.toolStats) {
      const sortedDuration = [...stats.duration.values].sort((a, b) => a - b);
      tools[name] = {
        invocations: stats.invocations,
        errors: stats.errors,
        durationP50: this.percentile(sortedDuration, 50),
        durationP95: this.percentile(sortedDuration, 95),
        durationP99: this.percentile(sortedDuration, 99),
      };
    }

    const tokens: Record<string, { prompt: number; completion: number }> = {};
    for (const [name, stats] of this.tokenStats) {
      tokens[name] = { ...stats };
    }

    const queueStats = this.queueStatsGetter?.() ?? { totalRooms: 0, totalPending: 0, totalRunning: 0 };
    const memUsage = process.memoryUsage();

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
        latencyP50: this.percentile(sortedLLM, 50),
        latencyP95: this.percentile(sortedLLM, 95),
        latencyP99: this.percentile(sortedLLM, 99),
        avgLatency: avgLLM,
      },
      tokens,
      messageDuration: {
        latencyP50: this.percentile(sortedMsg, 50),
        latencyP95: this.percentile(sortedMsg, 95),
        latencyP99: this.percentile(sortedMsg, 99),
      },
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
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
    for (const [name, stats] of Object.entries(m.tools)) {
      lines.push(`elastrax_tool_invocations_total{tool="${name}"} ${stats.invocations}`);
    }

    lines.push('# HELP elastrax_tool_errors_total Tool execution errors');
    lines.push('# TYPE elastrax_tool_errors_total counter');
    for (const [name, stats] of Object.entries(m.tools)) {
      lines.push(`elastrax_tool_errors_total{tool="${name}"} ${stats.errors}`);
    }

    lines.push('# HELP elastrax_tool_duration_ms Tool execution duration percentiles');
    lines.push('# TYPE elastrax_tool_duration_ms gauge');
    for (const [name, stats] of Object.entries(m.tools)) {
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.5"} ${stats.durationP50}`);
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.95"} ${stats.durationP95}`);
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.99"} ${stats.durationP99}`);
    }

    lines.push('# HELP elastrax_tokens_total Token usage by model and type');
    lines.push('# TYPE elastrax_tokens_total counter');
    for (const [model, stats] of Object.entries(m.tokens)) {
      lines.push(`elastrax_tokens_total{model="${model}",type="prompt"} ${stats.prompt}`);
      lines.push(`elastrax_tokens_total{model="${model}",type="completion"} ${stats.completion}`);
    }

    lines.push('# HELP elastrax_message_duration_ms Message processing duration percentiles');
    lines.push('# TYPE elastrax_message_duration_ms gauge');
    lines.push(`elastrax_message_duration_ms{quantile="0.5"} ${m.messageDuration.latencyP50}`);
    lines.push(`elastrax_message_duration_ms{quantile="0.95"} ${m.messageDuration.latencyP95}`);
    lines.push(`elastrax_message_duration_ms{quantile="0.99"} ${m.messageDuration.latencyP99}`);

    lines.push('# HELP elastrax_process_memory_bytes Process memory usage');
    lines.push('# TYPE elastrax_process_memory_bytes gauge');
    lines.push(`elastrax_process_memory_bytes{type="rss"} ${m.memory.rss}`);
    lines.push(`elastrax_process_memory_bytes{type="heapTotal"} ${m.memory.heapTotal}`);
    lines.push(`elastrax_process_memory_bytes{type="heapUsed"} ${m.memory.heapUsed}`);

    return lines.join('\n') + '\n';
  }
}

/** Singleton metrics instance. Import and use directly. */
export const healthMetrics = new HealthMetricsCollector();
