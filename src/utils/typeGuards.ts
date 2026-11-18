/**
 * Canonical type guards shared across the agent, AI, tools, and utils layers.
 *
 * These were previously duplicated in 3–4 inline copies across the codebase:
 *  - `src/agent/index.ts`
 *  - `src/ai/client.ts`
 *  - `src/tools/ParameterValidator.ts`
 *  - `src/utils/rawMessage.ts`
 *
 * Each copy had a slightly different name or signature. This module is the
 * single source of truth.
 */

/**
 * True for plain objects only.
 *
 * Excludes arrays and every non-plain object (`Date`, `Buffer`/`Uint8Array`,
 * `Map`, class instances, …). The previous check only excluded arrays and null,
 * so a `Buffer` counted as plain and `stripBlobs` exploded it into an
 * index-keyed object — corrupting a live provider proto before it was persisted.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
