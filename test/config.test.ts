import { describe, expect, test, mock, beforeEach } from "bun:test";

// Mock the logger to verify calls and suppress output
const mockLoggerError = mock(() => {});
const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: mockLoggerError,
  child: () => _mockLogger,
};
mock.module("../src/utils/logger", () => ({ logger: _mockLogger }));

// Import dynamically to ensure mock is applied
const { validateEnv } = await import("../src/config/env");

const baseValidEnv = {
  AI_API_KEY: "secret-key",
  AI_MODEL_NAME: "model-name",
  AI_API_BASE_URL: "https://api.example.com",
};

describe("Config Validation", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
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
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_PORT must be an integer between 1 and 65535");
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

  test("should require the external Jellyfin URL to be https", () => {
    expect(() => validateEnv({ ...baseValidEnv, JELLYFIN_EXTERNAL_URL: "http://jellyfin.example.com" }))
      .toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("JELLYFIN_EXTERNAL_URL must use https unless it points to a loopback address");
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
    expect(mockLoggerError).toHaveBeenCalledWith("JELLYFIN_EXTERNAL_URL must use https unless it points to a loopback address");
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
