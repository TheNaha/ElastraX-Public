/**
 * @file src/providers/telegramText.ts
 * @description Telegram message length handling.
 *
 * The Bot API rejects messages over 4096 characters. The agent's streaming path
 * edits a single live message, and the final answer can be longer than that, so
 * the limit has to be respected without silently truncating an answer — the
 * failure Discord had, where an over-long edit dropped the tail with no error.
 */

import { clampCaption, chunkTextTelegram } from '../utils/textChunking';

export const TELEGRAM_TEXT_LIMIT = 4096;
/** The Bot API caps a media caption at 1024 characters. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function chunkTelegramText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  return chunkTextTelegram(text, limit);
}

/** Clamp a caption to the API limit instead of failing the whole upload. */
export function clampTelegramCaption(caption: string | undefined): string | undefined {
  return clampCaption(caption, TELEGRAM_CAPTION_LIMIT);
}
