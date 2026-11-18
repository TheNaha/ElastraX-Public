# Deferred-item investigation — 2026-11-18 (pass 5 follow-up)

Follow-up to `audit-2026-11-18-pass5.md`. Every item flagged there is investigated here
with evidence, measured impact where measurable, options, a recommendation and an effort
estimate. Nothing here changes code.

Legend: **Effort** S ≈ under an hour, M ≈ a few hours with tests, L ≈ a design change.
**Contract** = changes an external or documented behaviour.

---

## 1. Delivery & durability

### D-02 — The durable inbox never retries a failed turn
**Evidence.** `InboxService.claim` has exactly one caller, the one-shot task in
`AppRuntime.ts` (`queuedHandler`). `fail()` computes a backoff and `attempt_count`
escalation, and `claim()` accepts `state IN ('received','failed')`, but nothing ever runs a
second attempt. `deferUnclaimed` (queue saturated for 2 s) writes `failed` + backoff and
nothing claims it. `recoverStranded` only touches `received`/`processing`; `retention.ts`
deletes terminal rows after 90 days.
**Provider redelivery?** None. Telegram long-polling records the update id before handling and
advances the offset on the next poll regardless of outcome, and the provider swallows handler
errors; Discord gateway events are not replayed and its handler also swallows errors;
WhatsApp acks an inbound stanza when it is received. So a turn that fails after admission is
final. (WhatsApp is the one accidental exception: a decrypt retry re-emits the message,
`admit` accepts a `failed` row as a duplicate, and the turn re-runs.)
**Who sees what.** A pre-reply failure (DB busy, room lookup) still replies
"An internal error occurred" and then rethrows, so the row becomes `failed` and the user
saw an error — lost, but not silent. Only the backpressure path (`deferUnclaimed`) is
silent: the handler never ran, so the user gets nothing; it is logged once.
**Why the obvious fix does not work.** The inbox row stores `payload = '{}'` — it is a dedupe
record, not the message. A drain worker has nothing to replay. Retrying requires persisting
a serialisable snapshot of `MessageContext` (text, ids, flags, media descriptor) plus a
per-provider way to rebuild `reply`/`sendMedia` for a room with no live update object.
**Options.** (a) Leave as at-most-once after admission and say so in the docs; (b) store a
minimal payload and add a per-provider replay façade (L, touches every provider); (c) for
the silent case only, keep the 80×25 ms backpressure retry longer or reply later.
**Recommendation.** (a) for now, plus one small honesty fix: the error reply already exists,
so document that a failed turn must be resent. Revisit (b) only if silent drops show up in
production metrics.
**Effort** S (doc) / L (replay). **Contract** docs only.

### D-08 — A re-enqueued outbox key resets `attempt_count` and `last_error`
**Evidence.** `OutboxService.enqueueText` `ON CONFLICT … DO UPDATE SET … attempt_count = 0,
last_error = NULL WHERE state IN ('pending','failed')`. The only production caller is
`AppRuntime.enqueueWebhook`, whose key contains the sender-supplied `job.eventId ?? …`.
**Impact.** An upstream that retries a webhook while our delivery keeps failing resets the
budget on every retry, so the row never dead-letters and its `last_error` is wiped. It stays
`failed` and visible to the admin retry list, so this is bounded noise, not loss.
The agent's own keys include the provider message id, so they only recur when the same turn
genuinely re-runs; the agent path is fine. `test/MessagingService.test.ts` asserts the reset,
so it is currently intended.
**Interpretation.** Resetting is defensible: the sender is explicitly asking for another
attempt, which is a fresh delivery request, not a retry of our old one. Keeping the counter
would dead-letter a row the sender is actively retrying.
**Options.** (a) keep current semantics and document it; (b) preserve `attempt_count` and
`last_error` only when the row is already `failed`; (c) cap resets (e.g. reset at most N
times).
**Recommendation.** (a). The behaviour matches the caller's intent; the audit's "can never
dead-letter" is accurate but not harmful.
**Effort** S if changed. **Contract** none.

