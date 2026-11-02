# Codebase Maintenance Audit — 3 November 2026 (second pass)

**Branch**: `main` (working tree clean)
**Scope**: whole repository (`src/`, `test/`, `scripts/`, `drizzle/`)
**Baseline**: `bun run check` passed — all green

---

## Baseline

| Check | Result |
|-------|--------|
| Lint (`--max-warnings=0`) | clean |
| Typecheck (`tsc --noEmit`) | clean |
| Tests (`bun test --no-env-file test/`) | 1532 pass, 0 fail |
| Tests hermetic (`test:hermetic`) | 1564 pass, 0 fail |
| Security audit (`bun audit --audit-level=high`) | clean (278 packages) |
| DB check (`drizzle-kit check`) | clean |
| Migration drift gate (`drizzle-kit generate`) | no changes |

---

## Summary

The codebase is in excellent health. All fixes from prior audits (2026-10-31, 2026-11-01, 2026-11-02) remain verified. No active bugs, broken public contracts, data-loss risks, TODOs/FIXMEs, empty catch blocks, or unhandled rejections were found in `src/`.

The only actionable findings in this pass are **tech debt / duplication** — three real, copy-pasted duplications that are safe, low-risk internal refactors with no public contract change. One long-deferred tech-debt item (`mock.module` in test files) is left as-is per prior decision (high refactor risk, tests pass under random/hermetic).

---

## Findings

### TD-005 — ReminderTool: identical time-parsing validation block (×2)

**Severity**: Low (tech debt)
**Location**: `src/tools/ReminderTool.ts:136-143` and `:154-161`
**Evidence**: The `tomorrow` branch (lines 136-143) and the standalone-time branch (lines 154-161) each contain a verbatim copy of:
```ts
let hours = Number(timeMatch[1]);
const minutes = Number(timeMatch[2] ?? 0);
const hasMeridiem = Boolean(timeMatch[3]);
if (!Number.isSafeInteger(hours) || (hasMeridiem && (hours < 1 || hours > 12)) || (!hasMeridiem && (hours < 0 || hours > 23)) || minutes < 0 || minutes > 59) return null;
if (timeMatch[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
if (timeMatch[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
date.setHours(hours, minutes, 0, 0);
```
**Proposed fix**: Extract a shared private helper `parseHoursMinutesAmPm(timeMatch: RegExpMatchArray | null, date: Date): void` (returns whether parsing succeeded) and call it from both branches. No behavior change, no public contract change.

### TD-006 — MediaSearchTool: repeated `slice(0, 10).map(formatResult)` call site (×4)

**Severity**: Low (tech debt)
**Location**: `src/tools/MediaSearchTool.ts:126`, `:138`, `:149`, `:163`
**Evidence**: The `search`, `trending`, `discover`, and `recommend` cases each end with:
```ts
const lines = <results>.slice(0, 10).map((r, i) => formatResult(lang, r, i + 1));
```
**Proposed fix**: Extract a local helper `formatTopResults(results, lang)` that returns `results.slice(0, 10).map((r, i) => formatResult(lang, r, i + 1))` and use it at all four call sites. No behavior change.

### TD-007 — ai/client.ts: duplicated fetch + error handling (streaming vs non-streaming)

