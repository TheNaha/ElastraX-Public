import { expect, test, describe, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { FFmpegConverter, ffmpegConverterDeps } from '../src/utils/FFmpegConverter';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const originalSpawn = ffmpegConverterDeps.spawn;
const originalMkdir = ffmpegConverterDeps.fs.mkdir;
const originalWriteFile = ffmpegConverterDeps.fs.writeFile;
const originalReadFile = ffmpegConverterDeps.fs.readFile;
const originalUnlink = ffmpegConverterDeps.fs.unlink;
const originalCrypto = ffmpegConverterDeps.crypto;

const mockSpawn = mock(() => {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof mock>;
  };
  child.stderr = new EventEmitter();
  child.kill = mock();
  return child as never;
});

const mockWriteFile = mock(async () => {});
const mockReadFile = mock(async () => Buffer.from('output'));
const mockUnlink = mock(async () => {});
const mockMkdir = mock(async () => {});

describe('FFmpegConverter', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockUnlink.mockClear();
    mockMkdir.mockClear();

    ffmpegConverterDeps.spawn = mockSpawn as typeof ffmpegConverterDeps.spawn;
    ffmpegConverterDeps.fs.mkdir = mockMkdir as typeof ffmpegConverterDeps.fs.mkdir;
    ffmpegConverterDeps.fs.writeFile = mockWriteFile as typeof ffmpegConverterDeps.fs.writeFile;
    ffmpegConverterDeps.fs.readFile = mockReadFile as unknown as typeof ffmpegConverterDeps.fs.readFile;
    ffmpegConverterDeps.fs.unlink = mockUnlink as typeof ffmpegConverterDeps.fs.unlink;
    ffmpegConverterDeps.crypto = {
      ...originalCrypto,
      randomBytes: mock((size: number) => Buffer.from('ab'.repeat(size), 'hex')),
    } as typeof ffmpegConverterDeps.crypto;
  });

  afterEach(() => {
    ffmpegConverterDeps.spawn = originalSpawn;
    ffmpegConverterDeps.fs.mkdir = originalMkdir;
    ffmpegConverterDeps.fs.writeFile = originalWriteFile;
    ffmpegConverterDeps.fs.readFile = originalReadFile;
    ffmpegConverterDeps.fs.unlink = originalUnlink;
    ffmpegConverterDeps.crypto = originalCrypto;
  });

  test('should convert buffer successfully', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 10);
      return child as never;
    });

    const result = await FFmpegConverter.convert(Buffer.from('input'), ['-vf', 'scale=320:320'], 'img', 'webp');

    expect(result).toBeDefined();
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockReadFile).toHaveBeenCalled();
  });

  test('should handle ffmpeg failure', async () => {
    expect.assertions(3);

    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => {
        child.stderr.emit('data', 'Error message');
        child.emit('close', 1);
      }, 10);
      return child as never;
    });

    try {
      await FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp');
    } catch (e: any) {
      expect(e.message).toContain('FFmpeg error 1');
      expect(e.message).toContain('Error message');
    }

    expect(mockUnlink).toHaveBeenCalled();
  });

  test('should handle unlink input error gracefully on close', async () => {
    expect.assertions(2);

    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => {
        child.emit('close', 1);
      }, 10);
      return child as never;
    });
    mockUnlink.mockImplementationOnce(() => Promise.reject(new Error('unlink failed')));

    try {
      await FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp');
    } catch (e: any) {
      expect(e.message).toContain('FFmpeg error 1');
    }

    expect(mockUnlink).toHaveBeenCalled();
  });

  test('should handle spawn error', async () => {
    expect.assertions(1);

    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('error', new Error('Spawn failed')), 10);
      return child as never;
    });

    try {
      await FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp');
    } catch (e: any) {
      expect(e.message).toBe('Spawn failed');
    }
  });

  test('should throw for invalid input extension containing special characters', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), [], 'invalid/ext', 'webp'),
    ).rejects.toThrow('Invalid extension provided');
  });

  test('should throw for invalid output extension containing special characters', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), [], 'mp4', 'out.put'),
    ).rejects.toThrow('Invalid extension provided');
  });

  test('should throw for unallowed FFmpeg flags', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), ['-unallowed'], 'mp4', 'webp'),
    ).rejects.toThrow('Unsafe or unsupported FFmpeg argument detected: -unallowed');
  });

  test('should allow numeric flags', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 10);
      return child as never;
    });

    const result = await FFmpegConverter.convert(Buffer.from('input'), ['-1', '-200'], 'img', 'webp');
    expect(result).toBeDefined();
  });

  test('should handle exception during success flow in close event', async () => {
    mockReadFile.mockImplementationOnce(async () => {
      throw new Error('Read failed');
    });
    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 10);
      return child as never;
    });

    await expect(
      FFmpegConverter.convert(Buffer.from('input'), [], 'img', 'webp'),
    ).rejects.toThrow('Read failed');
  });
});
