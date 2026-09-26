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
  cursor: number;
}

export interface TokenStats {
  prompt: number;
  completion: number;
  total: number;
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
  tokens: Record<string, TokenStats>;
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
  feedback: {
    positive: number;
    negative: number;
    retracted: number;
  };
  queue: {
    totalRooms: number;
    totalPending: number;
    totalRunning: number;
  };
  services: Record<string, { status: 'healthy' | 'unhealthy'; lastChecked: number; error?: string }>;
}

export class HealthMetricsCollector {
  private messagesReceived = 0;
  private messagesProcessed = 0;
  private messageErrors = 0;

  private llmRequests = 0;
  private llmFailures = 0;
  private llmLatency: LatencyWindow = { values: [], maxSize: 1000, cursor: 0 };

  private tokenStats = new Map<string, TokenStats>();
  private messageDuration: LatencyWindow = { values: [], maxSize: 1000, cursor: 0 };

  private providerStats = new Map<string, { success: number; failures: number }>();
  private toolStats = new Map<string, ToolStats>();
  private serviceHealth = new Map<string, { status: 'healthy' | 'unhealthy'; lastChecked: number; error?: string }>();

  private feedbackPositive = 0;
  private feedbackNegative = 0;
  private feedbackRetracted = 0;

  private queueStatsGetter: (() => { totalRooms: number; totalPending: number; totalRunning: number }) | null = null;

  /** Register the queue stats provider (called once during init). */
  registerQueueStats(getter: () => { totalRooms: number; totalPending: number; totalRunning: number }): void {
    this.queueStatsGetter = getter;
  }

  setServiceHealth(service: string, status: 'healthy' | 'unhealthy', error?: string): void {
    this.serviceHealth.set(service, { status, lastChecked: Date.now(), error });
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
    const win = this.messageDuration;
    if (win.values.length < win.maxSize) {
      win.values.push(durationMs);
    } else {
      win.values[win.cursor] = durationMs;
      win.cursor = (win.cursor + 1) % win.maxSize;
    }
  }

  recordTokenUsage(
    model: string,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number = promptTokens + completionTokens,
  ): void {
    const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
    const completion = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
    const total = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : prompt + completion;
    if (!this.tokenStats.has(model)) {
      this.tokenStats.set(model, { prompt: 0, completion: 0, total: 0 });
    }
    const stats = this.tokenStats.get(model)!;
    stats.prompt += prompt;
    stats.completion += completion;
    stats.total += total;
  }

  /** Record an LLM request completion with latency in milliseconds. */
  recordLLMRequest(providerName: string, latencyMs: number, success: boolean): void {
    this.llmRequests++;
    if (!success) this.llmFailures++;

    if (success) {
      const win = this.llmLatency;
      if (win.values.length < win.maxSize) {
        win.values.push(latencyMs);
      } else {
        win.values[win.cursor] = latencyMs;
        win.cursor = (win.cursor + 1) % win.maxSize;
      }
    }

    if (!this.providerStats.has(providerName)) {
      this.providerStats.set(providerName, { success: 0, failures: 0 });
    }
    const stats = this.providerStats.get(providerName)!;
    if (success) stats.success++;
    else stats.failures++;
  }

  private getToolStats(toolName: string): ToolStats {
    if (!this.toolStats.has(toolName)) {
      this.toolStats.set(toolName, { invocations: 0, errors: 0, duration: { values: [], maxSize: 100, cursor: 0 } });
    }
    return this.toolStats.get(toolName)!;
  }

  /**
   * Record a thumbs up/down on a bot reply. `retracted` counts reactions the
   * user took back, so a withdrawn negative is not double-counted as praise.
   */
  recordFeedback(sentiment: 'positive' | 'negative', retracted = false): void {
    if (retracted) {
      this.feedbackRetracted++;
      if (sentiment === 'positive') this.feedbackPositive = Math.max(0, this.feedbackPositive - 1);
      else this.feedbackNegative = Math.max(0, this.feedbackNegative - 1);
      return;
    }
    if (sentiment === 'positive') this.feedbackPositive++;
    else this.feedbackNegative++;
  }

  recordToolInvocation(toolName: string): void {
    this.getToolStats(toolName).invocations++;
  }

  recordToolError(toolName: string): void {
    this.getToolStats(toolName).errors++;
  }

