/**
 * @file src/utils/logger.ts
 * @description Shared structured logger instance for the entire ElastraX application.
 *
 * Built on [Pino](https://getpino.io/), a low-overhead JSON logger, with the
 * `pino-pretty` transport for human-readable, colourised output during development.
 *
 * Log level:
 *  Controlled by the `LOG_LEVEL` environment variable.  Valid values are:
 *  `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`.
 *
 * Usage:
 * ```ts
 * import { logger } from './utils/logger';
 *
 * logger.info('Server started');
 * logger.warn({ userId }, 'Session expired');
 * logger.error(err, 'Unexpected failure');
 * ```
 *
 * In production you may want to swap the transport for structured JSON output by
 * removing the `transport` block so logs can be ingested by tools like Datadog or Loki.
 */

import pino from 'pino';

/** Application-wide logger.  Import this in every module that emits log output. */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      singleLine: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
    },
  },
});
