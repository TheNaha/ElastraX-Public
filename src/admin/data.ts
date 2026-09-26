/**
 * @file src/admin/data.ts
 * @description Read queries and safe actions behind the admin dashboard.
 *
 * Every function here is a thin, purpose-built query. Nothing is assembled by
 * string interpolation of user input, and secrets are never returned — config is
 * reported through an explicit allowlist of key names.
 */
import { readFileSync } from 'fs';
import { and, desc, eq, sql, count } from 'drizzle-orm';
import { db } from '../db';
import {
  chatRooms,
  memories,
  messageInbox,
  messageOutbox,
  reminders,
  roomKeys,
  flowSessions,
} from '../db/schema';
import { healthMetrics } from '../utils/HealthMetrics';
import { getRoomKeyStats } from '../db/rooms';
import { getToolCatalog, getPluginLoadReports, getAlwaysLoadedDefinitions, getTriggeredTools } from '../tools/registry';
import { reloadRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/BaseTool';
import { removeRoomDocument, listRoomDocuments, DOCUMENT_CATEGORY } from '../utils/roomKnowledge';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { readIntegerEnv } from '../config/runtime';
import { APP_RELEASE_TAG, APP_VERSION } from '../config/version';

const log = logger.child({ module: 'AdminData' });

const MAX_TABLE_ROWS = 200;

/** Trim arbitrary text to something safe to render in a table cell. */
function clip(value: unknown, max = 300): string {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}

export type OverviewPayload = ReturnType<typeof buildOverview>;

export function buildOverview(): Record<string, unknown> {
  const metrics = healthMetrics.getMetrics();
  return {
    version: APP_VERSION,
    releaseTag: APP_RELEASE_TAG,
    uptimeSeconds: metrics.uptime,
    messages: metrics.messages,
    llm: metrics.llm,
    tokens: metrics.tokens,
    memory: metrics.memory,
    providers: metrics.providers,
    feedback: metrics.feedback,
    queue: metrics.queue,
    services: metrics.services,
    at: new Date().toISOString(),
  };
}

/** Token spend per model, plus a total, for a cost-oriented view. */
export function tokenSpend(): { models: Array<{ model: string; total: number; prompt: number; completion: number }>; total: number } {
  const metrics = healthMetrics.getMetrics();
  const models = Object.entries(metrics.tokens).map(([model, stats]) => ({
    model,
    total: stats.total,
    prompt: stats.prompt,
    completion: stats.completion,
  }));
  models.sort((a, b) => b.total - a.total);
  return { models, total: models.reduce((sum, entry) => sum + entry.total, 0) };
}

export type ToolRow = {
  name: string;
  category: string;
  permission: string;
  enabled: boolean;
  groupOnly: boolean;
  alwaysLoad: boolean;
  aliases: string[];
  hasTriggers: boolean;
  modelTier: string;
  mutability: string;
  invocations: number;
  errors: number;
  errorRate: number;
  durationP50: number;
  durationP95: number;
  seen: boolean;
};

export function toolInventory(): {
  tools: ToolRow[];
  alwaysLoaded: string[];
  plugins: ReturnType<typeof getPluginLoadReports>[number][];
  catalogSize: number;
  triggeredBySample: string[];
} {
  const metrics = healthMetrics.getMetrics();
  // An owner-wide view: the dashboard is already owner-gated, so this shows
  // every tool including admin-only ones rather than a user's subset.
  const context = { roles: ['owner'], isOwner: true };
  const tools: ToolRow[] = getToolCatalog(context).map(entry => {
    const tool = entry.tool;
    const stats = metrics.tools[tool.name];
    const invocations = stats?.invocations ?? 0;
    const errors = stats?.errors ?? 0;
    return {
      name: tool.name,
      category: tool.category,
      permission: tool.permissions,
      enabled: entry.access.enabled,
      groupOnly: entry.access.groupOnly,
      alwaysLoad: tool.alwaysLoad,
      aliases: tool.aliases,
      hasTriggers: (tool.triggerPatterns?.length ?? 0) > 0,
      modelTier: tool.modelTier,
      mutability: entry.access.mutability,
      invocations,
      errors,
      errorRate: invocations > 0 ? Number((errors / invocations).toFixed(4)) : 0,
      durationP50: stats?.durationP50 ?? 0,
      durationP95: stats?.durationP95 ?? 0,
      seen: Boolean(stats),
    };
  });
  tools.sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));
  return {
    tools,
    alwaysLoaded: getAlwaysLoadedDefinitions(context).map((definition: ToolDefinition) => definition.function.name),
    plugins: [...getPluginLoadReports()],
    catalogSize: tools.length,
    // A sanity probe: which tools would a plain sentence pull in.
    triggeredBySample: getTriggeredTools('summarise the pdf and send a voice note', 'application/pdf', context)
      .map(tool => tool.name),
  };
}