### D-17 — `runToolCalls` / `AI_MAX_PARALLEL_TOOLS` are production-dead
**Evidence.** `grep` for `runToolCalls`/`beginParallelCall` finds only `test/TurnBudget.test.ts`.
The agent passes `maxParallelToolCalls` into `createTurnBudget` (`agent/index.ts:1237`) and
then executes tools sequentially in `executeRequestedToolCalls`; a log line still says
"Parallel Execution". `AI_MAX_PARALLEL_TOOLS` is documented and shown in the admin config
list, so an operator can tune a value that does nothing.
**Impact.** Misleading config; no functional loss (sequential is safer for side-effecting
tools and the per-user mutation lock).
**Options.** (a) delete the method, the limit and the env var; (b) enforce it with
`Promise.all` for read-only tools; (c) keep sequential and relabel.
**Recommendation.** (c) now (remove the "Parallel Execution" comment and mark the env var as
reserved), (a) in a later pass if nobody wants parallel calls. Parallelising changes tool
ordering and concurrency guarantees, so it needs its own design note.
**Effort** S (relabel) / M (delete) / L (parallelise). **Contract** env var if deleted.

### D-18 — Offline `append` backlog is processed with unbounded concurrency
**Evidence.** `whatsapp.ts` `messages.upsert` maps the whole batch with `Promise.all`; each
item calls `createContext` (LID/PN lookups, parsing) and `readMessages` before the handler.
Accepting `append` means a reconnect can deliver a large backlog in one batch.
**What is already bounded.** WhatsApp media is a `createLazyPromise`, so no download starts
here, and `MediaStorage` caps slots/bytes/IO when the agent does await it. Agent turns are
capped by the message queue (`maxRunning`, default 8). So the fan-out is N concurrent
context builds, LID lookups and read receipts — not N downloads or LLM turns. A bad batch
can still spike the DB and the socket.
**Recommendation.** Run the per-message work through a small worker pool (3–8) built on the
existing `CancellableSemaphore`; localised, no new config.
**Effort** S. **Contract** none.

---

## 2. Storage & performance

### D-03 — Retention scans are unindexed; measured
**Evidence.** `retention.ts` compares `CASE WHEN col > 1e11 THEN col ELSE col*1000 END`
against a millisecond cutoff. Tables store different units: `messages.created_at`,
`reminders.created_at`, `flow_sessions.updated_at` are Drizzle `timestamp` (seconds);
`message_inbox`/`message_outbox` `*_at` columns are raw `Date.now()` (ms). The `CASE` blocks
any range search, and `messages`/`reminders` have no index led by `created_at` at all
(`messages_chat_room_id_created_at_idx` and `messages_room_key_created_at_idx` both lead
with another column).

**Measured** (bun:sqlite, same schema/indexes, `DELETE … WHERE rowid IN (SELECT … LIMIT 500)`
loop):

| Scenario (1M rows) | Current | Native units, no new index | Native units + `created_at` index |
|---|---|---|---|
| Mass expiry, 50 % eligible | 22.5 s | 15.1 s | **2.3 s** |
| Routine, 0.1 % eligible | 115 ms | — | **18 ms** |

`EXPLAIN QUERY PLAN` shows `SCAN messages` in both unindexed variants and a range search
with the index. The batch loop has no `ORDER BY`, so each batch re-scans from the start:
cost is `(eligible / 500) × N`. A mass expiry runs at startup and daily on the single
SQLite writer, so it also stalls the outbox timer and provider I/O for its duration.

**Options.** (a) compare in native units only (no schema change, −33 % on mass expiry);
(b) add `messages(created_at)` (and optionally `reminders(created_at)`) — a migration plus a
`REQUIRED_INDEXES` entry, −90 %; (c) also make the inbox/outbox predicates index-friendly
(drop `COALESCE` by choosing one column, or add `(state, updated_at)`), which is a policy
change about which timestamp decides expiry.
**Recommendation.** (a) now and (b) in the same change if a migration is acceptable — the
pair takes mass expiry from 22.5 s to 2.3 s. (c) separately, because it changes what
"terminal since" means.
**Effort** S (a) / M (a+b). **Contract** none (no data change); migration required for (b).

