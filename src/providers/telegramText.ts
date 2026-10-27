/**
 * @file src/providers/telegramText.ts
 * @description Telegram message length handling.
 *
 * The Bot API rejects messages over 4096 characters. The agent's streaming path
 * edits a single live message, and the final answer can be longer than that, so
 * the limit has to be respected without silently truncating an answer — the
 * failure Discord had, where an over-long edit dropped the tail with no error.
 */

import { chunkTextTelegram } from '../utils/textChunking';

export const TELEGRAM_TEXT_LIMIT = 4096;

export function chunkTelegramText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  return chunkTextTelegram(text, limit);
}
