# Tools Overview

ElastraX includes a powerful registry of autonomous tools. These tools are exposed to the LLM via OpenAI's function calling API, but can also be manually invoked by users using slash commands (e.g., `/download`).

The tool registry (`src/tools/registry.ts`, re-exported via `src/tools/index.ts`) optimizes LLM context usage by only loading essential tools by default, allowing the AI to use `find_tools` to dynamically load others on demand.

## Utility & Core Tools

| Tool | Alias | Description |
|------|-------|-------------|
| **Web Search** | `/search` | Queries SearXNG (`SEARXNG_URL`) to fetch live search engine results. |
| **Web Scrape** | `/scrape` | Reads and extracts the full markdown text of any URL via Jina AI. URLs are SSRF-validated (internal, loopback, and metadata targets are rejected) and the logged URL is redacted. |
| **Memory** | `/memory` | Manages persistent user facts (RAG). The LLM automatically curates this based on user interactions. |
| **Knowledge** | `/kb` | Room shared document knowledge base: index, search, list, remove attached/quoted documents. Images and scanned PDFs are OCR'd with a vision-capable model when `KB_OCR_ENABLED` is set (default on). |
| **Translate** | `/translate` | Translates text or quoted messages to specified languages. |
| **PDF Toolkit** | `/pdf` | A massive suite of PDF operations: compress, merge, split, rotate, remove pages, watermark, and convert image-to-PDF. |
| **Reminder** | `/remind` | Schedules cron-like or countdown reminders using a background task queue. |
| **Ping** | `/ping` | Returns exact system latency, uptime, and memory usage. |
| **Digest** | `/digest` | On-demand conversation digest for the last N hours (1-168); nightly/weekly digests also run automatically. |

## Media Tools

| Tool | Alias | Description |
|------|-------|-------------|
| **Download** | `/dl` | Downloads audio or video from 1000+ sites (YouTube, TikTok, Twitter) via `yt-dlp`. Enforces file size limits dynamically. |
| **Make Sticker** | `/sticker` | Converts attached/quoted images, videos, and GIFs into WhatsApp WebP stickers using `node-webpmux` and `ffmpeg`. |
| **Media Convert** | `/convert` | Converts audio and video formats using `ffmpeg` (e.g., `.ogg` to `.mp3`, or `.mkv` to `.mp4`). |
| **Transcribe** | `/transcribe`| Transcribes Voice Notes and audio files using a configured Whisper endpoint. |
| **Speak** | `/speak` | Sends a reply as a voice note via text-to-speech (opt-in: registered only when `TTS_API_KEY` is set). |

## Admin & Configuration

| Tool | Alias | Description |
|------|-------|-------------|
| **Group Admin**| `/kick`, etc | Group management actions (kick, promote, demote, settings). Mapped to Discord guild kicks where applicable. |
| **Role** | `/role` | Assigns RBAC privileges (e.g., `admin`, `premium`) to users. |
| **Config** | `/config` | Allows the bot owner to hot-reload system prompts, context limits, and temperature at runtime. |
| **Stats** | `/stats` | Generates SQL-backed analytics for chat room activity (message counts, top users). |

## Integration Tools (Jellyfin / Seerr)
- **Media Bind**: Links the chat room to specific Media Server APIs.
- **Media Search**: Searches Jellyfin for available movies/shows.
- **Media Request**: Submits requests via Overseerr/Jellyseerr.
- **Media Library**: Browse recently added / available library items.

## Misc & Discovery

| Tool | Alias | Description |
|------|-------|-------------|
| **Menu** | `/menu`, `/help` | Lists available commands grouped by category. |
| **Find Tools** | `/findtools` | Asks the LLM to discover and lazily load tools matching a description. |
| **Get ID** | `/id` | Shows the current chat/user JID (useful for wiring webhooks and roles). |
| **Language** | `/language` | Switches reply language (`en`/`id`) per chat. |
| **Delete Message** | `/del` | Deletes a quoted bot message (WhatsApp) or the quoted message (Discord). |
| **Menfess** | `/menfess` | Anonymous confession relay to configured target chats. |
| **Game Search** | — | Searches trusted repack sites for PC games. Opt-in: registered only when `ENABLE_GAME_SEARCH` is set. |
| **Software Search** | — | Searches trusted sites for desktop software. Opt-in: registered only when `ENABLE_SOFTWARE_SEARCH` is set. |
| **Reload Plugins** | `/reload` | Owner-only: hot-reloads plugin tools from `src/plugins/` (opt-in: requires `ENABLE_PLUGIN_RELOAD=true` and `PLUGIN_ALLOWED_PERMISSIONS` including `owner`). |
| **Owner Admin** | `/broadcast`, `/leave` | Owner-only: broadcast to all chats / leave a group. |

## Execution model

- Tools extend `BaseTool` and declare `permissions`, `mutability` (`read`, `local-write`, `external-mutation`, `admin`), `cost`, `aliases`, and optional `triggerPatterns`.
- `TOOL_LOADING_MODE` is `search` (default) or `all`. In `search` mode only always-loaded tools plus triggered ones are sent to the model; the rest are discoverable through `find_tools`.
- Opt-in tools (`GameSearchTool`, `SoftwareSearchTool`, `SpeakTool`) are not registered at all unless their own flag (`ENABLE_GAME_SEARCH`, `ENABLE_SOFTWARE_SEARCH`, `TTS_API_KEY`) is set; their slash command then reads as an unknown command rather than advertising an undeliverable feature.
- Mutating tools pass an admission check: a per-user/per-tool cost budget over 60 s (`TOOL_MUTATION_COST_LIMIT`, default 100) and per-user serialization of mutating calls.
- Plugin tools in `src/plugins/` are loaded only if they export a `pluginManifest` whose permissions cover every tool they export; otherwise the plugin is refused. `ENABLE_PLUGIN_RELOAD=true` plus `PLUGIN_ALLOWED_PERMISSIONS` (including `owner`) enables `/reload`.
- Slash commands bypass the LLM and call the tool directly; model tool calls go through the same authorization and argument validation.
- While a tool (or a batch of tools) runs, the agent posts a live status message and edits it in place, listing each step as `[i/N]` with a running/completed/failed icon (✅/❌) using `BaseTool.describeAction`; the final answer is delivered as a separate message. Platforms without `sendMessage`/`editMessage` support fall back to no progress updates.