  recordToolDuration(toolName: string, durationMs: number): void {
    const stats = this.getToolStats(toolName);
    const win = stats.duration;
    if (win.values.length < win.maxSize) {
      win.values.push(durationMs);
    } else {
      win.values[win.cursor] = durationMs;
      win.cursor = (win.cursor + 1) % win.maxSize;
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /** Reset all counters and windows (intended for testing). */
  reset(): void {
    this.messagesReceived = 0;
    this.messagesProcessed = 0;
    this.messageErrors = 0;
    this.llmRequests = 0;
    this.llmFailures = 0;
    this.llmLatency = { values: [], maxSize: 1000, cursor: 0 };
    this.tokenStats.clear();
    this.messageDuration = { values: [], maxSize: 1000, cursor: 0 };
    this.providerStats.clear();
    this.toolStats.clear();
    this.serviceHealth.clear();
  }

  getMetrics(): MetricsSnapshot {
    const sortedLLM = this.llmLatency.values.slice().sort((a, b) => a - b);
    let avgLLM = 0;
    if (sortedLLM.length > 0) {
      let sum = 0;
      for (let i = 0; i < sortedLLM.length; i++) {
        sum += sortedLLM[i]!;
      }
      avgLLM = Math.round(sum / sortedLLM.length);
    }

    const sortedMsg = this.messageDuration.values.slice().sort((a, b) => a - b);

    const providers: Record<string, { success: number; failures: number }> = {};
    this.providerStats.forEach((stats, name) => {
      providers[name] = { ...stats };
    });

    const tools: Record<string, { invocations: number; errors: number; durationP50: number; durationP95: number; durationP99: number }> = {};
    this.toolStats.forEach((stats, name) => {
      const sortedDuration = stats.duration.values.slice().sort((a, b) => a - b);
      tools[name] = {
        invocations: stats.invocations,
        errors: stats.errors,
        durationP50: this.percentile(sortedDuration, 50),
        durationP95: this.percentile(sortedDuration, 95),
        durationP99: this.percentile(sortedDuration, 99),
      };
    });

    const tokens: Record<string, TokenStats> = {};
    this.tokenStats.forEach((stats, name) => {
      tokens[name] = { ...stats };
    });

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
      feedback: {
        positive: this.feedbackPositive,
        negative: this.feedbackNegative,
        retracted: this.feedbackRetracted,
      },
      queue: queueStats,
      services: Object.fromEntries(this.serviceHealth),
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

    lines.push('# HELP elastrax_feedback_total User reaction feedback on bot replies');
    lines.push('# TYPE elastrax_feedback_total counter');
    lines.push(`elastrax_feedback_total{sentiment="positive"} ${m.feedback.positive}`);
    lines.push(`elastrax_feedback_total{sentiment="negative"} ${m.feedback.negative}`);
    lines.push(`elastrax_feedback_retracted_total ${m.feedback.retracted}`);

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
    for (const name in m.providers) {
      const stats = m.providers[name]!;
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
    for (const name in m.tools) {
      const stats = m.tools[name]!;
      lines.push(`elastrax_tool_invocations_total{tool="${name}"} ${stats.invocations}`);
    }

    lines.push('# HELP elastrax_tool_errors_total Tool execution errors');
    lines.push('# TYPE elastrax_tool_errors_total counter');
    for (const name in m.tools) {
      const stats = m.tools[name]!;
      lines.push(`elastrax_tool_errors_total{tool="${name}"} ${stats.errors}`);
    }

    lines.push('# HELP elastrax_tool_duration_ms Tool execution duration percentiles');
    lines.push('# TYPE elastrax_tool_duration_ms gauge');
    for (const name in m.tools) {
      const stats = m.tools[name]!;
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.5"} ${stats.durationP50}`);
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.95"} ${stats.durationP95}`);
      lines.push(`elastrax_tool_duration_ms{tool="${name}",quantile="0.99"} ${stats.durationP99}`);
    }

    lines.push('# HELP elastrax_tokens_total Token usage by model and type');
    lines.push('# TYPE elastrax_tokens_total counter');
    for (const model in m.tokens) {
      const stats = m.tokens[model]!;
      lines.push(`elastrax_tokens_total{model="${model}",type="prompt"} ${stats.prompt}`);
      lines.push(`elastrax_tokens_total{model="${model}",type="completion"} ${stats.completion}`);
      lines.push(`elastrax_tokens_total{model="${model}",type="total"} ${stats.total}`);
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

    lines.push('# HELP elastrax_service_health Service health status (1=healthy, 0=unhealthy)');
    lines.push('# TYPE elastrax_service_health gauge');
    for (const [service, data] of Object.entries(m.services)) {
      lines.push(`elastrax_service_health{service="${service}"} ${data.status === 'healthy' ? 1 : 0}`);
    }

    return lines.join('\n') + '\n';
  }
}

/** Singleton metrics instance. Import and use directly. */
export const healthMetrics = new HealthMetricsCollector();
