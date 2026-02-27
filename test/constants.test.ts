import { describe, test, expect } from 'bun:test';
import { CANCEL_COMMANDS } from '../src/core/constants';

describe('constants', () => {
  test('CANCEL_COMMANDS contains /cancel and /batal', () => {
    expect(CANCEL_COMMANDS).toContain('/cancel');
    expect(CANCEL_COMMANDS).toContain('/batal');
    expect(CANCEL_COMMANDS).toHaveLength(2);
  });
});
