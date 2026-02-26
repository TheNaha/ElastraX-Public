import { describe, expect, test, mock, beforeEach } from "bun:test";

// Mock the logger to verify calls and suppress output
const mockLoggerError = mock(() => {});
mock.module("../src/utils/logger", () => ({
  logger: {
    error: mockLoggerError,
    info: () => {},
    warn: () => {},
    debug: () => {},
  },
}));

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
});
