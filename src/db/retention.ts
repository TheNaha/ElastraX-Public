import type { Database } from 'bun:sqlite';

export interface RetentionPolicy {
  messagesDays: number;
  messageDeleteGraceDays: number;
  sentRemindersDays: number;
  terminalDeliveriesDays: number;
  expiredFlowSessionsDays: number;
}

export interface RetentionResult {
  rawMessages: number;
  messages: number;
  reminders: number;
  inbox: number;
  outbox: number;
  scheduledDeliveries: number;
  flowSessions: number;
  dryRun: boolean;
}

export interface RetentionOptions {
  now?: number;
  dryRun?: boolean;
  batchSize?: number;
  vacuum?: boolean;
}

const DEFAULT_POLICY: RetentionPolicy = {
  messagesDays: 180,
  messageDeleteGraceDays: 30,
  sentRemindersDays: 90,
  terminalDeliveriesDays: 90,
  expiredFlowSessionsDays: 30,
};

function dayCount(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

function deleteBatches(
  sqlite: Database,
  table: string,
  where: string,
  cutoff: number,
  batchSize: number,
  dryRun: boolean,
): number {
  if (dryRun) {
    const row = sqlite
      .query<{ count: number }, [number]>(`SELECT count(*) AS count FROM ${table} WHERE ${where}`)
      .get(cutoff);
    return Number(row?.count ?? 0);
  }
  let deleted = 0;
  while (true) {
    const result = sqlite
      .query<never, [number, number]>(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
      )
      .run(cutoff, batchSize);
    const changed = Number(result.changes);
    deleted += changed;
    if (changed < batchSize) break;
  }
  return deleted;
}

function clearRawMessageBatches(
  sqlite: Database,
  cutoff: number,
  batchSize: number,
  dryRun: boolean,
): number {
  if (dryRun) {
    const row = sqlite
      .query<{ count: number }, [number]>(
        'SELECT count(*) AS count FROM messages WHERE raw_message IS NOT NULL AND created_at < ?',
      )
      .get(cutoff);
    return Number(row?.count ?? 0);
  }
  let cleared = 0;
  while (true) {
    const result = sqlite
      .query<never, [number, number]>(
        `UPDATE messages
         SET raw_message = NULL, media_path = NULL, mime_type = NULL
         WHERE rowid IN (
           SELECT rowid FROM messages
           WHERE raw_message IS NOT NULL AND created_at < ?
           LIMIT ?
         )`,
      )
      .run(cutoff, batchSize);
    const changed = Number(result.changes);
    cleared += changed;
    if (changed < batchSize) break;
  }
  return cleared;
}

export function applyRetentionPolicy(
  sqlite: Database,
  policyInput: Partial<RetentionPolicy> = {},
  options: RetentionOptions = {},
): RetentionResult {
  const policy: RetentionPolicy = {
    messagesDays: dayCount(policyInput.messagesDays, DEFAULT_POLICY.messagesDays),
    messageDeleteGraceDays: dayCount(
      policyInput.messageDeleteGraceDays,
      policyInput.messagesDays === undefined ? DEFAULT_POLICY.messageDeleteGraceDays : 0,
    ),
    sentRemindersDays: dayCount(policyInput.sentRemindersDays, DEFAULT_POLICY.sentRemindersDays),
    terminalDeliveriesDays: dayCount(policyInput.terminalDeliveriesDays, DEFAULT_POLICY.terminalDeliveriesDays),
    expiredFlowSessionsDays: dayCount(policyInput.expiredFlowSessionsDays, DEFAULT_POLICY.expiredFlowSessionsDays),
  };
  const nowMs = options.now ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const dryRun = options.dryRun ?? true;
  const batchSize = Math.max(1, Math.min(10_000, Math.trunc(options.batchSize ?? 500)));
  const dayMs = 86_400_000;

  const result: RetentionResult = {
    rawMessages: clearRawMessageBatches(
      sqlite,
      nowSeconds - 7 * 86_400,
      batchSize,
      dryRun,
    ),
    messages: deleteBatches(
      sqlite,
      'messages',
      'created_at < ?',
      nowSeconds - (policy.messagesDays + policy.messageDeleteGraceDays) * 86_400,
      batchSize,
      dryRun,
    ),
    reminders: deleteBatches(
      sqlite,
      'reminders',
      'is_sent = 1 AND recurrence IS NULL AND created_at < ?',
      nowSeconds - policy.sentRemindersDays * 86_400,
      batchSize,
      dryRun,
    ),
    inbox: deleteBatches(
      sqlite,
      'message_inbox',
      "state IN ('completed', 'dead_letter') AND COALESCE(completed_at, updated_at) < ?",
      nowMs - policy.terminalDeliveriesDays * dayMs,
      batchSize,
      dryRun,
    ),
    outbox: deleteBatches(
      sqlite,
      'message_outbox',
      "state IN ('sent', 'dead_letter') AND COALESCE(sent_at, updated_at) < ?",
      nowMs - policy.terminalDeliveriesDays * dayMs,
      batchSize,
      dryRun,
    ),
    scheduledDeliveries: deleteBatches(
      sqlite,
      'scheduled_deliveries',
      "state IN ('sent', 'dead_letter') AND COALESCE(sent_at, updated_at) < ?",
      nowMs - policy.terminalDeliveriesDays * dayMs,
      batchSize,
      dryRun,
    ),
    flowSessions: deleteBatches(
      sqlite,
      'flow_sessions',
      'updated_at < ?',
      nowSeconds - policy.expiredFlowSessionsDays * 86_400,
      batchSize,
      dryRun,
    ),
    dryRun,
  };

  if (!dryRun) {
    sqlite.exec('PRAGMA optimize');
    if (options.vacuum) sqlite.exec('VACUUM');
  }
  return result;
}
