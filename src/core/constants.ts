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

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT_DIR = join(__dirname, '../../');
