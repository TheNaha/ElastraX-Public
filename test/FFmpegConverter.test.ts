import { expect, test, describe, mock, beforeEach } from 'bun:test';
import { FFmpegConverter } from '../src/utils/FFmpegConverter';
import { EventEmitter } from 'events';

// Mock child_process
const mockSpawn = mock(() => {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = mock();
  return child;
});

mock.module('child_process', () => ({
  spawn: mockSpawn
}));

// Mock fs
const mockWriteFile = mock(async () => {});
const mockReadFile = mock(async () => Buffer.from('output'));
const mockUnlink = mock(async () => {});
const mockMkdir = mock(async () => {});

mock.module('fs', () => ({
  promises: {
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    unlink: mockUnlink,
    mkdir: mockMkdir,
  }
}));

describe('FFmpegConverter', () => {
    beforeEach(() => {
        mockSpawn.mockClear();
        mockWriteFile.mockClear();
        mockReadFile.mockClear();
        mockUnlink.mockClear();
        mockMkdir.mockClear();
    });

  test('should convert buffer successfully', async () => {
    const inputBuffer = Buffer.from('input');
    const args = ['-vf', 'scale=320:320'];

    // Setup spawn to succeed
    mockSpawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
    });

    const result = await FFmpegConverter.convert(inputBuffer, args, 'img', 'webp');

    expect(result).toBeDefined();
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
    // Verify cleanup: input file and output file (after reading)
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockReadFile).toHaveBeenCalled();
  });

  test('should handle ffmpeg failure', async () => {
    const inputBuffer = Buffer.from('input');

    // Setup spawn to fail
    mockSpawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        setTimeout(() => {
            child.stderr.emit('data', 'Error message');
            child.emit('close', 1);
        }, 10);
        return child;
    });

    try {
        await FFmpegConverter.convert(inputBuffer, [], 'img', 'webp');
    } catch (e: any) {
        expect(e.message).toContain('FFmpeg error 1');
        expect(e.message).toContain('Error message');
    }

    // Should clean up temp input file. Output file might be cleaned up too if it exists,
    // but in failure case we try to unlink output too.
    expect(mockUnlink).toHaveBeenCalled();
  });

  test('should handle spawn error', async () => {
      const inputBuffer = Buffer.from('input');

      mockSpawn.mockImplementationOnce(() => {
          const child = new EventEmitter() as any;
          child.stderr = new EventEmitter();
          setTimeout(() => child.emit('error', new Error('Spawn failed')), 10);
          return child;
      });

      try {
          await FFmpegConverter.convert(inputBuffer, [], 'img', 'webp');
      } catch (e: any) {
          expect(e.message).toBe('Spawn failed');
      }
  });

  test('should throw for invalid input extension containing special characters', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), [], 'invalid/ext', 'webp')
    ).rejects.toThrow('Invalid extension provided');
  });

  test('should throw for invalid output extension containing special characters', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), [], 'mp4', 'out.put')
    ).rejects.toThrow('Invalid extension provided');
  });
});
