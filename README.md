# ElastraX v7

A multi-platform, general-purpose hybrid bot with conversational AI, built on Bun.

## Features

- **Agentic Framework**: The bot acts as an AI conversational agent first. It can dynamically use tools (like Web Search) to answer your questions.
- **Explicit Commands**: Supports direct commands like `/search` that route directly to the underlying tools without LLM mediation.
- **Multi-Platform Ready**: Designed with a unified `MessageContext` wrapper. Currently supports WhatsApp via Baileys v7.
- **OpenAI Compatible**: Connects to any OpenAI-compatible endpoint. Includes scripts to deploy a private Llama 3 instance on Modal GPUs. Google AI Studio (Gemini) is also natively supported out of the box!
- **State Persistence**: Uses SQLite and Drizzle ORM to maintain chat room conversations for the LLM context.
- **Hot-Reloading Docker**: The `docker-compose.yml` mounts the source code and uses `bun run --watch` allowing for instant development loops.

## Architecture

The project is structured into clear domains:
- `src/agent/`: The core conversational loop and command router.
- `src/ai/`: The OpenAI-compatible client handling `tool_calls`.
- `src/core/`: The unified interface (`MessageContext`) that all platforms must respect.
- `src/db/`: Drizzle ORM schemas and SQLite setup.
- `src/providers/`: The protocol wrappers (e.g., Baileys for WhatsApp).
- `src/tools/`: The agentic tools directory. Each tool implements `BaseTool` exposing a definition for the LLM.
- `modal/`: Python scripts to deploy an inference server to Modal.

## Setup & Running

1. **Install dependencies**:
   ```bash
   bun install
   ```
2. **Setup environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your AI Provider details (e.g. OpenRouter or Gemini) and SearXNG URL.
   ```
3. **Database migrations**:
   ```bash
   bun run db:push
   ```
4. **Run via Docker**:
   ```bash
   docker compose up --build
   ```
5. **Scan QR Code**:
   Check the terminal logs for the WhatsApp QR code on first startup.

## Testing

Run unit tests via `bun`:
```bash
bun test
```
