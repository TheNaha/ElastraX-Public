# Architecture Overview

ElastraX v7 is a multi-platform conversational agent built around a normalized message contract, a queued runtime, and a tool-driven LLM loop. The current architecture is optimized for behavior-preserving changes: risky platform, startup, and permission paths are separated into narrower modules with direct tests.

## Core Principles

1. **Single runtime contract**: Provider adapters normalize incoming events into `MessageContext`, so the agent loop and tools operate against one platform-agnostic shape.
2. **Queued room execution**: Messages are processed through per-room queueing to avoid cross-room interference and to serialize stateful flows safely.
3. **Explicit subsystem boundaries**: Startup orchestration, diagnostics, provider adapters, authorization, configuration, and flow/session state each have a dedicated module boundary.
4. **Fail soft, log hard**: Provider failover, webhook normalization, startup scans, and background maintenance tasks are designed to degrade safely while emitting structured diagnostics.

## Runtime Shape

- `src/index.ts` is the thin process entrypoint. It validates env, initializes the database/session layer, constructs the runtime, and wires shutdown.
- `src/runtime/AppRuntime.ts` owns provider startup, provider-to-queue binding, webhook/scheduler sender registration, background timers, and idempotent shutdown.
- `src/runtime/startupDiagnostics.ts` owns parser coverage scans and fixture dumping. These helpers are intentionally outside the entrypoint so they can be tested directly and disabled or replaced independently.

## Directory Structure

- `src/agent/`
    The conversational loop. It routes direct commands, manages iterative tool execution, and uses `RoleService.getAccessProfile()` when runtime policy decisions need both roles and merged privileges.
- `src/ai/`
    Model client and routing behavior, including provider failover and message sanitization for provider capability differences.
- `src/core/`
    Shared runtime contracts, especially `MessageContext`, plus flow handling and other cross-cutting primitives.
- `src/db/`
    Drizzle + SQLite schema and access layer. Stores chat-room config overrides, conversation history, long-term memory (RAG), reminders, persistent flow sessions, identities, roles, and privilege overrides.
- `src/providers/`
    Platform adapters for WhatsApp and Discord. These modules own SDK lifecycle, message normalization, and outbound provider behavior, but they do not own agent orchestration.
- `src/tools/`
    User-invokable capabilities exposed both as slash commands and LLM tools. Tool-level authorization depends on resolved roles and privileges rather than provider-specific checks.
- `src/utils/`
    Focused services for roles, privileges, configuration, rate limiting, parser coverage, media cleanup, scheduling, and other shared behavior.
- `src/webhookServer.ts`
    External ingress for automation and alerting sources. Payloads are normalized into chat messages through typed adapters and bounded body parsing.

## State Ownership

- `src/utils/SessionManager.ts` owns persisted user flow/session state and recovery behavior.
- `src/core/FlowHandler.ts` consumes `SessionManager.getActiveFlow()` instead of reaching into raw session structure directly.
- `src/utils/RoleService.ts` is the canonical role-resolution boundary.
- `src/utils/PrivilegeService.ts` owns per-role privilege defaults, DB overrides, and merged effective quotas.
- `src/utils/ConfigService.ts` is the single source of truth for resolved per-room configuration.
- `src/utils/permissions.ts` is the WhatsApp-facing bridge that resolves platform-native admin state before handing control to the set-based role model.

## Message Lifecycle

1. A provider receives a raw platform event.
2. The provider normalizes it into `MessageContext` and emits it to `AppRuntime`.
3. `AppRuntime` enqueues the work by room and dispatches it into `handleIncomingMessage()`.
4. The agent decides whether the message is a direct tool invocation or should enter the LLM loop.
5. When conversational handling is needed, the agent loads persisted history, resolves the room config, retrieves and injects long-term memories if enabled, resolves roles/privileges, and calls the model router/client.
6. If the model requests tools, the agent executes them iteratively with bounded execution paths and feeds results back into the model until a final answer is produced.
7. The provider sends the resulting text/media response back to the originating platform.
8. Conversation state, flow state, and other side effects are persisted through their dedicated services.

## Contributor Notes

- New provider behavior should land in provider modules or `AppRuntime`, not in `src/index.ts`.
- New startup-only checks belong in `src/runtime/startupDiagnostics.ts` if they need direct tests or isolated failure handling.
- New permission decisions should prefer `RoleService.getAccessProfile()` over ad hoc role-plus-privilege assembly.
- Tool/config validation should use fixed typed key spaces at the boundary instead of broad `any` argument objects.