### D-10 — Token series keyed on the server-supplied model string
**Evidence.** `ai/client.ts` normalises `model` from the response body with the configured
name only as a fallback; `ModelRouter` feeds that into
`healthMetrics.recordTokenUsage(model, …)`, which keeps a map entry per distinct string and
`getPrometheusMetrics` emits three series per model.
**Impact.** A server that echoes a per-request string adds a permanent map entry and three
permanent Prometheus series per request. Heap is trivial; the scrape/TSDB cardinality and
`/health` JSON size are the damage. A well-behaved server is stable.
**Options.** (a) key on the configured provider model (stable, loses per-response detail);
(b) cap the map (LRU, e.g. 50 models) and collapse the overflow into `other`; (c) leave.
**Recommendation.** (b). It keeps useful detail and bounds cardinality; the series set
changes only when more than 50 distinct names are seen, which is already a fault.
**Effort** S. **Contract** metrics series in the pathological case.

### D-14 — `clearUserIdentities` and the `MediaService` client cache
**Evidence.** `clearUserIdentities` (test-only; no `src/` caller) deletes `user_identities`
without a platform predicate and never deletes the `canonical_identities` row it resolved.
`MediaService` caches clients by `URL|API_KEY` and never evicts; nothing in `src/` writes
`process.env`, so in production it is effectively write-once, and the key retains the secret
in memory.
**Impact.** `clearUserIdentities`: latent cross-platform deletion + orphan. `MediaService`:
no leak in practice; only a secret held as a map key.
**Recommendation.** Fix `clearUserIdentities` (add the platform predicate and delete the
canonical row; test-only today, so zero runtime risk) and leave the cache, or make it
replace-in-place to also drop the secret from the old key.
**Effort** S. **Contract** none.

---

## 3. Providers & security

### D-04 — Telegram downloads attachments eagerly
**Evidence.** `telegram.ts` `createContext` starts an async IIFE for `downloadToStorage`;
WhatsApp and Discord use `createLazyPromise`. Telegram therefore downloads before the agent
decides to drop the turn (rate limit, slash command, duplicate event), and every download
takes one of four global media slots and part of the 200 MiB global byte budget.
**Impact.** Wasted bandwidth and, for a large video, the whole byte budget held until the
download finishes or times out — stalling media for the other providers.
**Fix sketch.** Wrap the body in `createLazyPromise`; move the `void mediaReady.then(…)`
descriptor reflection *inside* the lazy callback, since reading `.then` would otherwise start
it. Add `if (attachments[0]?.state === 'skipped') return;` so a size-skipped file is not
fetched and then flipped to `'error'`.
**Recommendation.** Do it; it aligns Telegram with the documented contract.
**Effort** S–M. **Contract** none (only when bytes are fetched).

### D-05 — Discord `forwardMessage` buffers every attachment
**Evidence.** `Promise.all` over attachments, each `readBoundedBody` into a `Buffer`, then
`AttachmentBuilder(buffer)`. `HARD_MEDIA_MAX_BYTES` is 200 MiB and Discord allows 10
attachments: up to 2 GiB live, roughly 4 GiB at the `Buffer.concat` peak. The path never
acquires the global media slots/budget, unlike `MediaStorage.saveMediaStream`.
**Recommendation.** Replace `Promise.all` with a sequential loop (peak 200 MiB) as the
minimal fix; routing through `saveMediaResponse` to a file path is better (budgeted, streams
to disk) but larger. Do the loop now.
**Effort** S (loop) / M (budgeted). **Contract** none.

### D-06 — Admin login throttle keys on the TCP peer
**Evidence.** `WebhookServer` passes `server.requestIP(req)?.address` to the admin handler;
`auth.ts` throttles on it; there is no `X-Forwarded-For` handling in the admin path. Behind
the documented reverse proxy every request is `127.0.0.1`, so all clients share one
5-attempt/60 s bucket and an unauthenticated attacker can keep the operator at 429.
The webhook limiter already solves this shape by dropping the `ip:` key on loopback and
limiting per source, but there is no trusted-proxy setting to reuse.
**Options.** (a) add `ADMIN_TRUST_PROXY=true` and read the leftmost `X-Forwarded-For` hop
when the peer is loopback; (b) exempt loopback peers from the throttle entirely; (c) leave
and document "do not expose the admin port through a proxy without auth".
**Recommendation.** (a) — it is the only option that keeps the throttle meaningful. Needs a
new env var, hence a decision.
**Effort** M. **Contract** new env var + throttle semantics.

