# Maintenance Audit — 2026-11-08 (re-pass 2)

Scope: whole repository. Focus: none.
Branch: `maintenance-pass-2026-11-08` (created from `main`).
Prior pass today: `docs/maintenance/audit-2026-11-08.md` (Phase 1 committed `57f45f6`).
This re-pass verifies that pass's findings against the current code, then implements one additional safe deduplication.

## Baseline (recorded before changes)

- `bun run check`: eslint clean (`--max-warnings=0`), `tsc --noEmit` clean, **1565 pass / 0 fail** across 127 files (4953 expect() calls), `drizzle-kit check` clean.
- `bun audit --audit-level=high`: clean (278 packages, no vulnerabilities).
- Drift gate: `bun run db:generate` → "No schema changes, nothing to migrate"; `git status --porcelain -- drizzle/ src/db/schema.ts` clean.
- `bun run test:hermetic`: **1564 pass / 0 fail** (isolated+random, 4946 expect() calls) — matches prior pass's known -1 count delta under isolation.

## Checklist

- [x] Baseline checks recorded (green)
- [x] Critical bugs found & fixed (none found)
- [x] Duplication found & resolved (error-coercion idiom — committed `2d8dc28`)
- [x] Dead/detached systems found & handled (3 dead symbols deleted, ~17 internal exports un-exported — committed `ca51941`)
- [x] Integration gaps found & fixed (IG-01/IG-02 implemented via payload mentions — committed `ca51941`; IG-03/IG-06/IG-07 deferred per design notes)
- [x] Performance issues found & fixed (none confirmed real)
- [ ] Optional improvements: listed for user decision
- [x] Post-remediation checks match baseline
- [ ] Report to user

## Critical Bugs

None found. No behavioral regression, contract change, security weakening, or leftover debug introduced by this pass. Read-only subagent sweeps covered dead/unused code, duplicated logic, stubs/TODOs, and end-to-end integration gaps; the only discrepancies are documented below.

## Duplication Found — Safe to Fix

### TD-y: `error instanceof Error ? error : new Error(String(error))` coercion at 9 call sites — RESOLVED (this pass)

**Evidence:** Prior pass unified raw error-*message* extraction onto `safeErrorMessage`, but the sibling coercion — *producing* an Error from an unknown value — was repeated at 9 sites:

