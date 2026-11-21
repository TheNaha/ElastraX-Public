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
/** An unterminated think block — i.e. one that is still being streamed. */
const OPEN_THINK_TAG_PATTERN = /<think>[\s\S]*$/i;

/**
 * Remove all *closed* think blocks and trim whitespace.
 *
 * Only matches a `<think>…</think>` pair; an unterminated block (a stream that
 * ended mid-reasoning) is left in place. That is correct for a complete message
 * object, but a *partial* stream must use {@link stripPartialThinkTags} instead,
 * or the model's chain of thought ships as the answer.
 */
export function stripThinkTags(text: string): string {
  return text.replace(THINK_TAG_PATTERN, "").trim();
}

/**
 * Remove think blocks from *partial* text, including one still being streamed.
 *
 * `stripThinkTags` only matches a closed block, so while a reasoning model is
 * mid-block the whole block is still in the string and a preview built from it
 * shows the model's chain of thought. When nothing but the open block has
 * arrived the result is empty, which callers must treat as "nothing to show
 * yet".
 */
export function stripPartialThinkTags(text: string): string {
  return text.replace(THINK_TAG_PATTERN, "").replace(OPEN_THINK_TAG_PATTERN, "").trim();
}
