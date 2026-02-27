/**
 * @file src/tools/PingTool.ts
 * @description Simple latency and uptime health-check tool.
 *
 * Measures the round-trip time from when the message arrives to when the bot
 * generates this response, and reports the process uptime.
 * 
 * Works both as a slash command (/ping) and conversationally
 * ("are you online?", "what's your latency?").
 *
 * Slash command aliases: /ping, /status
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';

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

export class PingTool extends BaseTool {
  readonly name = 'ping';
  readonly description = 'Check if the bot is responsive and display latency and uptime. Use this when the user asks if the bot is online, what the latency is, or for a health check.';
  readonly aliases = ['status', 'uptime'];
  readonly category = 'utility';
  readonly permissions = 'user';

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

  async execute(_args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const receivedAt = ctx.receivedAt ?? Date.now();
    const latency = Date.now() - receivedAt;
    const uptime = formatUptime(Date.now() - PROCESS_START);

    return t(ctx.language, 'ping.response', {
      latency: String(latency > 0 ? latency : 0),
      uptime,
    });
  }
}
