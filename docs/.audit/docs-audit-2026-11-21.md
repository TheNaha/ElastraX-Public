# Documentation audit — 2026-11-21

Scope: whole repo. Focus: none. Branch: `main`, HEAD `b71d28f`.
Prior pass: `docs-audit-2026-11-19.md` (content synced at `9e16190` / docs commit `97241e5`).

The last documentation pass read the tree at `97241e5`. Since then the i18n
localisation commit (`1c01c73`), the 2026-11-20 maintenance pass and its review
follow-ups (`a57d658`..`b71d28f`) changed behaviour. Maintenance pass 7 updated
three living documents on its own — `docs/database.md` (migration ledger,
restore), `docs/canary-runbook.md` (restore), and `docs/configuration.md` plus
`.env.example` (`ALLOW_INSECURE_HTTP_ENDPOINTS`, private-network literals) — so
those are treated as current unless the code says otherwise. Everything else in
the range was undocumented.

## Method

- Diffed `97241e5..HEAD` for `src/`, `scripts/`, `test/`, `drizzle/`,
  `package.json`, `.github/workflows/ci.yml` and read each commit's doc impact.
- Re-read the affected living docs against the changed code.
- Re-ran the environment-name extraction (`src/**`, `scripts/**` vs
  `.env.example` and `docs/configuration.md`): no drift beyond the documented
  test-internal and CLI-only names.
- Checked the webhook route table (`POST_PATHS`/`GET_PATHS`), the tool registry
  and `package.json` script names against the docs.
