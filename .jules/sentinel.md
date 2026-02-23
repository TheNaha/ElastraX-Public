## 2025-02-18 - DoS Prevention via Media Size Limit
**Vulnerability:** The application previously downloaded media files (images, videos, documents) of any size into memory as a Buffer, potentially leading to Memory Exhaustion (DoS) if a user sent a very large file.
**Learning:** Always validate input size before processing or buffering, especially for untrusted content like user uploads.
**Prevention:** Implemented a `MAX_MEDIA_SIZE` (50MB) check in `WhatsAppProvider` and `DiscordProvider` before initiating download.
