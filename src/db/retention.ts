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
  /** Inbox rows stuck in a non-terminal state past the retention window. */
  inboxStale: number;
  outbox: number;
  /** Outbox rows stuck in a non-terminal state past the retention window. */
  outboxStale: number;
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

// Whitelist of allowed table names for SQL queries (prevents SQL injection)
const ALLOWED_TABLES = new Set([
  'raw_messages',
  'messages',
  'reminders',
  'message_inbox',
  'message_outbox',
  'flow_sessions',
]);

function dayCount(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

function validateTableName(tableName: string): void {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
}

function deleteBatches(
  sqlite: Database,
  table: string,
  where: string,
  params: readonly number[],
  batchSize: number,
  dryRun: boolean,
): number {
  validateTableName(table);
  if (dryRun) {
    const row = sqlite
      .query<{ count: number }, number[]>(`SELECT count(*) AS count FROM ${table} WHERE ${where}`)
      .get(...params);
    return Number(row?.count ?? 0);
  }
  let deleted = 0;
  while (true) {
    const result = sqlite
      .query<never, number[]>(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
      )
      .run(...params, batchSize);
    const changed = Number(result.changes);
    deleted += changed;
    if (changed < batchSize) break;
  }
  return deleted;
}

// Normalize a stored timestamp to milliseconds. Columns written through Drizzle's
// `timestamp` mode hold seconds, while columns written with `Date.now()` hold
// milliseconds; retention must compare them on a common scale. Values above 1e11
// are treated as milliseconds, smaller ones as seconds.
const NORMALIZE_TS = (column: string): string =>
  `CASE WHEN ${column} > 100000000000 THEN ${column} ELSE ${column} * 1000 END`;

/**
 * "This timestamp is older than the cutoff, in whichever unit it was stored in".
 *
 * The `CASE` has to stay: rows written before the unit clean-up are still in the
 * table. But a column wrapped in an expression cannot be range-seeked, so the
 * plan for every retention pass was a scan of the whole timestamp index (verified
 * with `EXPLAIN QUERY PLAN`). The leading plain comparison is implied by the
 * normalized one in both units — seconds are always below a millisecond cutoff —
 * and gives the planner the range it needs. Bind the cutoff twice.
 */
function olderThan(column: string): string {
  return `${column} < ? AND ${NORMALIZE_TS(column)} < ?`;
}

/** Bindings for {@link olderThan} / {@link NORMALIZE_TS} predicates. */
function cutoffParams(cutoff: number): number[] {
  return [cutoff, cutoff];
}

function clearRawMessageBatches(
  sqlite: Database,
  cutoff: number,
  batchSize: number,
  dryRun: boolean,
): number {
  const where = `raw_message IS NOT NULL AND ${olderThan('created_at')}`;
  if (dryRun) {
    const row = sqlite
      .query<{ count: number }, number[]>(
        `SELECT count(*) AS count FROM messages WHERE ${where}`,
      )
      .get(...cutoffParams(cutoff));
    return Number(row?.count ?? 0);
  }
  let cleared = 0;
  while (true) {
    const result = sqlite
      .query<never, number[]>(
        `UPDATE messages
         SET raw_message = NULL, media_path = NULL, mime_type = NULL
         WHERE rowid IN (
           SELECT rowid FROM messages
           WHERE ${where}
           LIMIT ?
         )`,
      )
      .run(...cutoffParams(cutoff), batchSize);
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
  const dryRun = options.dryRun ?? true;
  const batchSize = Math.max(1, Math.min(10_000, Math.trunc(options.batchSize ?? 500)));
  const dayMs = 86_400_000;

  const result: RetentionResult = {
    rawMessages: clearRawMessageBatches(
      sqlite,
      nowMs - 7 * dayMs,
      batchSize,
      dryRun,
    ),
    messages: deleteBatches(
      sqlite,
      'messages',
      olderThan('created_at'),
      cutoffParams(nowMs - (policy.messagesDays + policy.messageDeleteGraceDays) * dayMs),
      batchSize,
      dryRun,
    ),
    reminders: deleteBatches(
      sqlite,
      'reminders',
      `is_sent = 1 AND recurrence IS NULL AND ${olderThan('created_at')}`,
      cutoffParams(nowMs - policy.sentRemindersDays * dayMs),
      batchSize,
      dryRun,
    ),
    inbox: deleteBatches(
      sqlite,
      'message_inbox',
      `state IN ('completed', 'dead_letter') AND COALESCE(${NORMALIZE_TS('completed_at')}, ${NORMALIZE_TS('updated_at')}) < ?`,
      [nowMs - policy.terminalDeliveriesDays * dayMs],
      batchSize,
      dryRun,
    ),
    // Rows that are still `pending`/`failed`/`leased` were never swept, so
    // they were immortal: a delivery for a platform that never came back
    // operational stays `pending` forever, its attempt counter never advances,
    // and the table grows without bound. Everything that has been sitting in a
    // non-terminal state for longer than the terminal window is garbage by
    // definition — the lease has long expired and nothing will claim it.
    inboxStale: deleteBatches(
      sqlite,
      'message_inbox',
      `state IN ('received', 'processing', 'failed') AND COALESCE(${NORMALIZE_TS('completed_at')}, ${NORMALIZE_TS('updated_at')}) < ?`,
      [nowMs - policy.terminalDeliveriesDays * dayMs],
      batchSize,
      dryRun,
    ),
    outbox: deleteBatches(
      sqlite,
      'message_outbox',
      `state IN ('sent', 'dead_letter') AND COALESCE(${NORMALIZE_TS('sent_at')}, ${NORMALIZE_TS('updated_at')}) < ?`,
      [nowMs - policy.terminalDeliveriesDays * dayMs],
      batchSize,
      dryRun,
    ),
    outboxStale: deleteBatches(
      sqlite,
      'message_outbox',
      `state IN ('pending', 'failed', 'leased') AND COALESCE(${NORMALIZE_TS('sent_at')}, ${NORMALIZE_TS('updated_at')}) < ?`,
      [nowMs - policy.terminalDeliveriesDays * dayMs],
      batchSize,
      dryRun,
    ),
    flowSessions: deleteBatches(
      sqlite,
      'flow_sessions',
      olderThan('updated_at'),
      cutoffParams(nowMs - policy.expiredFlowSessionsDays * dayMs),
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
