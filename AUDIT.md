# ElastraX Consolidation Audit

**Base snapshot:** `149ec0c785266632563b14c431fe449d807189b6` (`v8.0.1` release boundary: `661d3a8`)

**Scope:** TypeScript runtime, providers, tools/flows, AI, SQLite migrations, webhooks, Docker/CI, test harness, fixtures, documentation, and experimental Modal adapter.

**Release:** ElastraX `v8.0.1`

**Status:** The identity hotfix and retention drill are verified. v8.0.1 publication still requires tag approval. The canonical room-identity migration and operational cleanup are implemented and validated as a separate, not-yet-deployed v8.1.0 candidate.

## Previously confirmed release blockers addressed

- Corrected the `AuthService` parse failure and native-admin role resolution.
- Repaired migration `0008` for unapplied databases and added populated-0007 migration coverage.
- Added canonical identity aliases, platform-scoped role persistence, durable inbox/outbox/job tables, schema fingerprint/preflight, and guarded backup/restore.
- Added lazy/hermetic DB initialization, WAL durability, busy timeout, single-instance migration lease, retention policies, and retention dry-run tooling.
- Replaced the failed startup dump path with developer-only fixture generation and sanitized all WhatsApp fixtures.
- Added bounded queue admission, age limits, cancellation, drain semantics, lazy media acquisition, SSRF-safe downloads, process/resource caps, and provider lifecycle state.
- Added strict command/tool validation, platform-aware targets/roles, current-room flow/media ownership, memory consent/inert-data handling, Menfess allowlisting, and private-service ownership checks.
- Added standards-compliant AI streaming/SSE handling, real circuit state, usage metrics, persistent summaries, embedding-space isolation, and turn budgets.
- Hardened webhooks: exact routes, header auth, sanitized generic payloads, fail-closed media secrets, bounded destinations, replay/rate limits, 202 enqueue contract, liveness/readiness/metrics separation.
- Hardened Docker/Compose/CI: loopback host exposure, proxy network, writable non-root data path, pinned image inputs, migration drift checks, image build/smoke gates, and gated publication.
- Demoted Modal to one private, authenticated, pinned experimental adapter; removed unsupported ASR/full-omni claims from the default deployment surface.
- Added canonical `room:<platform>:<remoteRoomId>` identities, registry/backfill/conflict audit, room-scoped inbox/outbox/jobs/roles/subscriptions, and cross-platform delivery isolation.
- Added read-only CI diagnostics, a credential-free provider staging harness, a canary/rollback runbook, and a complete open-PR triage inventory. All 23 duplicate/superseded proposals were closed after their fixes were implemented locally.

## Important remaining constraints

- Canonical room keys are implemented. New v8.1 rooms use the canonical key as the internal room primary key while provider I/O keeps raw remote IDs. Rolling back to a pre-0022 application requires a matching database backup once canonical-ID rooms have been created.
- External delivery is at-least-once with durable deduplication. Exactly-once semantics are not promised when providers do not supply idempotency keys.
- A single bot process remains intentional for SQLite; multi-process rolling deployment is not supported.
- GitHub Actions may still require an account-side billing/permissions repair; no workflow can prove a runner started before that external state is fixed.
- The identity hotfix has been deployed and manually verified. The v8.0.1 full-release tag, image digest publication, and production rollout still require explicit approval.
- The final hermetic suite passes 1,212 tests with zero failures in normal, randomized, and isolated-per-file modes, including migration 0022 backfill, same-remote-ID cross-platform isolation, room-scoped delivery, CI diagnostics, and provider staging scenarios. Typecheck and zero-warning lint are clean. Bun's high-severity dependency audit and the working-tree Gitleaks scan are clean. A production-image build and disposable fresh-volume smoke apply migration 0022 successfully: `/health` 200, unauthenticated `/webhook` 401, authenticated `/webhook` 202 queued, and `/ready` 503 when no provider is configured.

## Release commands

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run db:check
bun run db:retention
bun run db:room-keys
bun run db:backup
bun run ci:diagnose
bun run provider:staging
```

The retention command is a dry run by default. Apply it only after backup verification:

```sh
bun run db:retention -- --apply
```

Do not run destructive database scripts against a live bot without a verified backup and a stopped single-instance deployment.

## Acceptance gates

- Fresh database and every supported migration predecessor upgrade pass integrity, foreign-key, schema, identity, and restore checks.
- Duplicate provider events and retries do not create duplicate local execution or avoidable duplicate delivery.
- WhatsApp and Discord rooms with the same raw provider ID resolve to separate canonical rooms, history, reminders, subscriptions, roles, and delivery jobs.
- Tool/flow/media/role boundaries enforce platform, room, ownership, consent, and permission policy.
- Queue, media, subprocess, context, webhook, database, and retention work remain bounded and observable.
- `/live` is minimal, `/ready` reflects actual database/provider readiness, and `/metrics` is private.
- The production image uses one pinned runtime identity, passes a fresh-volume smoke test, and is deployed by immutable digest only after explicit approval.

The detailed remediation sequence and evidence references are in `.kilo/plans/1790332641331-elastrax-stabilization-and-consolidation.md`.
