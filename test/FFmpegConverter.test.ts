import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { FFmpegConverter } from '../src/utils/FFmpegConverter';
import { EventEmitter } from 'events';
import * as fsModule from 'fs';

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

// fs.promises spies — initialised in beforeEach, restored in afterEach
const mockWriteFile = mock(async () => {});
const mockReadFile = mock(async () => Buffer.from('output'));
const mockUnlink = mock(async () => {});
const mockMkdir = mock(async () => {});

let writeFileSpy: ReturnType<typeof spyOn>;
let readFileSpy: ReturnType<typeof spyOn>;
let unlinkSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;

describe('FFmpegConverter', () => {
    beforeEach(() => {
        mockSpawn.mockClear();
        mockWriteFile.mockClear();
        mockReadFile.mockClear();
        mockUnlink.mockClear();
        mockMkdir.mockClear();

        writeFileSpy = spyOn(fsModule.promises, 'writeFile').mockImplementation(mockWriteFile as any);
        readFileSpy = spyOn(fsModule.promises, 'readFile').mockImplementation(mockReadFile as any);
        unlinkSpy = spyOn(fsModule.promises, 'unlink').mockImplementation(mockUnlink as any);
        mkdirSpy = spyOn(fsModule.promises, 'mkdir').mockImplementation(mockMkdir as any);
    });

    afterEach(() => {
        writeFileSpy?.mockRestore();
        readFileSpy?.mockRestore();
        unlinkSpy?.mockRestore();
        mkdirSpy?.mockRestore();
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
    expect.assertions(3);
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

  test('should handle unlink input error gracefully on close', async () => {
    expect.assertions(2);
    const inputBuffer = Buffer.from('input');

    // Setup spawn to fail
    mockSpawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        setTimeout(() => {
            child.emit('close', 1);
        }, 10);
        return child;
    });

    // Make unlink fail
    mockUnlink.mockImplementationOnce(() => Promise.reject(new Error('unlink failed')));

    try {
        await FFmpegConverter.convert(inputBuffer, [], 'img', 'webp');
    } catch (e: any) {
        expect(e.message).toContain('FFmpeg error 1');
    }

    // We only mocked the first unlink to fail, let's see if the second one works
    expect(mockUnlink).toHaveBeenCalled();
  });

  test('should handle spawn error', async () => {
      expect.assertions(1);
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

  test('should throw for unallowed FFmpeg flags', async () => {
    await expect(
      FFmpegConverter.convert(Buffer.from('data'), ['-unallowed'], 'mp4', 'webp')
    ).rejects.toThrow('Unsafe or unsupported FFmpeg argument detected: -unallowed');
  });

  test('should allow numeric flags', async () => {
    const inputBuffer = Buffer.from('input');
    const args = ['-1', '-200'];

    // Setup spawn to succeed
    mockSpawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
    });

    const result = await FFmpegConverter.convert(inputBuffer, args, 'img', 'webp');
    expect(result).toBeDefined();
  });

  test('should handle exception during success flow in close event', async () => {
    const inputBuffer = Buffer.from('input');

    // Simulate an error in reading the file
    mockReadFile.mockImplementationOnce(async () => {
        throw new Error('Read failed');
    });

    // Setup spawn to succeed
    mockSpawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
    });

    await expect(
      FFmpegConverter.convert(inputBuffer, [], 'img', 'webp')
    ).rejects.toThrow('Read failed');
  });
});
