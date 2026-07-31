# Setup & Configuration

This guide explains how to get ElastraX up and running in both development and production environments.

## Prerequisites
- [Bun](https://bun.sh/) (latest version)
- `ffmpeg` (Required for audio/video conversions and stickers)
- `yt-dlp` (Required for the `download_media` tool)
- Docker (optional, for containerized deployments)

## 1. Installation
Clone the repository and install dependencies using Bun:
```bash
git clone https://github.com/thenaha/ElastraX.git
cd ElastraX
bun install
```

## 2. Environment Configuration
Copy the sample environment file:
```bash
cp .env.example .env
```
Open `.env` and configure your settings:

### Bot Ownership
- `BOT_OWNER_JID`: Your WhatsApp JID (e.g., `6281234567890@s.whatsapp.net`). Grants root admin rights.

### AI Configuration (Multi-Provider)
To enable high-availability failover, define multiple providers:
```env
AI_PROVIDERS="modal,gemini"

AI_MODAL_BASE_URL="https://<workspace>--elastra-gpbot.modal.run/v1"
AI_MODAL_API_KEY="dummy"
AI_MODAL_MODEL="cyankiwi/Qwen3"

AI_GEMINI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/"
AI_GEMINI_API_KEY="your_gemini_api_key"
AI_GEMINI_MODEL="gemini-2.5-flash"
```

### Discord Integration (Optional)
If deploying to Discord:
```env
DISCORD_BOT_TOKEN="your_discord_bot_token"
```

## 3. Database Migration
Initialize the SQLite database schema:
```bash
bun run db:push
```

## 4. Running the Bot

### Development Mode
```bash
bun run dev
```

### Production (Native)
```bash
bun run start
```

### Production (Docker)
The provided `docker-compose.yml` ensures all dependencies (FFmpeg, yt-dlp, webpmux) are correctly installed in an Alpine container.
```bash
docker compose up -d --build
```

## 5. Connecting WhatsApp
When starting the bot for the first time without a saved session, a QR code will be printed to the terminal. Scan it using the "Linked Devices" feature in the WhatsApp app on your phone.