### D-09 — `TTS_BASE_URL` / `EMBEDDING_API_URL` skip the credential-endpoint policy
**Evidence.** Both send `Authorization: Bearer …`; `BaseHttpClient` only checks the protocol.
`validateEnv` validates the AI base URLs, transcription, SearXNG, Seerr and Jellyfin, but not
these two. `http://public-host` and `https://user:pass@host` are accepted today.
**Caveat.** `docs/configuration.md` documents a "bare host" for `EMBEDDING_API_URL`, which
`new URL()` rejects, so strict validation would newly fail that documented form. `.env.example`
uses `http://localhost:11434/v1`, which the loopback rule still allows.
**Options.** (a) validate with the default policy (https unless loopback, no credentials) and
update the docs to require a scheme; (b) validate only the protocol and the credentials rule,
allowing plain http (keeps LAN self-hosting, leaves the cleartext-key risk); (c) leave.
**Recommendation.** (a), because these endpoints carry a key and the AI base URLs already
behave this way. It can break an existing LAN deployment, so it is your call.
**Effort** S. **Contract** startup validation.

### D-16 — Readiness detail and CSRF double verification
**Evidence.** `handleReadiness` uses `Promise.all`; a probe that *throws* is swallowed by the
outer `catch`, which returns `{status, version, releaseTag}` with no `checks`, so the
diagnostic the endpoint exists for is lost. `verifyCsrf` re-runs `this.verify(cookie)` after
the route already verified the same session.
**Impact.** Readiness: an operator cannot see which dependency failed. CSRF: one extra HMAC +
map lookup per mutating admin request — cheap and idempotent.
**Recommendation.** Fix readiness with `Promise.allSettled` and a `checks` entry per failed
probe (additive; status code unchanged). Pass the verified session into `verifyCsrf` (no
external change). Both safe.
**Effort** S. **Contract** additive JSON field on a 503.

---

## 4. Tools & permissions

### D-07 — The foreign-room "notify" branch is unreachable
**Evidence.** `authorizeNotificationDestination` requires
`ctx.verifyRoomMembership`, which exists only in the tool's own extended interface;
`grep` shows no provider and no `MessageContext` member supplies it. So a foreign `room_id`
always yields `media.foreign_room_not_allowed`, for owners too. The `roomVerified` plumbing
below it is dead. All three providers *could* answer a membership question
(`groupMetadata`, `getChatMember`, `guild.members.fetch`), but only for the current
room/sender today.
**Options.** (a) delete the dead branch and state that foreign rooms are unsupported;
(b) implement `getMember(roomId, userId)` on each provider and wire it.
**Recommendation.** (a) — the branch is provably dead code, and (b) is a new cross-platform
surface for a niche feature. Either way it is your call because it edits a tool's behaviour
description.
**Effort** S (a) / M (b). **Contract** tool behaviour.

### D-11 — Three copies of the authorization predicates
**Evidence.**
- `MenuTool` (help text): enabled, group/dm, platform, roles. Omits binding.
- `FindToolsTool` (names): group/dm, platform, roles. Omits enabled and binding.
- `getAuthorizedTool` (slash): platform, group/dm, alias rules, deny-list, roles. Omits
  enabled, binding and per-action policy (the last is re-applied by
  `executeAuthorizedCommand`).
**Impact.** No hole today — every capability tool re-checks internally
(`MediaLibraryTool`, `MediaRequestTool`, `MediaBindTool`, `SpeakTool`). The risk is one new
tool that forgets.
**Fix sketch.** Build both listing tools from `getToolCatalog({roles, isGroup, isOwner,
platform, hasBinding})`, and add `isToolEnabled`/`requiresBinding` to `getAuthorizedTool`.
**Recommendation.** Do it; it deletes three copies and makes the registry the single source
of truth.
**Effort** S–M. **Contract** menu/find_tools listings become stricter (correctly).

