import { describe, test, expect, mock } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));

const mockWriteFile = mock(async () => {});
const mockMkdir = mock(async () => {});
mock.module('fs', () => ({ existsSync: () => true }));
mock.module('fs/promises', () => ({ writeFile: mockWriteFile, mkdir: mockMkdir }));
mock.module('file-type', () => ({ fileTypeFromBuffer: async () => ({ mime: 'image/png', ext: 'png' }) }));
mock.module('crypto', () => ({ randomUUID: () => 'test-uuid-1234' }));

import { saveMediaBuffer } from '../src/utils/MediaStorage';

describe('MediaStorage', () => {
  test('saveMediaBuffer returns path and mime', async () => {
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/png');
    expect(typeof result!.path).toBe('string');
  });

  test('path includes UUID filename', async () => {
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).not.toBeNull();
    expect(result!.path).toContain('test-uuid-1234');
    expect(result!.path).toContain('.png');
  });

  test('returns null on write error', async () => {
    mockWriteFile.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).toBeNull();
  });
});
