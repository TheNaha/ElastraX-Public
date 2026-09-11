/**
 * @file src/core/constants.ts
 * @description Shared constants used across the ElastraX core pipeline.
 *
 * Centralising constants here ensures that command names and other shared
 * values can be changed in one place without hunting through multiple files.
 */

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

/** Upper bound on rows returned by the memory `retrieve` action. */
export const MAX_LISTED_MEMORIES = 200;

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
