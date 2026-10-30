# Spec Delta

## Purpose

Multi-provider LLM failover router with a per-provider circuit breaker, capability-adaptive request shaping, and tiered provider selection.

## ADDED Requirements

### Requirement: Provider configuration via environment
LLM providers SHALL be declared via `AI_PROVIDERS` (comma-separated names) or the legacy single-provider `AI_API_BASE_URL`; each provider's keys, base URL, model, and media/tool support SHALL be read from per-provider env vars (`AI_<NAME>_*`) falling back to global `AI_*` defaults.

#### Scenario: Two providers configured
- **WHEN** `AI_PROVIDERS=llm,cf` is set
- **THEN** two provider entries are built, each with its own base URL and model

### Requirement: Tiered provider ordering
When a request specifies a tier, providers matching that tier SHALL be tried first; if none match, all providers SHALL be used in configured order.

#### Scenario: Tier preference
- **GIVEN** providers with tiers `gpt` and `llama`
- **WHEN** a request asks for tier `gpt`
- **THEN** the `gpt` provider is attempted before `llama`

### Requirement: Circuit breaker semantics
Each provider SHALL carry a circuit with state `closed` | `open` | `half-open`; after `CIRCUIT_BREAKER_THRESHOLD` (5) consecutive failures the circuit SHALL open and stay open for a jittered cooldown of `AI_PROVIDER_COOLDOWN_MS` (default 30000 ms).

#### Scenario: Circuit opens on repeated failure
- **WHEN** a provider fails 5 consecutive requests
- **THEN** its circuit becomes `open` and subsequent candidates skip it until the cooldown expires

#### Scenario: Half-open single probe
- **WHEN** an open circuit's cooldown has elapsed
- **THEN** exactly one in-flight request is allowed as a half-open probe; concurrent candidates are skipped until the probe settles

### Requirement: Open circuit throws when all unavailable
When every candidate circuit is `open` (within cooldown), the router SHALL throw `AllProvidersOpenError` listing the skipped provider keys.

#### Scenario: All providers open
- **WHEN** all providers are open within cooldown
- **THEN** the call throws AllProvidersOpenError and no request is dispatched

### Requirement: Capability-adaptive shaping
The router SHALL strip or placeholder message parts a provider cannot support: image_url parts dropped to a text note when `supportsImage === false`, missing video/audio when unsupported, and tool calls removed (and their results converted to text) when `supportsTools === false`.

#### Scenario: Tool-less provider
- **GIVEN** a provider with `supportsTools === false`
- **WHEN** the request includes tool calls
- **THEN** tool calls are converted to text notes and the tool result messages are rewritten as plain text

### Requirement: Token ceiling per provider
Resolved `max_tokens` SHALL be capped at the provider's `maxOutputTokens` when that is set; when null, the configured request limit SHALL pass through.

#### Scenario: Cap honored
- **GIVEN** a provider with `maxOutputTokens = 1024` and a requested 4096
- **WHEN** the request is dispatched
- **THEN** the adapter sends max_tokens 1024

### Requirement: Streaming parity
Streaming requests SHALL expose the same circuit-breaker, tiering, and capability-shaping behavior as non-streaming; each chunk's usage SHALL be recorded once.

#### Scenario: Streaming provider fallback
- **WHEN** the streaming primary provider errors mid-stream
- **THEN** the next available provider is attempted and token usage is recorded exactly once per successful stream

### Requirement: Client caching
Each configured provider SHALL be constructed once with a lazily-cached `AIClient`; the cache SHALL be invalidated only on explicit `clearProviderCircuit`.

#### Scenario: Same client reused
- **WHEN** two chat completion calls target the same provider
- **THEN** the same AIClient instance is reused
