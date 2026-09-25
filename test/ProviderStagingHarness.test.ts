import { afterEach, describe, expect, test } from 'bun:test';
import {
  DISCORD_TEXT_LIMIT,
  FakeStagingProvider,
  HARD_MEDIA_MAX_BYTES,
  ProviderError,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  STAGING_SCENARIOS,
  WHATSAPP_LOGGED_OUT,
  WHATSAPP_RESTART_REQUIRED,
  WHATSAPP_TEXT_LIMIT,
  chunkBoundaryText,
  chunkFixedText,
  chunkText,
  createLazyPromise,
  defaultChatId,
  formatStagingReport,
  parseStagingArgs,
  reconnectDelayMs,
  runStagingHarness,
  type CheckResult,
  type Platform,
  type ScenarioResult,
} from '../scripts/providerStagingHarness';
import { WHATSAPP_TEXT_LIMIT as SHIPPING_WHATSAPP_TEXT_LIMIT, chunkWhatsAppText } from '../src/providers/whatsapp';
import { DISCORD_TEXT_LIMIT as SHIPPING_DISCORD_TEXT_LIMIT, chunkDiscordText } from '../src/providers/discord';

const CREDENTIAL_ENV_KEYS = ['DISCORD_BOT_TOKEN', 'BOT_OWNER_JID', 'WEBHOOK_SECRET'] as const;
const savedCredentials = new Map<string, string | undefined>();
let credentialsCleared = false;

function clearCredentials(): void {
  if (credentialsCleared) return;
  for (const key of CREDENTIAL_ENV_KEYS) {
    savedCredentials.set(key, process.env[key]);
    process.env[key] = '';
  }
  credentialsCleared = true;
}

function failures(scenario: ScenarioResult): CheckResult[] {
  return scenario.checks.filter(check => !check.passed);
}

afterEach(() => {
  for (const [key, value] of savedCredentials) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedCredentials.clear();
  credentialsCleared = false;
});

describe('provider staging harness scenario matrix', () => {
  test('runs every scenario for both providers without credentials', async () => {
    clearCredentials();
    const report = await runStagingHarness();

    expect(report.scenarios).toHaveLength(STAGING_SCENARIOS.length * 2);
    for (const scenario of report.scenarios) {
      expect({ scenario: scenario.scenario, platform: scenario.platform, failures: failures(scenario) }).toEqual({
        scenario: scenario.scenario,
        platform: scenario.platform,
        failures: [],
      });
    }
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.scenarios.length);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  test('covers connect, reconnect, duplicate, permission, media, long reply, and shutdown on both providers', async () => {
    const report = await runStagingHarness();
    for (const platform of ['whatsapp', 'discord'] as const) {
      const names = report.scenarios.filter(entry => entry.platform === platform).map(entry => entry.scenario);
      expect(names).toEqual([...STAGING_SCENARIOS]);
    }
    expect(formatStagingReport(report)).toContain('Scenarios: 14 passed, 0 failed');
  });

  test('can run a single platform and a single scenario', async () => {
    const report = await runStagingHarness({ platforms: ['discord'], scenarios: ['shutdown'] });
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]?.scenario).toBe('shutdown');
    expect(report.scenarios[0]?.platform).toBe('discord');
    expect(report.ok).toBe(true);
  });

  test('reports a failing scenario instead of claiming success', () => {
    const failing: ScenarioResult = {
      scenario: 'connect',
      platform: 'whatsapp',
      passed: false,
      checks: [
        { name: 'start reaches running', passed: true, detail: 'status=running' },
        { name: 'reply respects the platform limit', passed: false, detail: 'limit=0' },
      ],
    };
    const text = formatStagingReport({
      generatedAt: '2026-09-25T17:00:00Z',
      scenarios: [failing],
      passed: 0,
      failed: 1,
      ok: false,
    });
    expect(text).toContain('FAIL connect [whatsapp]');
    expect(text).toContain('FAIL reply respects the platform limit - limit=0');
    expect(text).toContain('Scenarios: 0 passed, 1 failed');
  });
});

