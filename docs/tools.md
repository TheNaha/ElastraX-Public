# Tools Overview

ElastraX includes a powerful registry of autonomous tools. These tools are exposed to the LLM via OpenAI's function calling API, but can also be manually invoked by users using slash commands (e.g., `/download`).

The tool registry (`src/tools/registry.ts`, re-exported via `src/tools/index.ts`) optimizes LLM context usage by only loading essential tools by default, allowing the AI to use `find_tools` to dynamically load others on demand.

## Utility & Core Tools

| Tool | Alias | Description |
|------|-------|-------------|
| **Web Search** | `/search` | Queries SearXNG (`SEARXNG_URL`) to fetch live search engine results. |
| **Web Scrape** | `/scrape` | Reads and extracts the full markdown text of any URL via Jina AI. URLs are SSRF-validated (internal, loopback, and metadata targets are rejected) and the logged URL is redacted. |
| **Memory** | `/memory`, `/mem` | Manages private, consented long-term facts (RAG). Storage needs prior consent (`consent` action); `group` scope requires the `admin` role. Stored facts are inert data and are never treated as instructions. See [Architecture §8](./architecture.md#8-storage--long-term-memory). |
| **Knowledge** | `/kb` | Room shared document knowledge base: index, search, list, remove attached/quoted documents (or remove one entry by `document_id`; omitting the id clears the room). Indexing and removing change shared room state, so they require the `admin` role; search and list are open to any member. Images and scanned PDFs are OCR'd with a vision-capable model when `KB_OCR_ENABLED` is set (default on). |
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
| **Media Convert** | `/convert`, `/cv` | Converts audio and video formats using `ffmpeg` (e.g., `.ogg` to `.mp3`, or `.mkv` to `.mp4`). Optional `resolution` (`720p` or `640x480`), `fps`, `quality` (CRF for video, bitrate such as `128k` for audio) and `preset` (encoder preset) are applied when given. |
| **Transcribe** | `/transcribe`| Transcribes Voice Notes and audio files using a configured Whisper endpoint. |
| **Speak** | `/speak` | Sends a reply as a voice note via text-to-speech (opt-in: registered only when TTS is configured — `TTS_API_KEY`, plus `TTS_VOICE` for ElevenLabs). |

## Admin & Configuration

| Tool | Alias | Description |
|------|-------|-------------|
| **Group Admin**| `/kick`, etc | Group management actions (kick, promote, demote, settings). Mapped to Discord guild kicks where applicable. |
| **Role** | `/role` | Assigns RBAC privileges (e.g., `admin`, `premium`) to users. |
| **Config** | `/config` | Allows the bot owner to hot-reload system prompts, context limits, and temperature at runtime. |
| **Stats** | `/stats` | Generates SQL-backed analytics for chat room activity (message counts, top users). |

## Integration Tools (Jellyfin / Seerr)

| Tool | Alias | Description |
|------|-------|-------------|
| **Media Bind** | `/connect`, `/disconnect`, `/notify` | Links the chat room to specific Media Server APIs. |
| **Media Search** | `/search-media`, `/find` | Searches Jellyfin for available movies/shows. |
| **Media Request** | `/request`, `/request-media` | Submits requests via Overseerr/Jellyseerr. |
| **Media Library** | `/library`, `/watching` | Browse recently added / available library items. |

## Misc & Discovery

| Tool | Alias | Description |
|------|-------|-------------|
| **Menu** | `/menu`, `/help` | Lists available commands grouped by category. |
| **Find Tools** | `/find_tools` | Asks the LLM to discover and lazily load tools matching a description. There is no short alias: `/findtools` does not resolve. |
| **Get ID** | `/id` | Shows the current chat/user JID (useful for wiring webhooks and roles). |
| **Language** | `/language` | Switches reply language (`en`/`id`) per chat. |
| **Delete Message** | `/del` | Deletes a quoted bot message (WhatsApp) or the quoted message (Discord). |
| **Menfess** | `/menfess` | Anonymous confession relay to configured target chats. |
| **Game Search** | `/searchgame`, `/findgame` | Searches trusted repack sites for PC games. Opt-in: registered only when `ENABLE_GAME_SEARCH` is set. |
| **Software Search** | `/searchsoftware`, `/findsoftware` | Searches trusted sites for desktop software. Opt-in: registered only when `ENABLE_SOFTWARE_SEARCH` is set. |
| **Reload Plugins** | `/reload` | Owner-only: reloads the tool registry and re-evaluates plugin files from `src/plugins/` so edited code takes effect (opt-in: requires `ENABLE_PLUGIN_RELOAD=true` and `PLUGIN_ALLOWED_PERMISSIONS` including `owner`). |
| **Owner Admin** | `/owner`, `/broadcast`, `/leave`, `/botleave`, `/pinout` | Owner-only: broadcast to all chats, leave a group, `system_info` (memory/uptime/room count), and `pinout` (log inventory under `LOG_ROOT`). |

## Execution model

- Tools extend `BaseTool` and declare `permissions`, `mutability` (`read`, `local-write`, `external-mutation`, `admin`), `cost`, `aliases`, and optional `triggerPatterns`.
- `TOOL_LOADING_MODE` is `search` (default) or `all`. In `search` mode only always-loaded tools plus triggered ones are sent to the model; the rest are discoverable through `find_tools`.
- Opt-in tools (`GameSearchTool`, `SoftwareSearchTool`, `SpeakTool`) are not registered at all unless their own flag (`ENABLE_GAME_SEARCH`, `ENABLE_SOFTWARE_SEARCH`, `TTS_API_KEY`) is set; their slash command then reads as an unknown command rather than advertising an undeliverable feature.
- Mutating tools pass an admission check: a per-user/per-tool cost budget over 60 s (`TOOL_MUTATION_COST_LIMIT`, default 100) and per-user serialization of mutating calls.
- Plugin tools in `src/plugins/` are loaded only if they export a `pluginManifest` whose permissions cover every tool they export; otherwise the plugin is refused. `ENABLE_PLUGIN_RELOAD=true` plus `PLUGIN_ALLOWED_PERMISSIONS` (including `owner`) enables `/reload`, which re-evaluates edited plugin files.
- Slash commands bypass the LLM and call the tool directly; model tool calls go through the same authorization and argument validation.
- Command arguments are positional, and any declared parameter can be set explicitly with `field=value` (for example `/convert mp3 resolution=720p fps=30`). Only properties the tool actually declares are treated as overrides; an unknown `name=value` stays an ordinary positional argument and fails loudly if nothing accepts it.
- While a tool (or a batch of tools) runs, the agent posts a live status message and edits it in place, listing each step as `[i/N]` with a running/completed/failed icon (⏳/✅/❌) using `BaseTool.describeAction`; the final answer is delivered as a separate message. The rendered status is bounded to 1,800 UTF-16 units, because `editMessage` grows a message by re-editing its head and posting the remainder, so an unbounded status would duplicate its tail on every step. Platforms without `sendMessage`/`editMessage` support fall back to no progress updates.

## Tool metadata reference

Each tool declares `permissions`, `mutability`, `cost`, `aliases`, `triggerPatterns`, `alwaysLoad`, `requiresBinding`, `platforms`, `groupOnly`, `dmOnly`, and `enabled`. The registry derives mutating tool names from its own table (`mutatingToolNames()`) so the deny-list never rots.

Mutating (non-`read`) tools and their overrides (`src/tools/registry.ts`, `MUTABILITY_OVERRIDES`):

| Tool | Mutability | Notes |
|---|---|---|
| `owner_admin` | `admin` | `/owner`, `/broadcast`, `/leave`, `/botleave`, `/pinout` — owner only; `leave`/`botleave` are group-only. |
| `config` | `admin` | `/config set`/`reset` — admin only. |
| `language` | `local-write` | `/language set`/`reset` — admin only. |
| `reminder` | `local-write` | `/remind` — local state write. |
| `delete_message` | `external-mutation` | `/del` — deletes provider messages. |
| `download_media` | `external-mutation` | `/dl` — writes files to disk. |
| `convert_media` | `local-write` | `/convert` — writes converted files. |
| `groupadmin` | `external-mutation` | `/kick`, `/promote`, etc. — mutates provider group state. |
| `knowledge` | `local-write` | `/kb` — persists room documents. |
| `memory` | `local-write` | `/memory` — writes long-term user/room facts. |
| `role` | `admin` | `/role grant`/`revoke`/`setpriv` — changes role grants and privilege overrides. |
| `media_account` | `external-mutation` | `/connect` — links media-service accounts. |
| `media_request` | `external-mutation` | `/request` — submits Seerr/Jellyfin requests. |
| `menfess` | `external-mutation` | `/menfess` — relays messages to targets. |
| `pdf_tool` | `local-write` | `/pdf` — writes merged/converted PDFs. |
| `speak` | `external-mutation` | `/speak` — TTS, writes audio. |

All other built-in tools default to `read` mutability unless their own `metadata.access.mutability` overrides it.

### Downloaded video compatibility

`download_media` (and `/download`) prefers H.264/AAC streams and, after the download, probes the file with `ffprobe`. Any MP4 that is not already H.264 + `yuv420p` + AAC with even dimensions and a longest edge of at most 1920 (AV1/VP9 in an MP4 container is common on YouTube) is transcoded with `ffmpeg` to that profile before it is sent. WhatsApp's desktop and web clients play AV1/VP9, but the phone players reject those files with "something is wrong with the video file". The `yt-dlp --recode-video mp4` flag is not enough on its own: it only converts when the *container* differs, so an AV1 stream inside an MP4 is left untouched.


### Opt-in tools

| Tool | Flag | Registered when |
|---|---|---|
| `GameSearchTool` | `ENABLE_GAME_SEARCH=true` | `true` |
| `SoftwareSearchTool` | `ENABLE_SOFTWARE_SEARCH=true` | `true` |
| `SpeakTool` | `TTS_API_KEY` set | key present (`isTtsConfigured`: key + base URL, plus `TTS_VOICE` for ElevenLabs) |

Unset → tool absent from `/menu`, absent from the model's tool list, and its slash command reads as "unknown command".

### Binding-gated tools

Media tools (`media_search`, `media_request`, `media_library`) declare `requiresBinding`. One predicate decides visibility everywhere — `isToolAccessible` in `src/tools/access.ts`, which the registry, `/menu`, `/find_tools` and the slash listing all call — so an unbound user is never shown a tool the agent would refuse. The agent resolves the sender's binding (`ServiceBindingService`, via `resolveSenderHasBinding` in `src/utils/toolAccess.ts`) only when a binding-gated tool is registered, and publishes it as `ctx.hasBinding`; `/menu` and `/find_tools` run before that on the slash path, so they fall back to the same lookup when the flag is absent. A failed binding read is treated as "unbound": a database problem hides the media tools rather than exposing them.

### Per-tool parameters

Each tool's JSON Schema parameter definition lives in its own file under `src/tools/` (the `definition` getter on `BaseTool`). Parameters are validated server-side by `validateToolArguments` regardless of what the model is told; `additionalProperties` is closed to prevent injection. Inspect live definitions via `/find_tools` or the admin dashboard Tools view.
