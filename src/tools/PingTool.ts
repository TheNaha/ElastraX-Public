import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'PingTool' });
const PROCESS_START = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export class PingTool extends BaseTool<ToolArgs> {
  readonly name = 'ping';
  readonly description = 'Check bot responsiveness, latency, and uptime.';
  readonly aliases = ['status', 'uptime'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/\b(ping|lag|latency|koneksi)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    };
  }

  async execute(_args: ToolArgs, ctx: MessageContext): Promise<string> {
    const receivedAt = ctx.receivedAt ?? Date.now();
    const latency = Date.now() - receivedAt;
    const uptime = formatUptime(Date.now() - PROCESS_START);

    log.debug({ latency, uptime, chatId: ctx.chatId }, 'Ping executed');

    return t(ctx.language, 'ping.response', {
      latency: String(latency > 0 ? latency : 0),
      uptime,
    });
  }
}
