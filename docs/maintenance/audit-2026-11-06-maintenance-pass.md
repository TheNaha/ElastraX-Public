# Maintenance Audit — 2026-11-06 (this pass)

Scope: whole repository. Focus: none.
Branch: `maintenance-pass-2026-11-06` (created from `main`).
Baseline: `bun run check` fully green — lint clean, typecheck clean, **1557 tests pass / 0 fail**, `drizzle-kit check` clean, `bun audit` clean.
Prior passes: 2026-10-29 Phase 1, 2026-11-02 tech-debt reduction, 2026-11-03 maintenance passes, 2026-11-04 pass 2, 2026-11-05 docs audit, 2026-11-06 pass.

## Method
Read `src/` (155 TS files), `test/`, `scripts/`, `AGENTS.md`, project map, prior audits. Dispatched parallel read-only subagents for: dead/unused code, duplicated logic, end-to-end inbound message flow. Ran targeted greps for `console.*`, empty catches, fire-and-forget, manual room-key builds, TODOs/FIXMEs, `toISOString().slice(0,10)`, `MediaLimitError`, `checkPermissions`. Nothing was modified during the audit.

---

## Critical Bugs
None found.

## Integration Gaps

### IG-01: `handleIncomingMessage` top-level error boundary — ALREADY RESOLVED
**Location:** `src/agent/index.ts` (line 685 `try` → line 1359 `catch`, closing at line 1365).

**Evidence:** `handleIncomingMessage` already wraps the entire write/AI/delivery body (from the user-message insert at line ~695 through the final reply delivery at line ~1335) in a top-level `try/catch`. On error it logs and sends `agent.internal_error` (defined at line 1000). No code change was required; no action taken.

**Risk:** None (already implemented).

## Tech Debt and Duplication

### TD-006: Room-key format hand-built in 2 places — RESOLVED
**Location:** `src/core/FlowHandler.ts:254`; `src/utils/AuthService.ts:127` (before fix).

**Evidence:** `src/core/roomKeyFormat.ts` is the single source of truth (`toRoomKey`, `ROOM_KEY_FULL_PREFIX = 'room:'`). But:
- `FlowHandler.ts:254` guarded with `session.roomId.startsWith(\`room:${session.platform}:\`)` — a hand-built prefix — then fell back to `toRoomKeyFormat` (no trimming).
- `AuthService.ts:127` (`legacyScopeFor`) built `const prefix = \`room:${platform}:\`;` by hand even though the same module imports `toRoomKey` for `roomKeyFor` (line 123).
Both diverged if the prefix/format ever changed.

**Fix applied:** `FlowHandler.ts` now uses `isRoomKeyFor(session.roomId, session.platform)` + `toRoomKey(...)`; `AuthService.ts` builds the prefix from `ROOM_KEY_FULL_PREFIX`. Both sites now delegate to the canonical module.

**Risk:** Low. Pure string-constant substitution; same resulting keys.

### TD-007: Date key `now.toISOString().slice(0, 10)` × 3
**Location:** `src/utils/feedback.ts:129-131` (`dayKey`, private); `src/utils/DigestService.ts:101-103` (`dateKey`, exported); `src/utils/scheduledTasks.ts:77-79` (`todayKey`, private).

**Evidence:** Three identical one-liners producing a UTC `YYYY-MM-DD` key. Same reason to change (format/locale of the date key).

**Proposed fix:** Extract a single shared `dateKey(now: Date): string` (new lightweight `src/utils/date.ts`); re-export from DigestService for compat; have feedback.ts and scheduledTasks.ts import it.

**Risk:** Low. Identical output; behavior unchanged.

### TD-008: Platform binding guard × 2
**Location:** `src/tools/MediaRequestTool.ts:52`; `src/tools/MediaLibraryTool.ts:49`.

**Evidence:** Identical 3-line check:
```ts
if ((binding as { platform?: string }).platform && (binding as { platform: string }).platform !== ctx.platform) return null;
```
Same reason to change (binding/platform semantics).

**Proposed fix:** Extract shared `bindingPlatformMismatch(binding, platform): boolean` helper (new `src/utils/toolAccess.ts`); both call sites use it.

**Risk:** Low. Same boolean result.

### TD-009: Permission check idiom × 3
**Location:** `src/tools/registry.ts:401`; `src/tools/MenuTool.ts:73`; `src/tools/FindToolsTool.ts:77`.

**Evidence:** Identical idiom:
```ts
if (typeof ctx.checkPermissions === 'function' && !(await ctx.checkPermissions(tool.permissions))) return ...;
```
Same reason to change (permission-check semantics). Note `GroupAdminTool.ts:101` uses the same pattern with a literal `'admin'` — consistent with the idiom but a fixed argument, so it stays.

