/**
 * parserCoverage.ts
 *
 * Scans a list of raw WAMessage JSON strings from the database and runs each
 * through `parseWhatsAppMessage()`, reporting:
 *  - OK messages grouped by messageType
 *  - Errors (parser threw) with the raw message attached
 *  - Messages that parsed as 'unknown' (unrecognised structure)
 *
 * This module has NO side effects — it is pure scanning logic. Both the bot
 * startup check and the SIGINT fixture dumper import from here.
 */

import { parseWhatsAppMessage, ParsedWAMessage } from '../providers/whatsappParser';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────

export interface CoverageResult {
  /** One representative raw WAMessage per unique canonical messageType */
  uniqueByType: Map<string, { raw: any; parsed: ParsedWAMessage }>;
  /** Messages that threw during parsing, keyed by index */
  errors: Array<{ index: number; raw: any; error: Error }>;
  /** messageTypes that came back as 'unknown' (parser gap) */
  unknownSamples: Array<{ index: number; raw: any }>;
  total: number;
}

/**
 * Run the parser against every rawMessage row from the `messages` table.
 *
 * @param rows       Array of { rawMessage: string | null, providerMessageId: string | null }
 * @param botUserId  The bot's own JID (sock.user?.id). Pass null during offline scanning.
 */
export async function scanParserCoverage(
  rows: Array<{ rawMessage: string | null; providerMessageId: string | null }>,
  botUserId: string | null,
): Promise<CoverageResult> {
  const uniqueByType = new Map<string, { raw: any; parsed: ParsedWAMessage }>();
  const errors: CoverageResult['errors'] = [];
  const unknownSamples: CoverageResult['unknownSamples'] = [];
  let total = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.rawMessage) continue;

    let raw: any;
    try {
      raw = JSON.parse(row.rawMessage);
    } catch {
      // Not valid JSON — skip silently (shouldn't happen with our serialiser)
      continue;
    }

    total++;

    try {
      const parsed = await parseWhatsAppMessage(raw, botUserId);

      // Track one sample per unique type (prefer messages without large blobs)
      if (!uniqueByType.has(parsed.messageType)) {
        uniqueByType.set(parsed.messageType, { raw, parsed });
      }

      if (parsed.messageType === 'unknown') {
        unknownSamples.push({ index: i, raw });
      }
    } catch (err: any) {
      errors.push({ index: i, raw, error: err });
    }
  }

  return { uniqueByType, errors, unknownSamples, total };
}

/**
 * Log a human-readable summary of a coverage scan to the logger.
 * Safe to call at any point — produces no side effects other than log output.
 */
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
      `[ParserCoverage] ⚠  ${errors.length} message(s) threw during parsing — run "bun run fixtures:dump" to investigate.`,
    );
    for (const { index, error } of errors.slice(0, 5)) {
      logger.warn({ index, err: error.message }, '[ParserCoverage] Parse error');
    }
  }

  if (unknownSamples.length > 0) {
    logger.warn(
      `[ParserCoverage] ⚠  ${unknownSamples.length} message(s) parsed as "unknown" type — parser may have a gap.`,
    );
  }
}
