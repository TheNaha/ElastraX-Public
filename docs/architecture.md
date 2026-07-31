# Architecture & Design

ElastraX is designed with a domain-driven architecture that completely decouples the messaging platforms (WhatsApp, Discord) from the core conversational logic (the Agent).

## Core Concepts

### 1. The `MessageContext` Interface
The most critical part of the architecture is the `src/core/MessageContext.ts` wrapper. 
Every incoming message from any platform is normalized into a standard `MessageContext` object. This interface exposes platform-agnostic methods like:
- `ctx.reply()`
- `ctx.react()`
- `ctx.sendMedia()`
- `ctx.downloadMedia()`
- `ctx.deleteMessage()`

This guarantees that the core AI agent (`src/agent/index.ts`) does not need to know whether it's talking to WhatsApp or Discord.

### 2. Platform Providers
Platform implementations live in `src/providers/` and implement the `BotProvider` interface:
- **WhatsApp**: Built using Baileys (`src/providers/whatsapp.ts`). Handles socket reconnections, media downloading via buffers, and pairing logic.
- **Discord**: Built using discord.js (`src/providers/discord.ts`). Normalizes Discord guilds/channels and attachments.

### 3. The Agent Loop (`src/agent/index.ts`)
The `handleIncomingMessage` function is the single entry point for all normalized messages. It performs the following pipeline:
1. **Flow Interception**: Checks if the user is in an active interactive flow (e.g. PDF multi-image collection).
2. **Explicit Commands**: Routes slash commands directly to their tool implementations (bypassing the LLM).
3. **Intent / Rule Checking**: Decides if the bot should reply (e.g., ignoring group messages where the bot isn't mentioned).
4. **LLM Inference**: Fetches chat history, builds the context, and invokes the `AIClient`.
5. **Tool Execution Loop**: If the LLM returns tool calls, the agent executes them securely and feeds the result back until a final answer is generated.

### 4. Interactive State Management (`FlowHandler.ts`)
For complex actions that require multiple user steps (like merging 5 PDFs), `FlowHandler` manages state persistence using an in-memory Map backed by SQLite. It gracefully handles session expiration, conflict resolution on hot-reloads, and step-by-step processing.

### 5. Multi-Provider AI Router (`ModelRouter.ts`)
The AI layer features a highly resilient Failover Router:
- Allows configuration of multiple providers (e.g., Modal, Gemini, Ollama, Cloudflare).
- If the primary tier fails (HTTP 5xx, timeout, or rate-limit), the router circuit-breaks and silently falls back to a lower tier without dropping the user's message.
- Providers are instantiated lazily and their health is tracked in `src/utils/HealthMetrics.ts`.

### 6. Storage & Long-Term Memory
- **Database**: SQLite using `better-sqlite3` (or Bun's native SQLite) with Drizzle ORM (`src/db/schema.ts`).
- **Memory (RAG)**: The `MemoryTool` allows the AI to explicitly store facts about users. These facts are queried and injected into the system prompt, providing persistent long-term memory across chat sessions.
