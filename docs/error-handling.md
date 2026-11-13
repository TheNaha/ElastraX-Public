# Error Handling

ElastraX uses typed errors with codes and retryability flags. Startup validation throws after logging every environment error; the process does not start with an invalid environment.

## Startup validation

`validateEnv` (`src/config/env.ts`) throws at startup if any required variable is missing or malformed:

- Bad booleans (must be exactly `true` or `false`).
- Non-integer bounds or out-of-range integers.
- Weak secrets (fewer than 24 bytes).
- Non-RFC3339 compatibility deadlines (must be absolute, future-dated).
- Unsafe hosts (`http` non-loopback URLs without `allowLoopbackHttp`).
- Credentials in URLs (`user:pass@`).
- `AI_PROVIDERS` empty, duplicated, or containing invalid provider names.
- `AI_TIER` not one of `standard`, `fast`, `powerful`.

`parseWebhookConfig` (`src/webhooks/config.ts`) throws for malformed webhook settings (non-integer ports, bad host values, `0.0.0.0` without `WEBHOOK_CONTAINER_MODE=true`, whitespace-padded secrets). A too-short `METRICS_AUTH_TOKEN` does **not** abort boot; it disables `/metrics` and `/admin` (fail closed) and logs a warning.

## Error types

| Type | File | Codes / kinds | Retryable? |
|---|---|---|---|
| `ProviderError` | `src/providers/errors.ts` | `NOT_CONFIGURED`, `START_FAILED`, `NOT_CONNECTED`, `INVALID_TARGET`, `UNSUPPORTED`, `OPERATION_FAILED`, `STALE_LIFECYCLE`, `PERMISSION_DENIED` | `retryable` flag per error |
| `AIProtocolError` | `src/ai/errors.ts` | `invalid_response`, `no_choices`, `invalid_chunk`, `invalid_sse`, `sse_buffer_limit`, `empty_stream`, `incomplete_stream`, `empty_response`, `response_too_large` | — |
| `WebhookRequestError` | `src/webhooks/utils.ts` | carries an HTTP status; server maps it to the response status | — |
| `TurnBudgetExceededError` | `src/ai/turnBudget.ts` | — | reported back to the model as a tool result; the turn still finishes |
| `FlowVersionConflictError` | `src/core/FlowHandler.ts` | raised when a stale flow writer loses the version race | — |
| `ScheduledTaskCapabilityError` | `src/runtime/AppRuntime.ts` | raised when a scheduled agent task reaches for a denied capability | — |
| `ReadOnlyViolationError` | `scripts/ciDiagnostics.ts` | raised when a non-allowlisted `gh` command is attempted | — |

## Provider lifecycle errors

Provider failures surface as `ProviderError` subclasses. WhatsApp reconnect policy:

- Close code `515`: schedules a reconnect (backoff 1500 ms, doubling, capped at 300 000 ms); retryable; status `backoff` → `running`; readiness is 503 transiently then recovers without restart.
- Close code `401`: terminal (logged out); no reconnect scheduled; status `error`; requires re-pairing.

## Inbox / Outbox dead-lettering

Both `InboxService` and `OutboxService` dead-letter a row after 5 failed attempts (`MAX_ATTEMPTS = 5`). Stranded in-flight rows are recovered or dead-lettered by the hourly `recoverStranded` scan (24 h lease). Outbox rows are retried with attempt-aware exponential backoff (`baseMs: 30_000`, `maxExponent: 7`).

## Webhook errors

`WebhookRequestError` carries an HTTP status:

- `401` — invalid or missing secret (generic/media routes), invalid GitHub signature.
- `405` — wrong method on a known path, with `Allow` header.
- `415` — non-JSON `Content-Type` on POST.
- `413` — body over `WEBHOOK_MAX_BODY_BYTES`.
- `408` — body not completed within `WEBHOOK_BODY_READ_TIMEOUT_MS`.
- `400` — invalid or excess destinations, invalid JSON body, invalid platform.
- `429` — rate limit exceeded, with `Retry-After`.
- `503` — webhook intake disabled, missing secret, durable enqueuer rejected, replay cache at capacity.

## Logging of errors

All modules log via Pino (`src/utils/logger.ts`). Errors are logged with structured context (`{ err, module, ... }`). `getErrorMessage` / `safeErrorMessage` (`src/utils/errorUtils.ts`) extract a safe message for user-facing responses; `redactSecrets` (`src/runtime/AppRuntime.ts`) strips credential-shaped strings before they leave the process (readiness bodies must never leak secrets).

## Verification

```
bun test --no-env-file test/errorUtils.test.ts
bun test --no-env-file test/config.test.ts
bun test --no-env-file test/WebhookServer.security.test.ts
bun test --no-env-file test/ProviderStagingHarness.test.ts
```