- Resolved relative links and `src/` paths in every living doc after editing.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|---|---|---|---|
| 1 | `docs/error-handling.md` (§Startup validation) | Safe-host rule says plain `http` is accepted "only on a loopback address, except `SEARXNG_URL`/`SEERR_API_URL`/`JELLYFIN_API_URL`". Literal private-network addresses (RFC 1918, IPv6 ULA/link-local, CGNAT `100.64.0.0/10`) are now accepted for credential-bearing endpoints too, and `ALLOW_INSECURE_HTTP_ENDPOINTS=true` widens it to a public address or DNS name. A DNS name is never classified as private, because it can resolve anywhere. | `src/config/env.ts` `validateUrl`; `src/utils/netAddress.ts` `isPrivateHost`; `dcd3536`, `cca101a` | Rewrite the bullet and name the opt-out |
| 2 | `docs/admin-dashboard.md` (login throttle) | Says 5 attempts per 60 s without saying that only **failed** logins are charged, that a success resets the bucket, and that `Retry-After` reports the real remaining window. The old text also implied a correct login could be refused after a few typos. | `src/admin/auth.ts` `LoginThrottle.isAllowed`/`recordFailure`/`reset`/`retryAfterSeconds`; `d9f53ff`, `bb2bf17` | Document the failure-only accounting and the header |
| 3 | `docs/api.md` (Replay and rate limits) | Describes the source and peer token buckets but not the **pre-authentication** per-peer bucket: it runs before the body is read or the secret checked, uses its own limiter (four times the delivery budget), and is skipped for loopback so the documented proxy deployment is unaffected. It answers `429` with `Retry-After`. | `src/webhooks/WebhookServer.ts` `preAuthLimiter`, `handlePost`; `bb2bf17` (I-09) | Add a paragraph |
| 4 | `docs/api.md` (Replay and rate limits) | "the same key becomes the delivery idempotency key" is now true, but the durable key's parts are not stated: the outbox key includes the webhook **source**, so two senders reusing `X-Webhook-Id` on one route both deliver. Before C-04 the second event was answered `202 duplicate` and dropped. | `src/runtime/AppRuntime.ts` `enqueueWebhook` key `['webhook', route, source, eventKey, …]`; `d9f53ff` | State the key parts |
| 5 | `docs/api.md` (Delivery) | Does not say a webhook is rendered once per destination room in **that room's language** (`textVariants` for `en`/`id`; `text` stays the English default). A caller-supplied generic `text` body is treated as already localised and sent unchanged. | `src/webhooks/types.ts` `textVariants`, `WebhookDestination.language`; `src/webhooks/WebhookServer.ts` `dispatch`/`handleGenericWebhook`; `src/webhooks/rooms.ts` `getRoomLanguage`; `1c01c73` | One paragraph, link the localisation doc |
| 6 | `docs/tools.md` (Execution model) | The live `[i/N]` status is described without saying it is rendered in the room language, and `/menu`/`/help` are not said to read `help.tool.*`, `help.param.*` and `help.category.*` keys. A malformed slash command now raises `CommandUsageError` (localised) and is answered with the usage text, not "internal error". | `src/agent/toolProgress.ts` `formatToolAction(..., lang)`; `src/tools/MenuTool.ts`; `src/tools/registry.ts` `CommandUsageError`; `src/agent/index.ts` slash catch; `1c01c73` | Add a localisation bullet and link the doc |
| 7 | `docs/message-context.md` (`language`) | Says only that the agent populates it. It is read from the room row before tools run (`chat_rooms.language`, default `en`) and is what tool output, progress, help and error strings use. Out-of-context senders (reminders, webhooks, digests) must look it up with `getRoomLanguage` because they have no `MessageContext`. | `src/agent/index.ts` (`ctx.language = room.language`); `src/db/roomLanguage.ts`; `1c01c73` | Reword the field description |
| 8 | `docs/services.md` (Reminder delivery) | Does not say the sender is resolved by the **canonical** provider name: a legacy row holding `WhatsApp` matched a target but no sender and was retired after the defer budget. The row's stored `language` is used first, else the room row via `getRoomLanguage`. | `src/utils/Scheduler.ts` `resolveReminderTarget`, sender lookup; `6325b2c` (B-15) | Add two bullets |
| 9 | `docs/services.md` (DigestService) | Does not state that the transcript anonymises human senders (`[HH:MM] Sender: …`, `Bot` for assistant rows) before summarisation. It is a deliberate privacy contract (a digest may be forwarded), not an accident. | `src/utils/DigestService.ts` `fetchRoomTranscript`; `bb2bf17` (T-05) | Add one clause to the service row |
| 10 | `docs/architecture.md` (§7 router) | Describes the circuit breaker but not the half-open probe: a probe held by a streaming request is released in `finally` when the consumer abandons the generator, without recording a failure. Before C-01 one abandoned stream could leave the only provider skipped for the life of the process. | `src/utils/ModelRouter.ts` `acquireProvider`/streaming loop; `a57d658` | Add a bullet |
| 11 | `docs/architecture.md` (§4 prompt assembly) | Says the summary watermark persists; it now also advances inside an immediate transaction and never moves backwards, so overlapping turns (a scheduled run bypasses the per-room queue) cannot re-summarise or un-fold messages. | `src/ai/summaryStore.ts`; `a57d658` (B-05) | One clause |
| 12 | `docs/flows.md` | Says state is "pruned of expired entries"; pruning and expired-session deletion now run under the per-key lock with a re-read inside it, so a flow started during a prune is not clobbered. | `src/core/FlowHandler.ts` `pruneAllExpired`, `getSessionInternal`, `clearSessionInternal`; `06eb755`, `bb2bf17` | One bullet |
| 13 | `docs/scripts.md` / `docs/database.md` | Already correct after maintenance pass 7 (`db:restore` migrates an older snapshot forward; the ledger ignores `created_at`). Verified, no edit. | `7efcb1c` | — |
| 14 | `docs/tools.md` (mutability table, `language` row) | Says `/language` is "admin only". The tool declares `permissions = 'user'`; only a **group** requires `admin` (`ctx.isGroup && !checkPermissions('admin')`), so any participant may change the language in a DM. The registry comment says the same. | `src/tools/LanguageTool.ts` `execute`; `src/tools/registry.ts` note above `MUTABILITY_OVERRIDES` | Correct the note |
| 15 | `docs/scripts.md` (`db:embed`, `push-to-public.sh`) | `db:embed` did not say it skips blank content and empty vectors, which is why one row can no longer fail every run. `push-to-public.sh` now also refuses a dirty tree and a checkout that is not `origin/main`, and pushes the verified commit explicitly. | `scripts/backfillEmbeddings.ts`; `scripts/push-to-public.sh`; `0f7c896`, `bb2bf17` | Update both rows |

## 2. Missing coverage

| # | Gap | Action |
|---|---|---|
| 16 | The localisation system has no page: locales, `t()` fallback, key-parity and placeholder-parity test invariants, every key referenced by source, per-tool `help.tool.*`/`help.param.*`, room-language storage and propagation, `getRoomLanguage` for out-of-context paths, webhook `textVariants`, and `CommandUsageError`. This is the largest undocumented subsystem in the range. | New `docs/i18n.md`; link from `docs/README.md` and cross-reference from tools/api/services/message-context/configuration |
| 17 | `docs/README.md` — no entry for the new page. | Add link |
| 18 | `docs/.agent/project-map.md` — recorded commit `9e16190`; `src/utils/netAddress.ts` and `src/db/roomLanguage.ts` are missing from the map. | Update commit and symbols |
| 19 | `docs/configuration.md` — no statement that reply language is per-room database state, not an environment variable. Readers looking for `LANGUAGE=` find only `{{LANGUAGE}}`. | Add a note near the system-prompt row and link `docs/i18n.md` |

