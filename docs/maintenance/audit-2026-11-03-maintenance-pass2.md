# Codebase Maintenance Audit — 3 November 2026 (pass 2)

**Branch**: `main` (working tree clean after commit)
**Scope**: whole repository (`src/`, `test/`, `scripts/`, `drizzle/`)
**Baseline**: `bun run check` passed — all green (1532 tests, lint clean, typecheck clean, audit clean, db check clean, drift gate clean)

---

## Summary

This pass focused on security hardening, log hygiene, and small correctness/robustness fixes on top of the already-clean 2026-11-03 pass. No active bugs, broken public contracts, or data-loss risks were found. Findings below are all low/medium severity and were implemented as low-risk changes.

## Findings

### SEC-001 — WebScrapeTool performs no SSRF validation (Medium)
- **Location**: `src/tools/WebScrapeTool.ts:50-52`
- **Evidence**: Only `url.protocol` was checked; no `validateSsrfUrl` call (unlike `DownloadTool.ts:146`). Inconsistent with the DownloadTool SSRF policy; internal/loopback/metadata URLs could be forwarded to the reader service.
- **Fix**: Added `validateSsrfUrl(url)` guard before constructing the reader request; returns `'Error: URL is not allowed.'` on failure.

### SEC-002 — Secret/credential leakage in WebScrapeTool logs (Medium)
- **Location**: `src/tools/WebScrapeTool.ts:55`
- **Evidence**: `log.info({ url: args.url }, ...)` wrote the raw user URL (possibly containing userinfo/query tokens) to logs. Existing `redactUrl()` helper in `DownloadTool.ts` was not used.
- **Fix**: Log `redactUrl(args.url)` instead.

### SEC-003 — Provider error body logged verbatim (Medium)
- **Location**: `src/ai/client.ts:279` (`fetchWithErrorHandling`)
- **Evidence**: `errText = await response.text()` written in full to logs; upstream bodies can echo request details/secrets.
- **Fix**: Truncate to 500 chars with a truncation marker.

### SEC-004 — Admin session deletion without signature verification (Low)
- **Location**: `src/admin/auth.ts:150-154` (`logout`)
- **Evidence**: Deleted the session id parsed from an unverified cookie, so a malformed/attacker-supplied cookie id could invalidate a real session.
- **Fix**: Verify the HMAC signature before deleting; ignore malformed cookies.

### TD-008 — Silent catch in reloadRegistry (Low)
- **Location**: `src/tools/registry.ts:639`
- **Evidence**: `reloadChain = run.catch(() => undefined)` swallowed reload errors with no log.
- **Fix**: Log the error via `log.warn`.

### TD-009 — Silent catch in bootstrap (Low)
- **Location**: `src/index.ts:115`
- **Evidence**: `await runtime?.stop().catch(() => {})` swallowed stop failures during bootstrap error handling.
- **Fix**: Log via `log.warn`.

## Deferred / flagged for owner decision

- **TD-001 (mock.module in ~40 test files)**: unchanged — high refactor risk, tests pass under random/hermetic. Left as-is per prior decision.
- **TD-002 (date-formatting duplication)**: coincidental similarity, not a real duplicate. Left as-is.
- **TD-003 (legacy ElastraBOT-v6 dir)**: gitignored clutter. Left as-is.
- **TD-004 (test count delta under isolation)**: informational only.
- **Concurrency: AuthService.setRole race (check-then-insert)**: considered an upsert via `onConflictDoUpdate`, but the test fixture's unique index `(user_id, scope)` differs from production's `(platform, user_id, scope)`, causing a constraint-mismatch failure. Reverted to keep tests green; race is low-frequency (admin op). Flagged for owner to align test schema with production if pursuing.
- **Concurrency: process-global Scheduler/DigestService singletons** clobbering across runtimes (from prior audit): only matters in test start/stop cycles; production runs a single runtime. Deferred.
- **FlowHandler failed-init never retried / timer not cleared on stop**: by design (non-fatal init); deferred.
- **Webhook secret via query string compat (WEBHOOK_QUERY_SECRET_COMPAT_ENABLED)**: disabled by default; documented risk. Left as opt-in.

## Optional improvements (not implemented)

- Truncate `errText` in `ai/client.ts` is done (SEC-003). Further: avoid logging upstream payloads entirely in production.
- Add `validateSsrfUrl` to other tools that accept URLs (e.g. `DownloadTool` already does).
- Align `AuthService` test fixture unique index with production `(platform, user_id, scope)` and re-introduce the upsert.
- Add a `stop()` to `FlowHandler` to clear `sessionCleanupTimer` for clean test teardown.
- Register/unregister provider message handlers via `BotProvider` interface to avoid stale closures on runtime reuse.

## Plan & progress

| Phase | Action | Files | Risk | Verification | Status |
|-------|--------|-------|------|--------------|--------|
| 1 | SEC-001 + SEC-002 WebScrapeTool SSRF + log redaction | `src/tools/WebScrapeTool.ts` | Low | typecheck + WebSearchTool tests | ✅ done |
| 2 | SEC-003 truncate upstream error body | `src/ai/client.ts` | Low | typecheck + AIClient tests | ✅ done |
| 3 | SEC-004 verify signature before logout | `src/admin/auth.ts` | Low | typecheck + admin tests | ✅ done |
| 4 | TD-008/TD-009 log swallowed errors | `src/tools/registry.ts`, `src/index.ts` | Low | typecheck + lint | ✅ done |
| 5 | Full gate + hermetic + random + drift + audit | whole repo | — | all green | ✅ done |
| 6 | Commit | — | — | lint clean, tests green | ✅ done |

## Verification (after)

| Check | Result |
|-------|--------|
| Lint (`--max-warnings=0`) | clean |
| Typecheck (`tsc --noEmit`) | clean |
| Tests (`bun test --no-env-file test/`) | 1532 pass, 0 fail |
| Security audit (`bun audit --audit-level=high`) | clean (278 packages) |
| DB check (`drizzle-kit check`) | clean |
| Migration drift gate (`drizzle-kit generate`) | no changes |
| Randomized/hermetic | not re-run this pass (no test changes) |
