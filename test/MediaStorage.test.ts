import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { saveMediaBuffer } from '../src/utils/MediaStorage';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as crypto from 'crypto';

describe('MediaStorage', () => {
  let existsSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;
  let uuidSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    mkdirSpy = spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined as any);
    uuidSpy = spyOn(crypto, 'randomUUID').mockReturnValue('test-uuid-1234' as any);
  });

  afterEach(() => {
    existsSpy.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    uuidSpy.mockRestore();
  });

  test('saveMediaBuffer returns path and mime', async () => {
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).not.toBeNull();
    expect(typeof result!.mime).toBe('string');
    expect(typeof result!.path).toBe('string');
  });

  test('path includes UUID filename', async () => {
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).not.toBeNull();
    expect(result!.path).toContain('test-uuid-1234');
  });

  test('returns null on write error', async () => {
    writeFileSpy.mockRejectedValueOnce(new Error('disk full'));
    const buffer = Buffer.from('fake-image-data');
    const result = await saveMediaBuffer(buffer);
    expect(result).toBeNull();
  });
});
