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
      if (created.id && fragment.id) created.id = fragment.id;
      this.calls.set(fragment.index, created);
      return { ...created, function: { ...created.function } };
    }

    if (fragment.id) {
      if (existing.id && existing.id !== fragment.id) {
        throw new AIProtocolError('invalid_chunk', 'Streaming tool-call fragment changed its call id.');
      }
      existing.id = fragment.id;
    }
    if (fragment.function?.name) existing.function.name += fragment.function.name;
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
