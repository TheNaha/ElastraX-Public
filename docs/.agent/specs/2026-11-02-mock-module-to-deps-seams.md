# Tech Debt Reduction: Migrate `mock.module` Tests to `*Deps` Seams

**Date:** 2026-11-02  
**Status:** Draft — awaiting go-ahead  
**Branch:** not yet created  
**Baseline:** `bun run check` passes (lint clean, typecheck clean, 1565 tests pass, audit clean, drift gate clean)

---

## 1. Goal

Eliminate process-scoped `mock.module` leakage across test files by migrating tests that mock source modules (`../src/db`, `../src/utils/logger`, etc.) to use the existing `*Deps` seam objects instead. This makes tests order-independent and hermetic, removing a class of cross-test pollution bugs that only surface under CI's randomized/hermetic runs.

**Explicitly out of scope:**
- Deleting or changing `test/helpers/modules.ts` (it may remain legitimately used for non-source mocks such as `libsignal`).
- Fixing the other audit tech-debt items (date-formatting duplication, `ElastraBOT-v6` clutter, test-count delta under isolation).
- Any production source-code change other than adding `*Deps` seam objects where a module under test currently has none.
- Changing any public contract (tool definitions, config schema, API routes, DB schema).

---

## 2. User-facing behavior

This is an internal quality change with no user-facing UI or behavior change. The observable difference is purely in test reliability:

- **Before:** Running `bun run test:random` or `bun run test:hermetic` can expose order- or mock-leak-dependent failures (e.g., `test/RoleTool.test.ts` must manually override a `db` mock that leaks from `agent.test.ts` because `mock.module` is process-scoped).
- **After:** Each test patches only its own module-under-test `*Deps` seam and restores it in `afterEach`. No cross-file mock leakage. Tests pass identically in normal, random, and hermetic modes.

Entry point for verification: `bun test --no-env-file --isolate --randomize test/`.

---

## 3. States and edge cases

| State | Behavior |
|-------|----------|
| Empty DB | Unchanged — tests continue to use the temp DB provided by `test/setup.ts`. |
| Mock seam missing | If a module under test has no `*Deps` object, the migration adds one (minimal, following existing `downloadToolDeps` pattern) OR the test continues to use `mock.module` for that module only (documented exception). |
| Invalid input | Unchanged — validation logic in source is not modified. |
| Partial failure / cancel halfway | Each test file is migrated independently. A partially migrated repo is still valid: migrated files use `*Deps`, unmigrated files still use `mock.module`. No all-or-nothing requirement. |
| Running twice | Idempotent — restoring seams in `afterEach` means re-running a test file has no side effects on other files. |
| Existing data | No production data is touched; tests use temp databases only. |

---

## 4. Fit with the existing system

**Components touched:**
- `test/*.test.ts` — approximately 40 files currently use `mock.module` (86 matches via `grep mock.module test/`).
- `src/*.ts` — source modules that may need a `*Deps` seam added where one is missing (e.g. `src/utils/logger.ts`, `src/db/index.ts` if a test mocks them).
- `test/setup.ts` — not modified; continues to provide the temp DB and blocked `fetch`.
- `test/helpers/modules.ts` — not modified; `installModuleMock`/`withModuleMock` remain available for non-source mocks.

**Conventions followed (from AGENTS.md):**
- "Modules expose `*Deps` objects (e.g. `downloadToolDeps.spawn`) as seams for tests. Patch those and restore them in `afterEach` instead of adding a new `mock.module`, because `mock.module` leaks across files."
- `any` is allowed under `test/`.
- Lint runs with `--max-warnings=0`.

**Existing `*Deps` examples (verified in source):** `downloadToolDeps` (`src/tools/DownloadTool.ts:112`), `discordProviderDeps`, `mediaStorageDeps`, `IdentityServiceDeps` (in `src/utils/IdentityService.ts`), `DigestDeps` (in `src/utils/DigestService.ts`), `AppRuntimeDeps` (referenced in `src/index.ts:102`).

---

## 5. Design decisions

