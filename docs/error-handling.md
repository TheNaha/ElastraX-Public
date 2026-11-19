# Error Handling

ElastraX uses typed errors with codes and retryability flags. Startup validation throws after logging every environment error; the process does not start with an invalid environment.

## Startup validation

`validateEnv` (`src/config/env.ts`) throws at startup if any required variable is missing or malformed:

- Bad booleans (must be exactly `true` or `false`).
- Non-integer bounds or out-of-range integers.
- Weak secrets (fewer than 24 bytes).
- Non-RFC3339 compatibility deadlines (must be absolute, future-dated).
- Unsafe hosts: plain `http` is accepted only on a loopback address, except for `SEARXNG_URL`, `SEERR_API_URL` and `JELLYFIN_API_URL`, which opt in to plain http on any host because they are routinely self-hosted without TLS. The AI base URLs and `TRANSCRIBE_ENDPOINT` carry a credential, so they stay https-unless-loopback.
- Credentials in URLs (`user:pass@`).
- `AI_PROVIDERS` empty, duplicated, or containing invalid provider names.
- `AI_TIER` not one of `standard`, `fast`, `powerful`.

`parseWebhookConfig` (`src/webhooks/config.ts`) throws for malformed webhook settings (non-integer ports, bad host values, `0.0.0.0` without `WEBHOOK_CONTAINER_MODE=true`, whitespace-padded secrets). `AppRuntime.start()` calls it *before* any provider connects, so a bad `WEBHOOK_*` value fails fast instead of tearing down providers that already connected. A too-short `METRICS_AUTH_TOKEN` does **not** abort boot; it disables `/metrics` and `/admin` (fail closed) and logs a warning.

## Error types

| Type | File | Codes / kinds | Retryable? |
|---|---|---|---|
| `ProviderError` | `src/providers/errors.ts` | `NOT_CONFIGURED`, `START_FAILED`, `NOT_CONNECTED`, `INVALID_TARGET`, `UNSUPPORTED`, `OPERATION_FAILED`, `STALE_LIFECYCLE`, `PERMISSION_DENIED` | `retryable` flag per error |
| `AIProtocolError` | `src/ai/errors.ts` | `invalid_response`, `no_choices`, `invalid_chunk`, `invalid_sse`, `sse_buffer_limit`, `empty_stream`, `incomplete_stream`, `empty_response`, `response_too_large` | — |
| `WebhookRequestError` | `src/webhooks/utils.ts` | carries an HTTP status; server maps it to the response status | — |
| `HttpClientError` | `src/utils/BaseHttpClient.ts` | `INVALID_URL`, `INVALID_PROTOCOL`, `TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR`, `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`; carries `service`, `status`, `retryable` | `true` for timeouts, network failures, `429`, and `5xx` |
| `TurnBudgetExceededError` | `src/ai/turnBudget.ts` | — | reported back to the model as a tool result; the turn still finishes |
| `TimeoutError` | `src/utils/withTimeout.ts` | `TIMEOUT` | carries a label and the timeout; the wrapped operation is aborted when it accepts a signal |
| `FlowVersionConflictError` | `src/core/FlowHandler.ts` | raised when a stale flow writer loses the version race | — |
| `ScheduledTaskCapabilityError` | `src/runtime/AppRuntime.ts` | raised when a scheduled agent task reaches for a denied capability | — |
| `ReadOnlyViolationError` | `scripts/ciDiagnostics.ts` | raised when a non-allowlisted `gh` command is attempted | — |

### LLM request failures

`AIClient` (`src/ai/client.ts`) throws a plain `Error` — `LLM API returned <status>: request failed` — for a non-2xx completion. The response body is read through a 64 KiB bound and truncated to 500 characters for the log line; it is never re-thrown, because a gateway error page can echo credentials. An oversized error body is logged as `<error body exceeds 64 KiB>` rather than `<unreadable>`, so the log says why the text is missing. A success body is bounded by `AI_MAX_RESPONSE_BYTES` as bytes arrive and an oversize one becomes `AIProtocolError('response_too_large')`.

## Provider lifecycle errors

Provider failures surface as `ProviderError` subclasses. WhatsApp reconnect policy:

