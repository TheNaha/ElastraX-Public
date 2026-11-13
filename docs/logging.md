# Logging

ElastraX logs with [Pino](https://getpino.io/), a low-overhead JSON logger (`src/utils/logger.ts`).

## Transport and level

| Setting | Value | Purpose |
|---|---|---|
| `LOG_LEVEL` | `trace` \| `debug` \| `info` (default) \| `warn` \| `error` \| `fatal` | Verbosity. |
| `NODE_ENV` | `development` (default) \| `production` | `production` emits raw JSON lines; anything else uses the `pino-pretty` transport for human-readable, colourised output. |

In development, `pino-pretty` is configured with `colorize: true`, `singleLine: true`, `translateTime: 'HH:MM:ss.l'`, and `messageFormat: '{module} {msg}'`. Tests also use raw JSON (no transport).

## Usage

```ts
import { logger } from './utils/logger';

logger.info('Server started');
logger.warn({ userId }, 'Session expired');
logger.error(err, 'Unexpected failure');
logger.child({ module: 'Agent' }).debug({ chatId }, 'Routing message');
```

Every module that emits log output imports `logger` and typically creates a child logger:

```ts
const log = logger.child({ module: 'MyModule' });
```

## What is logged

- Startup: schema fingerprint, applied migration count, provider connect status (`Connected successfully.` / `Logged in as …`), webhook server listening, `Bot is running` with the ready provider list.
- Provider lifecycle: reconnects (backoff, delay), close codes (`515`, `401`), send failures.
- Inbound: `Provider event already completed` for duplicate events; rate-limit rejections.
- Outbox: pruned terminal rows, recovered stranded inbox rows, delivery failures.
- Background tasks: rate-limiter prune, retention maintenance, flow-session TTL prune, media cleanup.
- Errors: tool execution failures, webhook request rejections, health-check failures.
- Shutdown: graceful shutdown complete.

## Log levels by convention

- `trace` / `debug`: fine-grained diagnostic context (binding lookups, cache hits, per-turn details).
- `info`: normal operational events (startup, shutdown, message received, command completed).
- `warn`: expected failures that are handled (transcription failed, media download skipped, plugin refused).
- `error`: unexpected failures (provider stop failed, outbox worker failed, retention maintenance failed).
- `fatal`: process-terminating errors (bootstrap failure, environment validation failure).

## Verification

```
bun test --no-env-file test/  # logger used throughout; no dedicated logger test file
LOG_LEVEL=debug bun run src/index.ts   # local dev with verbose logging
```