## 3. Structural problems

None. Configuration stays one page plus `.env.example`; routes stay in
`docs/api.md`/`docs/admin-dashboard.md`; timers and delivery in
`docs/services.md`; lifecycle in `docs/architecture.md`. The new localisation
page is the canonical home; other documents link to it instead of repeating it.

## 4. Found while documenting (code observations, not changed)

- `docs/admin-dashboard.md` (carried from the 2026-11-19 pass): an unexpected
  exception in a dashboard action is still mapped to HTTP `400`. A database
  failure arguably deserves `500`; the documented contract is the `{ok:false,
  message}` shape, which is accurate. Left for a decision.
- `docs/services.md` (carried): `OutboxService` re-enqueue keeps
  `MAX(available_at, …)` while resetting `attempt_count`, so a frequently
  re-enqueued row inherits the previous exponential backoff. This is pinned by
  the re-enqueue tests and remains a product decision (pass 7, D-04).
- The pre-auth webhook bucket sizes itself from `WEBHOOK_RATE_LIMIT_MAX * 4`
  (capped at 10,000) but uses the same `WEBHOOK_RATE_LIMIT_MAX_SOURCES` key-count
  cap as the delivery map. The two knobs are independent; the docs now state
  both.
- `src/db/roomLanguage.ts` treats a failure of the SELECT as "unknown language"
  after logging; callers fall back to `en`. That is deliberate (an outbound
  notice must not be dropped for a config read), so it is documented rather than
  flagged.

## Plan

1. `docs/.audit/docs-audit-2026-11-21.md` — this audit.
2. `docs/i18n.md` — new canonical localisation page.
3. `docs/README.md` — index entry.
4. `docs/architecture.md` — half-open probe release, monotonic summary watermark, localisation pointer.
5. `docs/api.md` — pre-auth bucket, source-scoped delivery key, per-room language delivery.
6. `docs/admin-dashboard.md` — failure-only login throttle.
7. `docs/error-handling.md` — private-literal HTTP rule, `ALLOW_INSECURE_HTTP_ENDPOINTS`, `CommandUsageError`.
8. `docs/tools.md` — localised help/progress and usage errors.
9. `docs/services.md` — reminder platform/language lookup, digest anonymisation, webhook language.
10. `docs/message-context.md` — `language` provenance.
11. `docs/flows.md` — pruning under the per-key lock.
12. `docs/configuration.md` — per-room language note.
13. `docs/.agent/project-map.md` — commit and new modules.

Progress:

- [x] Audit written
- [x] `docs/i18n.md`
- [x] `docs/README.md`
- [x] `docs/architecture.md`
- [x] `docs/api.md`
- [x] `docs/admin-dashboard.md`
- [x] `docs/error-handling.md`
- [x] `docs/tools.md`
- [x] `docs/services.md`
- [x] `docs/message-context.md`
- [x] `docs/flows.md`
- [x] `docs/configuration.md`
- [x] `docs/.agent/project-map.md`
- [x] Validation

## Verification (after changes)

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` | clean (`--max-warnings=0`) |
| Typecheck | `bun run typecheck` | clean |
| Schema | `bun run db:check` | "Everything's fine" |
| Tests | `bun test --no-env-file test/` | **1904 pass / 0 fail**, 139 files |
| i18n invariants | `bun test --no-env-file test/i18n.test.ts` | 9 pass / 0 fail (650 `expect()` calls) |
| Relative links | script over every living doc | 0 broken |
| `#anchor` links | script over every heading | 0 broken |
| Code paths (`src/…`, `scripts/…`, `test/…`, `drizzle/…`) | script over every living doc | 0 missing |
| Env coverage | names extracted from `src/**`, `scripts/**` vs `.env.example` + `docs/configuration.md` | no drift; `RETENTION_DRY_RUN` is documented in `docs/database.md` (its canonical home), and only test-internal (`HOME`, `VITEST`, `BUN_TEST`) and the documented CLI overrides (`DB_BACKUP_PATH`, `DB_RESTORE_PATH`) are absent |

Could not verify:

- **Docker build and container smoke**: no Docker daemon here; `docs/deployment.md` and the Compose file were not re-run. No change in this pass touches them.
- **Real provider connections** (WhatsApp QR, Discord gateway, Telegram polling): the test harness throws on network access.
- **Live admin login throttle and webhook pre-auth bucket under a real proxy**: verified by reading `src/admin/auth.ts`/`routes.ts` and `src/webhooks/WebhookServer.ts`, plus the unit tests, not by driving a proxy.

