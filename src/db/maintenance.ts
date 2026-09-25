import { sqlite } from './index';
import { applyRetentionPolicy, type RetentionOptions, type RetentionResult } from './retention';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'Retention' });

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function runRetentionMaintenance(overrides: Partial<RetentionOptions> = {}): RetentionResult {
  const dryRun = overrides.dryRun ?? envBoolean('RETENTION_DRY_RUN', true);
  const result = applyRetentionPolicy(sqlite, {
    messagesDays: envInteger('RETENTION_MESSAGES_DAYS', 180, 30, 3_650),
    messageDeleteGraceDays: envInteger('RETENTION_MESSAGE_GRACE_DAYS', 30, 0, 365),
    sentRemindersDays: envInteger('RETENTION_SENT_REMINDER_DAYS', 90, 7, 3_650),
    terminalDeliveriesDays: envInteger('RETENTION_TERMINAL_DELIVERY_DAYS', 90, 7, 3_650),
    expiredFlowSessionsDays: envInteger('RETENTION_FLOW_SESSION_DAYS', 30, 1, 365),
  }, {
    dryRun,
    batchSize: envInteger('RETENTION_BATCH_SIZE', 500, 1, 10_000),
    vacuum: false,
    ...overrides,
  });
  log.info(result, dryRun ? 'Retention dry run completed' : 'Retention cleanup completed');
  return result;
}
