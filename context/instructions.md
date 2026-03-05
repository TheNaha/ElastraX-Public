---
description: ElastraGPBOT-v7 core context and guidelines
---

# Project Overview
ElastraGPBOT-v7 is a hybrid, multi-platform bot (currently focused on WhatsApp via Baileys) running on **Bun** and **TypeScript**. Its primary interface is conversational agentic AI, alongside traditional robust explicit command tools.

## Key Technologies
- **Runtime**: Bun (fast execution and native test runner)
- **Database**: SQLite with Drizzle ORM (`bun:sqlite`)
- **Bot Engine**: `@whiskeysockets/baileys` v7 for WhatsApp
- **AI Backend**: Connects to OpenAI-compliant conversational endpoints (usually a local or serverless GPU deployment via Modal).

## Architecture
- **`src/agent/`**: The core AI conversation loop and routing logic (`index.ts`).
- **`src/ai/`**: Client wrappers pointing to the AI provider handling completions.
- **`src/core/`**: Core interfaces shared across platforms. Contains `MessageContext` which unifies the shape of WhatsApp and Discord payloads, and `FlowHandler` for stateful sessions.
- **`src/db/`**: Schema specifications for Users, ChatRooms, and Messages.
- **`src/providers/`**: Platform-specific implementations (e.g. `whatsapp.ts`) that populate `MessageContext` universally.
- **`src/tools/`**: Contains pure LLM-friendly tools inheriting from `BaseTool`. They fulfill a dual purpose: being usable as explicit slash commands natively, and as function schemas for the LLM.
- **`src/utils/`**: Shared utilities like `StickerUtils`, `FFmpegConverter`, `SessionManager`, and `ParameterValidator`.

## Testing Best Practices
- We use the native `bun:test` framework. No Jest or Vitest required.
- Place all test files in the `test/` directory, suffixed with `.test.ts`.
- When testing tools, you can often mock the `MessageContext`. E.g., for sticker tools, mock `downloadMedia()`.
- Example of running tests: `bun test test/`
