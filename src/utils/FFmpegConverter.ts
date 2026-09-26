import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { logger } from './logger';
import { HARD_MEDIA_MAX_BYTES, NORMAL_MEDIA_MAX_BYTES } from '../providers/media';
import { runBoundedProcess, type BoundedProcessOptions } from '../providers/process';

const log = logger.child({ module: 'FFmpegConverter' });
const ALLOWED_FLAGS = new Set([
  '-vcodec', '-acodec', '-vn', '-an', '-q:a', '-movflags',
  '-vf', '-loop', '-ss', '-t', '-preset', '-fps_mode',
  '-vframes', '-lossless', '-quality', '-y',
]);
const ALLOWED_VALUES = new Set([
  'libmp3lame', 'libvorbis', 'aac', 'libopus', 'pcm_s16le', 'libx264', 'faststart',
  'libvpx-vp9', 'copy', 'fps=10,scale=320:-1:flags=lanczos', '0', '1', '2', '80', 'libwebp',
]);

/**
 * The WhatsApp sticker filter graph: scale to fit 320x320, pad to a square,
 * cap at 15 fps, and quantise to a palette so transparency survives.
 *
 * It lives here, next to the allowlist that has to accept it, so the value that
 * is validated and the value that is executed can never drift apart. It is a
 * compile-time constant with no interpolation points, which is what makes it
 * safe to allow verbatim.
 */
export const STICKER_WEBP_FILTER =
  "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease,fps=15,pad=320:320:-1:-1:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse";

/** Values the sticker graph above is always paired with. */
const STICKER_ARG_VALUES = new Set(['00:00:00', '00:00:05', 'default', 'passthrough']);

export interface FFmpegConvertOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const ffmpegConverterDeps = {
  spawn,
  fs,
  path,
  crypto,
  os,
  runProcess: undefined as undefined | ((options: BoundedProcessOptions) => Promise<Awaited<ReturnType<typeof runBoundedProcess>>>),
};

export class FFmpegConverter {
  static async convert(
    inputBuffer: Buffer,
    args: string[],
    extIn: string,
    extOut: string,
    options: FFmpegConvertOptions = {},
  ): Promise<Buffer> {
    validateExtension(extIn);
    validateExtension(extOut);
    validateArguments(args);
    if (inputBuffer.length > HARD_MEDIA_MAX_BYTES) {
      throw new Error(`FFmpeg input exceeds ${HARD_MEDIA_MAX_BYTES} bytes.`);
    }
    const maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const parentDir = path.resolve(
      process.env.ELASTRAX_FFMPEG_DIR
      || process.env.ELASTRAX_TEST_FFMPEG_DIR
      || path.join(os.tmpdir(), 'elastrax-ffmpeg'),
    );
    const jobId = crypto.randomBytes(16).toString('hex');
    const jobDir = path.join(parentDir, jobId);
    const inputPath = path.join(jobDir, `input.${extIn}`);
    const outputPath = path.join(jobDir, `output.${extOut}`);

    await ffmpegConverterDeps.fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await ffmpegConverterDeps.fs.chmod(parentDir, 0o700);
    await ffmpegConverterDeps.fs.mkdir(jobDir, { recursive: false, mode: 0o700 });
    try {
      await ffmpegConverterDeps.fs.writeFile(inputPath, inputBuffer, { mode: 0o600, flag: 'wx' });
      const argsList = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, ...args, outputPath];
      const run = ffmpegConverterDeps.runProcess ?? (runOptions => runBoundedProcess({ ...runOptions, spawn: ffmpegConverterDeps.spawn }));
      await run({
        command: 'ffmpeg',
        args: argsList,
        cwd: jobDir,
        kind: 'ffmpeg',
        timeoutMs,
        signal: options.signal,
        stdoutLimitBytes: 64 * 1024,
        stderrLimitBytes: 64 * 1024,
        env: { TMPDIR: jobDir },
        spawn: ffmpegConverterDeps.spawn,
        watchDirectory: { path: jobDir, maxBytes: HARD_MEDIA_MAX_BYTES },
      });
      const info = await ffmpegConverterDeps.fs.stat(outputPath);
      if (!info.isFile()) throw new Error('FFmpeg output is not a regular file.');
      if (info.size > maxOutputBytes) throw new Error(`FFmpeg output exceeds ${maxOutputBytes} bytes.`);
      const data = await ffmpegConverterDeps.fs.readFile(outputPath);
      if (data.length > maxOutputBytes) throw new Error(`FFmpeg output exceeds ${maxOutputBytes} bytes.`);
      log.debug({ extIn, extOut, inputSize: inputBuffer.length, outputSize: data.length }, 'FFmpeg conversion completed');
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error, extIn, extOut }, 'FFmpeg conversion failed');
      throw new Error(`FFmpeg error: ${message.slice(0, 1000)}`, { cause: error });
    } finally {
      await ffmpegConverterDeps.fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function validateExtension(extension: string): void {
  if (!/^[a-zA-Z0-9]{1,12}$/.test(extension)) throw new Error('Invalid extension provided');
}

function validateArguments(args: string[]): void {
  for (const arg of args) {
    if (arg.startsWith('-') && !ALLOWED_FLAGS.has(arg) && !/^-\d+$/.test(arg)) {
      throw new Error(`Unsafe or unsupported FFmpeg argument detected: ${arg}`);
    }
    if (!arg.startsWith('-')
      && !ALLOWED_VALUES.has(arg)
      && !STICKER_ARG_VALUES.has(arg)
      && arg !== STICKER_WEBP_FILTER
      && !/^scale=\d{1,4}:\d{1,4}$/.test(arg)
      && !/^fps=\d{1,3}(?:,\d{1,4}:\d{1,4})?$/.test(arg)) {
      throw new Error(`Unsafe or unsupported FFmpeg value detected: ${arg}`);
    }
  }
}

function normalizeOutputLimit(value?: number): number {
  const resolved = value ?? NORMAL_MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error('FFmpeg output limit must be a positive safe integer.');
  return Math.min(resolved, HARD_MEDIA_MAX_BYTES);
}
