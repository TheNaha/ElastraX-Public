# Open PR Triage

> **Resolution (2026-09-25):** All 23 open proposals listed below were reviewed and closed as superseded after their security/performance/migration fixes were implemented and tested on `main`. No proposal branch was merged. Inventory

Read-only inventory of the open pull requests in `TheNaha/ElastraX`, produced with `gh pr list` and `gh pr view`/`gh api` reads. **Nothing was closed, merged, labelled, retitled, or edited.** Every group below is a proposal for a human to act on; this document records the evidence, not a decision.

Snapshot: 2026-09-25, 23 open PRs, all from `main` ← `TheNaha`, all single-commit, all created by automation branches (`sentinel-*`, `bolt-*`, `jules-*`), all with a red or unknown CI state because no step ever runs (see [ci-diagnostics](./ci-diagnostics.md)).

## Groups

### 1. Security-sensitive — 11 PRs (Sentinel timing-attack series)

`#442 #441 #439 #438 #435 #433 #430 #427 #426 #424 #421`

All eleven propose the same change to `src/webhooks/utils.ts`: hash both operands with `crypto.createHash('sha256')` to a fixed 32-byte length and compare with `crypto.timingSafeEqual`, instead of comparing raw buffers behind a length check plus a dummy self-comparison. Most also append a dated entry to `.jules/sentinel.md`.

Why this group is separated from the rest:

- **It touches HMAC webhook verification.** A mistake here either breaks every webhook delivery or weakens authentication. It must be reviewed by a human with the current file open, not merged because CI is red.
- **The pattern is not yet on `main`.** Committed `main` still performs a length comparison with `timingSafeEqual(expectedBytes, expectedBytes)` on mismatch. The eleven PRs are therefore *not* superseded in content — they are duplicates of one another.
- **They are stale.** They were generated against older revisions of `src/webhooks/utils.ts`, which is under active change. A clean application cannot be assumed.
- **None of them adds a regression test.** A correct adoption needs a test that a wrong-length secret and a wrong-content secret are both rejected, and that the comparison path is exercised.

Proposed handling: pick exactly one representative (the smallest diff that changes only the verification function, e.g. `#442`), re-base it onto current `main`, add the regression test, and let the remaining ten be closed as duplicates. That closure is a human decision; it is listed here as a proposal only.

### 2. Duplicate and superseded — 10 PRs (Bolt room-count series)

`#440 #437 #436 #432 #429 #428 #425 #423 #422 #420`

All ten replace the room count in `src/tools/OwnerTool.ts` with a SQL `count()` aggregate and touch `test/OwnerTool.test.ts`. Evidence:

- Committed `main` already performs the aggregate: `db.select({ value: count() }).from(chatRooms)`. The performance intent is already satisfied, so the code change is **superseded**.
- Seven of the ten additionally append a journal entry for a `0NaN_*` migration (`0NaN_sour_hex.sql` in `#428`) that does not exist in `drizzle/migrations/` and is not in `_journal.json` on `main`. Merging any of them introduces a phantom migration tag, which contradicts the CI migration-drift gate that regenerates migrations and fails on any uncommitted change under `drizzle/`, `drizzle.config.ts`, or `src/db/schema.ts`.
- `#428` is the outlier in size: it adds a 923-line snapshot file and a new journal entry, with a one-line functional change to `OwnerTool`.

Proposed handling: close all ten as superseded, keeping the rationale in this document. No code needs to be taken from any of them.

### 3. Obsolete / mislabelled — 2 PRs (Jules migration chores)

`#434` and `#431`

- `#434 "chore: abort UX task and clean up rogue migrations"` changes exactly one file, `drizzle/migrations/meta/_journal.json`, and its only change is to **add** the phantom entry `0NaN_high_moon_knight` — the opposite of its own title. It creates the problem it claims to remove.
- `#431 "chore: remove rogue migrations"` has zero changed files: no diff at all.

Proposed handling: close both. Neither can be merged as-is; `#434` is actively harmful to the migration-drift gate.

### 4. Relevant — 0 PRs

Nothing in the current window is a candidate for direct adoption today. The only group with a plausible future is group 1, and only after a re-base, a regression test, and human review of the webhook verification change.

## Why none of these can be merged right now

- All 23 are based on `main` and carry a red CI check, but that red is `no_step_scheduling_failure`: the job concluded failure with zero recorded steps. No step ran, so the check is not evidence about the code.
- Local verification is mandatory before any decision: `bun install --frozen-lockfile && bun run check`.
- Several PRs touch files under active development (`src/webhooks/utils.ts`, `src/tools/OwnerTool.ts`, `drizzle/migrations/meta/_journal.json`). Merging stale diffs into moving files is how drift enters the tree.

## Suggested order of work for a human reviewer

1. Run `bun run scripts/ciDiagnostics.ts` and confirm the red runs are still external, not code failures.
2. Close group 3 (`#434`, `#431`) — zero risk, zero value.
3. Close group 2 (Bolt, 10 PRs) — superseded, and seven of them would break the migration gate.
4. Take one Sentinel representative, re-base, add the constant-time regression test, and review it as a security change.
5. Close the remaining Sentinel duplicates with a pointer to the merged representative.

## Reproducing this inventory

```bash
gh pr list --state open --limit 100 \
  --json number,title,isDraft,author,createdAt,updatedAt,headRefName,baseRefName,url

gh pr view <number> --json number,title,files,additions,deletions,commits
gh pr diff <number>
```

All of the commands above are read-only. The triage script for CI state is `bun run scripts/ciDiagnostics.ts`, which is read-only by construction.
