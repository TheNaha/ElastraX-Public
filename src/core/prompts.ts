/**
 * @file src/core/prompts.ts
 * @description Default system prompt(s) for the ElastraX LLM agent.
 *
 * The system prompt is injected as the first message in every LLM request to
 * shape the model's persona, capabilities, and localisation behaviour.
 *
 * Per-room overrides:
 *   Admins can replace `DEFAULT_SYSTEM_PROMPT` on a per-chat-room basis via the
 *   `/config set systemPrompt <text>` command.  `ConfigService.getResolvedConfig()`
 *   will use the DB value when present, otherwise it falls back to this constant
 *   (or the value of the `DEFAULT_SYSTEM_PROMPT` environment variable if set).
 *
 * Template variables:
 *   - `{{LANGUAGE}}` — Replaced at runtime with the full language name
 *     (e.g., "English" or "Indonesian (Bahasa Indonesia)") so the AI responds
 *     in the correct language for the active chat room.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The built-in fallback system prompt used when no per-room or per-env override exists.
 * The `{{LANGUAGE}}` placeholder is substituted at runtime by the agent in `src/agent/index.ts`.
 */
import { ROOT_DIR } from './constants';

let cachedPrompt: string | null = null;
export function getDefaultSystemPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = readFileSync(
      join(ROOT_DIR, 'src/core/default_system_prompt.txt'),
      'utf-8'
    );
  }
  return cachedPrompt;
}
