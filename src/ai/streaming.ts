import { AIProtocolError } from './errors';
import type { StreamingToolCallDelta } from '../types/ai';
import type { ToolCallAccumulator } from './types';

export class StreamingToolCallAccumulator {
  private readonly calls = new Map<number, ToolCallAccumulator>();

  consume(fragment: StreamingToolCallDelta): ToolCallAccumulator {
    if (!Number.isInteger(fragment.index) || fragment.index < 0) {
      throw new AIProtocolError('invalid_chunk', 'Streaming tool-call fragment has an invalid index.');
    }
    if (fragment.type !== undefined && fragment.type !== 'function') {
      throw new AIProtocolError('invalid_chunk', 'Streaming tool-call fragment has an unsupported type.');
    }

    const existing = this.calls.get(fragment.index);
    if (!existing) {
      const created: ToolCallAccumulator = {
        index: fragment.index,
        id: fragment.id ?? '',
        type: 'function',
        function: {
          name: fragment.function?.name ?? '',
          arguments: fragment.function?.arguments ?? '',
        },
      };
      this.calls.set(fragment.index, created);
      return { ...created, function: { ...created.function } };
    }

    if (fragment.id) {
      if (existing.id && existing.id !== fragment.id) {
        throw new AIProtocolError('invalid_chunk', 'Streaming tool-call fragment changed its call id.');
      }
      existing.id = fragment.id;
    }
    if (fragment.function?.name) {
      // OpenAI-compatible servers fragment the name across deltas ("get_" then
      // "weather"), but some repeat the *whole* name in every delta. Blind
      // concatenation turned the latter into "get_weatherget_weather", so the
      // tool lookup failed and tool calling was dead on that backend. Accept a
      // repeat that extends what we already have; otherwise treat it as the
      // next fragment.
      const incoming = fragment.function.name;
      if (!existing.function.name || !incoming.startsWith(existing.function.name)) {
        existing.function.name += incoming;
      } else {
        existing.function.name = incoming;
      }
    }
    if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments;
    return { ...existing, function: { ...existing.function } };
  }

  consumeDelta(toolCalls: StreamingToolCallDelta[] | undefined): ToolCallAccumulator[] {
    if (!toolCalls) return [];
    return toolCalls.map(fragment => this.consume(fragment));
  }

  finish(): ToolCallAccumulator[] {
    return [...this.calls.values()]
      .sort((a, b) => a.index - b.index)
      .map(call => ({ ...call, function: { ...call.function } }));
  }

  get size(): number {
    return this.calls.size;
  }

  clear(): void {
    this.calls.clear();
  }
}
