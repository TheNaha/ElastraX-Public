import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigService } from '../src/utils/ConfigService';
import { ChatRoom } from '../src/db/schema';

const baseRoom = (): ChatRoom => ({
  id: 'room-123',
  platform: 'whatsapp',
  language: 'en',
  systemPrompt: null,
  contextLimit: null,
  temperature: null,
  maxTokens: null,
  allowTools: null,
  autoReplyAll: null,
  summarize: null,
  created_at: new Date(),
});

describe('ConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEFAULT_SYSTEM_PROMPT;
    delete process.env.CONTEXT_MESSAGE_LIMIT;
    delete process.env.AI_TEMPERATURE;
    delete process.env.AI_MAX_TOKENS;
    delete process.env.AUTO_REPLY_ALL;
    delete process.env.CONTEXT_SUMMARIZE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('systemPrompt', () => {
    test('should use hardcoded default when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.systemPrompt).toContain('ElastraX');
    });

    test('default system prompt should contain the LANGUAGE placeholder', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.systemPrompt).toContain('{{LANGUAGE}}');
    });

    test('should use DEFAULT_SYSTEM_PROMPT env var when DB field is null', () => {
      process.env.DEFAULT_SYSTEM_PROMPT = 'Custom prompt from env';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.systemPrompt).toBe('Custom prompt from env');
    });

    test('should prefer DB systemPrompt over env var', () => {
      process.env.DEFAULT_SYSTEM_PROMPT = 'Env prompt';
      const room = { ...baseRoom(), systemPrompt: 'DB custom prompt' };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.systemPrompt).toBe('DB custom prompt');
    });

    test('should fall back to default if DB systemPrompt is empty string', () => {
      // An empty string is falsy in JS, so it falls back to default
      const room = { ...baseRoom(), systemPrompt: '' };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.systemPrompt).toContain('ElastraX');
    });
  });

  describe('contextLimit', () => {
    test('should default to 10 when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.contextLimit).toBe(10);
    });

    test('should use CONTEXT_MESSAGE_LIMIT env var when DB field is null', () => {
      process.env.CONTEXT_MESSAGE_LIMIT = '25';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.contextLimit).toBe(25);
    });

    test('should fall back to default contextLimit when env value is invalid', () => {
      process.env.CONTEXT_MESSAGE_LIMIT = 'NaN';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.contextLimit).toBe(10);
    });

    test('should prefer DB contextLimit over env var', () => {
      process.env.CONTEXT_MESSAGE_LIMIT = '25';
      const room = { ...baseRoom(), contextLimit: 5 };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.contextLimit).toBe(5);
    });

    test('should allow DB contextLimit of 0', () => {
      const room = { ...baseRoom(), contextLimit: 0 };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.contextLimit).toBe(0);
    });
  });

  describe('temperature', () => {
    test('should default to 0.7 when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.temperature).toBe(0.7);
    });

    test('should use AI_TEMPERATURE env var when DB field is null', () => {
      process.env.AI_TEMPERATURE = '0.5';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.temperature).toBe(0.5);
    });

    test('should fall back to default temperature when env value is invalid', () => {
      process.env.AI_TEMPERATURE = 'hot';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.temperature).toBe(0.7);
    });

    test('should prefer DB temperature over env var', () => {
      process.env.AI_TEMPERATURE = '0.5';
      const room = { ...baseRoom(), temperature: 1.0 };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.temperature).toBe(1.0);
    });

    test('should allow DB temperature of 0', () => {
      const room = { ...baseRoom(), temperature: 0 };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.temperature).toBe(0);
    });
  });

  describe('allowTools', () => {
    test('should default to true when DB field is null', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.allowTools).toBe(true);
    });

    test('should respect DB value of false', () => {
      const room = { ...baseRoom(), allowTools: false };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.allowTools).toBe(false);
    });

    test('should respect DB value of true explicitly', () => {
      const room = { ...baseRoom(), allowTools: true };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.allowTools).toBe(true);
    });
  });

  describe('maxTokens', () => {
    test('should default to 2048 when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.maxTokens).toBe(2048);
    });

    test('should use AI_MAX_TOKENS env var when DB field is null', () => {
      process.env.AI_MAX_TOKENS = '4096';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.maxTokens).toBe(4096);
    });

    test('should fall back to default maxTokens when env value is invalid', () => {
      process.env.AI_MAX_TOKENS = 'a lot';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.maxTokens).toBe(2048);
    });

    test('should prefer DB maxTokens over env var', () => {
      process.env.AI_MAX_TOKENS = '4096';
      const room = { ...baseRoom(), maxTokens: 1024 };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.maxTokens).toBe(1024);
    });
  });

  describe('autoReplyAll', () => {
    test('should default to false when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.autoReplyAll).toBe(false);
    });

    test('should return true when AUTO_REPLY_ALL env is "true"', () => {
      process.env.AUTO_REPLY_ALL = 'true';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.autoReplyAll).toBe(true);
    });

    test('should return false when AUTO_REPLY_ALL env is "false"', () => {
      process.env.AUTO_REPLY_ALL = 'false';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.autoReplyAll).toBe(false);
    });

    test('should return false when AUTO_REPLY_ALL env is any non-"true" string', () => {
      process.env.AUTO_REPLY_ALL = '1';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.autoReplyAll).toBe(false);
    });

    test('should prefer DB autoReplyAll over env var', () => {
      process.env.AUTO_REPLY_ALL = 'true';
      const room = { ...baseRoom(), autoReplyAll: false };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.autoReplyAll).toBe(false);
    });
  });

  describe('summarize', () => {
    test('should default to true when DB and env are both unset', () => {
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.summarize).toBe(true);
    });

    test('should use CONTEXT_SUMMARIZE env var when DB field is null', () => {
      process.env.CONTEXT_SUMMARIZE = 'false';
      const config = ConfigService.getResolvedConfig(baseRoom());
      expect(config.summarize).toBe(false);
    });

    test('should prefer DB summarize over env var', () => {
      process.env.CONTEXT_SUMMARIZE = 'false';
      const room = { ...baseRoom(), summarize: true };
      const config = ConfigService.getResolvedConfig(room);
      expect(config.summarize).toBe(true);
    });
  });

  describe('combined override behavior', () => {
    test('should mix DB overrides and env fallbacks independently', () => {
      process.env.CONTEXT_MESSAGE_LIMIT = '30';
      process.env.AI_TEMPERATURE = '0.3';
      const room = { ...baseRoom(), systemPrompt: 'Only this is custom', temperature: 0.9 };
      const config = ConfigService.getResolvedConfig(room);

      expect(config.systemPrompt).toBe('Only this is custom');
      expect(config.contextLimit).toBe(30);  // from env
      expect(config.temperature).toBe(0.9);   // from DB
      expect(config.allowTools).toBe(true);   // hardcoded default
      expect(config.autoReplyAll).toBe(false); // hardcoded default
    });

    test('should return all DB values when all fields are explicitly set', () => {
      const room: ChatRoom = {
        id: 'room-full',
        platform: 'discord',
        language: 'id',
        systemPrompt: 'You are a Discord bot.',
        contextLimit: 15,
        temperature: 0.8,
        maxTokens: 4096,
        allowTools: false,
        autoReplyAll: true,
        summarize: false,
        created_at: new Date(),
      };
      const config = ConfigService.getResolvedConfig(room);

      expect(config.systemPrompt).toBe('You are a Discord bot.');
      expect(config.contextLimit).toBe(15);
      expect(config.temperature).toBe(0.8);
      expect(config.maxTokens).toBe(4096);
      expect(config.allowTools).toBe(false);
      expect(config.autoReplyAll).toBe(true);
      expect(config.summarize).toBe(false);
    });
  });
});
