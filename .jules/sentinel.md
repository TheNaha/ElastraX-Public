## 2025-02-18 - DoS Prevention via Media Size Limit
**Vulnerability:** The application previously downloaded media files (images, videos, documents) of any size into memory as a Buffer, potentially leading to Memory Exhaustion (DoS) if a user sent a very large file.
**Learning:** Always validate input size before processing or buffering, especially for untrusted content like user uploads.
**Prevention:** Implemented a `MAX_MEDIA_SIZE` (200MB) check in `WhatsAppProvider` and `DiscordProvider` before initiating download.

## 2025-02-18 - DoS Prevention via System Prompt Limit
**Vulnerability:** The `ConfigTool` allowed setting an unbounded `systemPrompt`, enabling malicious admins to cause Denial of Service (DoS) or resource exhaustion by setting a massive prompt (e.g., 1GB) that would be loaded on every message.
**Learning:** Always validate the length of user input, even for configuration values that seem internal or administrative.
**Prevention:** Implemented a 5000-character limit for `systemPrompt` in `ConfigTool.ts`.

## 2026-03-04 - SSRF/LFI in WebSearchTool via SEARXNG_URL
**Vulnerability:** `WebSearchTool` fetches data from the URL defined in `process.env.SEARXNG_URL` without validating its protocol. This allows reading local files (LFI) via `file:///` or probing local services (SSRF) if the admin environment variable is manipulated or exposed.
**Learning:** URL parameters provided by environments should be strictly validated for expected protocols (e.g. `http:` or `https:`) before being passed to `fetch()`, even if they are environment configurations, as a defense-in-depth measure.
**Prevention:** Always validate `url.protocol` before making an external request using `fetch` to prevent SSRF and LFI vulnerabilities.
