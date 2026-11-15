import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FFmpegConverter, ffmpegConverterDeps } from '../src/utils/FFmpegConverter';
import { NORMAL_MEDIA_MAX_BYTES } from '../src/providers/media';
import type { BoundedProcessOptions } from '../src/providers/process';

const original = {
  mkdir: ffmpegConverterDeps.fs.mkdir,
  chmod: ffmpegConverterDeps.fs.chmod,
  writeFile: ffmpegConverterDeps.fs.writeFile,
  stat: ffmpegConverterDeps.fs.stat,
  readFile: ffmpegConverterDeps.fs.readFile,
  rm: ffmpegConverterDeps.fs.rm,
  crypto: ffmpegConverterDeps.crypto,
  runProcess: ffmpegConverterDeps.runProcess,
};

const mocks = {
  mkdir: mock(async () => {}),
  chmod: mock(async () => {}),
  writeFile: mock(async () => {}),
  stat: mock(async () => ({ isFile: () => true, size: 6 })),
  readFile: mock(async () => Buffer.from('output')),
  rm: mock(async () => {}),
  runProcess: mock(async (_options: BoundedProcessOptions) => undefined),
};

describe('FFmpegConverter', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.stat.mockImplementation(async () => ({ isFile: () => true, size: 6 }) as never);
    mocks.readFile.mockImplementation(async () => Buffer.from('output'));
    mocks.runProcess.mockImplementation(async () => undefined);
    ffmpegConverterDeps.fs.mkdir = mocks.mkdir as never;
    ffmpegConverterDeps.fs.chmod = mocks.chmod as never;
    ffmpegConverterDeps.fs.writeFile = mocks.writeFile as never;
    ffmpegConverterDeps.fs.stat = mocks.stat as never;
    ffmpegConverterDeps.fs.readFile = mocks.readFile as never;
    ffmpegConverterDeps.fs.rm = mocks.rm as never;
    ffmpegConverterDeps.runProcess = mocks.runProcess as never;
    ffmpegConverterDeps.crypto = {
      ...original.crypto,
      randomBytes: mock((size: number) => Buffer.from('ab'.repeat(size), 'hex')),
    } as typeof ffmpegConverterDeps.crypto;
  });

  afterEach(() => {
    ffmpegConverterDeps.fs.mkdir = original.mkdir;
    ffmpegConverterDeps.fs.chmod = original.chmod;
    ffmpegConverterDeps.fs.writeFile = original.writeFile;
    ffmpegConverterDeps.fs.stat = original.stat;
    ffmpegConverterDeps.fs.readFile = original.readFile;
    ffmpegConverterDeps.fs.rm = original.rm;
    ffmpegConverterDeps.crypto = original.crypto;
    ffmpegConverterDeps.runProcess = original.runProcess;
  });

  test('converts with private permissions and bounded output', async () => {
    const result = await FFmpegConverter.convert(Buffer.from('input'), ['-vf', 'fps=10,scale=320:-1:flags=lanczos'], 'img', 'webp');

    expect(result.toString()).toBe('output');
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), { mode: 0o600, flag: 'wx' });
    expect(mocks.runProcess).toHaveBeenCalled();
    const options = mocks.runProcess.mock.calls[0]![0];
    expect(options.args).toContain('-nostdin');
    expect(options.env).toEqual({ TMPDIR: expect.any(String) });
    expect(mocks.rm).toHaveBeenCalledWith(expect.any(String), { recursive: true, force: true });
  });

  test('rejects unsafe arguments and extensions before starting work', async () => {
    await expect(FFmpegConverter.convert(Buffer.from('input'), ['-exec', 'rm'], 'img', 'webp')).rejects.toThrow('Unsafe');
    await expect(FFmpegConverter.convert(Buffer.from('input'), ['-vf', 'movie=/etc/passwd'], 'img', 'webp')).rejects.toThrow('Unsafe');
    await expect(FFmpegConverter.convert(Buffer.from('input'), [], '../webp', 'webp')).rejects.toThrow('Invalid extension');
    expect(mocks.runProcess).not.toHaveBeenCalled();
  });

  test('cleans up and reports bounded process failures', async () => {
    mocks.runProcess.mockRejectedValueOnce(new Error('ffmpeg failed with bounded stderr'));
    await expect(FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp')).rejects.toThrow('ffmpeg failed with bounded stderr');
    expect(mocks.rm).toHaveBeenCalled();
  });

  test('rejects output above the normal media cap before reading it', async () => {
    mocks.stat.mockImplementationOnce(async () => ({ isFile: () => true, size: NORMAL_MEDIA_MAX_BYTES + 1 }) as never);
    await expect(FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp')).rejects.toThrow('exceeds');
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  test('cleans up when output reading fails', async () => {
    mocks.readFile.mockRejectedValueOnce(new Error('read failed'));
    await expect(FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp')).rejects.toThrow('read failed');
    expect(mocks.rm).toHaveBeenCalled();
  });
});

/**
 * `MediaConvertTool` advertises `quality`, `preset` and a `NNNp` resolution and
 * builds `-crf`, `-b:a`, `-preset` and `scale=-2:<height>` from them. None of
 * those were on the converter's allowlist, so every one of them threw
 * "Unsafe or unsupported FFmpeg value" and surfaced as a generic convert error.
 */
describe('FFmpegConverter option arguments built by MediaConvertTool', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.stat.mockImplementation(async () => ({ isFile: () => true, size: 6 }) as never);
    mocks.readFile.mockImplementation(async () => Buffer.from('output'));
    mocks.runProcess.mockImplementation(async () => undefined);
    ffmpegConverterDeps.fs.mkdir = mocks.mkdir as never;
    ffmpegConverterDeps.fs.chmod = mocks.chmod as never;
    ffmpegConverterDeps.fs.writeFile = mocks.writeFile as never;
    ffmpegConverterDeps.fs.stat = mocks.stat as never;
    ffmpegConverterDeps.fs.readFile = mocks.readFile as never;
    ffmpegConverterDeps.fs.rm = mocks.rm as never;
    ffmpegConverterDeps.runProcess = mocks.runProcess as never;
    ffmpegConverterDeps.crypto = {
      ...original.crypto,
      randomBytes: mock((size: number) => Buffer.from('ab'.repeat(size), 'hex')),
    } as typeof ffmpegConverterDeps.crypto;
  });

  afterEach(() => {
    ffmpegConverterDeps.fs.mkdir = original.mkdir;
    ffmpegConverterDeps.fs.chmod = original.chmod;
    ffmpegConverterDeps.fs.writeFile = original.writeFile;
    ffmpegConverterDeps.fs.stat = original.stat;
    ffmpegConverterDeps.fs.readFile = original.readFile;
    ffmpegConverterDeps.fs.rm = original.rm;
    ffmpegConverterDeps.crypto = original.crypto;
    ffmpegConverterDeps.runProcess = original.runProcess;
  });

  test.each([
    ['video quality (CRF)', ['-crf', '23']],
    ['audio quality (bitrate)', ['-b:a', '128k']],
    ['encoder preset', ['-preset', 'medium']],
    ['height-only resolution', ['-vf', 'scale=-2:720']],
    ['resolution plus fps', ['-vf', 'scale=1280:720,fps=30']],
  ])('accepts %s', async (_label, args) => {
    await expect(FFmpegConverter.convert(Buffer.from('input'), args as string[], 'mp4', 'mp4'))
      .resolves.toBeDefined();
  });

  test('still rejects an unlisted flag and a non-numeric value', async () => {
    await expect(FFmpegConverter.convert(Buffer.from('input'), ['-exec', 'rm'], 'mp4', 'mp4'))
      .rejects.toThrow(/Unsafe or unsupported/);
    await expect(FFmpegConverter.convert(Buffer.from('input'), ['-crf', 'rm -rf'], 'mp4', 'mp4'))
      .rejects.toThrow(/Unsafe or unsupported/);
  });
});