- Every disconnect reason **except** `DisconnectReason.loggedOut` schedules a reconnect (backoff 1500 ms, doubling, capped at 300 000 ms); status goes `backoff` → `running`, and readiness is 503 transiently then recovers without a restart. Code `515` (connection closed) is the common case.
- `401` (`loggedOut`): terminal. No reconnect is scheduled; status is `error` and the account must be re-paired.

## Inbox / Outbox dead-lettering

Both `InboxService` and `OutboxService` dead-letter a row after 5 failed attempts (`MAX_ATTEMPTS = 5`). Stranded in-flight rows are recovered or dead-lettered by the hourly `recoverStranded` scan, which fails never-claimed rows older than 24 h and returns expired-lease rows to `received`. The outbox claim lease is 120 s; the inbox claim lease is derived from the turn budget and clamped to 10–60 minutes. Outbox rows are retried with attempt-aware exponential backoff (`baseMs: 30_000`, `maxExponent: 7`). A `failed` inbox row has no periodic retry driver of its own, with one exception: a provider redelivery of an event already in the ledger is admitted with `claim(id, owner, { allowBackoff: true })`, so it proceeds despite the worker's own backoff (WhatsApp's decrypt-retry re-emit is the one real redelivery path). That exception never preempts a turn that is still running.

## Message-handling failures

`handleIncomingMessage` (`src/agent/index.ts`) wraps every phase before the AI call — room lookup, role resolution, flow interception and slash routing. If one throws, the handler logs with `(pre-reply)`, records `healthMetrics.recordMessageError()`, reacts ❌, replies with the translated `agent.internal_error` string, and **rethrows**. The rethrow is deliberate: swallowing it made the caller mark the inbox row `completed`, so a transient failure (busy database, a room-config read) was acknowledged and could never be retried. The AI phase is caught inside the handler and produces its own user-facing error instead.

## Timeouts

`withTimeout` / `withCancellableTimeout` (`src/utils/withTimeout.ts`) race an operation against `TimeoutError`. Both settle the returned promise **before** invoking `onTimeout` and the abort controller, so a throwing abort listener cannot leave the caller awaiting a promise that never resolves. `withCancellableTimeout` passes the generated signal to the operation, so an HTTP client or child process is actually cancelled rather than merely ignored. `timeoutSignal(ms)` is the shared, `unref`'d alternative for `fetch` calls that only need a signal.

## Transactions

`withImmediateTransaction` (`src/db/runtime.ts`) is **synchronous by contract**. A callback that returns a promise makes it roll back, observe and swallow the abandoned promise (so a later rejection cannot become an unhandled rejection, which Bun treats as fatal), and throw a `TypeError`. Restructure the work or wrap the synchronous write instead of awaiting inside the callback.

## Webhook errors

`WebhookRequestError` carries an HTTP status:

- `401` — invalid or missing secret (generic/media routes), invalid GitHub signature.
- `405` — wrong method on a known path, with `Allow` header.
- `415` — non-JSON `Content-Type` on POST.
- `413` — body over `WEBHOOK_MAX_BODY_BYTES`.
- `408` — body not completed within `WEBHOOK_BODY_READ_TIMEOUT_MS`.
- `400` — invalid or excess destinations, invalid JSON body, invalid platform.
- `429` — rate limit exceeded, with `Retry-After`.
- `502` — a synchronous delivery failed for every destination (nothing was sent, so the request is retryable).
- `503` — webhook intake disabled, missing secret, durable enqueuer rejected, replay cache at capacity, or a duplicate delivery id still in flight.

## Logging of errors

All modules log via Pino (`src/utils/logger.ts`). Errors are logged with structured context (`{ err, module, ... }`). `getErrorMessage` / `safeErrorMessage` (`src/utils/errorUtils.ts`) extract a safe message for user-facing responses; `redactSecrets` (`src/runtime/AppRuntime.ts`) strips credential-shaped strings before they leave the process (readiness bodies must never leak secrets).

## Verification

```
bun test --no-env-file test/errorUtils.test.ts
bun test --no-env-file test/config.test.ts
bun test --no-env-file test/WebhookServer.security.test.ts
bun test --no-env-file test/ProviderStagingHarness.test.ts
```