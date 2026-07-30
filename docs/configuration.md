# Configuration Guide

ElastraX v7 relies heavily on environment variables for configuration. This allows for flexible deployments across different environments (local development, production servers, Docker containers).

## Core Application Settings

- `NODE_ENV`: The environment the application is running in (e.g., `development`, `production`).
- `LOG_LEVEL`: The severity level for logging (e.g., `debug`, `info`, `warn`, `error`). Defaults to `info`.
- `PORT`: The port on which the web server (if applicable) listens. Defaults to `3000`.

## AI/LLM Provider Configuration

ElastraX supports two configuration models for AI providers: Legacy Single-Provider and Multi-Provider Failover.

### Multi-Provider Failover (Recommended)

This is the preferred setup for high availability. You define a comma-separated list of providers in order of priority.

- `AI_PROVIDERS`: A comma-separated list of provider identifiers (e.g., `modal,gemini,ollama`). The system will attempt to use the first provider in the list. If it fails, it will fall back to the next, and so on.

#### Provider-Specific Settings

Each provider requires its own set of base URL, API key, and model configuration variables, following a consistent naming convention: `AI_<PROVIDER_NAME>_...`.

**Modal Example:**
- `AI_MODAL_BASE_URL`: The base URL for your Modal deployment (e.g., `https://your-modal-app.modal.run/v1`).
- `AI_MODAL_API_KEY`: Your authentication key for the Modal endpoint.
- `AI_MODAL_MODEL`: The identifier for the specific model deployed on Modal (e.g., `meta-llama/Meta-Llama-3-8B-Instruct`).

**Gemini Example:**
- `AI_GEMINI_BASE_URL`: The OpenAI-compatible endpoint for Gemini (e.g., `https://generativelanguage.googleapis.com/v1beta/openai/`).
- `AI_GEMINI_API_KEY`: Your Google AI Studio API key.
- `AI_GEMINI_MODEL`: The Gemini model to use (e.g., `gemini-2.5-flash`).

**Ollama Example (Local inference):**
- `AI_OLLAMA_BASE_URL`: The local Ollama server address (e.g., `http://localhost:11434/v1`).
- `AI_OLLAMA_API_KEY`: Typically just `ollama` for local setups without auth.
- `AI_OLLAMA_MODEL`: The local model pulled via Ollama (e.g., `llama3`).

### Legacy Single-Provider

This older configuration style is still supported but less robust than the failover method.

- `AI_API_BASE_URL`: The base URL of the primary AI provider.
- `AI_API_KEY`: The API key for the primary provider.
- `AI_MODEL_NAME`: The name of the model to use.

### AI Runtime Behavior

These settings control how the AI interacts during a conversation.

- `AI_MAX_TOKENS`: The maximum number of tokens the model is allowed to generate in a single response (e.g., `2048`).
- `AI_TIMEOUT_MS`: The maximum time, in milliseconds, to wait for an API response before timing out and potentially triggering a failover (e.g., `60000` for 60 seconds).
- `AI_MAX_TOOL_ITERATIONS`: The maximum number of consecutive tool calls the AI can make in a single conversational turn before forcing a final text response (e.g., `8`). This prevents infinite loops.
- `TOOL_LOADING_MODE`: Either `search` (default) or `all`. When set to `search`, it uses "Smart Tool Loading" to save tokens by dynamically loading only relevant tools. When set to `all`, it forces the bot to send all 26+ tool definitions on every request.

### Long-Term Memory (RAG)

In V7.16, ElastraX includes built-in long-term memory. This uses SQLite to seamlessly retrieve past user facts.
- Memory is **enabled** by default for private DMs.
- Memory is **disabled** by default for group chats.
- Note: This is controlled per-room rather than via environment variables. Use `/config set longTermMemory true` in any chat to toggle it dynamically.

## Tool Configurations

Certain tools require their own environment variables to function correctly.

- `SEARXNG_URL`: The URL of your SearXNG instance for the Web Search tool.
- `JINA_API_KEY`: (Optional) A free API key from Jina AI used for the `web_scrape` tool. It prevents rate limiting when extracting clean markdown from webpages.

## Webhook Inbound API

Settings for the webhook server, allowing external services to send messages to chat rooms.

- `WEBHOOK_ENABLED`: Set to `true` to enable the webhook server.
- `WEBHOOK_PORT`: The port the webhook server listens on (e.g., `3500`).
- `WEBHOOK_SECRET`: A shared secret required for authenticating incoming webhook requests.

## Media and File Handling

- `MEDIA_CLEANUP_INTERVAL_MS`: How often the background task runs to clean up cached media files, in milliseconds (e.g., `21600000` for 6 hours).
- `MEDIA_RETENTION_HOURS`: How long media files should be kept before deletion (e.g., `72` hours).

## External Services

- `TRANSCRIBE_ENDPOINT`: URL for an audio transcription service (used for voice notes).
- `TRANSCRIBE_API_KEY`: API key for the transcription service (optional, depending on the service).
- `TRANSCRIBE_TIMEOUT_MS`: Timeout for transcription requests (e.g., `45000` ms).

## Testing and Development

- `FIXTURE_DUMP_DIR`: (Optional) Path to save WhatsApp message fixtures during a graceful shutdown. Useful for building a test suite. Defaults to `./data/fixtures/wa_messages` in production and `./test/fixtures/wa_messages` in development.