### D-12 — Billable read tools have no cost accounting
**Evidence.** `checkToolAdmission` returns "allowed, cost 0" for any `read` tool.
`TranslateTool.query` has no `maxLength` and takes up to the quoted text; `DigestTool`,
`TranscribeTool` and the two search tools all make upstream calls. The only bound is the
message rate limiter (10/min for `user`, unlimited for `owner`). `GameSearchTool`/
`SoftwareSearchTool` declare `cost = 2`, which is never read because they are `read`.
**Impact.** An ordinary user can trigger 10 paid LLM/STT/search calls a minute with almost no
input bound; an owner is unlimited.
**Options.** (a) add a `billable` flag consulted before the read fast-path; (b) reclassify
those tools as `external-mutation` (gives cost + serialization + scheduled-run denial);
(c) add `maxLength` to translate and leave costs alone.
**Recommendation.** (c) now (cheap, no policy change), (a) as a small registry change with
your agreement on which tools are billable.
**Effort** S (c) / M (a). **Contract** tool admission for reads.

### D-13 — `bun run fixtures:dump` runs the unhardened dumper
**Evidence.** Two implementations. The script (wired to `fixtures:dump`) hardcodes
`./test/fixtures/wa_messages`, ignores `FIXTURE_DUMP_DIR`, reads every row of `messages` on
every platform with no cap, writes mode `0644` (umask-dependent), and lets errors escape.
`startupDiagnostics.dumpFixtures` honours `FIXTURE_DUMP_DIR`, caps rows (500/2000), writes
`0700` dir / `0600` file, and tolerates `EACCES`/`EROFS` — and has no caller outside tests.
**Impact.** Real WhatsApp payloads can be dumped world-readable, unlimited, into the repo.
**Recommendation.** Make the script a thin wrapper over the hardened function (this changes
only the script's output details, which is the point). Treat as safe, but it is a CLI
behaviour change, so listed.
**Effort** S. **Contract** CLI output/permissions.

---

## 5. Infrastructure

### D-15 — Signal handlers are installed after migration
**Evidence.** `bootstrap()` awaits `ensureDatabaseSchema()` (integrity check, drizzle
migrate, fingerprint, lease + heartbeat) and `FlowHandler.initialize()` before
`process.on('SIGINT'|'SIGTERM', …)`. A SIGTERM in that window gets the default disposition:
immediate exit, no `runtime.stop()`, no `closeDatabase()`, no lease release.
**Impact.** In-flight DDL rolls back transactionally, so no half-applied schema; the lease
row lingers until its TTL and the fingerprint path covers "applied but not recorded" next
boot. Nothing else runs that early (no children). So the damage is a stale lease and an
ungraceful exit, not corruption.
**Fix sketch.** Hoist the handler registration above the awaits (guard the database/runtime
references, and re-check `shuttingDown` after each await).
**Recommendation.** Do it; small and removes a class of surprises.
**Effort** S. **Contract** none.

---

## 6. Optional items from the audit

- **O-01** `MessageQueue.processNext` can throw synchronously if the front controller was
  aborted. Only `dropStale` aborts queued entries and it removes them first, and
  `beginStop` returns early, so it is latent. Leave.
- **O-02** Turn "a read tool declaring `cost`" into an assertion test so the field cannot be
  silently inert. Safe. **S.**
- **O-03** Streaming uses one absolute `AbortSignal.timeout`, so a long, healthy answer is
  aborted mid-stream. An idle timeout is the right model but changes what `AI_TIMEOUT_MS`
  means. Needs a decision. **M.**
- **O-04** `ToolProgressTracker.syncMessage` blocks the tool path with one provider round-trip
  per step; debounce as the streaming preview is throttled. Safe, moderate. **M.**

---

## Summary — safe to implement now (no contract change)

| Item | Change | Effort |
|---|---|---|
| D-03a | Compare retention cutoffs in each column's native unit | S |
| D-03b | Migration: index `messages(created_at)` (and `reminders(created_at)`) | M |
| D-04 | Lazy Telegram media download | S–M |
| D-05 | Sequential Discord forward loop | S |
| D-11 | One authorization source (`getToolCatalog`, `isToolAccessible`) | S–M |
| D-14 | Platform-scoped `clearUserIdentities` + canonical delete | S |
| D-15 | Register signal handlers before the awaits | S |
| D-16 | `allSettled` readiness detail + dedupe CSRF verify | S |
| D-18 | Bound the `append` batch concurrency | S |
| D-12c | `maxLength` on `TranslateTool.query` | S |
| O-02 | Assertion test for read tools declaring `cost` | S |

## Needs your decision

| Item | Why it needs you |
|---|---|
| D-02 | Persisting the inbox payload + replay façade is a design change (L) |
| D-06 | New trusted-proxy env var and throttle semantics |
| D-09 | Strict URL validation can fail an existing LAN deployment |
| D-10 | Bounding the model map changes a metrics series in the pathological case |
| D-12a | Which tools count as billable is a product decision |
| D-13 | Changing the fixtures CLI output/permissions |
| D-17 | Deleting `AI_MAX_PARALLEL_TOOLS` (env-var contract) or parallelising tools |
| D-07 | Delete the dead foreign-room branch or implement membership checks |
| O-03 | Redefining `AI_TIMEOUT_MS` as an idle timeout for streams |

---

## Implemented 2026-11-18 (safe batch)

Branch `maint/2026-11-18-pass5-followups`, from `df382d4`.

| Item | What changed |
|---|---|
| D-03b | **Approach revised by measurement.** Keeping the `CASE` and adding `messages(created_at)` / `reminders(created_at)` is both safer (mixed-unit rows still handled) and faster than comparing native units: 1M rows / 500k eligible went from 22.5 s to **1.6 s**, versus 15.1 s for native units without an index. Migration `0026_retention_indexes` (journal `when=27`, seq idx 5); the plan is pinned by a test. |
| D-04 | Telegram media download is lazy; a size-skipped attachment is not fetched. |
| D-05 | Discord forward fetches attachments one at a time (peak one buffer, not ten). |
| D-11 | `tools/access.ts` holds the single predicate; MenuTool, FindToolsTool and `getAuthorizedTool` all apply it; `ctx.hasBinding` publishes the agent's lookup. |
| D-12c | `TranslateTool.query` is capped at 4000 characters. |
| D-14 | `clearUserIdentities` is platform-scoped and deletes the canonical row. |
| D-15 | Signal handlers are installed before the first await; the database is closed only after schema work finishes. |
| D-16 | `/ready` reports a throwing probe via `allSettled`; CSRF is verified once per request (`verifyCsrfFor`). |
| D-18 | `messages.upsert` prepares at most four entries at a time. |
| O-02 | `registry.mutability.test.ts` fails if any read tool declares `cost > 1`; the two inert declarations were removed. |

Not done (still open, as listed above): D-02, D-06, D-07, D-08, D-09, D-10, D-12a, D-13, D-17, O-03, O-04.

### Review follow-ups (2026-11-18, second batch)

An independent reviewer read the batch. Verdict: approve with nits; applied:

1. `TranslateTool` caps the quoted-message fallback at the same 4000 characters,
   not just `args.query`.
2. `getAuthorizedTool` resolves the binding gate lazily, so it can actually fire
   on the slash path (it previously read `ctx.hasBinding` before the agent sets it).
3. `index.ts` keeps only SIGINT/SIGTERM early; the fatal-error handlers stay just
   before the runtime starts, so a stray rejection during import cannot become a
   boot crash-loop. A signal that closed the database before `AppRuntime` starts
   now aborts startup instead of running providers against a closed handle.
4. `messaging-history.set` uses the same concurrency bound as `messages.upsert`.
5. The Discord forward comment now states that finished buffers still accumulate
   until the single send; only the in-flight fetch count is bounded.
6. Journal `0026` drops the non-canonical `idx`; the retention test title says
   "scans the index" (it is a covering-index scan, not a range seek).

Final numbers: **1800 pass / 0 fail** (1799 hermetic), lint/typecheck/`db:check`/
drift green.
