/**
 * @file src/core/constants.ts
 * @description Shared constants used across the ElastraX core pipeline.
 *
 * Centralising constants here ensures that command names and other shared
 * values can be changed in one place without hunting through multiple files.
 */

/**
 * The bot's display name, used in quoted-message sender labels and log payloads.
 * Centralised here so the name appears consistently across all platforms.
 */
export const BOT_NAME = 'ElastraX';

/**
 * Slash commands that will cancel an active interactive flow session.
 * Checked by `FlowHandler.handle()` before forwarding to the flow processor.
 * Supports both English (`/cancel`) and Indonesian (`/batal`) locales.
 */
export const CANCEL_COMMANDS = ['/cancel', '/batal'];

/**
 * Upper bound on long-term memories injected into the system prompt per message.
 * Prevents unbounded context growth in chatty rooms; most recent N win.
 */
export const MAX_INJECTED_MEMORIES = 50;
/** Room knowledge excerpts injected per AI turn. Kept small: these are verbatim document text. */
export const MAX_ROOM_KNOWLEDGE_CHUNKS = 4;

/** Upper bound on rows returned by the memory `retrieve` action. */
export const MAX_LISTED_MEMORIES = 200;

/**
 * `memories.category` value that marks a row as a room *document chunk* rather
 * than a memory. Room knowledge shares the `memories` table (keyed on the room's
 * owner id), so anything that reasons about "this owner's memories" must exclude
 * it. Defined here so both the writer (`utils/roomKnowledge`) and the readers
 * (`utils/semanticMemory`) share one value without an import cycle.
 */
export const MEMORY_DOCUMENT_CATEGORY = 'document';

/**
 * Sentinel meaning "unlimited" for privilege fields such as contextLimit,
 * matching the `-1 = unlimited` convention used by ROLE_PRIV_* overrides.
 */
export const UNLIMITED = -1;

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT_DIR = join(__dirname, '../../');
