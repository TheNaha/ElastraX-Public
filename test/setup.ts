/**
 * test/setup.ts – bun test preload file
 *
 * This file is executed by the bun test runner before any test modules are
 * loaded.  Setting AI env vars here ensures that the AIClient singleton
 * created at module-evaluation time in src/agent/index.ts picks up a valid
 * base URL, so chatCompletion() proceeds to the fetch() call (which is then
 * intercepted per-test via global.fetch mock).
 */

process.env.AI_API_BASE_URL = 'https://test-ai.example.com/v1';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL_NAME = 'test-model';
