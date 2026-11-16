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
 * Measures:
 *  - 'codepoints': `limit` counts Unicode code points (discord.js counts these).
 *  - 'utf16'     : `limit` counts UTF-16 code units, which is what the Telegram
 *                  Bot API enforces (its entity offsets are UTF-16 too). A chunk
 *                  of 4096 emoji is 8192 units and is rejected, so Telegram
 *                  chunking has to use this measure.
 *
 * Empty input always returns `['']` so callers can safely index `chunks[0]`.
 * Chunking is lossless: `chunks.join('')` always reconstructs the input, and a
 * surrogate pair is never split across two chunks.
 */

export type ChunkMode = 'fixed' | 'boundary';
export type ChunkMeasure = 'codepoints' | 'utf16';

/**
 * Length, in code points, of `window` up to and including the last occurrence of
 * any of `patterns`, or `null` when none occurs.
 *
 * The caller indexes an array of code points (`Array.from(text)`), but
 * `String.lastIndexOf` answers in UTF-16 units. Returning the raw index mixed the
 * two scales: any astral character in the window (an emoji, most non-Latin
 * symbols) shifted the split past the delimiter that was found, cutting a word in
 * half.
 */
function lastBreakCodePoints(window: string, patterns: readonly string[]): number | null {
  for (const pattern of patterns) {
    const index = window.lastIndexOf(pattern);
    if (index >= 0) return Array.from(window.slice(0, index + pattern.length)).length;
  }
  return null;
}

/**
 * Split `text` into chunks of at most `limit` characters each.
 *
 * @param mode    - 'fixed' hard-splits every `limit` chars; 'boundary' tries to
 *                  break at '\n\n', '\n', or ' ' within the trailing half of the limit.
 * @param limit   - Maximum size per chunk (must be a positive safe integer), in
 *                  the unit named by `measure`.
 * @param measure - How `limit` is counted: code points (default) or UTF-16 units.
 * @returns       Array of chunks. Empty input returns `['']`. Chunking is lossless.
 */
export function chunkTextSmart(
  text: string,
  options: { mode?: ChunkMode; limit?: number; measure?: ChunkMeasure } = {},
): string[] {
  const { mode = 'fixed', limit = 4096, measure = 'codepoints' } = options;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Text chunk limit must be a positive integer.');
  }
  const characters = Array.from(text);
  if (characters.length === 0) return [''];

  // Prefix sums of the per-code-point size in the requested measure, so the
  // chunk end for a UTF-16 budget is found in O(log n) without splitting a pair.
  let prefix: number[] | null = null;
  if (measure === 'utf16') {
    prefix = new Array<number>(characters.length + 1);
    prefix[0] = 0;
    for (let index = 0; index < characters.length; index++) {
      prefix[index + 1] = prefix[index]! + characters[index]!.length;
    }
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end: number;
    if (prefix) {
      // Largest end whose accumulated size from `offset` stays within the limit.
      let low = offset + 1;
      let high = characters.length;
      end = offset + 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (prefix[mid]! - prefix[offset]! <= limit) {
          end = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    } else {
      end = Math.min(offset + limit, characters.length);
    }
    if (mode === 'boundary' && end < characters.length) {
      // The caller has already narrowed the search to the trailing half of the
      // chunk; this must not apply a second half-window filter, which only
      // accepted a break in the last quarter of the chunk and pushed ordinary
      // messages into a hard character split.
      const searchStart = Math.max(offset + Math.floor(limit / 2), offset + 1);
      const boundary = characters.slice(searchStart, end);
      const breakAt = lastBreakCodePoints(boundary.join(''), ['\n\n', '\n', ' ']);
      if (breakAt !== null && breakAt < boundary.length) {
        end = searchStart + breakAt;
      } else if (end - 1 > offset && characters[end - 1] === '\n' && characters[end] === '\n') {
        // The paragraph break straddles the hard limit, so no delimiter was found
        // inside the window. Move the split one character earlier to keep the
        // pair in the next chunk instead of splitting it.
        end -= 1;
      }
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
 * Telegram: boundary-aware 4096-unit split.
 *
 * The limit is measured in UTF-16 units (what the Bot API enforces), so an
 * emoji-heavy answer cannot produce a chunk the API rejects as too long.
 * Trims trailing whitespace, matching the historical chunkTelegramText behavior.
 * Returns [] for empty input.
 */
export function chunkTextTelegram(text: string, limit = 4096): string[] {
  if (text.length === 0) return [];
  const chunks = chunkTextSmart(text, { mode: 'boundary', limit, measure: 'utf16' });
  // Telegram historically trimmed each chunk and dropped leading newlines on
  // the remainder so chunk boundaries land on clean sentence breaks.
  const trimmed: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    trimmed.push(chunks[i]!.trimEnd());
  }
  return trimmed;
}

/**
 * Split `text` into a head of at most `limit` UTF-16 units and the remainder.
 *
 * Used by providers that edit a message in place and have to post the overflow
 * separately: the head must fit the platform count (Telegram's is UTF-16), and
 * the split must not land between the two halves of a surrogate pair.
 */
export function splitTextAtUtf16Limit(text: string, limit: number): { head: string; rest: string } {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Text split limit must be a positive integer.');
  }
  if (text.length <= limit) return { head: text, rest: '' };
  const characters = Array.from(text);
  let units = 0;
  let end = 0;
  for (const character of characters) {
    if (units + character.length > limit) break;
    units += character.length;
    end += 1;
  }
  return {
    head: characters.slice(0, end).join(''),
    rest: characters.slice(end).join(''),
  };
}