export type RoomRow = {
  id: string;
  platform: string | null;
  roomKey: string | null;
  label: string;
  createdAt: string | null;
  knowledgeDocuments: number;
  reminders: number;
};

export function roomInventory(limit = MAX_TABLE_ROWS): { rooms: RoomRow[]; total: number; keyStats: unknown } {
  const rows = db.select().from(chatRooms).orderBy(desc(chatRooms.created_at)).limit(limit).all();
  const rooms: RoomRow[] = rows.map(room => {
    const scopedKey = room.roomKey ?? null;
    const documents = scopedKey
      ? db.select({ n: count() }).from(memories)
        .where(and(eq(memories.ownerId, scopedKey), eq(memories.category, DOCUMENT_CATEGORY)))
        .all()[0]?.n ?? 0
      : 0;
    const remindersForRoom = db.select({ n: count() }).from(reminders)
      .where(eq(reminders.chatRoomId, room.id))
      .all()[0]?.n ?? 0;
    return {
      id: room.id,
      platform: room.platform ?? null,
      roomKey: scopedKey,
      label: clip(room.roomKey || room.id, 80),
      createdAt: room.created_at ? new Date(room.created_at.getTime() * 1000).toISOString() : null,
      knowledgeDocuments: documents,
      reminders: remindersForRoom,
    };
  });
  const total = db.select({ n: count() }).from(chatRooms).all()[0]?.n ?? 0;
  let keyStats: unknown = null;
  try {
    keyStats = getRoomKeyStats();
  } catch (error) {
    keyStats = { error: getErrorMessage(error) };
  }
  return { rooms, total, keyStats };
}

export type DeliveryRow = {
  id: string | number;
  platform: string | null;
  chatRoomId: string;
  state: string;
  attempts: number;
  lastError: string;
  availableAt: string | null;
  sentAt: string | null;
  text: string;
  createdAt: string;
};

