import type { WAMessage } from '@whiskeysockets/baileys';
import { parseWhatsAppMessage, ParsedWAMessage } from '../providers/whatsappParser';
import { logger } from './logger';

export interface CoverageResult {
  uniqueByType: Map<string, { raw: unknown; parsed: ParsedWAMessage }>;
  errors: Array<{ index: number; raw: unknown; error: Error }>;
  unknownSamples: Array<{ index: number; raw: unknown }>;
  total: number;
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
        unknownSamples.push({ index: i, raw });
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
    logger.warn(
      `[ParserCoverage] ${unknownSamples.length} message(s) parsed as "unknown" type - parser may have a gap.`,
    );
  }
}
