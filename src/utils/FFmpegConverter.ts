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

    log.debug({ extIn, extOut, inputSize: inputBuffer.length }, 'FFmpeg conversion starting');

    const tmpDir = path.join(os.tmpdir(), 'elastrax-tmp');
    await fs.mkdir(tmpDir, { recursive: true });

    const randId = crypto.randomBytes(8).toString('hex');
    const tmpIn = path.join(tmpDir, `${randId}.${extIn}`);
    const tmpOut = path.join(tmpDir, `${randId}.${extOut}`);

    await fs.writeFile(tmpIn, inputBuffer);

    const ffmpegArgs = [
      '-y',
      '-i', tmpIn,
      ...args,
      tmpOut
    ];

    return new Promise((resolve, reject) => {
      // It is assumed ffmpeg is installed on the host system
      const child = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';

      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', async (code) => {
        try {
          // Cleanup temp input
          await fs.unlink(tmpIn).catch(() => {});
          
          if (code !== 0) {
            await fs.unlink(tmpOut).catch(() => {});
            log.error({ code, stderr: stderr.slice(-300), extIn, extOut }, 'FFmpeg conversion failed');
            return reject(new Error(`FFmpeg error ${code}: ${stderr}`));
          }
          
          // Read success output and cleanup
          const data = await fs.readFile(tmpOut);
          await fs.unlink(tmpOut).catch(() => {});
          log.debug({ extIn, extOut, outputSize: data.length }, 'FFmpeg conversion completed');
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
