import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { AIClient } from "../src/ai/client";

describe("AIClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear relevant env vars
    delete process.env.AI_API_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL_NAME;
  });

  afterEach(() => {
    process.env = originalEnv;
    // Restore fetch if mocked
    if ((global.fetch as any).mockRestore) {
      (global.fetch as any).mockRestore();
    }
  });

  test("should instantiate without config (empty env)", () => {
    const client = new AIClient();
    expect(client).toBeInstanceOf(AIClient);
  });

  test("should use config values if provided", () => {
    const config = {
      baseUrl: "https://example.com/v1",
      apiKey: "secret-key",
      modelName: "my-model",
    };
    const client = new AIClient(config);
    // accessing private properties via any cast for testing
    expect((client as any).baseUrl).toBe(config.baseUrl);
    expect((client as any).apiKey).toBe(config.apiKey);
    expect((client as any).modelName).toBe(config.modelName);
  });

  test("should fall back to env values if config is missing", () => {
    process.env.AI_API_BASE_URL = "https://env-url.com/v1";
    process.env.AI_API_KEY = "env-key";
    process.env.AI_MODEL_NAME = "env-model";

    const client = new AIClient();
    expect((client as any).baseUrl).toBe("https://env-url.com/v1");
    expect((client as any).apiKey).toBe("env-key");
    expect((client as any).modelName).toBe("env-model");
  });

  test("chatCompletion should throw if baseUrl is missing", async () => {
    const client = new AIClient({ baseUrl: "" });
    try {
      await client.chatCompletion([], []);
    } catch (e: any) {
      expect(e.message).toBe("AI_API_BASE_URL is not configured properly.");
    }
  });

  test("chatCompletion should throw if baseUrl contains placeholder", async () => {
    const client = new AIClient({ baseUrl: "https://<your-username>--app.modal.run/v1" });
    try {
      await client.chatCompletion([], []);
    } catch (e: any) {
      expect(e.message).toBe("AI_API_BASE_URL is not configured properly.");
    }
  });

  test("chatCompletion should make a fetch request if configured", async () => {
    const originalFetch = global.fetch;
    const client = new AIClient({ baseUrl: "https://api.example.com/v1" });

    const mockFetch = mock(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
        usage: { total_tokens: 10 }
      }), { status: 200 });
    });
    global.fetch = mockFetch as any;

    try {
      const result = await client.chatCompletion([{ role: "user", content: "Hi" }]);

      expect(mockFetch).toHaveBeenCalled();
      expect(result.content).toBe("Hello");

      // Check endpoint construction
      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toBe("https://api.example.com/v1/chat/completions");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("chatCompletion should throw error on non-OK response", async () => {
    const originalFetch = global.fetch;
    const client = new AIClient({ baseUrl: "https://api.example.com/v1" });

    const mockFetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });
    global.fetch = mockFetch as any;

    try {
      await client.chatCompletion([{ role: "user", content: "Hi" }]);
      // Fail the test if no error is thrown
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe("LLM API returned 500: Internal Server Error");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
