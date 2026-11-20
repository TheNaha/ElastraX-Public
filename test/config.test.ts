import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { logger } from "../src/utils/logger";

const { validateEnv } = await import("../src/config/env");

const mockLoggerError = mock(() => {});
const originalError = logger.error;

const baseValidEnv = {
  AI_API_KEY: "secret-key",
  AI_MODEL_NAME: "model-name",
  AI_API_BASE_URL: "https://api.example.com",
};

describe("Config Validation", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
    logger.error = mockLoggerError;
  });

  afterEach(() => {
    logger.error = originalError;
  });

  test("should pass with valid environment variables", () => {
    expect(() => validateEnv({ ...baseValidEnv })).not.toThrow();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  test("should throw if AI_API_KEY is missing for a non-loopback endpoint", () => {
    const invalidEnv = {
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_KEY is required for non-loopback single-provider endpoints");
  });

  test("should allow a loopback endpoint without an API key", () => {
    expect(() => validateEnv({
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "http://127.0.0.1:8000/v1",
    })).not.toThrow();
  });

  test("rejects an invalid global AI capability flag at startup", () => {
    // ModelRouter's envBoolean throws on anything but true/false, and it runs on
    // the first chat call, so a typo used to break every message instead of
    // failing startup once.
    expect(() => validateEnv({
      ...baseValidEnv,
      AI_SUPPORTS_IMAGE: "yes",
    })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('AI_SUPPORTS_IMAGE must be either "true" or "false"');
  });

  test("rejects an unsupported AI_MAX_TOKENS_PARAM", () => {
    expect(() => validateEnv({
      ...baseValidEnv,
      AI_MAX_TOKENS_PARAM: "max_new_tokens",
    })).toThrow("Environment validation failed");
  });

  test("should throw if AI_MODEL_NAME is missing", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_API_BASE_URL: "https://api.example.com",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MODEL_NAME is required in single-provider mode");
  });

  test("should throw if AI_API_BASE_URL is missing", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL is required");
  });

  test("should throw if AI_API_BASE_URL is invalid", () => {
    const invalidEnv = {
      ...baseValidEnv,
      AI_API_BASE_URL: "not-a-url",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL must be a valid URL");
  });

  test("should throw if AI_API_BASE_URL uses an invalid protocol", () => {
    const invalidEnv = {
      ...baseValidEnv,
      AI_API_BASE_URL: "file:///etc/passwd",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL must use http or https");
  });

  test("still requires an API key for a plain-http remote AI endpoint", () => {
    expect(() => validateEnv({
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "http://api.example.com",
    })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_KEY is required for non-loopback single-provider endpoints");
  });

  test("should throw if AI_API_BASE_URL embeds credentials", () => {
    const invalidEnv = {
      ...baseValidEnv,
      AI_API_BASE_URL: "https://user:pass@api.example.com",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL must not contain credentials");
  });

  test("should throw if AI_API_BASE_URL is empty string (only spaces)", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "   ",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL is required");
    // Ensure we don't get the "invalid URL" error as well
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  test("should throw if AI_TOOL_TIMEOUT_MS is out of range", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_TOOL_TIMEOUT_MS: "0" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_TOOL_TIMEOUT_MS must be an integer between 1000 and 600000");
  });

  test("should throw if AI_TIMEOUT_MS is out of range", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_TIMEOUT_MS: "10" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_TIMEOUT_MS must be an integer between 1000 and 600000");
  });

  test("should throw if AI_PROVIDER_COOLDOWN_MS is out of range", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_PROVIDER_COOLDOWN_MS: "-5" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_PROVIDER_COOLDOWN_MS must be an integer between 1000 and 3600000");
  });

  test("should throw if AI_MAX_TOKENS is not a positive integer", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_MAX_TOKENS: "zero" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MAX_TOKENS must be an integer between 1 and 1000000");
  });

  test("should throw if AI_MAX_TOOL_ITERATIONS exceeds the hard cap", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_MAX_TOOL_ITERATIONS: "50" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MAX_TOOL_ITERATIONS must be an integer between 1 and 20");
  });

  test("should throw if AI_TEMPERATURE is outside the valid range", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_TEMPERATURE: "2.5" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_TEMPERATURE must be a number between 0 and 2");
  });

  test("should throw if AUTO_REPLY_ALL is not a boolean string", () => {
    expect(() => validateEnv({ ...baseValidEnv, AUTO_REPLY_ALL: "1" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('AUTO_REPLY_ALL must be either "true" or "false"');
  });

  test("should throw if WEBHOOK_PORT is outside the valid range", () => {
    expect(() => validateEnv({ ...baseValidEnv, WEBHOOK_PORT: "70000" })).toThrow("Environment validation failed");
    // Port 0 is legal: it binds an ephemeral port, which `parseWebhookConfig`
    // already accepted and which the project's own CI webhook smoke test uses.
    // This validator was the only thing rejecting it.
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_PORT must be an integer between 0 and 65535");
  });

  test("accepts WEBHOOK_PORT=0 for an ephemeral port", () => {
    expect(() => validateEnv({ ...baseValidEnv, WEBHOOK_PORT: "0" })).not.toThrow();
  });

  test("should throw if WEBHOOK_MAX_BODY_BYTES is not a positive integer", () => {
    expect(() => validateEnv({ ...baseValidEnv, WEBHOOK_MAX_BODY_BYTES: "NaN" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_MAX_BODY_BYTES must be an integer between 1024 and 10485760");
  });

  test("should throw if TRANSCRIBE_ENDPOINT is not a valid URL", () => {
    expect(() => validateEnv({ ...baseValidEnv, TRANSCRIBE_ENDPOINT: "not-a-url" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("TRANSCRIBE_ENDPOINT must be a valid URL");
  });

  test("should throw when a webhook secret is too weak", () => {
    expect(() => validateEnv({ ...baseValidEnv, WEBHOOK_SECRET: "short" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_SECRET must contain at least 24 bytes of entropy");
  });

  test("should accept a sufficiently long webhook secret", () => {
    expect(() => validateEnv({ ...baseValidEnv, WEBHOOK_SECRET: "a".repeat(32) })).not.toThrow();
  });

  test("should reject a plain-http AI base URL that is not loopback", () => {
    // A typo like http://api.openai.com/v1 would otherwise send the API key in
    // cleartext; only loopback http is allowed for credential-bearing endpoints.
    expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: "http://api.openai.com/v1" }))
      .toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL must use https unless it points to a loopback or private-network address (set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)");
  });

  test("should accept a loopback plain-http AI base URL", () => {
    expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: "http://127.0.0.1:8000/v1" })).not.toThrow();
    expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: "http://localhost:8000/v1" })).not.toThrow();
  });

  test("should reject a plain-http transcription endpoint that is not loopback", () => {
    expect(() => validateEnv({ ...baseValidEnv, TRANSCRIBE_ENDPOINT: "http://whisper.lan:9000/transcribe" }))
      .toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("TRANSCRIBE_ENDPOINT must use https unless it points to a loopback or private-network address (set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)");
  });

  test("should accept a literal private-network plain-http AI base URL", () => {
    // A self-hosted inference box on the LAN has no certificate and is not
    // internet-reachable. Classifying a *literal* address is exact, so this
    // needs no operator opt-out.
    for (const base of [
      "http://192.168.1.10:8080/v1",
      "http://10.4.0.9:8000/v1",
      "http://172.20.5.5/v1",
      "http://100.64.0.9:8080/v1", // CGNAT / Tailscale
      "http://[fd00::5]:8080/v1", // IPv6 ULA
    ]) {
      expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: base })).not.toThrow();
    }
  });

  test("warns that a private-network plain-http endpoint sends its key in cleartext", () => {
    const warn = mock(() => {});
    const originalWarn = logger.warn;
    logger.warn = warn;
    try {
      expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: "http://192.168.1.10:8080/v1" })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI_API_BASE_URL uses plain http to a private address"));
    } finally {
      logger.warn = originalWarn;
    }
  });

  test("still rejects a public literal and a name over plain http", () => {
    // 100.150.0.4 is a real deployment's inference host and is *not* in the
    // 100.64/10 shared block: it is a public address, so it needs the opt-out.
    for (const base of [
      "http://100.150.0.4:8080/v1",
      "http://8.8.8.8/v1",
      "http://inference.corp.example/v1",
      "http://whisper.lan:9000/transcribe",
    ]) {
      expect(() => validateEnv({ ...baseValidEnv, AI_API_BASE_URL: base }))
        .toThrow("Environment validation failed");
    }
  });

  test("ALLOW_INSECURE_HTTP_ENDPOINTS accepts plain http for a self-hosted AI server", () => {
    // A private-network inference server (no certificate, not internet-reachable)
    // is a real deployment; the operator opts in explicitly and gets a warning.
    const warn = mock(() => {});
    const originalWarn = logger.warn;
    logger.warn = warn;
    try {
      expect(() => validateEnv({
        ...baseValidEnv,
        AI_API_BASE_URL: "http://100.150.0.4:8080/v1",
        ALLOW_INSECURE_HTTP_ENDPOINTS: "true",
      })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ALLOW_INSECURE_HTTP_ENDPOINTS"));
    } finally {
      logger.warn = originalWarn;
    }
  });

  test("ALLOW_INSECURE_HTTP_ENDPOINTS covers per-provider and transcription URLs", () => {
    expect(() => validateEnv({
      AI_PROVIDERS: "omnirouter",
      AI_OMNIROUTER_BASE_URL: "http://100.150.0.4:8080/v1",
      AI_OMNIROUTER_API_KEY: "key",
      AI_OMNIROUTER_MODEL: "model",
      TRANSCRIBE_ENDPOINT: "http://whisper.lan:9000/transcribe",
      ALLOW_INSECURE_HTTP_ENDPOINTS: "true",
    })).not.toThrow();

    // …and the same configuration is refused without the opt-in.
    expect(() => validateEnv({
      AI_PROVIDERS: "omnirouter",
      AI_OMNIROUTER_BASE_URL: "http://100.150.0.4:8080/v1",
      AI_OMNIROUTER_API_KEY: "key",
      AI_OMNIROUTER_MODEL: "model",
      TRANSCRIBE_ENDPOINT: "http://whisper.lan:9000/transcribe",
    })).toThrow("Environment validation failed");
  });

  test("ALLOW_INSECURE_HTTP_ENDPOINTS does not relax every endpoint", () => {
    // The opt-out is scoped to the keys it names; the externally reachable
    // Jellyfin URL keeps its https requirement, and URL credentials are still
    // refused because they would be logged and shown in the dashboard.
    expect(() => validateEnv({
      ...baseValidEnv,
      JELLYFIN_EXTERNAL_URL: "http://jellyfin.example.com",
      ALLOW_INSECURE_HTTP_ENDPOINTS: "true",
    })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("JELLYFIN_EXTERNAL_URL must use https unless it points to a loopback or private-network address (set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)");

    expect(() => validateEnv({
      ...baseValidEnv,
      AI_API_BASE_URL: "http://user:pass@100.150.0.4:8080/v1",
      ALLOW_INSECURE_HTTP_ENDPOINTS: "true",
    })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL must not contain credentials");
  });

  test("ALLOW_INSECURE_HTTP_ENDPOINTS must be true or false", () => {
    expect(() => validateEnv({ ...baseValidEnv, ALLOW_INSECURE_HTTP_ENDPOINTS: "yes" }))
      .toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('ALLOW_INSECURE_HTTP_ENDPOINTS must be either "true" or "false"');
  });

  test("should still allow plain http for self-hosted internal media services", () => {
    expect(() => validateEnv({
      ...baseValidEnv,
      JELLYFIN_API_URL: "http://jellyfin:8096",
      SEERR_API_URL: "http://seerr:5055/api/v1",
      SEARXNG_URL: "http://searxng.lan:8080",
    })).not.toThrow();
  });

  test("should require the external Jellyfin URL to be https", () => {
    expect(() => validateEnv({ ...baseValidEnv, JELLYFIN_EXTERNAL_URL: "http://jellyfin.example.com" }))
      .toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("JELLYFIN_EXTERNAL_URL must use https unless it points to a loopback or private-network address (set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)");
  });

  test("should validate every provider in multi-provider mode", () => {
    expect(() => validateEnv({
      AI_PROVIDERS: "openai,modal",
      AI_OPENAI_BASE_URL: "https://api.openai.com/v1",
      AI_OPENAI_API_KEY: "openai-key",
      AI_OPENAI_MODEL: "gpt-4o-mini",
      AI_MODAL_API_KEY: "modal-key",
    })).toThrow("Environment validation failed with 2 error(s)");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MODAL_BASE_URL is required");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MODAL_MODEL is required in multi-provider mode");
  });

  test("should enforce https for externally reachable provider URLs that opt out of loopback http", () => {
    expect(() => validateEnv({
      AI_PROVIDERS: "openai",
      AI_OPENAI_BASE_URL: "https://api.openai.com/v1",
      AI_OPENAI_API_KEY: "openai-key",
      AI_OPENAI_MODEL: "gpt-4o-mini",
      JELLYFIN_EXTERNAL_URL: "http://jellyfin.example.com",
    })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("JELLYFIN_EXTERNAL_URL must use https unless it points to a loopback or private-network address (set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)");
  });

  test("should require a base url, key, and model for each multi-provider entry", () => {
    expect(() => validateEnv({ AI_PROVIDERS: "openai" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_OPENAI_BASE_URL is required");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_OPENAI_API_KEY is required for non-loopback providers");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_OPENAI_MODEL is required in multi-provider mode");
  });

  test("should reject duplicate and malformed provider names", () => {
    expect(() => validateEnv({ AI_PROVIDERS: "openai,openai" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_PROVIDERS must not contain duplicates");

    mockLoggerError.mockClear();
    expect(() => validateEnv({ AI_PROVIDERS: "bad name" })).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_PROVIDERS contains an invalid provider name: bad name");
  });

  test("should ignore legacy single-provider vars when AI_PROVIDERS is set", () => {
    expect(() => validateEnv({
      AI_PROVIDERS: "openai",
      AI_OPENAI_BASE_URL: "https://api.openai.com/v1",
      AI_OPENAI_API_KEY: "openai-key",
      AI_OPENAI_MODEL: "gpt-4o-mini",
    })).not.toThrow();
  });

  test("should pass with valid operational settings", () => {
    const validEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_TOOL_TIMEOUT_MS: "30000",
      AI_PROVIDER_COOLDOWN_MS: "60000",
      AI_MAX_TOOL_ITERATIONS: "8",
      WEBHOOK_PORT: "3500",
      WEBHOOK_MAX_BODY_BYTES: "262144",
      TRANSCRIBE_ENDPOINT: "https://transcribe.example.com/api",
      AUTO_REPLY_ALL: "true",
      AI_TEMPERATURE: "0.7",
    };

    expect(() => validateEnv(validEnv)).not.toThrow();
  });
});
