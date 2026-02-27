import { describe, test, expect, mock, beforeEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockIdentityRows: any[] = [];
let lastInsertedIdentity: any = null;
let lastUpdatedIdentity: any = null;

/** Creates a chainable thenable mock query that resolves to mockIdentityRows. */
function mockQuery() {
  const obj: any = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    then: (resolve: any) => resolve(mockIdentityRows),
  };
  return obj;
}

mock.module('../src/db', () => ({
  db: {
    select: () => mockQuery(),
    insert: () => ({
      values: (vals: any) => {
        lastInsertedIdentity = vals;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (data: any) => {
        lastUpdatedIdentity = data;
        return {
          where: () => Promise.resolve(),
        };
      },
    }),
  },
}));

import { IdentityService } from '../src/utils/IdentityService';

describe('IdentityService', () => {
  beforeEach(() => {
    mockIdentityRows = [];
    lastInsertedIdentity = null;
    lastUpdatedIdentity = null;
  });

  test('upsert with no lid and no pn does nothing', async () => {
    await IdentityService.upsert(undefined, undefined);
    expect(lastInsertedIdentity).toBeNull();
    expect(lastUpdatedIdentity).toBeNull();
  });

  test('upsert with new identity inserts', async () => {
    mockIdentityRows = [];
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');
    expect(lastInsertedIdentity).toBeDefined();
    expect(lastInsertedIdentity.lid).toBe('abc@lid');
    expect(lastInsertedIdentity.pn).toBe('123@s.whatsapp.net');
  });

  test('upsert with existing identity updates', async () => {
    mockIdentityRows = [{ lid: 'abc@lid', pn: null }];
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');
    expect(lastUpdatedIdentity).toBeDefined();
    expect(lastUpdatedIdentity.pn).toBe('123@s.whatsapp.net');
  });

  test('getAllJids with no mapping returns [jid]', async () => {
    mockIdentityRows = [];
    const jids = await IdentityService.getAllJids('unknown@s.whatsapp.net');
    expect(jids).toEqual(['unknown@s.whatsapp.net']);
  });

  test('getAllJids with mapping returns all known JIDs', async () => {
    mockIdentityRows = [{ lid: 'abc@lid', pn: '123@s.whatsapp.net' }];
    const jids = await IdentityService.getAllJids('abc@lid');
    expect(jids).toContain('abc@lid');
    expect(jids).toContain('123@s.whatsapp.net');
  });

  test('getAllJids with empty string returns []', async () => {
    const jids = await IdentityService.getAllJids('');
    expect(jids).toEqual([]);
  });

  test('getPnForLid returns pn when found', async () => {
    mockIdentityRows = [{ pn: '123@s.whatsapp.net' }];
    const pn = await IdentityService.getPnForLid('abc@lid');
    expect(pn).toBe('123@s.whatsapp.net');
  });

  test('getPnForLid returns undefined when not found', async () => {
    mockIdentityRows = [];
    const pn = await IdentityService.getPnForLid('unknown@lid');
    expect(pn).toBeUndefined();
  });

  test('getLidForPn returns lid when found', async () => {
    mockIdentityRows = [{ lid: 'abc@lid' }];
    const lid = await IdentityService.getLidForPn('123@s.whatsapp.net');
    expect(lid).toBe('abc@lid');
  });

  test('getLidForPn returns undefined when not found', async () => {
    mockIdentityRows = [];
    const lid = await IdentityService.getLidForPn('unknown@s.whatsapp.net');
    expect(lid).toBeUndefined();
  });

  test('getIdentity returns identity record when found', async () => {
    mockIdentityRows = [{ lid: 'abc@lid', pn: '123@s.whatsapp.net', displayName: 'Test', platform: 'whatsapp' }];
    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
    expect(identity!.pn).toBe('123@s.whatsapp.net');
    expect(identity!.displayName).toBe('Test');
    expect(identity!.platform).toBe('whatsapp');
  });

  test('getIdentity returns null when not found', async () => {
    mockIdentityRows = [];
    const identity = await IdentityService.getIdentity('unknown@s.whatsapp.net');
    expect(identity).toBeNull();
  });

  test('getIdentity with LID JID queries correctly', async () => {
    mockIdentityRows = [{ lid: 'abc@lid', pn: '123@s.whatsapp.net', displayName: 'LID User', platform: 'whatsapp' }];
    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
  });
});