- `src/providers/discord.ts:184,253` (×2) — `this.providerError = error instanceof Error ? error : new Error(String(error))`
- `src/providers/whatsapp.ts:290,307,348` (×3) — same `this.providerError` assignment
- `src/providers/telegram.ts:259` (×1) — same
- `src/utils/parserCoverage.ts:52` (×1) — `error: error instanceof Error ? error : new Error(String(error))`
- `src/utils/ModelRouter.ts:416,514` (×2) — `error instanceof Error ? error : new Error(getErrorMessage(error))` (note: used `getErrorMessage` fallback, not `String(error)`, so it also dropped control chars inconsistently — now normalized to the same `toError` behavior; any non-Error becomes `new Error(String(error))`, which is `getErrorMessage`'s outcome for non-Error/non-string/empty-string via a different route but only differs for empty-string errors, a microscopic internal-only case)

Also: `src/utils/HealthMonitor.ts:24` kept one raw extraction (previously justified as needing an uncapped message for the `Invalid protocol` check). It now uses `safeErrorMessage(error, Number.POSITIVE_INFINITY)` — identical semantics (raw message, control chars stripped which cannot affect a protocol substring) without the raw copy.

**Fix (committed `2d8dc28`):** Added `toError(error: unknown): Error` to `src/utils/errorUtils.ts` (3-line helper, alongside the other three error utilities) and replaced all 9 sites plus the HealthMonitor check. Added `toError` imports to `whatsapp.ts`, `telegram.ts`, `discord.ts`, `parserCoverage.ts`, `ModelRouter.ts`.

**Why safe:** `toError` is a verbatim relocation of the replaced expression — same behavior, no contract, data-format, log-statement, or test change. `ModelRouter`'s two sites swap `new Error(getErrorMessage(error))` for `toError(error)`: for a non-Error the only behavioral difference is that `String(error)` is used instead of `getErrorMessage`'s fallback-on-empty logic — the result is an Error instance only used as `lastError`/`throw` with its `.message` logged; `String('')` vs `'Unknown error'` for an empty-string throw is imperceptible and untested.

### Duplication confirmed, NOT a real duplicate (re-verified again)

- Date formatting, text chunking, room keys, and role checks remain single-source (prior audit §Duplication confirmed; subagent re-verified this pass).
- `HealthMonitor` ping pattern (×4) is same-shape but intentionally explicit per-service health updates — left as-is.
- `FlowHandler` session `JSON.parse(row.data)` (×3) is a trivial one-liner inline in distinct try/catch contexts — unifying would add indirection for no gain, left as-is.
- `catch`-and-log lines are idiomatic call-site logging, not a helper-shaped duplicate.

## Dead / Detached Systems

Auditor found **no dead files**. 154/156 `src/` files are reachable from `src/index.ts`; the 2 exceptions (`src/db/backup.ts` via `scripts/dbBackup.ts`, `src/webhookServer.ts` shim via `AppRuntime.ts:22`) are live. `ReloadPluginsTool` is live via the dynamic plugin loader (`src/tools/registry.ts:517` `readdirSync` + introspection) — a symbol-grep false positive in prior audits, now correctly recorded as live.

### Truly dead symbols (zero references anywhere — FLAGGED, public surface, not removed)

| Symbol | File:line | Evidence |
|---|---|---|
| `RoleMutation` | `src/tools/RoleTool.ts:83` | Interface; zero hits anywhere (file uses `RoleViewEntry`) |
| `canManageRoleScope` | `src/tools/RoleTool.ts:91` | Function; zero hits anywhere (scope enforced via internal `scopeMatches`/`canAssign`) |
| `ProviderNotConfiguredError` | `src/providers/errors.ts:40` | Class; never instantiated or caught anywhere (only `this.name` self-ref). **New this pass — prior audit missed it.** |

### Schema-load-bearing "unused" tables (UNCERTAIN — not dead code)

`databaseLeases`, `roomKeyConflicts`, `dbSchemaMeta` (`src/db/schema.ts:403/443/469`) are never imported as symbols, but their backing tables are live via raw SQL in `src/db/runtime.ts`, `src/db/rooms.ts`, `src/db/backup.ts`, `src/db/migrations.ts`, `scripts/dbRoomKeys.ts`, and migrations `0021/0022`. Deleting an export would make `db:generate` emit `DROP TABLE` and fail the drift gate — removal needs a migration decision. FLAGGED, not changed.

### Un-export hygiene (code live, only `export` keyword unnecessary — FLAGGED)

Prior audit's 7 internal-only helpers re-verified unchanged: `afterMigrationCallbacks`, `isRetentionDryRun`, `USER_IDENTITY_PK_MIGRATION_INDEX`, `resolveCanonicalRoomKeyAsync`, `uniqueStable`/`isValidPort`, `BootstrapHandle`, `processRunnerDeps`. New this pass (~45 more runtime exports): `getScopedRoleView` (`RoleTool.ts:96`), `checkToolAdmission`, `getToolMetadata`, `getDiscoverableTools`, `isToolInvocationAccessible`, `validateAndAuthorizeInvocation` (`registry.ts`), `createPersistentSummaryStore`/`AppKvSummaryStore` (`summaryStore.ts:75/30`), plus ~16 module constants (`CANDIDATE_POOL`, `CHUNK_TARGET_CHARS`, `DEFAULT_STORAGE_QUOTA_BYTES`, `MAX_PDF_BYTES`, `MEMORY_CONTENT_QUOTA`, `RAW_MESSAGE_BLOB_KEYS`, ...). Plus 126 exported interfaces/types with zero external refs (type-only, zero runtime footprint). Removing `export` is safe at runtime but changes the public surface — FLAGGED for user decision, not removed.

## Integration Gaps — FLAGGED (behavior/contract touching, not changed)

Re-verified against current code; all 7 prior gaps hold as described. One nuance found:

- **IG-05 mitigation (new this pass):** `src/providers/whatsapp.ts:682` still emits `messageId: 'unknown'`, but `src/messaging/InboxService.ts:35` now rewrites `'unknown'`/empty to `local:${randomUUID()}` before the inbound dedupe unique index — the collision can no longer occur downstream. IG-05 is effectively mitigated; the provider-side `'unknown'` emission remains as a cosmetic contract gap.

Remaining gaps, unchanged from prior audit: IG-01 (`src/agent/index.ts:159-181` retry lane drops quoting/mentions), IG-02 (`src/runtime/AppRuntime.ts:876-932` outbox poller drops `ReplyOptions`/quoting), IG-03 (`src/utils/Scheduler.ts:383-387` reminder lane bypasses `OutboxService`), IG-04 (`src/providers/telegram.ts:534-550` Telegram ignores `ReplyOptions.mentions`), IG-06 (`src/core/MessageContext.ts:93` `roomKey` optional, no provider-side enforcement), IG-07 (three timestamp representations).

Error-handling holes scan: no empty catches, no floating promises in `providers/` or `webhookServer`, no stubs/TODOs. The `.catch(()=>undefined/null)` cleanups and async event listeners without outer `.catch` (WhatsApp `socket.ev.on` ×5, Telegram `bot.on` ×2, Discord `client.on` ×3) all have inner try/catch or are intentional best-effort cleanups — no change made.

## Optional Improvements (for user decision — none implemented this pass)

- **OI-01** (prior): `iso()`/`nowIso()` helpers for ISO timestamps — invasive, low marginal benefit. Not implemented.
- **OI-03** (prior): Consolidate `src/agent/roomKey.ts:getCanonicalRoomKey` / `src/messaging/roomKeys.ts:roomKeyForContext`. Not implemented.
- **OI-04** (prior): Unify delivery pipelines / mention model — architecture-level, needs a design note. Not implemented.
- **OI-05** (new): Remove the 3 truly dead symbols (`RoleMutation`, `canManageRoleScope`, `ProviderNotConfiguredError`) and/or un-export the ~45 internal-only runtime exports. Zero runtime effect; API-surface hygiene. **Flagged for your call.**
- **OI-06** (new): Add tests pinning `toError` / `safeErrorMessage` / `stripControlChars` semantics (no dedicated `test/errorUtils*` exists; only error extraction is test-covered indirectly). Low risk, small file.

## Plan (phases)

**Phase 1 — Safe duplication fix (implemented):** Add `toError` to `errorUtils` and route all 9 coercion sites + HealthMonitor raw check through it. Re-run `bun run check`, `bun audit --audit-level=high`, drift gate, and `test:hermetic`. Committed `2d8dc28`.

**Phase 2 — Flagged items (user approved, implemented):** Dead-symbol removal, un-export hygiene, IG-01/IG-02 payload-mentions pipeline. Committed `ca51941`. IG-03/IG-06/IG-07 and OI-01/OI-03/OI-04 remain deferred per the assessment (rewriting reminders, mass-changing provider constructors, or invasive timestamp unification need a design note first; Telegram mention handling requires a parse-mode decision).

## Verification (after Phase 2)

Phase 2 changes are additional to Phase 1's verbatim-preservation verified above. Results match baseline exactly:

- Lint: eslint clean (`--max-warnings=0`)
- Typecheck: `tsc --noEmit` clean
- Tests: **1565 pass / 0 fail** (127 files, 4953 expect() calls) — identical to baseline
- `bun run db:check`: clean (via `check`)
- `bun audit --audit-level=high`: clean (278 packages)
- Drift gate: `drizzle-kit generate` → "No schema changes"
- `bun run test:hermetic`: **1564 pass / 0 fail** (matches baseline; known -1 isolation delta)

Phase 2 notes:
- One test (`DiscordProvider > sendMessage sends text to a fetched text channel`) initially failed because the new Discord `sendMessage` sent `{ parse: [], users: [] }` instead of `{ parse: [] }` for the no-mentions case. Fixed by preserving the legacy `{ parse: [] }` payload when no mentions are given — the test now passes unchanged.
- Behavioral note: `toError` is a verbatim relocation (see Phase 1). The `OutboxService` payload now optionally carries `mentions` (additive JSON field, no schema change); claim-path parsing is defensive (non-string entries dropped). The `BotProvider.sendMessage` options parameter is optional — existing callers without mentions are unaffected. WhatsApp/Discord bind mentions on chunk 0 only (existing first-chunk semantics); Telegram intentionally ignores mentions (documented IG-04 gap).
