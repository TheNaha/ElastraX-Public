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
## 2026-03-06 - Prototype Pollution in Dictionary Lookup
**Vulnerability:** Object dictionary lookup via user-provided keys like `targetFmt` or `firstTokenLower` allowed prototype pollution vulnerabilities (e.g., bypassing validation using `__proto__`).
**Learning:** Direct object indexing for user input validation (e.g., `if (!FORMAT_ARGS[userInput])`) is insecure and can be bypassed or abused if the input matches inherited properties like `__proto__` or `constructor`.
**Prevention:** Use `Object.prototype.hasOwnProperty.call(obj, key)` instead of direct indexing to validate if a key exists safely on a plain object dictionary without triggering prototype chain lookups.

## 2026-03-08 - Argument Injection in FFmpegConverter
**Vulnerability:** `FFmpegConverter` passed user-provided arguments directly to `child_process.spawn()` without checking if they were allowed flags. This allowed Argument Injection vulnerabilities where an attacker could pass arbitrary FFmpeg flags (e.g., to read arbitrary files, overwrite files, or execute commands).
**Learning:** Any user-provided input that is passed as arguments to an external command (like FFmpeg) should be strictly validated against an allowlist of permitted flags and patterns to prevent Argument Injection.
**Prevention:** Implemented an `ALLOWED_FLAGS` set in `FFmpegConverter` and strictly validated that any argument starting with `-` matches either a permitted flag or a valid numeric value before passing it to `spawn`.

## 2025-05-18 - SSRF/LFI Prevention in AIClient via AI_API_BASE_URL
**Vulnerability:** `AIClient` fetched data from the URL defined in `process.env.AI_API_BASE_URL` without validating its protocol. This allowed reading local files (LFI) via `file:///` or probing local services (SSRF) if the admin environment variable was manipulated or exposed.
**Learning:** Similar to `WebSearchTool`, URL parameters provided by environments should be strictly validated for expected protocols (e.g. `http:` or `https:`) before being passed to `fetch()`, even if they are environment configurations.
**Prevention:** Updated `isValidUrl` in `src/ai/client.ts` to enforce `http:` or `https:` protocol checks.

## 2025-05-19 - SSRF/LFI Prevention in Transcription via TRANSCRIBE_ENDPOINT
**Vulnerability:** `requestTranscription` function in `src/utils/transcription.ts` fetched data from the URL defined in the `TRANSCRIBE_ENDPOINT` environment variable without validating its protocol. This allowed reading local files (LFI) via `file:///` or probing local services (SSRF) if the admin environment variable was manipulated or exposed.
**Learning:** URL parameters provided by environments should be strictly validated for expected protocols (e.g. `http:` or `https:`) before being passed to `fetch()`, even if they are environment configurations.
**Prevention:** Updated `requestTranscription` in `src/utils/transcription.ts` to enforce `http:` or `https:` protocol checks on the resolved endpoint.

## 2026-03-10 - SSRF/LFI Prevention in SeerrClient and JellyfinClient
**Vulnerability:** `SeerrClient` and `JellyfinClient` fetched data from the URLs defined in their respective environment variables (`SEERR_API_URL` and `JELLYFIN_API_URL`) without validating the protocol. This allowed reading local files (LFI) via `file:///` or probing local services (SSRF) if the admin environment variable was manipulated or exposed.
**Learning:** URL parameters provided by environments should be strictly validated for expected protocols (e.g. `http:` or `https:`) before being passed to `fetch()`, even if they are environment configurations. This pattern of defense-in-depth must be applied consistently across all HTTP clients wrapping environment URLs.
**Prevention:** Updated `request` in `src/providers/seerr/SeerrClient.ts` and `src/providers/jellyfin/JellyfinClient.ts` to enforce `http:` or `https:` protocol checks on the resolved endpoint.
## 2025-05-20 - Command Injection in spawn
**Vulnerability:** Calls to `child_process.spawn()` did not explicitly disable shell execution. If shell execution was enabled or inferred, user-provided inputs like `url` or `format` could be evaluated by the shell, leading to command injection vulnerabilities.
**Learning:** Always explicitly pass `{ shell: false }` to `spawn` calls when executing external commands with user-provided arguments, ensuring inputs are treated strictly as arguments and not as shell commands.
**Prevention:** Added `{ shell: false }` to `spawn` calls in `DownloadTool.ts` and `FFmpegConverter.ts`.
## 2026-03-12 - SSRF/LFI Prevention in Discord Attachment Fetch
**Vulnerability:** The Discord provider downloaded media by directly passing `attachment.url` to `fetch()` without validating the URL protocol. This permitted Server-Side Request Forgery (SSRF) and Local File Inclusion (LFI) vulnerabilities if the Discord attachment object was manipulated or mocked to contain malicious protocols like `file:///`.
**Learning:** Even URLs provided by seemingly trusted external systems (like the Discord API) must be validated before being passed to `fetch()`. The assumption that external APIs always return standard protocols is unsafe for downstream consumers making HTTP requests.
**Prevention:** Always validate `new URL(url).protocol` to ensure it is `http:` or `https:` before passing any attachment or media URL to `fetch()`.
