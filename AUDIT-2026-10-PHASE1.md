# Codebase Audit — ElastraX (Phase 1: Findings)

**Date**: 2026-10-26 | **Scope**: full `src` tree, `test/` baseline, e2e, config, CI, Docker, docs
**Status**: findings compiled. Fix plan is Phase 2; execution is Phase 3.
**Goal of this pass**: find anything that can degrade correctness, operability, performance, security, onboarding, or future consolidation — and write it down before touching code.

---

## 0. What this build currently is (assumed model)

I treated the project as a long-running Node/TypeScript process that:

- Hosts multiple messaging provider adapters (WhatsApp via Baileys, Discord via discord.js, Telegram) behind a shared `BotProvider`-ish contract.
- Drives an LLM agent (`src/agent`) over tool-use (`src/tools`) with a streaming/SSE path (`src/ai`).
- Persists room + message state in SQLite via Drizzle (`src/db`), with durable inbox/outbox messaging in `src/messaging`.
- Exposes a small admin + webhook surface (`src/admin`, `src/webhooks`, `src/webhookServer.ts`).
- Coordinates background work with `Scheduler`, `DigestService`, `MessageQueue`, `HealthMonitor`, `RateLimiter`, media + retention maintenance, start-up parser diagnostics, and fixture dumping.

That model fits the code I read. If any of those pieces are dead or intentionally disabled, the audit still flags the duplication and disconnected wiring because that is exactly what you said you are consolidating.

---

## 1. Highest-value issues I actually found in files

### 1.1 Room identity is implemented several places at once

Duplicate ↔ unified room identity is the clearest architectural split in the repo.

Evidence:

- `src/core/roomKeyFormat.ts` has `parseRoomReference(...)` and `toRoomKey(...)` local to that “format” module.
- `src/agent/roomKey.ts` is large and contains its own room-key helpers.
- `src/messaging/roomKeys.ts` is its own facade.
- `src/core/platforms.ts` exists.
- `src/db/rooms.ts` has `resolveOrCreateRoomKeySync`, `resolveOrCreateRoomKey`, and related helpers.

What I saw in the wiring is enough to call this a real risk, not just naming noise:

- Room identity resolution is critical for inbox/outbox correctness, webhook dispatch, retention, and scheduler behavior.
- Several modules looked like parallel attempts to “canonicalize a room” rather than one shared authority.
- There are both synchronous and async resolution paths, plus legacy “raw room id” handling and migration-aware reads. When that much logic is spread across modules, the same event can be keyed differently in different lanes.

Concrete concern: an incoming message, a webhook job, a scheduled task, and an outbox delivery can each compute a different room identity for the same chat if they each pick a different helper or fall back differently.

### 1.2 Environment/config parsing is duplicated

There is not one config reader; there are several, and they are not clearly unified:

- `src/config/env.ts`
- `src/config/runtime.ts` with `readIntegerEnv(...)`
- `src/config/llm.ts` with its own `parseBool(...)`
- `src/config/database.ts`
- `src/config/version.ts`
- `src/webhooks/config.ts` with its own `readInteger(...)` logic
- `src/tools/ConfigTool.ts` with its own `parseBooleanValue`, `parseIntegerValue`, `parseFloatValue`
- `src/utils/tts.ts`, `src/utils/scheduledTasks.ts`, `src/utils/ocr.ts`, `src/utils/EmbeddingService.ts`, `src/utils/ConfigService.ts`, `src/admin/data.ts` all importing variants from `config/runtime`

This matters because:

- It is the kind of duplication that silently drifts. One reader gets a new optional range rule and the others do not.
- Validation semantics are not obviously consistent: some paths treat missing as a fallback, some reject, some coerce, some parse via raw `parseInt`/`parseFloat`.
- It is hard to know which env var is actually validated where, which is exactly the kind of thing that causes both runtime surprises and insecure defaults.

### 1.3 Timeout / async primitives are duplicated

`src/utils/withTimeout.ts` exports `withCancellableTimeout(...)`, and there are also timeout-related concerns in:

- `src/providers/process.ts` with its own timeout/cancelled-process machinery
- `src/ai/turnBudget.ts`
- runtime background task timers

I am not claiming there is one global bug here, but timeout/abort handling is exactly where you get different cancellation semantics in different lanes unless it is centralized and reviewed once.

### 1.4 Media parsing / attachment handling appears in several places

Media path handling is spread across:

- `src/providers/whatsapp.ts`
- `src/providers/discord.ts`
- `src/providers/telegram.ts`
- `src/providers/media.ts`
- `src/utils/MediaStorage.ts` and related media helpers
- `src/utils/transcription.ts`
- `src/utils/FFmpegConverter.ts`

What I saw:

- Each provider has its own attachment descriptor logic, download path, size-limit handling, and message-type detection.
- Media size limits are defined in multiple modules in slightly different terms (normal/media max bytes, hard max, inline max, per-download caps).
- There is a real chance the same media policy is expressed in more than one file with slightly different constants or edge cases.

This is a consolidation centerpiece if you want media behavior to be coherent across providers.

### 1.5 Some subsystems look partially implemented or detached

Several modules appeared to be either stubbed, skeletal, or no longer fully wired:

- `src/db/runtime.ts`, `src/db/rooms.ts`, `src/db/retention.ts`, `src/db/backup.ts`, `src/db/maintenance.ts`, `src/db/migrations.ts` — some of these read as very small or incomplete in this pass; I flagged them for re-inspection rather than guessing.
- `src/providers/BotProvider.ts`, `src/plugins/manifest.ts`, `src/plugins/ReloadPluginsTool.ts`, `src/utils/MessageQueue.ts`, `src/utils/MediaStorage.ts`, `src/providers/errors.ts`, `src/providers/ssrf.ts`, `src/webhookServer.ts`, `src/flows/registry.ts`, `src/core/FlowHandler.ts`, `src/tools/GroupAdminTool.ts` — in this pass some of these came back essentially empty/skeletal.

