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

/** True for plain objects only (excludes arrays). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
