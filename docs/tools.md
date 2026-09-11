# Tools Overview

ElastraX includes a powerful registry of autonomous tools. These tools are exposed to the LLM via OpenAI's function calling API, but can also be manually invoked by users using slash commands (e.g., `/download`).

The tool registry (`src/tools/index.ts`) optimizes LLM context usage by only loading essential tools by default, allowing the AI to use `find_tools` to dynamically load others on demand.

## Utility & Core Tools

| Tool | Alias | Description |
|------|-------|-------------|
| **Web Search** | `/search` | Queries SearXNG (`SEARXNG_URL`) to fetch live search engine results. |
| **Web Scrape** | `/scrape` | Reads and extracts the full markdown text of any URL via Jina AI. |
| **Memory** | `/memory` | Manages persistent user facts (RAG). The LLM automatically curates this based on user interactions. |
| **Translate** | `/translate` | Translates text or quoted messages to specified languages. |
| **PDF Toolkit** | `/pdf` | A massive suite of PDF operations: compress, merge, split, rotate, remove pages, watermark, and convert image-to-PDF. |
| **Reminder** | `/remind` | Schedules cron-like or countdown reminders using a background task queue. |
| **Ping** | `/ping` | Returns exact system latency, uptime, and memory usage. |

## Media Tools

| Tool | Alias | Description |
|------|-------|-------------|
| **Download** | `/dl` | Downloads audio or video from 1000+ sites (YouTube, TikTok, Twitter) via `yt-dlp`. Enforces file size limits dynamically. |
| **Make Sticker** | `/sticker` | Converts attached/quoted images, videos, and GIFs into WhatsApp WebP stickers using `node-webpmux` and `ffmpeg`. |
| **Media Convert** | `/convert` | Converts audio and video formats using `ffmpeg` (e.g., `.ogg` to `.mp3`, or `.mkv` to `.mp4`). |
| **Transcribe** | `/transcribe`| Transcribes Voice Notes and audio files using a configured Whisper endpoint. |

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
| **Game Search** | — | Searches trusted repack sites for PC games (always loaded). |
| **Software Search** | — | Searches trusted sites for desktop software (always loaded). |
| **Reload Plugins** | `/reload` | Owner-only: hot-reloads plugin tools from `src/plugins/`. |
| **Owner Admin** | `/broadcast`, `/leave` | Owner-only: broadcast to all chats / leave a group. |
