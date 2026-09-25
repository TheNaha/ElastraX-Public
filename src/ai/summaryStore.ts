import { eq } from 'drizzle-orm';
import { db } from '../db';
import { appKv } from '../db/schema';
import { logger } from '../utils/logger';
import {
  ConversationSummaryService,
  type SummaryStore,
  type SummaryWatermark,
} from '../utils/ConversationSummarizer';

const log = logger.child({ module: 'ConversationSummaryStore' });
const KEY_PREFIX = 'conversation-summary:v1:';

function storageKey(scope: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(scope)}`;
}

function isWatermark(value: unknown, scope: string): value is SummaryWatermark {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1
    && row.scope === scope
    && typeof row.throughMessageId === 'string'
    && Number.isInteger(row.summarizedMessages)
    && (row.summarizedMessages as number) >= 0
    && typeof row.summary === 'string'
    && typeof row.updatedAt === 'string';
}

export class AppKvSummaryStore implements SummaryStore {
  async load(scope: string): Promise<SummaryWatermark | null> {
    const rows = db.select({ value: appKv.value })
      .from(appKv)
      .where(eq(appKv.id, storageKey(scope)))
      .limit(1)
      .all();
    const stored = rows[0]?.value;
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as unknown;
      return isWatermark(parsed, scope) ? parsed : null;
    } catch (error: unknown) {
      log.warn({ scope, err: error }, '[ConversationSummaryStore] Ignoring invalid watermark');
      return null;
    }
  }

  async save(scope: string, watermark: SummaryWatermark): Promise<void> {
    if (watermark.scope !== scope || watermark.version !== 1) {
      throw new TypeError('Summary watermark scope/version mismatch.');
    }
    const now = new Date();
    const value = JSON.stringify(watermark);
    db.insert(appKv)
      .values({
        id: storageKey(scope),
        value,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: appKv.id,
        set: {
          value,
          updated_at: now,
        },
      })
      .run();
  }

  async delete(scope: string): Promise<void> {
    db.delete(appKv).where(eq(appKv.id, storageKey(scope))).run();
  }
}

export function createPersistentSummaryStore(): SummaryStore {
  return new AppKvSummaryStore();
}

export function createPersistentSummaryService(): ConversationSummaryService {
  return new ConversationSummaryService(createPersistentSummaryStore());
}