| Decision | Option picked | Why |
|----------|---------------|-----|
| Primary target | Migrate tests that mock `../src/db` and `../src/utils/logger` first | These are the two most common `mock.module` targets and the highest leakage risk (db mocks are elaborate hand-rolled fakes; logger mocks are near-universal). |
| Modules without `*Deps` | Add a minimal `*Deps` seam following the `downloadToolDeps` pattern, OR leave `mock.module` for that module as a documented exception | Avoids over-engineering seams for modules that are genuinely hard to seam (e.g., `db` is the connection itself). |
| `test/helpers/modules.ts` | Keep as-is | It's a sanctioned test helper; `mock.module` inside a helper is acceptable for non-source mocks (e.g. `libsignal`). |
| Branch | `tech-debt/mock-module-to-deps` | Dedicated branch per the workflow. |

**Decisions that need your input (product/trade-off):**
- Whether to add `*Deps` seams to `src/db/index.ts` and `src/utils/logger.ts` if tests currently mock them, or to leave those tests on `mock.module` as exceptions. (I lean toward adding seams where tests mock source modules, but this is a judgment call.)
- Whether the migration should be "all 40 files" or a prioritized subset (db + logger first, others as time permits).

---

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Regression: a migrated test behaves differently with a real seam vs. a mock | Run each migrated test file individually and under `--isolate --randomize` after every slice. |
| Adding a `*Deps` seam changes source behavior | Seams are optional overrides (`deps.foo ?? defaultFoo`); default path is unchanged. |
| Forgetting to restore a seam in `afterEach` | Enforce `afterEach` restore by convention; verify with random/hermetic runs. |
| Public contract change | None — only internal test scaffolding and optional seam objects. |
| Data format change | None — no DB or config changes. |

---

## 7. Acceptance criteria

- [ ] `grep mock.module test/` returns zero matches outside `test/helpers/` and `test/setup.ts`.
- [ ] Every migrated test file patches its seam(s) and restores them in `afterEach`.
- [ ] `bun run lint` (with `--max-warnings=0`) passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun test --no-env-file test/` passes (1565 tests, 0 fail).
- [ ] `bun test --no-env-file --isolate --randomize test/` passes (random + hermetic, 0 fail).
- [ ] No test file contains a comment about overriding a leaked `mock.module` from another file.

---

## 8. Slices

Each slice is small, testable, and leaves the project working.

**Slice 0 — Baseline & branch** (no test changes)
- Create branch `tech-debt/mock-module-to-deps`.
- Record baseline: `bun run check`, `bun test test:random`.
- Inventory: list every `mock.module` target per test file, flag which source modules lack `*Deps` seams.

**Slice 1 — Logger mocks** (~15 files)
- Migrate `mock.module('../src/utils/logger', ...)` tests to use a `loggerDeps` seam (add `src/utils/logger.ts` seam if missing) or to the real logger.
- Verify each file under `--isolate --randomize`.

**Slice 2 — DB mocks** (~8 files, including the elaborate fakes in `ReminderTool.test.ts`, `agent.test.ts`, `ConfigTool.security.test.ts`, `StatsTool.test.ts`, `roomKnowledge.test.ts`, `RoleTool.test.ts`)
- Migrate `mock.module('../src/db', ...)` to use the real temp DB from the harness, or add a `dbDeps` seam where a module under test wraps db access.
- Verify each file under `--isolate --randomize`.

**Slice 3 — Remaining mock.module targets** (~17 files, assorted modules)
- Migrate remaining `mock.module` calls (e.g. `../src/utils/ModelRouter`, `@whiskeysockets/baileys`, etc.) to `*Deps` seams or documented exceptions.
- Verify each file under `--isolate --randomize`.

**Slice 4 — Full gate + cleanup**
- Run `bun run check` + `test:random` + `test:hermetic`.
- Remove now-obvious duplicate mock helpers if any (only if proven unused).
- Update `docs/.agent/project-map.md` if needed.

---

## 9. Open questions

- Unverified: exactly which source modules lack `*Deps` seams but are mocked by tests (need to cross-reference `mock.module` targets against source exports).
- Unverified: whether `src/db/index.ts` can practically expose a `*Deps` seam given it's the connection itself, or whether db-mocking tests should instead use the real temp DB directly.
- Unverified: the exact count of test files using `mock.module` per target (grep gave 86 matches but some files have multiple).
- Your preference: prioritize "all files" vs "db + logger first, rest as time permits."

---

## Next step

I'm waiting for your go-ahead before creating the branch and starting Slice 0. If you approve, I'll proceed conservatively: add `*Deps` seams only where tests mock source modules, never change production behavior, and verify every slice with `test:random`.