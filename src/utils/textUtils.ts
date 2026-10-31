/**
 * @file src/utils/textUtils.ts
 * @description Shared text-processing helpers used across the agent, AI client,
 * and ModelRouter layers.
 *
 * Consolidates the think-tag stripping that was previously duplicated in
 * `src/agent/index.ts` (as `stripThinkTags`) and `src/utils/ModelRouter.ts`
 * (as `usefulText`).
 */

const THINK_TAG_PATTERN = /<think>[\s\S]*?<\/think>/gi;

/** Remove all think blocks and trim whitespace. */
export function stripThinkTags(text: string): string {
  return text.replace(THINK_TAG_PATTERN, "").trim();
}