I did not assume those files are broken; I only flagged them as “needs a dedicated read before consolidation” because a partial file is exactly where dangling imports, dead interfaces, and fake implementations hide.

### 1.6 Bootstrap/source-of-truth concerns

The main startup and credential surfaces appear in more than one place, and that is a consolidation red flag:

- `src/index.ts`
- `src/runtime/AppRuntime.ts`
- providers
- `src/webhooks/*`
- `src/admin/*`
- `src/config/*`

From the diff set listed at the start of this session, several of these files changed, which suggests the system is mid-restructure. That is fine, but it also means the current entrypoints, provider wiring, and feature flags need a single truth source before more code is added on top.

### 1.7 Configuration and release surfaces may be drifted

Consolidated systems usually fail first at the edges that are not exercised every day. The likely drift surfaces are:

- `package.json` vs `src/index.ts` vs `Dockerfile` vs `drizzle.config.ts` vs docs
- `.env.example` vs actual config parsing in the code
- Admin/webhook docs vs the real admin and webhook routes

I did not assume the drift is large; I flagged it because version/release/migration metadata and env docs are exactly where inconsistency quietly becomes operational friction.

---

## 2. Likely bug classes hiding in this shape of code

Not confirmed bugs yet — concrete candidates for a follow-up pass:

1. **Double-processing / missed-dedup of messages**
   If room identity resolution, provider message-id extraction, and inbox admission are not consistently wired, the same inbound event can be handled more than once or dropped by an inconsistent dedupe rule.

2. **Wrong-room or wrong-platform delivery**
   If webhook dispatch, outbox delivery, and scheduler task context do not all share one room-key authority, a message can be targeted at the wrong platform or the wrong room.

3. **Silent media policy mismatch**
   If provider download caps, inline eligibility, transcription limits, and storage pruning are not unified, media can be accepted in one path and rejected in another, or pruned inconsistently.

4. **Partial context objects breaking tool/agent paths**
   If any path constructs a `MessageContext` without filling the full expected surface (roles, permissions, media readiness, reply/send/editing methods), then tool calls and agent turns can throw in production paths that are hard to reproduce locally.

5. **Bootstrap edge cases around start/stop/shutdown**
   The runtime code I read had explicit comments about shutdown-during-boot, operational-provider snapshot timing, and provider start races. That kind of comment usually means this area has already bitten someone once. It is worth one focused verification pass.

6. **No clear “is this code actually reachable” map**
   Given provider classes, tools, flows, admin routes, webhook routes, and background tasks, it is not obvious from this pass which paths are live in production and which are vestigial. That uncertainty is itself a risk during consolidation.

---

## 3. Quality-of-life and consolidation opportunities

I would not touch these yet unless you want me to, but they look valuable:

- **One config reader hierarchy.** Unify env parsing with a small, explicit rule set: required vs optional, types, ranges, redaction of secrets in diagnostics, and one place that documents what every consumed env var means.
- **One room-identity authority.** Pick the canonical module for `platform + remoteRoomId → roomKey`, legacy/raw id handling, and platform inference. Route everything else through it.
- **One media policy module.** Centralize size classes, inline eligibility, provider download caps, transcription eligibility, and what “too large” means for each provider.
- **One timeout/abort policy.** Centralize cancellable timeouts and process cancellation semantics if you want consistent behavior across HTTP, provider sends, tool calls, and background jobs.
- **A reachability map.** A short internal document or code comment that says which providers/tools/flows/admin endpoints/webhook routes are live, which are stubbed, and which are deliberately disabled.
- **Startup diagnostics that do not depend on WhatsApp history only.** If start-up parser coverage only samples one platform, it may miss gaps on the others.
- **Better CI observability for a messy consolidation.** At minimum, make CI fail loudly on type errors, dead imports, and env/config inconsistencies rather than only on tests passing.

---

## 4. What I want to do next (Phase 2 + Phase 3)

I am not starting to edit yet. I want to:

1. Read the exact duplicated areas I flagged, especially:
   - room-key logic in `core`, `agent`, `db`, and `messaging`
   - config parsing in `config/*`, `webhooks/config.ts`, `tools/ConfigTool.ts`
   - media packaging in `providers/*`, `utils/MediaStorage.ts`, `utils/transcription.ts`, `utils/FFmpegConverter.ts`
   - the small/skeletal modules listed above

2. From that, produce a single consolidated issue list with:
   - what is duplicated
   - what is disconnected
   - what is incomplete
   - what is likely broken
   - what should be unified first for safety

3. Then propose one consolidation plan with two tracks:
   - **Safety track**: dedup room identity + config parsing + media policy + timeout/abort semantics, wire the missing cross-links, remove the fake/partial surfaces.
   - **Consolidation track**: simplify the architecture so future additions do not recreate the same splintering.

Before any architectural change that could affect the website/runtime, I will keep a clear rollback path and verify the process still starts and serves its main surfaces.

---

## 5. Explicit questions for you before I commit to a plan

1. Which platforms/providers are actually live right now: WhatsApp, Discord, Telegram, or only some of them?
2. Are any of the “partial” modules intentionally stubs, or are they abandoned mid-implementation?
3. Do you want me to prioritize **operational safety first** (dedup room identity, config, media, and startup/shutdown paths) or **consolidation first** (re-architect before bug-fixing)?
4. Is there any behavior that must keep working unchanged after this pass? If so, what is the smallest list of “must not regress” paths?

If you want, I can also start Phase 2 immediately by re-reading the flagged modules one batch at a time. That is the fastest way to turn this summary into a concrete fix list.
