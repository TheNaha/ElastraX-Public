import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { db } from '../db';
import { messages } from '../db/schema';
import { scanParserCoverage, logCoverageSummary, type CoverageResult } from '../utils/parserCoverage';
import { logger } from '../utils/logger';

type MessageRow = { rawMessage: string | null; providerMessageId: string | null };

type StartupDiagnosticsDeps = {
  loadMessages?: (limit?: number) => MessageRow[];
  scanCoverage?: (rows: MessageRow[], botUserId: string | null) => Promise<CoverageResult>;
  logCoverage?: (result: CoverageResult) => void;
  makeDirectory?: typeof mkdir;
  writeTextFile?: typeof writeFile;
  fileExists?: typeof existsSync;
};

const BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

type JsonLike = Record<string, unknown> | unknown[];

function getDefaultRows(limit?: number): MessageRow[] {
  const query = db.select({
    rawMessage: messages.rawMessage,
    providerMessageId: messages.providerMessageId,
  }).from(messages);

  if (typeof limit === 'number') {
    return query.limit(limit).all();
  }

  return query.all();
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

import { ROOT_DIR } from '../core/constants';

export function resolveFixtureDir(env: NodeJS.ProcessEnv = process.env): string {
  const configuredDir = env.FIXTURE_DUMP_DIR?.trim();
  if (configuredDir) return configuredDir;

  return env.NODE_ENV === 'production'
    ? join(ROOT_DIR, 'data/fixtures/wa_messages')
    : join(ROOT_DIR, 'test/fixtures/wa_messages');
}

export function stripFixtureBlobs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;

  const out: JsonLike = Array.isArray(raw) ? [] : {};
  for (const [key, value] of Object.entries(raw)) {
    if (BLOB_KEYS.has(key)) continue;
    if (Array.isArray(out)) {
      out.push(typeof value === 'object' ? stripFixtureBlobs(value) : value);
    } else {
      out[key] = typeof value === 'object' ? stripFixtureBlobs(value) : value;
    }
  }

  return out;
}

export async function dumpFixtures(
  botUserId: string | null,
  deps: StartupDiagnosticsDeps = {},
): Promise<void> {
  logger.info('[FixtureDumper] Reading messages from database...');

  const loadMessages = deps.loadMessages ?? getDefaultRows;
  const scanCoverage = deps.scanCoverage ?? scanParserCoverage;
  const logCoverage = deps.logCoverage ?? logCoverageSummary;
  const makeDirectory = deps.makeDirectory ?? mkdir;
  const writeTextFile = deps.writeTextFile ?? writeFile;
  const fileExists = deps.fileExists ?? existsSync;
  const fixtureDir = resolveFixtureDir();

  const rows = loadMessages();
  if (rows.length === 0) {
    logger.info('[FixtureDumper] No messages in database, skipping fixture dump.');
    return;
  }

  const result = await scanCoverage(rows, botUserId);
  logCoverage(result);

  try {
    await makeDirectory(fixtureDir, { recursive: true });
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === 'EACCES' || code === 'EROFS') {
      logger.warn({ path: fixtureDir, code }, '[FixtureDumper] Fixture directory is not writable; skipping fixture dump.');
      return;
    }
    throw err;
  }

  let written = 0;
  for (const [messageType, { raw }] of result.uniqueByType) {
    const filepath = join(fixtureDir, `${messageType}.json`);
    if (fileExists(filepath)) continue;

    try {
      await writeTextFile(filepath, JSON.stringify(stripFixtureBlobs(raw), null, 2), 'utf-8');
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === 'EACCES' || code === 'EROFS') {
        logger.warn({ path: filepath, code }, '[FixtureDumper] Cannot write fixture file; skipping remaining fixture dump.');
        return;
      }
      throw err;
    }

    logger.info(`[FixtureDumper] Wrote ${messageType}.json`);
    written++;
  }

  logger.info(`[FixtureDumper] Done. Wrote ${written} new fixture(s), skipped ${result.uniqueByType.size - written} existing.`);

  if (result.errors.length > 0 || result.unknownSamples.length > 0) {
    logger.warn('[FixtureDumper] ⚠  Parser gaps detected — see logs above. Run "bun run fixtures:dump" for a full report.');
  }
}

export async function runStartupCoverageScan(
  botUserId: string | null,
  deps: StartupDiagnosticsDeps = {},
): Promise<void> {
  const loadMessages = deps.loadMessages ?? getDefaultRows;
  const scanCoverage = deps.scanCoverage ?? scanParserCoverage;
  const logCoverage = deps.logCoverage ?? logCoverageSummary;

  try {
    const rows = loadMessages(2000);
    if (rows.length === 0) return;

    const result = await scanCoverage(rows, botUserId);
    logCoverage(result);
  } catch (err) {
    logger.warn({ err }, '[ParserCoverage] Startup scan failed (non-fatal)');
  }
}