## 2025-02-18 - DoS Prevention via Media Size Limit
**Vulnerability:** The application previously downloaded media files (images, videos, documents) of any size into memory as a Buffer, potentially leading to Memory Exhaustion (DoS) if a user sent a very large file.
**Learning:** Always validate input size before processing or buffering, especially for untrusted content like user uploads.
**Prevention:** Implemented a `MAX_MEDIA_SIZE` (200MB) check in `WhatsAppProvider` and `DiscordProvider` before initiating download.

## 2025-02-18 - DoS Prevention via System Prompt Limit
**Vulnerability:** The `ConfigTool` allowed setting an unbounded `systemPrompt`, enabling malicious admins to cause Denial of Service (DoS) or resource exhaustion by setting a massive prompt (e.g., 1GB) that would be loaded on every message.
**Learning:** Always validate the length of user input, even for configuration values that seem internal or administrative.
**Prevention:** Implemented a 5000-character limit for `systemPrompt` in `ConfigTool.ts`.