**Proposed fix:** Extract shared `hasPermission(ctx, required): Promise<boolean>` (new `src/utils/toolAccess.ts`); the 3 sites use it.

**Risk:** Low. Same boolean result; `checkPermissions` returns `Promise<boolean>`.

### TD-010: rooms.ts migration-verification SQL embeds room-key format × 3
**Location:** `src/db/rooms.ts:430, :439, :485`.

**Evidence:** Diagnostic SQL strings contain `'room:' || platform || ':' || remote_room_id` — the room-key format duplicated into SQL. These are verification queries in a TS file (not hash-checked migration `.sql` files, which must not be edited).

**Proposed fix:** Add a small local helper `roomKeySql(platformCol, idCol): string` in `src/db/rooms.ts` and use it in the 3 spots. Produces identical SQL.

**Risk:** Low. Same SQL text; behavior unchanged. Lower priority than TD-007/008/009.

### TD-011: Two `MediaLimitError` classes (conceptual duplicate, different fields)
**Location:** `src/providers/media.ts:15-25` (`actualBytes`/`maxBytes`); `src/utils/mediaShared.ts:120-130` (`actual`/`limit`).

**Evidence:** Two classes with the same name and purpose but different field names and messages. `src/utils/MediaStorage.ts:22` imports `MediaLimitError` from `providers/media.ts`, while `mediaShared.ts` throws its own at lines 155/186.

**Proposed fix:** Unify onto one class. **Deferred:** field names differ (`actual` vs `actualBytes`, `limit` vs `maxBytes`), so merging is a small contract change for any consumer reading those fields. Flag for decision (see Deferred below).

**Risk:** Medium (contract touch). Not implemented in this pass.

## Dead / Detached Systems

### DD-001: `scripts/push-to-public.sh`
**Evidence:** Not listed in `package.json` scripts; only self-referenced; `docs/scripts.md` references it. Could not 100% prove unused without checking docs consumers.

**Proposed fix:** **Deferred** — deletion cannot be proven safe from static analysis alone. Flag for user decision.

**Risk:** Low if deleted, but unproven.

## Performance
None confirmed real. Media quota uses an in-memory directory cache (`mediaShared.ts` `mediaDirCache`) to avoid O(n) scans; startup scan already guards fixture writes (`EROFS` handled non-fatally). No changes needed.

## Optional Improvements
1. Unify `MediaLimitError` (TD-011) — see above.
2. Delete `scripts/push-to-public.sh` (DD-001) after confirming no docs/CI dependence.
3. `src/db/rooms.ts` SQL helper (TD-010) — low priority.

---

## Remediation Plan

| Phase | Change | Files | Risk | Verification |
|-------|--------|-------|------|--------------|
| 1 | Add `dateKey` shared util; dedup feedback.ts, DigestService.ts, scheduledTasks.ts | `src/utils/date.ts` (new), `src/utils/feedback.ts`, `src/utils/DigestService.ts`, `src/utils/scheduledTasks.ts` | Low | lint, typecheck, test — DONE |
| 2 | Dedup platform binding guard | `src/utils/toolAccess.ts` (new), `src/tools/MediaRequestTool.ts`, `src/tools/MediaLibraryTool.ts` | Low | lint, typecheck, test — DONE |
| 3 | Dedup permission check idiom | `src/utils/toolAccess.ts`, `src/tools/registry.ts`, `src/tools/MenuTool.ts`, `src/tools/FindToolsTool.ts` | Low | lint, typecheck, test — DONE |
| 4 | Dedup room-key prefix (TD-006 completion) | `src/core/FlowHandler.ts`, `src/utils/AuthService.ts` | Low | lint, typecheck, test — DONE |
| 5 | `handleIncomingMessage` error boundary (IG-01) | `src/agent/index.ts` | Low | Already resolved (no change) — VERIFIED |
| 6 | rooms.ts SQL helper (low priority) | `src/db/rooms.ts` | Low | lint, typecheck, test — DONE |

**Checklist (completed):**
- [x] Baseline checks recorded (green — done)
- [x] Phase 1: dateKey dedup
- [x] Phase 2: platform binding guard dedup
- [x] Phase 3: permission check dedup
- [x] Phase 4: room-key prefix dedup (TD-006 completed)
- [x] Phase 5: handleIncomingMessage error boundary (IG-01 already resolved)
- [x] Phase 6: rooms.ts SQL helper
- [x] Post-remediation `bun run check` matches baseline (lint clean, typecheck clean, 1557 pass/0 fail, drizzle-kit clean)
- [x] `bun run test:random` green (1556 pass, 0 fail)
- [x] Reviewer review of full diff
- [x] Report to user

## Deferred (need your decision)
- TD-011 `MediaLimitError` unification (contract touch).
- DD-001 `scripts/push-to-public.sh` deletion (unproven unused).