function msToIso(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** States the outbox uses, mirroring the column's enum. */
const OUTBOX_STATES = ['pending', 'leased', 'sent', 'failed', 'dead_letter'] as const;

export function outboxInventory(options: { state?: string; limit?: number } = {}): {
  byState: Record<string, number>;
  rows: DeliveryRow[];
} {
  const byStateRows = db.select({ state: messageOutbox.state, n: count() })
    .from(messageOutbox)
    .groupBy(messageOutbox.state)
    .all();
  const byState: Record<string, number> = {};
  for (const entry of byStateRows) byState[entry.state] = entry.n;

  const limit = Math.min(options.limit ?? 100, MAX_TABLE_ROWS);
  const base = db.select().from(messageOutbox);
  const requested = OUTBOX_STATES.find(state => state === options.state);
  const filtered = requested
    ? base.where(eq(messageOutbox.state, requested))
    : base.where(sql`${messageOutbox.state} IN ('failed', 'dead_letter')`);
  const rows = filtered.orderBy(desc(messageOutbox.createdAt)).limit(limit).all();

  return {
    byState,
    rows: rows.map(row => ({
      id: row.id,
      platform: row.platform ?? null,
      chatRoomId: row.chatRoomId,
      state: row.state,
      attempts: row.attemptCount,
      lastError: clip(row.lastError, 200),
      availableAt: msToIso(row.availableAt),
      sentAt: msToIso(row.sentAt),
      text: clip(row.payload, 160),
      createdAt: msToIso(row.createdAt) ?? '',
    })),
  };
}

export function inboxInventory(limit = 100): { byState: Record<string, number>; stranded: DeliveryRow[] } {
  const byStateRows = db.select({ state: messageInbox.state, n: count() })
    .from(messageInbox)
    .groupBy(messageInbox.state)
    .all();
  const byState: Record<string, number> = {};
  for (const entry of byStateRows) byState[entry.state] = entry.n;

  // Rows that no longer have a lease but are not finished are stranded: the
  // recovery scan that would re-select them does not exist, so they need to be
  // visible rather than silently accumulating.
  const rows = db.select().from(messageInbox)
    .where(sql`${messageInbox.state} IN ('received', 'processing', 'failed')`)
    .orderBy(desc(messageInbox.createdAt))
    .limit(Math.min(limit, MAX_TABLE_ROWS))
    .all();

  return {
    byState,
    stranded: rows.map(row => ({
      id: row.id,
      platform: row.platform ?? null,
      chatRoomId: row.chatRoomId,
      state: row.state,
      attempts: row.attemptCount,
      lastError: clip(row.lastError, 200),
      availableAt: msToIso(row.availableAt),
      sentAt: null,
      text: '',
      createdAt: msToIso(row.createdAt) ?? '',
    })),
  };
}

export function reminderInventory(limit = 100): {
  pending: number;
  rows: Array<{ id: number; room: string; message: string; remindAt: string; recurrence: string | null; isSent: boolean }>;
} {
  const pending = db.select({ n: count() }).from(reminders).where(eq(reminders.isSent, false)).all()[0]?.n ?? 0;
  const rows = db.select().from(reminders).where(eq(reminders.isSent, false))
    .orderBy(reminders.remindAt)
    .limit(Math.min(limit, MAX_TABLE_ROWS))
    .all();
  return {
    pending,
    rows: rows.map(row => ({
      id: row.id,
      room: row.chatRoomId,
      message: clip(row.message, 160),
      remindAt: new Date(row.remindAt.getTime()).toISOString(),
      recurrence: row.recurrence,
      isSent: row.isSent,
    })),
  };
}

export function flowSessionInventory(): { total: number; oldest: string | null } {
  const total = db.select({ n: count() }).from(flowSessions).all()[0]?.n ?? 0;
  const oldest = db.select({ at: flowSessions.updated_at }).from(flowSessions)
    .orderBy(flowSessions.updated_at)
    .limit(1)
    .all()[0];
  return { total, oldest: oldest ? new Date(oldest.at.getTime()).toISOString() : null };
}

export function roomKeyInventory(limit = MAX_TABLE_ROWS): { total: number; rows: Array<Record<string, unknown>> } {
  const total = db.select({ n: count() }).from(roomKeys).all()[0]?.n ?? 0;
  const rows = db.select().from(roomKeys).orderBy(desc(roomKeys.createdAt)).limit(limit).all();
  return {
    total,
    rows: rows.map(row => ({
      roomKey: row.roomKey,
      platform: row.platform,
      remoteRoomId: row.remoteRoomId,
      legacyRoomId: row.legacyRoomId,
      createdAt: msToIso(row.createdAt),
    })),
  };
}

/**
 * Tail the JSONL feedback log.
 * The file is operator-writable, so each line is parsed defensively and a
 * malformed line is reported rather than allowed to throw.
 */
export function feedbackInventory(limit = 100): {
  positive: number;
  negative: number;
  ratio: number | null;
  malformedLines: number;
  entries: Array<Record<string, unknown>>;
} {
  const metrics = healthMetrics.getMetrics();
  const entries: Array<Record<string, unknown>> = [];
  let malformedLines = 0;
  try {
    const path = readStringEnvOrDefault(process.env.FEEDBACK_LOG_PATH, 'data/feedback.jsonl');
    const text = readTextSafe(path);
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        entries.push({
          at: parsed.at ?? '',
          platform: parsed.platform ?? '',
          chatRoomId: clip(parsed.chatRoomId, 60),
          sentiment: parsed.sentiment ?? '',
          reaction: clip(parsed.reaction, 8),
          removed: parsed.removed === true,
        });
      } catch {
        malformedLines += 1;
      }
    }
  } catch (error) {
    log.debug({ err: getErrorMessage(error) }, 'Feedback log unavailable');
  }
  const positive = metrics.feedback.positive;
  const negative = metrics.feedback.negative;
  const total = positive + negative;
  entries.reverse();
  return { positive, negative, ratio: total > 0 ? Number((positive / total).toFixed(3)) : null, malformedLines, entries };
}

function readStringEnvOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed || fallback;
}

function readTextSafe(path: string): string {
  // Synchronous on purpose: the file is operator-sized, and the alternative
  // would force every caller in this module to become async.
  return readFileSync(path, 'utf8');
}

/** Config keys the dashboard may report. Secrets are never included. */
const CONFIG_ALLOWLIST = [
  'NODE_ENV', 'WEBHOOK_ENABLED', 'WEBHOOK_HOST', 'WEBHOOK_PORT', 'WEBHOOK_MAX_BODY_BYTES',
  'WEBHOOK_MAX_DESTINATIONS', 'WEBHOOK_RATE_LIMIT_MAX', 'WEBHOOK_RATE_LIMIT_WINDOW_MS',
  'WEBHOOK_RATE_LIMIT_MAX_SOURCES', 'WEBHOOK_REPLAY_TTL_MS', 'WEBHOOK_CONTAINER_MODE',
  'AI_BASE_URL', 'AI_MODEL_NAME', 'AI_MAX_TOKENS', 'AI_TOOL_TIMEOUT_MS', 'AI_MAX_TOOL_CALLS',
  'AI_MAX_PARALLEL_TOOLS', 'AI_OPERATIONAL_CONTEXT_LIMIT', 'CONTEXT_MESSAGE_LIMIT',
  'LONG_TERM_MEMORY', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSION', 'EMBEDDING_ENDPOINT',
  'TOOL_MUTATION_COST_LIMIT', 'MESSAGE_QUEUE_PER_ROOM_LIMIT', 'MESSAGE_QUEUE_GLOBAL_LIMIT',
  'MEDIA_STORAGE_MAX_FILES', 'MEDIA_STORAGE_MAX_MB', 'RETENTION_DRY_RUN',
  'RETENTION_MESSAGES_DAYS', 'RETENTION_RAW_MESSAGE_DAYS', 'RETENTION_FLOW_SESSION_DAYS',
  'ENABLE_GAME_SEARCH', 'ENABLE_SOFTWARE_SEARCH', 'ENABLE_MEDIA_LIBRARY', 'ENABLE_PLUGIN_RELOAD',
  'ENABLE_PIRACY_SEARCH', 'ENABLE_PIRACY_TOOLS', 'JELLYFIN_URL', 'JELLYFIN_PUBLIC_MODE',
  'SEERR_URL', 'TRANSCRIBE_MODE', 'SCHEDULED_TASKS_ENABLED', 'SCHEDULED_TASKS_ALLOWED_ROOMS',
  'SCHEDULED_TASKS_MAX_RUNS_PER_DAY', 'TTS_PROVIDER', 'TTS_MODEL', 'TTS_VOICE',
  'TELEGRAM_BOT_TOKEN', 'BOT_OWNER_JID', 'BOT_OWNER_TELEGRAM_ID', 'BOT_OWNER_DISCORD_ID',
];

/** Anything whose name looks like a secret is reported as set/unset, never by value. */
const SECRET_PATTERN = /(secret|token|password|api[-_]?key|credential|private)/i;

