import { describe, test, expect, mock, beforeEach } from 'bun:test';

type PrivilegeOverrideRow = {
  maxMessagesPerWindow: number | null;
  rateLimitWindowSec: number | null;
  contextLimit: number | null;
  maxDownloadMb: number | null;
};

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockPrivRows: PrivilegeOverrideRow[] = [];
let lastInsertedPriv: Record<string, unknown> | null = null;
let lastDeletedRole = false;

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockPrivRows),
        }),
      }),
    }),
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        lastInsertedPriv = vals;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => {
        lastDeletedRole = true;
        return Promise.resolve();
      },
    }),
  },
}));

import { PrivilegeService, isPrivilegeField } from '../src/utils/PrivilegeService';

describe('PrivilegeService', () => {
  beforeEach(() => {
    mockPrivRows = [];
    lastInsertedPriv = null;
    lastDeletedRole = null;
  });

  test('getDefaults for user returns expected values', () => {
    const defaults = PrivilegeService.getDefaults('user');
    expect(defaults.maxMessagesPerWindow).toBe(10);
    expect(defaults.rateLimitWindowSec).toBe(60);
    expect(defaults.contextLimit).toBe(20);
    expect(defaults.maxDownloadMb).toBe(25);
  });

  test('getDefaults for owner returns unlimited values', () => {
    const defaults = PrivilegeService.getDefaults('owner');
    expect(defaults.maxMessagesPerWindow).toBe(-1);
    expect(defaults.maxDownloadMb).toBe(-1);
  });

  test('getDefaults for unknown role falls back to user defaults', () => {
    const defaults = PrivilegeService.getDefaults('custom_role');
    expect(defaults.maxMessagesPerWindow).toBe(10);
  });

  test('getForRole returns defaults when no DB overrides', async () => {
    const privs = await PrivilegeService.getForRole('user');
    expect(privs.maxMessagesPerWindow).toBe(10);
  });

  test('getForRole applies DB overrides', async () => {
    mockPrivRows = [{ maxMessagesPerWindow: 50, rateLimitWindowSec: null, contextLimit: null, maxDownloadMb: null }];
    const privs = await PrivilegeService.getForRole('premium');
    expect(privs.maxMessagesPerWindow).toBe(50);
  });

  test('getEffective with multiple roles picks most permissive', async () => {
    mockPrivRows = [];
    const privs = await PrivilegeService.getEffective(['user', 'owner']);
    expect(privs.maxMessagesPerWindow).toBe(-1);
  });

  test('isPrivilegeField accepts known fields and rejects unknown ones', () => {
    expect(isPrivilegeField('contextLimit')).toBe(true);
    expect(isPrivilegeField('unknownField')).toBe(false);
  });

  test('setOverride inserts new override', async () => {
    mockPrivRows = [];
    await PrivilegeService.setOverride('premium', 'contextLimit', 100);
    expect(lastInsertedPriv).toBeDefined();
  });

  test('resetToDefaults deletes overrides', async () => {
    await PrivilegeService.resetToDefaults('premium');
    expect(lastDeletedRole).toBe(true);
  });
});
