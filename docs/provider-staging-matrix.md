# Provider Staging Matrix

Two layers of provider verification exist, and they are deliberately separate:

1. **Automated, hermetic, credential-free** — `scripts/providerStagingHarness.ts` plus `test/ProviderStagingHarness.test.ts`. It exercises the provider contract with in-memory fakes. It runs in CI, proves nothing about the network, and is not a substitute for a real account.
2. **Manual, real-provider** — this document. Every cell below must be executed by a human against real WhatsApp and Discord accounts, with the recorded evidence attached to the release record.

Nothing in this document may be automated with production credentials, and no cell may be marked passed from the fake harness alone.

## Layer 1: automated harness (no credentials)

```bash
bun run scripts/providerStagingHarness.ts
bun run scripts/providerStagingHarness.ts --json
bun run scripts/providerStagingHarness.ts --only duplicate_event,media_failure
bun test --no-env-file test/ProviderStagingHarness.test.ts
```

The harness reads no environment variable, opens no socket, spawns no subprocess, and touches no database or repository file. It models seven scenarios on both platforms (14 scenario runs):

| Scenario | What the fake proves | Representative checks |
|----------|----------------------|-----------------------|
| `connect` | `start()` reaches `running`, clears `lastError`, and the first delivery reaches the handler | typing presence precedes the reply; one reply envelope; chunk within the platform limit |
| `reconnect` | Close-code policy, backoff growth, and generation bump | `515` schedules a reconnect and enters `backoff`; first delay `1500 ms`, doubling, capped at `300000 ms`; `515` is retryable; `401` never reconnects, is `error`, and is not retryable; readiness is false during backoff; events flow after reconnect |
| `duplicate_event` | At-least-once delivery plus durable suppression | replay of the same `senderId:messageId` is rejected; a new message id is accepted; handler runs once per distinct event; exactly one reply per accepted event |
| `permission` | Role resolution boundaries | group member denied `admin`/`premium`; native group admin granted `admin` but not `owner`; `owner` satisfies every check; direct messages never grant native admin; every peer holds `user` |
| `media_failure` | Lazy bounded media acquisition | rejected download marks the descriptor `error` with a ≤500-character reason; `downloadMedia` throws `OPERATION_FAILED`; lazy `mediaReady` never rejects the turn; oversize media is `skipped` before download and still throws on explicit request; unknown attachment id is `INVALID_TARGET`; acquisition stays `pending` until awaited |
| `long_reply` | Chunking and cancellation | multiple chunks, count matches the platform chunker, no chunk over the limit, concatenation is lossless, mentions on the first chunk only, `AbortSignal` stops the reply before the first chunk and emits nothing |
| `shutdown` | Graceful stop semantics | `stopped` status and `isOperational: false`; in-flight media resolves without rejecting and is recorded as aborted; `reply`, `sendMessage`, `sendTyping` after stop throw `STALE_LIFECYCLE`; a disconnect after stop schedules no reconnect; no envelope escapes; the provider restarts cleanly |

The harness mirrors `WHATSAPP_TEXT_LIMIT` (65 536) and `DISCORD_TEXT_LIMIT` (2 000), the `200 MiB` hard media cap, and the `1500 ms → 300 000 ms` reconnect backoff. `test/ProviderStagingHarness.test.ts` asserts these against the shipping exports of `src/providers/whatsapp.ts` and `src/providers/discord.ts` and compares the fake chunker output with `chunkWhatsAppText` / `chunkDiscordText` for long and multi-line samples, so drift fails the suite rather than silently weakening the model.

## Layer 2: manual real-provider matrix

Record for every cell: date, operator, commit SHA, image digest or `bun.lock` hash, account used, and the evidence artifact. A cell is passed only when the listed evidence exists.

### A. WhatsApp

