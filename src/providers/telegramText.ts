/**
 * @file src/providers/telegramText.ts
 * @description Telegram message length handling.
 *
 * The Bot API rejects messages over 4096 characters. The agent's streaming path
 * edits a single live message, and the final answer can be longer than that, so
 * the limit has to be respected without silently truncating an answer — the
 * failure Discord had, where an over-long edit dropped the tail with no error.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;

/** Prefer breaking at a paragraph, then a line, then whitespace. */
function lastBreakBefore(text: string, limit: number): number {
  for (const pattern of ['\n\n', '\n', ' ']) {
    const index = text.lastIndexOf(pattern, limit);
    if (index > Math.floor(limit / 2)) return index;
  }
  return limit;
}

export function chunkTelegramText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const max = Math.max(1, Math.floor(limit));
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = lastBreakBefore(rest, max);
    // A hard break is fine when there is no whitespace to break on.
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim().length > 0) chunks.push(rest);
  return chunks.filter(chunk => chunk.length > 0);
}
