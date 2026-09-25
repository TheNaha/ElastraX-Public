import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getTestWorkerPaths } from './helpers/paths';
import { resolveTargetMedia } from '../src/utils/mediaResolve';
import type { MessageContext } from '../src/core/MessageContext';

const rootDir = join(getTestWorkerPaths().root, `media-selection-${randomUUID()}`);
await mkdir(rootDir, { recursive: true, mode: 0o700 });

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('resolveTargetMedia attachment selection', () => {
  test('selects the requested multi-attachment target', async () => {
    const first = join(rootDir, 'first.txt');
    const second = join(rootDir, 'second.txt');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    let selected = first;
    const requested: string[] = [];

    const ctx = {
      get mediaPath() { return selected; },
      mimeType: 'text/plain',
      quoted: undefined,
      mediaAttachments: [
        { id: 'one', providerAttachmentId: 'one', index: 0, sizeBytes: 5, mimeType: 'text/plain' },
        { id: 'two', providerAttachmentId: 'two', index: 1, sizeBytes: 6, mimeType: 'text/plain' },
      ],
      mediaReady: Promise.resolve(),
      async selectMediaAttachment(id: string) {
        selected = id === 'one' ? first : second;
      },
      async downloadMedia(id?: string) {
        requested.push(id ?? '');
        return Buffer.from(id === 'one' ? first : second);
      },
    } as unknown as MessageContext;

    const result = await resolveTargetMedia(ctx, { attachmentId: 'two', useDownloader: true });
    expect(result?.path).toBe(second);
    expect(selected).toBe(second);
    expect(requested).toEqual([]);
  });

  test('rejects an unknown attachment identifier', async () => {
    const ctx = {
      mediaAttachments: [],
      mediaReady: Promise.resolve(),
    } as unknown as MessageContext;
    expect(resolveTargetMedia(ctx, { attachmentId: 'missing' })).rejects.toThrow('Attachment not found');
  });
});
