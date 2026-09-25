export type AIProtocolErrorCode =
  | 'invalid_response'
  | 'no_choices'
  | 'invalid_chunk'
  | 'invalid_sse'
  | 'sse_buffer_limit'
  | 'empty_stream'
  | 'incomplete_stream'
  | 'empty_response';

export class AIProtocolError extends Error {
  readonly code: AIProtocolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AIProtocolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AIProtocolError';
    this.code = code;
    this.details = details;
  }
}

export class AINoChoiceError extends AIProtocolError {
  readonly responseId?: string;

  constructor(message: string, responseId?: string) {
    super('no_choices', message, responseId ? { responseId } : undefined);
    this.name = 'AINoChoiceError';
    this.responseId = responseId;
  }
}

export class AllProvidersOpenError extends Error {
  readonly code = 'all_providers_open';
  readonly providerKeys: string[];

  constructor(providerKeys: string[]) {
    super('All configured AI provider circuits are open.');
    this.name = 'AllProvidersOpenError';
    this.providerKeys = providerKeys;
  }
}
