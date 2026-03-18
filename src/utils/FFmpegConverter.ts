/**
 * @file src/utils/FFmpegConverter.ts
 * @description Low-level buffer-to-buffer FFmpeg wrapper used by `StickerUtils`.
 *
 * Spawns an FFmpeg child process with caller-supplied arguments to convert an
 * input buffer (written to a temporary file) into an output buffer (read back
 * from a temporary file).  Temporary files are cleaned up regardless of success
 * or failure.
 *
 * Prerequisites:
 *  - `ffmpeg` must be available on the system `PATH`.  Install via your OS package
 *    manager (e.g., `apt install ffmpeg`, `brew install ffmpeg`) or the Dockerfile.
 *
 * Security:
 *  - File extensions are validated against a strict alphanumeric allowlist before
 *    being interpolated into the file path to prevent path-traversal attacks.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { logger } from './logger';

const log = logger.child({ module: 'FFmpegConverter' });

const ALLOWED_FLAGS = new Set([
  '-vcodec', '-acodec', '-vn', '-an', '-q:a', '-movflags',
  '-vf', '-loop', '-ss', '-t', '-preset', '-vsync',
  '-vframes', '-lossless', '-quality', '-y', '-i'
]);

export const ffmpegConverterDeps = {
  spawn,
  fs,
  path,
  crypto,
  os,
};

/** Utility class that wraps FFmpeg for buffer-to-buffer media conversion. */
export class FFmpegConverter {
  /**
   * Converts an in-memory buffer from one format to another using FFmpeg.
   *
   * The caller supplies the FFmpeg arguments that sit between the `-i <input>`
   * and the `<output>` file arguments.  For example, to convert to WebP:
   * ```ts
   * FFmpegConverter.convert(imageBuffer, ['-vcodec', 'libwebp'], 'png', 'webp');
   * ```
   *
   * @param inputBuffer - Raw bytes of the input file.
   * @param args        - Additional FFmpeg CLI arguments placed between input and output.
   * @param extIn       - Input file extension (e.g., `'mp4'`, `'png'`).  Alphanumeric only.
   * @param extOut      - Output file extension (e.g., `'webp'`).  Alphanumeric only.
   * @returns           - Raw bytes of the converted output file.
   * @throws            - On invalid extensions, FFmpeg non-zero exit, or I/O errors.
   */
  static async convert(inputBuffer: Buffer, args: string[], extIn: string, extOut: string): Promise<Buffer> {
    if (!/^[a-zA-Z0-9]+$/.test(extIn) || !/^[a-zA-Z0-9]+$/.test(extOut)) {
      throw new Error('Invalid extension provided');
    }

    // Security: Validate all caller-supplied args against the allowlist to prevent argument injection.
    for (const arg of args) {
      if (arg.startsWith('-') && !ALLOWED_FLAGS.has(arg) && !/^-\d+$/.test(arg)) {
        throw new Error(`Unsafe or unsupported FFmpeg argument detected: ${arg}`);
      }
    }

    log.debug({ extIn, extOut, inputSize: inputBuffer.length }, 'FFmpeg conversion starting');

    const tmpDir = ffmpegConverterDeps.path.join(ffmpegConverterDeps.os.tmpdir(), 'elastrax-tmp');
    await ffmpegConverterDeps.fs.mkdir(tmpDir, { recursive: true });

    const randId = ffmpegConverterDeps.crypto.randomBytes(8).toString('hex');
    const tmpIn = ffmpegConverterDeps.path.join(tmpDir, `${randId}.${extIn}`);
    const tmpOut = ffmpegConverterDeps.path.join(tmpDir, `${randId}.${extOut}`);

    await ffmpegConverterDeps.fs.writeFile(tmpIn, inputBuffer);

    const ffmpegArgs = [
      '-y',
      '-i', tmpIn,
      ...args,
      tmpOut
    ];

    return new Promise((resolve, reject) => {
      // It is assumed ffmpeg is installed on the host system
      const child = ffmpegConverterDeps.spawn('ffmpeg', ffmpegArgs);
      let stderr = '';

      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', async (code) => {
        try {
          // Cleanup temp input
          await ffmpegConverterDeps.fs.unlink(tmpIn).catch(() => {});
          
          if (code !== 0) {
            await ffmpegConverterDeps.fs.unlink(tmpOut).catch(() => {});
            log.error({ code, stderr: stderr.slice(-300), extIn, extOut }, 'FFmpeg conversion failed');
            return reject(new Error(`FFmpeg error ${code}: ${stderr}`));
          }
          
          // Read success output and cleanup
          const data = await ffmpegConverterDeps.fs.readFile(tmpOut);
          await ffmpegConverterDeps.fs.unlink(tmpOut).catch(() => {});
          log.debug({ extIn, extOut, outputSize: data.length }, 'FFmpeg conversion completed');
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
