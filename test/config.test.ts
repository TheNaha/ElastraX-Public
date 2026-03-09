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

describe("Config Validation", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  test("should pass with valid environment variables", () => {
    const validEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
    };

    expect(() => validateEnv(validEnv)).not.toThrow();
  });

  test("should throw if AI_API_KEY is missing", () => {
    const invalidEnv = {
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_KEY is missing or empty");
  });

  test("should throw if AI_MODEL_NAME is missing", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_API_BASE_URL: "https://api.example.com",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MODEL_NAME is missing or empty");
  });

  test("should throw if AI_API_BASE_URL is missing", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL is missing or empty");
  });

  test("should throw if AI_API_BASE_URL is invalid", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "not-a-url",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('AI_API_BASE_URL is not a valid URL: "not-a-url"');
  });

  test("should throw if AI_API_BASE_URL is empty string (only spaces)", () => {
     const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "   ",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_API_BASE_URL is missing or empty");
    // Ensure we don't get the "invalid URL" error as well
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  test("should throw if AI_TOOL_TIMEOUT_MS is not a positive integer", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_TOOL_TIMEOUT_MS: "0",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_TOOL_TIMEOUT_MS must be a positive integer when set");
  });

  test("should throw if AI_PROVIDER_COOLDOWN_MS is not a positive integer", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_PROVIDER_COOLDOWN_MS: "-5",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_PROVIDER_COOLDOWN_MS must be a positive integer when set");
  });

  test("should throw if AI_MAX_TOKENS is not a positive integer", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_MAX_TOKENS: "zero",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_MAX_TOKENS must be a positive integer when set");
  });

  test("should throw if AI_TEMPERATURE is outside the valid range", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_TEMPERATURE: "2.5",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("AI_TEMPERATURE must be a number between 0 and 2 when set");
  });

  test("should throw if AUTO_REPLY_ALL is not a boolean string", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AUTO_REPLY_ALL: "1",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('AUTO_REPLY_ALL must be either "true" or "false" when set');
  });

  test("should throw if WEBHOOK_PORT is outside the valid range", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      WEBHOOK_PORT: "70000",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_PORT must be an integer between 0 and 65535 when set");
  });

  test("should throw if WEBHOOK_MAX_BODY_BYTES is not a positive integer", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      WEBHOOK_MAX_BODY_BYTES: "NaN",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith("WEBHOOK_MAX_BODY_BYTES must be a positive integer when set");
  });

  test("should throw if TRANSCRIBE_ENDPOINT is not a valid URL", () => {
    const invalidEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      TRANSCRIBE_ENDPOINT: "not-a-url",
    };

    expect(() => validateEnv(invalidEnv)).toThrow("Environment validation failed");
    expect(mockLoggerError).toHaveBeenCalledWith('TRANSCRIBE_ENDPOINT is not a valid URL: "not-a-url"');
  });

  test("should pass with valid operational settings", () => {
    const validEnv = {
      AI_API_KEY: "secret-key",
      AI_MODEL_NAME: "model-name",
      AI_API_BASE_URL: "https://api.example.com",
      AI_TOOL_TIMEOUT_MS: "30000",
      AI_PROVIDER_COOLDOWN_MS: "60000",
      WEBHOOK_PORT: "3500",
      WEBHOOK_MAX_BODY_BYTES: "262144",
      TRANSCRIBE_ENDPOINT: "https://transcribe.example.com/api",
    };

    expect(() => validateEnv(validEnv)).not.toThrow();
  });
});
