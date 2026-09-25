export type ProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'START_FAILED'
  | 'NOT_CONNECTED'
  | 'INVALID_TARGET'
  | 'UNSUPPORTED'
  | 'OPERATION_FAILED'
  | 'STALE_LIFECYCLE'
  | 'PERMISSION_DENIED';

export class ProviderError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(
    provider: string,
    operation: string,
    code: ProviderErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.operation = operation;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class ProviderStartError extends ProviderError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(provider, 'start', 'START_FAILED', message, { cause, retryable: true });
    this.name = 'ProviderStartError';
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(provider, operation, 'NOT_CONFIGURED', `${provider} provider is not configured.`);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderLifecycleError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(provider, operation, 'STALE_LIFECYCLE', `${provider} connection changed before ${operation} completed.`, { retryable: true });
    this.name = 'ProviderLifecycleError';
  }
}

export class ProviderOperationError extends ProviderError {
  constructor(provider: string, operation: string, message: string, cause?: unknown, code: ProviderErrorCode = 'OPERATION_FAILED') {
    super(provider, operation, code, message, { cause });
    this.name = 'ProviderOperationError';
  }
}
