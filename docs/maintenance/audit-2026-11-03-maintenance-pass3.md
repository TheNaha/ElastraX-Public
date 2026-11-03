# Codebase Maintenance Audit — 3 November 2026 (pass 3)

**Branch**: `main` (working tree clean)
**Scope**: whole repository (`src/`, `test/`, `scripts/`, `drizzle/`)
**Baseline**: `bun run check` fully green — 1536 tests pass, lint clean (`--max-warnings=0`), typecheck clean, `bun audit --audit-level=high` clean, `drizzle-kit check` clean, migration drift gate clean (`0024_snapshot.json` present, no schema diff).

---

## Summary

This pass re-audited the whole repo after maintenance passes 1 and 2 (2026-11-02 and 2026-11-03). No active bugs, broken public contracts, data-loss risks, or security issues were found. All previously remediated findings were verified intact. The only remaining items are low-severity / optional tech debt: a set of unused i18n translation keys and a trivial date-formatting repetition. Neither was acted on unilaterally (see below).

## Baseline checks (all PASS)

| Check | Result |
|---|---|
| `bun run lint` | clean, `--max-warnings=0` |
| `bun run typecheck` (`tsc --noEmit`) | clean |
| `bun test --no-env-file test/` | 1536 pass, 0 fail |
| `bun audit --audit-level=high` | no vulnerabilities (278 packages) |
| `bun run db:check` (`drizzle-kit check`) | clean, no schema changes |
| Migration drift gate (`db:generate` leaves `drizzle/` + `src/db/schema.ts` unchanged) | clean |
| `bun run test:hermetic` (`--isolate --randomize`) | previously green |

## Findings

### None — Critical Bugs
No unhandled errors, null/nil risks, swallowed errors, races, or resource leaks were found.

### None — Integration Gaps
Verified end-to-end:
- Inbox/Outbox claim/ack/stranded recovery (`src/messaging/InboxService.ts:113-216`) — correct claim, complete, defer, and stranded-recovery logic.
- LLM tool-calling loop (`src/agent/index.ts:217-328`) — per-tool try/catch converts failures into tool results; `TurnBudgetExceededError` handled; `withCancellableTimeout` wraps execution; no unhandled escape.
- Plugin permission gate (`src/plugins/manifest.ts`, `src/tools/registry.ts:500-567`) — manifest bound to actual exports; refused when permissions don't cover tools.
- `withTimeout` (`src/utils/withTimeout.ts`) — `settled` flag prevents double resolution; correct.

### None — Tech Debt / Duplication (actionable)
- The previously-fixed `stripBlobs` duplication, migration `0024` snapshot, missing indexes (`memories.category`, `reminders.claimed_at`, `user_roles.role`), and `mock.module` migration are all resolved and verified.
- `toISOString().slice(0, 10)` appears 3x (`src/utils/feedback.ts:130`, `src/utils/scheduledTasks.ts:78`, `src/utils/DigestService.ts:102`) — a one-liner, previously deemed not worth a refactor (TD-002). Left as-is.
- No `any` in `src/` (only one, in a comment at `src/tools/RoleTool.ts:21`). No empty `catch` blocks that silently swallow — all log warnings. No TODO/FIXME/HACK in `src/`. All async-in-loop usage awaited via `Promise.all`; all `parseInt` use radix 10.

### OPT-001 — 105 unused i18n translation keys (low / flagged for decision)
- **Location**: `src/utils/i18n.ts` (353 keys in `en`, 353 in `id` — parity is perfect).
- **Evidence**: All `t(lang, key)` calls in `src/`, `test/`, `scripts/` use static string keys (no dynamic/template key construction). 105 of the 353 defined keys are never referenced anywhere (e.g. `agent.chat_prompt`, `kb.*`, `media.*`, `media_request.*`, `media_library.*`).
- **Assessment**: These are dead translations (detached content), not code. They are product content that may be intentionally reserved for upcoming features, so I did **not** delete them (deletion is a behavior/content change I cannot unilaterally approve).
- **Proposed fix**: Review the unused-key list and either wire them into features or remove them. If removed, add a test asserting no unused keys (currently `test/i18n.test.ts` only enforces en/id parity).

### OPT-002 — i18n test does not guard unused keys (low / optional)
- **Location**: `test/i18n.test.ts`
- **Evidence**: Enforces en/id key parity only; does not detect keys defined but never used.
- **Proposed fix**: Add a parity check that fails when a defined key has no static `t(...)` reference (after OPT-001 review decides which keys are truly dead).

## Remediation plan

No remediation commits are required for this pass. The repo is fully green.

Ordered optional work (low risk, left for your decision):

1. **OPT-001** — Review the 105 unused i18n keys; remove the truly dead ones (after confirming none are dynamically referenced). Risk: low, but it's a content change.
2. **OPT-002** — Add unused-key detection to `test/i18n.test.ts` once OPT-001 is resolved. Risk: low.

## Checklist (post-pass)

- [x] Baseline `bun run check` green
- [x] Security audit clean
- [x] Migration drift gate clean
- [x] No active bugs found
- [x] Prior fixes verified intact
- [ ] OPT-001 unused i18n keys — pending your decision
- [ ] OPT-002 unused-key test — pending OPT-001

---

**Bottom line**: This maintenance pass found nothing to fix. The codebase is healthy, well-tested, and all previous remediation is intact. The only items are the two optional findings above, flagged for your decision rather than implemented unilaterally.
