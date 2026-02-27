# ElastraX v7 — Copilot Instructions

## Project Overview

Multi-platform conversational AI bot (WhatsApp via Baileys v7, Discord) built on **Bun** + **TypeScript**. Uses an agentic tool-calling loop over any OpenAI-compatible LLM endpoint with multi-provider failover.

## Architecture & Message Flow

```
Provider (whatsapp.ts / discord.ts)
  → parseWhatsAppMessage()          # pure parser, side-effect-free
  → createContext() → MessageContext # platform-agnostic interface (src/core/MessageContext.ts)
  → MessageQueue (per-room serial)
    → handleIncomingMessage()        # src/agent/index.ts — the brain
      → Room resolution → Role check → Rate limit
      → FlowHandler (intercept multi-step wizards)
      → Slash-command router (direct tool dispatch, no LLM)
      → LLM conversation loop (iterative tool-calling, max 8 rounds)
```

Key directories: `src/agent/` (orchestration), `src/ai/` (LLM HTTP client), `src/core/` (MessageContext interface, FlowHandler), `src/db/` (Drizzle ORM + SQLite), `src/providers/` (platform bindings), `src/tools/` (agentic tools), `src/utils/` (services).

## Adding a New Tool

1. Create `src/tools/MyTool.ts` extending `BaseTool` from `src/tools/BaseTool.ts`.
2. Implement: `name`, `description`, `aliases` (slash triggers), `category`, `permissions` (`'user'`/`'admin'`/`'owner'`), `definition` getter (OpenAI JSON Schema), `execute(args, ctx)` → returns string for LLM context.
3. Register in `src/tools/index.ts`: import and push `new MyTool()` onto `toolsList`. This auto-wires it into the LLM payload, slash-command router, and `/menu`.

See `src/tools/WebSearchTool.ts` (simple) or `src/tools/ConfigTool.ts` (admin, multi-action) as examples.

## Database

SQLite via Drizzle ORM (`src/db/schema.ts`). WAL mode, file at `./data/bot.db`. Key tables: `chat_rooms` (per-room config), `messages` (conversation log), `reminders`, `user_roles`, `role_privileges`, `user_identities` (LID↔PN mapping), `flow_sessions`.

- Schema changes: edit `src/db/schema.ts` → `bun run db:generate` → `bun run db:push`
- Migrations live in `drizzle/migrations/`

## Config Resolution

Three-level merge via `ConfigService.getResolvedConfig()`: **DB per-room override** → **env var** → **hardcoded default**. Runtime-modifiable with `/config set`. Supported keys: `systemPrompt`, `contextLimit`, `temperature`, `maxTokens`, `allowTools`, `autoReplyAll`.

## RBAC & Permissions

4-tier set-based model: `user` (implicit) → `premium` / `admin` → `owner`. Resolution: env `BOT_OWNER_JID` → DB `user_roles` (via all JIDs from `IdentityService`) → platform-native (WA group admin). Privileges (rate limits, quotas) merge across roles with "most permissive wins" in `PrivilegeService`.

## i18n

Inline dictionary in `src/utils/i18n.ts`. Call `t(locale, 'dot.key', {vars})`. Supported locales: `en`, `id`. Fallback chain: `id → en → raw key`. No external library.

## Commands & Conventions

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run dev` | Watch mode (auto-restart) |
| `bun test test/` | Run all tests |
| `bun test test/foo.test.ts` | Run single test file |
| `bun run lint` | ESLint (TS-ESLint + Prettier config) |
| `bun run db:push` | Apply schema to SQLite |
| `bun run db:generate` | Generate migration SQL |
| `docker compose up --build` | Full containerized run |

## Testing Patterns

- **Runner:** Bun test with preload `test/setup.ts` (sets dummy env vars, stubs `libsignal` for Baileys).
- **Mocking:** `global.fetch` mocks for AI/HTTP. No real connections.
- **Fixtures:** Parser tests use JSON fixtures in `test/fixtures/wa_messages/` (auto-generated from production messages on SIGINT).
- **File naming:** `test/Foo.test.ts`, plus `Foo.edge.test.ts` (edge cases), `Foo.security.test.ts` (security).
- **ESLint:** `@typescript-eslint/no-explicit-any` is warn-only. Unused vars prefixed with `_` are allowed.

## Code Conventions

- **Runtime:** Bun (not Node). Use Bun APIs (`Bun.serve()`, `Bun.file()`, native SQLite).
- **Modules:** ESM only (`"type": "module"`), `ESNext` target, `Bundler` module resolution.
- **MessageContext is an interface**, not a class — providers implement it with closures.
- **`mediaReady: Promise<void>`** must be awaited before accessing `ctx.mediaPath`.
- **WhatsApp LID/PN dual identity:** Always use `IdentityService` for JID resolution; never compare JIDs directly.
- **ModelRouter** is the only entry point for LLM calls — never instantiate `AIClient` directly.
- **FlowHandler** for multi-step wizards: register processor with `FlowHandler.register()`, manage state via `SessionManager`.