describe('provider staging harness contract details', () => {
  test('mirrors the shipping provider limits and chunking exactly', () => {
    expect(WHATSAPP_TEXT_LIMIT).toBe(SHIPPING_WHATSAPP_TEXT_LIMIT);
    expect(DISCORD_TEXT_LIMIT).toBe(SHIPPING_DISCORD_TEXT_LIMIT);

    const samples = [
      'a'.repeat(SHIPPING_WHATSAPP_TEXT_LIMIT - 1),
      'b'.repeat(SHIPPING_WHATSAPP_TEXT_LIMIT + 5),
      `${'word '.repeat(900)}tail`,
      'line one\nline two\nline three',
    ];
    for (const sample of samples) {
      expect(chunkFixedText(sample, WHATSAPP_TEXT_LIMIT)).toEqual(chunkWhatsAppText(sample));
    }
    for (const sample of samples) {
      const discordSample = sample.length > SHIPPING_DISCORD_TEXT_LIMIT * 3 ? sample.slice(0, SHIPPING_DISCORD_TEXT_LIMIT * 3) : sample;
      expect(chunkBoundaryText(discordSample, DISCORD_TEXT_LIMIT)).toEqual(chunkDiscordText(discordSample));
    }
  });

  test('chunking never exceeds the limit and is lossless', () => {
    for (const platform of ['whatsapp', 'discord'] as const) {
      const limit = platform === 'whatsapp' ? WHATSAPP_TEXT_LIMIT : DISCORD_TEXT_LIMIT;
      const text = platform === 'whatsapp' ? 'z'.repeat(limit * 2 + 1) : `${'chunk me '.repeat(limit)}end`;
      const chunks = chunkText(platform, text, limit);
      expect(chunks.every(chunk => Array.from(chunk).length <= limit)).toBe(true);
      expect(chunks.join('')).toBe(text);
    }
    expect(() => chunkFixedText('x', 0)).toThrow('positive integer');
    expect(chunkFixedText('', 10)).toEqual(['']);
  });

  test('reconnect backoff grows exponentially and is capped', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(reconnectDelayMs(3)).toBe(RECONNECT_BASE_DELAY_MS * 4);
    expect(reconnectDelayMs(8)).toBe(RECONNECT_BASE_DELAY_MS * 2 ** 7);
    expect(reconnectDelayMs(9)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(30)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS);
  });

  test('separates restart-required reconnects from logged-out terminal states', async () => {
    const provider = new FakeStagingProvider({ platform: 'whatsapp', sendLimit: WHATSAPP_TEXT_LIMIT });
    await provider.start();
    expect(provider.simulateDisconnect(WHATSAPP_RESTART_REQUIRED).reconnectScheduled).toBe(true);
    expect(provider.status).toBe('backoff');
    expect(provider.isOperational).toBe(false);

    const loggedOut = provider.simulateDisconnect(WHATSAPP_LOGGED_OUT);
    expect(loggedOut.reconnectScheduled).toBe(false);
    expect(loggedOut.error.code).toBe('PERMISSION_DENIED');
    expect(provider.status).toBe('error');
  });

  test('suppresses replayed provider events without suppressing new ones', async () => {
    const provider = new FakeStagingProvider({ platform: 'discord', sendLimit: DISCORD_TEXT_LIMIT });
    await provider.start();
    const handled: string[] = [];
    provider.onMessage(async ctx => {
      handled.push(ctx.messageId);
    });

    const chatId = defaultChatId('discord');
    const peer = { senderId: '1', senderName: 'Peer', roles: [] };
    expect((await provider.deliver({ messageId: 'a', chatId, peer, text: 'hi', isGroup: true })).accepted).toBe(true);
    expect((await provider.deliver({ messageId: 'a', chatId, peer, text: 'hi', isGroup: true })).accepted).toBe(false);
    expect((await provider.deliver({ messageId: 'b', chatId, peer, text: 'hi', isGroup: true })).accepted).toBe(true);
    expect(handled).toEqual(['a', 'b']);
    expect(provider.duplicateEventsSuppressed).toBe(1);
  });

  test('bounds media acquisition by the hard cap and keeps lazy acquisition lazy', async () => {
    const provider = new FakeStagingProvider({ platform: 'whatsapp', sendLimit: WHATSAPP_TEXT_LIMIT });
    await provider.start();
    const states: string[] = [];
    let buffer: Buffer | null = null;
    let failureCode = '';
    provider.onMessage(async ctx => {
      states.push(ctx.mediaAttachments[0]?.state ?? 'none');
      try {
        buffer = await ctx.downloadMedia();
      } catch (error) {
        failureCode = error instanceof ProviderError ? error.code : 'UNKNOWN';
      }
      states.push(ctx.mediaAttachments[0]?.state ?? 'none');
    });

    const oversize = {
      providerId: 'huge',
      mimeType: 'video/mp4',
      sizeBytes: HARD_MEDIA_MAX_BYTES + 1,
    };
    await provider.deliver({
      messageId: 'huge',
      chatId: 'chat',
      peer: { senderId: '1', senderName: 'Peer', roles: [] },
      text: 'big',
      isGroup: true,
      media: oversize,
    });
    expect(states).toEqual(['skipped', 'skipped']);
    expect(failureCode).toBe('OPERATION_FAILED');
    expect(buffer).toBeNull();
  });

  test('rejects every action after shutdown with a stale lifecycle error', async () => {
    const provider = new FakeStagingProvider({ platform: 'whatsapp', sendLimit: WHATSAPP_TEXT_LIMIT });
    await provider.start();
    await provider.stop();

    await expect(provider.sendMessage('chat', 'text')).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.sendTyping('chat')).rejects.toMatchObject({ code: 'STALE_LIFECYCLE' });
    await expect(provider.deliver({
      messageId: 'after-stop',
      chatId: 'chat',
      peer: { senderId: '1', senderName: 'Peer', roles: [] },
      text: 'hi',
    })).rejects.toMatchObject({ code: 'STALE_LIFECYCLE' });
    expect(provider.outgoing).toHaveLength(0);
  });

  test('lazy media promises start only when awaited', async () => {
    let started = 0;
    const lazy = createLazyPromise(async () => {
      started++;
    });
    expect(started).toBe(0);
    await lazy;
    await lazy;
    expect(started).toBe(1);
  });

  test('platform defaults are distinct and the report is printable', async () => {
    expect(defaultChatId('whatsapp')).toContain('@g.us');
    expect(defaultChatId('discord')).toMatch(/^\d+$/);
    const report = await runStagingHarness({ platforms: ['whatsapp'] as Platform[], scenarios: ['connect'] });
    const text = formatStagingReport(report);
    expect(text).toContain('PASS connect [whatsapp]');
    expect(text).toContain('fakes only, no credentials');
  });
});

describe('provider staging harness CLI parsing', () => {
  test('accepts supported flags', () => {
    const parsed = parseStagingArgs(['--platform', 'discord', '--only', 'connect,shutdown', '--json']);
    expect(parsed.error).toBeNull();
    expect(parsed.options.platforms).toEqual(['discord']);
    expect(parsed.options.scenarios).toEqual(['connect', 'shutdown']);
    expect(parsed.json).toBe(true);
    expect(parseStagingArgs(['--help']).help).toBe(true);
  });

  test('rejects unknown platforms, unknown scenarios, and unknown flags', () => {
    expect(parseStagingArgs(['--platform', 'telegram']).error).toContain('--platform');
    expect(parseStagingArgs(['--only', 'connect,explode']).error).toContain('explode');
    expect(parseStagingArgs(['--only']).error).toContain('--only');
    expect(parseStagingArgs(['--nope']).error).toContain('unknown argument');
  });
});
