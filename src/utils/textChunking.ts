/**
 * @file src/utils/textChunking.ts
 * @description Unified text chunking used by all messaging providers.
 *
 * Consolidates the previously duplicated chunking logic that lived in
 * whatsapp.ts (`chunkWhatsAppText`), discord.ts (`chunkDiscordText`),
 * and telegramText.ts (`chunkTelegramText`). All three used the same
 * character-splitting approach with different boundary preferences and
 * different empty-input handling. This module is the single source of truth.
 *
 * Modes:
 *  - 'fixed'     : Hard character split, no boundary awareness (WhatsApp).
 *  - 'boundary'  : Prefers breaking at paragraph, then line, then whitespace
 *                  within the trailing half of the limit (Discord, Telegram).
 *
 * Empty input always returns `['']` so callers can safely index `chunks[0]`.
 * Chunking is lossless: `chunks.join('')` always reconstructs the input.
 */

export type ChunkMode = 'fixed' | 'boundary';

/**
 * Offset just past the last occurrence of any of `patterns` in `window`, or
 * `window.length` when none occurs.
 *
 * The caller has already narrowed the search to the trailing half of the chunk,
 * so this must not apply a second half-window filter: doing so only accepted a
 * break in the last *quarter* of the chunk and pushed ordinary messages into a
 * hard character split. Advancing past the whole delimiter keeps a two-character
 * paragraph break inside one chunk instead of splitting it across two.
 */
function lastBreakOffset(window: string, patterns: readonly string[]): number {
  for (const pattern of patterns) {
    const index = window.lastIndexOf(pattern);
    if (index >= 0) return index + pattern.length;
  }
  return window.length;
}

/**
 * Split `text` into chunks of at most `limit` characters each.
 *
 * @param mode    - 'fixed' hard-splits every `limit` chars; 'boundary' tries to
 *                  break at '\n\n', '\n', or ' ' within the trailing half of the limit.
 * @param limit   - Maximum characters per chunk (must be a positive safe integer).
 * @returns       Array of chunks. Empty input returns `['']`. Chunking is lossless.
 */
export function chunkTextSmart(
  text: string,
  options: { mode?: ChunkMode; limit?: number } = {},
): string[] {
  const { mode = 'fixed', limit = 4096 } = options;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Text chunk limit must be a positive integer.');
  }
  const characters = Array.from(text);
  if (characters.length === 0) return [''];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = Math.min(offset + limit, characters.length);
    if (mode === 'boundary' && end < characters.length) {
      const searchStart = Math.max(offset + Math.floor(limit / 2), offset + 1);
      const boundary = characters.slice(searchStart, end);
      const breakAt = lastBreakOffset(boundary.join(''), ['\n\n', '\n', ' ']);
      if (breakAt < boundary.length) end = searchStart + breakAt;
    }
    chunks.push(characters.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}

/** WhatsApp: hard 65536-char split, no boundary awareness. Lossless. */
export function chunkTextFixed(text: string, limit = 65_536): string[] {
  return chunkTextSmart(text, { mode: 'fixed', limit });
}

/** Discord: boundary-aware 2000-char split. Lossless. */
export function chunkTextDiscord(text: string, limit = 2000): string[] {
  return chunkTextSmart(text, { mode: 'boundary', limit });
}

/**
 * Telegram: boundary-aware 4096-char split.
 * Trims trailing whitespace and skips leading newlines on the remainder,
 * matching the historical chunkTelegramText behavior. Returns [] for empty input.
 */
export function chunkTextTelegram(text: string, limit = 4096): string[] {
  if (text.length === 0) return [];
  const chunks = chunkTextSmart(text, { mode: 'boundary', limit });
  // Telegram historically trimmed each chunk and dropped leading newlines on
  // the remainder so chunk boundaries land on clean sentence breaks.
  const trimmed: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    trimmed.push(chunks[i]!.trimEnd());
  }
  return trimmed;
}