**Severity**: Low (tech debt)
**Location**: `src/ai/client.ts:270-294` (`chatCompletionEnvelope`) and `:481-499` (`chatCompletionStream`)
**Evidence**: Both methods perform the identical `fetch(endpoint, { method: 'POST', headers: this.headers(requestId), body: JSON.stringify(payload), signal: withTimeout(...) })` followed by the identical `!response.ok` error-handling block (429/5xx logging, same error message). A shared private `fetchWithErrorHandling(endpoint, payload, requestId, timeoutMs)` method would merge them.
**Proposed fix**: Extract shared private method. Keep `startTime`/`elapsed` logging only in `chatCompletionEnvelope` (the streaming path doesn't log elapsed). No behavior change.

### TD-001 (deferred, prior decision) — `mock.module` used in ~10 test files

**Severity**: Low (tech debt / fragility risk)
**Location**: `test/*.test.ts` + `test/setup.ts`
**Evidence**: `grep mock.module test/` returns ~20 matches. Most are intentional and unavoidable: third-party lib mocks (`libsignal`, `whatsapp-rust-bridge`) in `setup.ts`, `node-webpmux` in `StickerUtils.test.ts`, `baileys` in `zz.useDBAuthState.test.ts`. A handful remain in `ReminderTool.test.ts`, `MemoryTool.test.ts`, `DigestTool.test.ts`, `Scheduler.tasks.test.ts`, `ocr.test.ts`, `MediaSearchTool.test.ts` style files.
**Risk**: Cross-test pollution can cause order- or mock-leak-dependent failures.
**Decision**: DEFERRED. The 2026-11-02 tech-debt reduction migrated 23 test files off `mock.module('../src/db')` and ~38 files off `mock.module('../src/utils/logger')` onto real database / `*Deps` seams. Remaining usages are either global third-party mocks (setup.ts) or tightly-scoped module mocks where migrating would be high-refactor-risk with no active failure. Tests pass under normal, isolated, randomized, and hermetic runs.

---

## Coincidental similarities (examined, NOT duplicates — do not merge)

- Provider reaction recording (Discord/WhatsApp/Telegram): shared `recordReactionFeedback` call, but platform-specific event unwrapping. Coincidental.
- RoomKey / chatId resolution: already centralized in `src/agent/roomKey.ts`.
- `env.ts` validation functions: already centralized.
- `BaseHttpClient` inheritance: used properly by 3 clients.
- SearXng search tool hierarchy: base class + 3 subclasses via inheritance.
- Tool metadata via `BaseTool` abstract class.
- `t()` i18n lookups: centralized.
- `admin/data.ts` datetime conversions: different fields/contexts, one helper (`msToIso`) already consolidates where applicable.
- `new Date()` timestamps: idiomatic JS, context-specific.

---

## Plan

| Phase | Action | Files | Risk | Verification | Status |
|-------|--------|-------|------|--------------|--------|
| 1 | Refactor ReminderTool duplicated time-parsing into shared helper | `src/tools/ReminderTool.ts` | Low | typecheck + ReminderTool tests | ✅ done |
| 2 | Refactor MediaSearchTool repeated slice/map into shared helper | `src/tools/MediaSearchTool.ts` | Low | typecheck + MediaSearchTool tests | ✅ done |
| 3 | Refactor ai/client duplicated fetch+error handling into shared method | `src/ai/client.ts` | Low | typecheck + AIClient tests | ✅ done |
| 4 | Add missing i18n keys; align `media.already_linked`→`already_bound` | `src/utils/i18n.ts`, `src/tools/MediaBindTool.ts` | Low | i18n parity test + WebSearchTool tests | ✅ done |
| 5 | `process.once`→`process.on` fatal handlers | `src/index.ts` | Low | typecheck + bootstrap tests | ✅ done |
| 6 | Log (not swallow) FlowHandler cleanup-start error | `src/core/FlowHandler.ts` | Low | typecheck + FlowHandler tests | ✅ done |
| 7 | Log (not swallow) flow-registration failure | `src/flows/registry.ts` | Low | typecheck | ✅ done |
| 8 | Fix DigestService cache-poisoning race (resolved values, no null-on-fail) | `src/utils/DigestService.ts` | Low | typecheck + DigestService tests | ✅ done |
| 9 | Log swallowed process.ts stdin/directory errors | `src/providers/process.ts` | Low | typecheck | ✅ done |
| 10 | Guard AppRuntime media-cleanup interval against overlapping runs | `src/runtime/AppRuntime.ts` | Low | typecheck | ✅ done |
| 11 | Re-run full `bun run check` + hermetic + random + drift gate | whole repo | — | all green | ✅ done |
| 12 | Commit (one logical commit) | — | — | lint clean, tests green | pending |

Execution begins now. No public contracts change; nothing is deleted.