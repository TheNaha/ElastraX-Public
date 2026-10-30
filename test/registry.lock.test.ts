import { describe, test, expect, beforeEach } from 'bun:test';
import { runMutatingTool, resetToolRateLimits } from '../src/tools/registry';
import type { BaseTool } from '../src/tools/BaseTool';
import type { MessageContext } from '../src/core/MessageContext';

describe('runMutatingTool lock recovery', () => {
  beforeEach(() => resetToolRateLimits());

  test('releases the per-key lock after a rejected task', async () => {
    const tool = {
      name: 'lock_recovery_test_tool',
      cost: 1,
      metadata: { access: { mutability: 'local-write' } },
    } as unknown as BaseTool;
    const ctx = { senderId: 'lock-user' } as unknown as MessageContext;

    await expect(runMutatingTool(tool, ctx, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const result = await runMutatingTool(tool, ctx, async () => 'ok');
    expect(result).toBe('ok');
  });
});
