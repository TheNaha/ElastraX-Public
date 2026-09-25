import { AIProtocolError } from './errors';

export interface SSEEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface SSEDecoderOptions {
  maxBufferBytes?: number;
  maxEventBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export class SSEDecoder {
  private readonly maxBufferBytes: number;
  private readonly maxEventBytes: number;
  private buffer = '';
  private dataLines: string[] = [];
  private eventName?: string;
  private eventId?: string;
  private retry?: number;
  private eventBytes = 0;

  constructor(options: SSEDecoderOptions = {}) {
    this.maxBufferBytes = positiveLimit(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES);
    this.maxEventBytes = positiveLimit(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
  }

  push(chunk: string): SSEEvent[] {
    if (!chunk) return [];
    if (chunk.length > this.maxBufferBytes || this.buffer.length + chunk.length > this.maxBufferBytes) {
      throw new AIProtocolError('sse_buffer_limit', 'SSE input exceeded the configured buffer limit.', {
        limit: this.maxBufferBytes,
      });
    }

    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): SSEEvent[] {
    const events = this.drain(true);
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    const finalEvent = this.dispatch();
    if (finalEvent) events.push(finalEvent);
    return events;
  }

  private drain(final: boolean): SSEEvent[] {
    const events: SSEEvent[] = [];
    while (this.buffer.length > 0) {
      const lf = this.buffer.indexOf('\n');
      const cr = this.buffer.indexOf('\r');
      let end: number;
      if (lf < 0 && cr < 0) break;
      if (lf < 0) end = cr;
      else if (cr < 0) end = lf;
      else end = Math.min(lf, cr);

      if (!final && end === this.buffer.length - 1 && this.buffer[end] === '\r') break;

      const line = this.buffer.slice(0, end);
      const newline = this.buffer[end];
      const consumed = newline === '\r' && this.buffer[end + 1] === '\n' ? end + 2 : end + 1;
      this.buffer = this.buffer.slice(consumed);
      const event = this.processLine(line);
      if (event) events.push(event);
    }

    if (this.buffer.length > this.maxBufferBytes) {
      throw new AIProtocolError('sse_buffer_limit', 'SSE input exceeded the configured buffer limit.', {
        limit: this.maxBufferBytes,
      });
    }
    return events;
  }

  private processLine(line: string): SSEEvent | null {
    this.eventBytes += line.length + 1;
    if (this.eventBytes > this.maxEventBytes) {
      throw new AIProtocolError('sse_buffer_limit', 'SSE event exceeded the configured size limit.', {
        limit: this.maxEventBytes,
      });
    }
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      this.dataLines.push(value);
    } else if (field === 'event') {
      this.eventName = value;
    } else if (field === 'id' && !value.includes('\0')) {
      this.eventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      this.retry = Number.parseInt(value, 10);
    }
    return null;
  }

  private dispatch(): SSEEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.eventId = undefined;
      this.retry = undefined;
      this.eventBytes = 0;
      return null;
    }
    const data = `${this.dataLines.join('\n').replace(/\n$/, '')}`;
    const event: SSEEvent = { data };
    if (this.eventName !== undefined) event.event = this.eventName;
    if (this.eventId !== undefined) event.id = this.eventId;
    if (this.retry !== undefined) event.retry = this.retry;
    this.dataLines = [];
    this.eventName = undefined;
    this.eventId = undefined;
    this.retry = undefined;
    this.eventBytes = 0;
    return event;
  }
}
