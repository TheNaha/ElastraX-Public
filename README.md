# ElastraX v7

A multi-platform, general-purpose hybrid bot with conversational AI, built on Bun.

## Features

- **Agentic Framework**: The bot acts as an AI conversational agent first. It can dynamically use tools (like Web Search) to answer your questions.
- **Explicit Commands**: Supports direct commands like `/search` that route directly to the underlying tools without LLM mediation.
- **Multi-Platform Ready**: Designed with a unified `MessageContext` wrapper. Supports WhatsApp (Baileys v7) and Discord.
- **OpenAI Compatible**: Connects to any OpenAI-compatible endpoint. Includes scripts to deploy a private Llama 3 instance on Modal GPUs. Google AI Studio (Gemini) is also natively supported out of the box!
- **State Persistence**: Uses SQLite and Drizzle ORM to maintain chat room conversations for the LLM context.
- **Hybrid UX**: Every capability is available via slash-command and conversational tool-calling.
- **Expanded Tools**: Download (yt-dlp), media converter (FFmpeg), PDF utilities, delete bot messages, translation, reminders, room stats, IDs, ping, and group admin actions.
- **Scheduler/Reminder System**: Persistent reminders stored in DB and delivered by a background scheduler.
- **Voice Note Transcription**: Audio can be transcribed through a configurable endpoint.
- **LLM Failover Router**: Priority-based provider failover (Modal → Gemini → Ollama, etc.).
- **Webhook Inbound Server**: Canonical `/webhook` API plus auto-adapters for GitHub and Grafana payloads.
- **Conversation Summarizer**: Automatically compresses overflowing history into memory summaries.
- **Container Healthcheck**: `/health` endpoint and Docker healthcheck are configured.

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

## Environment Configuration

### 1) LLM Provider Mode

Use either **legacy single-provider** or **multi-provider failover**.

Legacy:
```env
AI_API_BASE_URL=https://...
AI_API_KEY=...
AI_MODEL_NAME=...
```

Failover:
```env
AI_PROVIDERS=modal,gemini,ollama

AI_MODAL_BASE_URL=https://...
AI_MODAL_API_KEY=...
AI_MODAL_MODEL=meta-llama/Meta-Llama-3-8B-Instruct

AI_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
AI_GEMINI_API_KEY=...
AI_GEMINI_MODEL=gemini-2.5-flash

AI_OLLAMA_BASE_URL=http://localhost:11434/v1
AI_OLLAMA_API_KEY=ollama
AI_OLLAMA_MODEL=llama3

# Runtime behavior
AI_MAX_TOKENS=2048
AI_TIMEOUT_MS=60000
AI_MAX_TOOL_ITERATIONS=8
```

### 2) Webhook Inbound API

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=3500
WEBHOOK_SECRET=your_shared_secret
```

Auth behavior:
- Generic sources: send secret via `x-webhook-secret` header, JSON `secret`, or `?secret=` query.
- GitHub webhooks: use `X-Hub-Signature-256` HMAC with `WEBHOOK_SECRET`.

Canonical request format:
```http
POST /webhook
Content-Type: application/json

{
   "room_id": "120363xxxxxx@g.us",
   "text": "Hello from webhook",
   "secret": "your_shared_secret"
}
```

Health endpoint:
```http
GET /health
```

### 3) Voice Transcription

```env
TRANSCRIBE_ENDPOINT=https://your-transcribe-endpoint
TRANSCRIBE_API_KEY=optional
TRANSCRIBE_TIMEOUT_MS=45000
```

### 4) Media Cache Cleanup

```env
# Every 6 hours
MEDIA_CLEANUP_INTERVAL_MS=21600000

# Delete cached media older than 72 hours
MEDIA_RETENTION_HOURS=72
```

### 5) Fixture Dump Path (Optional)

```env
# Used during graceful shutdown to export parser fixtures.
# In production defaults to ./data/fixtures/wa_messages
# In non-production defaults to ./test/fixtures/wa_messages
FIXTURE_DUMP_DIR=./data/fixtures/wa_messages
```

## Testing

Run unit tests via `bun`:
```bash
bun test
```
