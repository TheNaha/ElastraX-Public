import type { WAMessage, proto } from '@whiskeysockets/baileys';
import { getContentType } from '@whiskeysockets/baileys';
import { parseWhatsAppMessage, ParsedWAMessage } from '../providers/whatsappParser';
import { logger } from './logger';

export interface CoverageResult {
  uniqueByType: Map<string, { raw: unknown; parsed: ParsedWAMessage }>;
  errors: Array<{ index: number; raw: unknown; error: Error }>;
  unknownSamples: Array<{ index: number; raw: unknown; baileysType: string | null }>;
  total: number;
}

const BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

function stripBlobs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: Record<string, unknown> = Array.isArray(raw) ? {} : {};
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === 'object' ? stripBlobs(v) : v));
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (BLOB_KEYS.has(key)) continue;
    out[key] = typeof value === 'object' ? stripBlobs(value) : value;
  }
  return out;
}

export async function scanParserCoverage(
  rows: Array<{ rawMessage: string | null; providerMessageId: string | null }>,
  botUserId: string | null,
): Promise<CoverageResult> {
  const uniqueByType = new Map<string, { raw: unknown; parsed: ParsedWAMessage }>();
  const errors: CoverageResult['errors'] = [];
  const unknownSamples: CoverageResult['unknownSamples'] = [];
  let total = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.rawMessage) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(row.rawMessage);
    } catch {
      continue;
    }

    total++;

    try {
      const parsed = await parseWhatsAppMessage(raw as WAMessage, botUserId);
      if (!uniqueByType.has(parsed.messageType)) {
        uniqueByType.set(parsed.messageType, { raw, parsed });
      }

      if (parsed.messageType === 'unknown') {
        const baileysType = raw && typeof raw === 'object' && 'message' in raw
          ? (getContentType((raw as WAMessage).message as proto.IMessage | undefined) ?? null)
          : null;
        unknownSamples.push({ index: i, raw, baileysType });
      }
    } catch (error: unknown) {
      errors.push({
        index: i,
        raw,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return { uniqueByType, errors, unknownSamples, total };
}

export function logCoverageSummary(result: CoverageResult): void {
  const { uniqueByType, errors, unknownSamples, total } = result;
  const types = [...uniqueByType.keys()].sort().join(', ');

  logger.info(
    {
      total,
      uniqueTypes: uniqueByType.size,
      errors: errors.length,
      unknownSamples: unknownSamples.length,
      types,
    },
    '[ParserCoverage] Scan complete',
  );

  if (errors.length > 0) {
    logger.warn(
      `[ParserCoverage] ${errors.length} message(s) threw during parsing - run "bun run fixtures:dump" to investigate.`,
    );
    for (const { index, error } of errors.slice(0, 5)) {
      logger.warn({ index, err: error.message }, '[ParserCoverage] Parse error');
    }
  }

  if (unknownSamples.length > 0) {
    const baileysTypes = new Map<string, number>();
    for (const sample of unknownSamples) {
      const key = sample.baileysType ?? 'null';
      baileysTypes.set(key, (baileysTypes.get(key) ?? 0) + 1);
    }
    const typeBreakdown = [...baileysTypes.entries()]
      .map(([t, c]) => `${t}: ${c}`)
      .join(', ');

    logger.warn(
      `[ParserCoverage] ${unknownSamples.length} message(s) parsed as "unknown" type - parser may have a gap. baileys type breakdown: ${typeBreakdown}`,
    );

    // Log stripped raw samples of up to 3 unknown messages so the gap can be identified.
    for (const sample of unknownSamples.slice(0, 3)) {
      logger.warn(
        { index: sample.index, baileysType: sample.baileysType, raw: stripBlobs(sample.raw) },
        '[ParserCoverage] Unknown message sample',
      );
    }
  }
}