export function configInventory(env: NodeJS.ProcessEnv = process.env): { keys: Array<{ name: string; value: string; secret: boolean }>; missing: string[] } {
  const keys = CONFIG_ALLOWLIST.map(name => {
    const raw = env[name];
    const set = (raw ?? '').trim().length > 0;
    const secret = SECRET_PATTERN.test(name);
    let value: string;
    if (!set) value = '(unset)';
    else if (secret) value = 'set';
    else value = clip(raw, 120);
    return { name, value, secret };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const missing = CONFIG_ALLOWLIST.filter(name => (env[name] ?? '').trim().length === 0);
  return { keys, missing };
}

// ── Safe actions ────────────────────────────────────────────────────────────
// Each is idempotent or narrowly scoped, logs what it did, and returns a
// human-readable result. None can delete user history or change a room's
// configuration.

export type ActionResult = { ok: boolean; message: string; detail?: unknown };

export async function actionReloadRegistry(): Promise<ActionResult> {
  try {
    await reloadRegistry();
    const reports = getPluginLoadReports();
    const refused = reports.filter(report => report.status === 'refused');
    log.info({ refused: refused.length }, '[Admin] Registry reloaded');
    return {
      ok: true,
      message: refused.length === 0
        ? 'Registry reloaded. All plugins loaded.'
        : `Registry reloaded, but ${refused.length} plugin(s) were refused.`,
      detail: reports,
    };
  } catch (error) {
    return { ok: false, message: `Reload failed: ${getErrorMessage(error)}` };
  }
}

export async function actionRetryOutbox(rawId: string | number): Promise<ActionResult> {
  // The id is text, so it is never coerced to a number: that would silently
  // match a different row and requeue the wrong delivery.
  const id = String(rawId ?? '').trim();
  if (!id) return { ok: false, message: 'A valid outbox row id is required.' };
  const row = db.select().from(messageOutbox).where(eq(messageOutbox.id, id)).all()[0];
  if (!row) return { ok: false, message: `No outbox row with id ${id}.` };
  if (row.state !== 'dead_letter' && row.state !== 'failed') {
    return { ok: false, message: `Row ${id} is ${row.state}; only failed or dead-lettered rows can be retried.` };
  }
  // Back to pending with the attempt counter cleared, so the normal claim path
  // picks it up on its next tick.
  db.update(messageOutbox)
    .set({ state: 'pending', attemptCount: 0, lastError: null, availableAt: Date.now(), leaseOwner: null, leaseExpiresAt: null })
    .where(eq(messageOutbox.id, id))
    .run();
  log.info({ id, platform: row.platform }, '[Admin] Outbox row requeued');
  return { ok: true, message: `Outbox row ${id} requeued for delivery.`, detail: { id } };
}

export async function actionDeleteKnowledge(roomKey: string, documentId?: string): Promise<ActionResult> {
  const key = (roomKey ?? '').trim();
  if (!key) return { ok: false, message: 'A room key is required.' };
  // Confirm the room actually has documents before deleting, so a typo cannot
  // wipe a different room's knowledge or silently do nothing.
  const documents = await listRoomDocuments(key);
  if (documents.length === 0) return { ok: false, message: `No documents indexed for ${key}.` };
  const removed = await removeRoomDocument(key, documentId?.trim() || undefined);
  if (removed === 0) return { ok: false, message: 'Nothing matched, so nothing was removed.' };
  log.info({ roomKey: key, documentId: documentId ?? '(all)', removed }, '[Admin] Knowledge removed');
  return { ok: true, message: `Removed ${removed} knowledge chunk(s).`, detail: { roomKey: key, removed } };
}

export function actionRetentionReport(): ActionResult {
  // Dry run only. Applying retention is irreversible and belongs on the CLI
  // (`bun run db:retention --apply`), not behind a web button.
  const dryRun = readIntegerEnv(process.env.RETENTION_DRY_RUN, 1, { min: 0, max: 1 }) === 1;
  return {
    ok: true,
    message: dryRun
      ? 'RETENTION_DRY_RUN is on, so the scheduler only counts. Apply from the CLI with `bun run db:retention --apply`.'
      : 'Retention is live. A no-op preview was not run, to avoid touching rows from a request.',
  };
}