| ID | Scenario | Procedure | Expected result | Evidence |
|----|----------|-----------|-----------------|----------|
| WA-1 | Pairing and connect | Start the bot with an empty auth store, scan the QR from the primary device | QR rendered, `[WhatsApp] Connected successfully.`, `status: running`, `BOT_OWNER_JID` owner role seeded | Startup log excerpt, `/ready` returning 200, screenshot of the QR scan |
| WA-2 | Reconnect after a 515 | From the paired device, open the same account in another WhatsApp session to force a multi-device restart, then restore the original session | Log shows `connection: close` with status `515`, `[WhatsApp] Scheduling reconnect` at `1500 ms`, status `backoff` then `running` again, **no** QR prompt, `/ready` flips 503 → 200 by itself | Timestamped log slice covering close, backoff, and recovery; two `/ready` samples with timestamps |
| WA-3 | Reconnect is not attempted after 401 | Log out the bot from the paired device (unlink) | Close with `401` logged-out, status `error`, **no** `Scheduling reconnect` line, `/ready` stays 503 until credentials are re-paired | Log slice proving absence of reconnect scheduling; `/ready` 503 sample |
| WA-4 | Duplicate event | Replay one inbound message by re-sending the identical message from the provider history sync, or re-deliver the same stanza while it is being processed | Exactly one reply; the replay logs `Provider event already completed` | Log slice with both deliveries and a single reply; chat transcript |
| WA-5 | Permission boundaries | In a real group, use three accounts: a plain member, a group admin, and `BOT_OWNER_JID`; run an owner-only slash command from each | Member and admin are denied the owner-only command with the standard denial message; owner succeeds; role change is reflected without restart | Chat transcript for all three accounts; `AuthService` role rows for the three identities |
| WA-6 | Media success | Send an image, an audio note, a quoted image, and a document | Each attachment appears once; quoted media is selectable; reply references the correct attachment | Chat transcript plus the `mediaAttachments` descriptor log for each message |
| WA-7 | Media failure | Send an image, then delete/expire it from the provider before the bot downloads it (or interrupt connectivity during the download) | Descriptor `state: error` with a bounded reason; the turn still completes; no unbounded retry; nothing is written to the media directory | Log slice with the descriptor error, the empty media directory listing, chat transcript |
| WA-8 | Oversize media | Send a file larger than the hard cap (200 MiB) or a file the provider reports as larger than the cap | Descriptor `state: skipped` naming the byte cap; the model answers from text without attempting a download; no `/app/data/media` growth | Descriptor log; `du -sh` of the media directory before and after |
| WA-9 | Long reply | Ask for output longer than 65 536 characters | Reply is split into as many messages as needed, none over the limit, in order, with no interleaving from a second request | Chat transcript showing the full sequence plus the chunk-count log |
| WA-10 | Graceful shutdown | `docker compose stop` (30 s grace) while a media download and a reply are in flight | In-flight work finishes or is cancelled with a `ProviderLifecycleError`; no partial or duplicate reply; process exits 0; second start reconnects without a new QR | Container stop log with timestamps, exit code, and the following start log |
| WA-11 | Readiness semantics | While the provider is in `backoff` (after WA-2's close) query `/live`, `/ready`, `/health` | `/live` stays 200, `/ready` returns 503 `not_ready`, `/health` remains a compatibility alias; readiness recovers without a restart | The three HTTP samples with timestamps |
| WA-12 | Post-canary identity | Re-check the owner identity and a group member identity after a restart | Canonical identity resolution is stable; roles persist; no duplicate identity rows | `IdentityService`/`AuthService` row dump before and after the restart |

### B. Discord

| ID | Scenario | Procedure | Expected result | Evidence |
|----|----------|-----------|-----------------|----------|
| DC-1 | Invite and connect | Invite the bot to a scratch guild with the required gateway intents and message-content permission | `Logged in as <tag>`, `status: running`, `/ready` 200 | Startup log and `/ready` sample |
| DC-2 | Gateway reconnect | Block and unblock the bot's network path, or restart the gateway session from the Discord client | Client reconnects; the provider stays `running`; no message loss for events sent after recovery | Log slice with disconnect/reconnect timestamps |
| DC-3 | Duplicate event | Deliver the same message id twice (for example a gateway replay) | One reply; the second delivery is suppressed | Log slice with both deliveries and a single reply |
| DC-4 | Permission boundaries | In the scratch guild use a plain member, a guild administrator, and the configured owner; attempt `/kick` and an owner-only command from each | Member denied; guild admin passes the Discord-native admin check but not owner-only checks; owner succeeds | Chat transcript for all three accounts plus resolved role sets |
| DC-5 | Media success and quoted media | Send an attachment, then reply to a message that has its own attachment | Attachments are described, selected explicitly, and the quoted attachment is addressable | Chat transcript plus descriptor log |
| DC-6 | Media failure | Send an attachment and revoke/expire its CDN URL before download, or interrupt connectivity | Descriptor `error` with a bounded reason; the turn completes; only allow-listed Discord CDN hosts are ever fetched | Descriptor log and a `MEDIA` log line naming the rejected host |
| DC-7 | Oversize media | Send an attachment larger than the hard cap | Descriptor `skipped` naming the byte cap; no download attempted | Descriptor log and media directory size |
| DC-8 | Long reply | Request more than 2 000 characters, including multi-line text | Reply split on line/word boundaries, never over 2 000 characters, order preserved, mentions limited to the first chunk | Chat transcript plus chunk log |
| DC-9 | Typing and mentions | Trigger a reply that mentions a user | Typing indicator appears; allowed mentions are limited to the requested user; no mass pings (`allowedMentions.parse: []` elsewhere) | Chat transcript and the `allowed_mentions` field in the outgoing payload |
| DC-10 | Graceful shutdown | `docker compose stop` during a reply | In-flight reply completes or is cancelled with a lifecycle error; exit 0; restart does not require re-invite | Stop log, exit code, and the following start log |
| DC-11 | Unsupported operations | Call group promote/demote through the Discord adapter | `UNSUPPORTED` error with a clear message; no partial state change | Log slice and the error code surfaced to the caller |
| DC-12 | Not-configured degradation | Start the bot with `DISCORD_BOT_TOKEN` unset or set to the dummy placeholder | Status `not_configured`, warning logged, WhatsApp still serves traffic, `/ready` reflects the remaining provider | Startup log and `/ready` sample |

### C. Cross-cutting

| ID | Scenario | Procedure | Expected result | Evidence |
|----|----------|-----------|-----------------|----------|
| X-1 | Single instance | Start a second instance against the same data volume | The runtime refuses to start; the running instance is unaffected | Second-instance log and the first instance's continued `/live` samples |
| X-2 | Provider isolation | Disable one provider and exercise the other | Traffic flows on the healthy provider; `/ready` 503 only when **no** provider is operational | Traffic transcript and `/ready` samples for both states |
| X-3 | Delivery semantics | Force a send failure after the assistant row is written | The outbox records the failure for retry; no user-visible duplicate | Outbox row dump and the user-visible transcript |
| X-4 | Metrics privacy | Query `/metrics` without and with the token | 404 without a token, 200 with it; no secret or message content in the output | Both HTTP samples and a redacted metric dump |

## Sign-off

The release record must contain, for every cell: the evidence artifact, the operator, and the date. Cells without evidence are `NOT RUN`, never `PASS`. Any `FAIL` blocks the release and is recorded in the same table with the reproduction steps.

This matrix complements — and never replaces — the hermetic suite, the CI gates in [deployment](./deployment.md), and the canary procedure in [canary-runbook.md).
