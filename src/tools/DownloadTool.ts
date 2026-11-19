import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { BaseTool, type ToolArgs, type ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { getDownloadMaxMb, getYtDlpPath } from '../config/runtime';
import { AuthService } from '../utils/AuthService';
import { HARD_MEDIA_MAX_BYTES, MIB } from '../providers/media';
import { runBoundedProcess, type BoundedProcessOptions, type BoundedProcessResult } from '../providers/process';
import { SsrfSafeProxy, validateSsrfUrl, type SafeNetworkTarget } from '../providers/ssrf';
import {
  needsPhoneTranscode,
  parseVideoProbe,
  phoneTranscodeArgs,
  type ProbedVideo,
} from '../utils/videoCompat';

const log = logger.child({ module: 'DownloadTool' });

type AudioFormat = 'mp3' | 'aac' | 'm4a' | 'ogg' | 'opus';
type VideoFormat = 'mp4' | 'mkv' | 'webm';
type DownloadFormat = AudioFormat | VideoFormat;
type DownloadArgs = ToolArgs & {
  url?: string;
  format?: DownloadFormat;
  max_resolution?: string; // e.g. "1080p", "720p", "480p"
  max_fps?: string; // e.g. "30", "60"
  audio_quality?: string; // 0-10 for audio extraction quality
};

const VALID_RESOLUTIONS = ['8k', '4k', '1080p', '720p', '480p', '360p', '240p'];
const VALID_FPS = ['24', '30', '48', '60', '120'];

/**
 * Validate an audio quality string (0-10, where 0 is best for VBR).
 */
function validateAudioQuality(quality: string | undefined): string | undefined {
  if (quality === undefined || quality === '') return undefined;
  const parsed = Number.parseInt(quality, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) return undefined;
  return String(parsed);
}

/**
 * Validate a max resolution string (e.g. "1080p", "720p").
 */
function validateResolution(res: string | undefined): string | undefined {
  if (res === undefined || res === '') return undefined;
  const normalized = res.toLowerCase().trim();
  if (!VALID_RESOLUTIONS.includes(normalized)) return undefined;
  return normalized;
}

/**
 * Validate a max FPS string (e.g. "30", "60").
 */
function validateFps(fps: string | undefined): string | undefined {
  if (fps === undefined || fps === '') return undefined;
  if (!VALID_FPS.includes(fps)) return undefined;
  return fps;
}

/**
 * Build a yt-dlp format selector string that constrains resolution and FPS.
 * Falls back to the default best-quality selector when constraints are invalid.
 *
 * H.264 (`avc1`) is preferred over the better-scoring AV1/VP9 streams YouTube
 * also serves in an MP4 container: those play in desktop/web WhatsApp but the
 * phone players reject them. The post-download guard in `downloadViaYtDlp`
 * still transcodes whatever the selector falls back to.
 */
function buildVideoFormatSelector(resolution: string | undefined, fps: string | undefined): string {
  const res = validateResolution(resolution);
  const maxFps = validateFps(fps);
  let heightFilter = '';
  if (res) {
    const heightMap: Record<string, number> = {
      '240p': 240, '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160, '8k': 4320,
    };
    heightFilter = `[height<=${heightMap[res] ?? 1080}]`;
  }
  let fpsFilter = '';
  if (maxFps) fpsFilter = `[fps<=${maxFps}]`;
  const constraint = heightFilter + fpsFilter;
  return [
    `bv*[vcodec^=avc1][ext=mp4]${constraint}+ba[acodec^=mp4a]`,
    `bv*[vcodec^=avc1]${constraint}+ba`,
    `best${constraint}[ext=mp4]`,
    `best${constraint}`,
  ].join('/');
}

const AUDIO_FORMATS = new Set<DownloadFormat>(['mp3', 'aac', 'm4a', 'ogg', 'opus']);
const VIDEO_FORMATS = new Set<DownloadFormat>(['mp4', 'mkv', 'webm']);
const FORMAT_MIME: Record<DownloadFormat, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

export interface DownloadQualityOptions {
  /** Maximum resolution to download (e.g. "1080p", "720p", "480p"). */
  max_resolution?: string;
  /** Maximum frame rate to download (e.g. "30", "60"). */
  max_fps?: string;
  /** Audio extraction quality (0–10, where 0 is best). */
  audio_quality?: string;
}

export interface DownloadViaYtDlpOptions extends DownloadQualityOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  validateUrl?: (url: string) => Promise<SafeNetworkTarget>;
  createProxy?: () => SsrfSafeProxy;
}

export const downloadToolDeps = {
  spawn,
  fs,
  path,
  os,
  crypto,
  validateUrl: validateSsrfUrl,
  createProxy: () => new SsrfSafeProxy(),
  runProcess: undefined as undefined | ((options: BoundedProcessOptions) => Promise<BoundedProcessResult | void>),
};

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

type ProcessRunner = (options: BoundedProcessOptions) => Promise<BoundedProcessResult | void>;

const FFPROBE_COMMAND = 'ffprobe';
const FFMPEG_COMMAND = 'ffmpeg';
const PROBE_TIMEOUT_MS = 30_000;

/** Read the video/audio stream facts with ffprobe. `null` when it cannot be read. */
async function probeVideoFile(
  inputPath: string,
  run: ProcessRunner,
  signal?: AbortSignal,
): Promise<ProbedVideo | null> {
  const result = await run({
    command: FFPROBE_COMMAND,
    args: ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', inputPath],
    cwd: downloadToolDeps.path.dirname(inputPath),
    kind: 'ffprobe',
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
    stdoutLimitBytes: 256 * 1024,
    stderrLimitBytes: 64 * 1024,
    spawn: downloadToolDeps.spawn,
  });
  const stdout = result?.stdout;
  if (!stdout) return null;
  return parseVideoProbe(Buffer.from(stdout).toString('utf8'));
}

/**
 * Re-encode a video into the shape WhatsApp's phone players accept.
 *
 * Runs as a separate ffmpeg pass rather than through `yt-dlp --recode-video`
 * because that flag only converts when the *container* differs: an AV1 stream
 * merged into an `.mp4` is already "mp4" and is therefore left untouched.
 */
async function transcodeForPhone(
  inputPath: string,
  info: ProbedVideo,
  run: ProcessRunner,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  const outputPath = `${inputPath.replace(/\.[a-zA-Z0-9]+$/, '')}.phone.mp4`;
  await run({
    command: FFMPEG_COMMAND,
    args: [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      ...phoneTranscodeArgs(info),
      outputPath,
    ],
    cwd: downloadToolDeps.path.dirname(inputPath),
    kind: 'ffmpeg',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    stdoutLimitBytes: 64 * 1024,
    stderrLimitBytes: 64 * 1024,
    env: { TMPDIR: downloadToolDeps.path.dirname(inputPath) },
    spawn: downloadToolDeps.spawn,
  });
  return outputPath;
}

/**
 * Make a downloaded video playable by WhatsApp on a phone.
 *
 * Returns the input path unchanged when it is already compatible or when it
 * cannot be probed. A transcode failure propagates: sending a file known to be
 * rejected is the bug being fixed, so the caller must surface it.
 */
export async function normalizeVideoForWhatsApp(
  inputPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const run: ProcessRunner = downloadToolDeps.runProcess ?? (runOptions => runBoundedProcess(runOptions));
  let probed: ProbedVideo | null;
  try {
    probed = await probeVideoFile(inputPath, run, options.signal);
  } catch (error) {
    // Do not break a deployment that simply lacks ffprobe: ffmpeg itself is
    // already required by `--recode-video`. The file is sent unchanged.
    log.warn({ err: error }, 'Could not probe the downloaded video; sending it unchanged');
    return inputPath;
  }
  if (!probed || !needsPhoneTranscode(probed)) return inputPath;
  log.info(
    {
      vcodec: probed.vcodec, acodec: probed.acodec, pixFmt: probed.pixFmt,
      width: probed.width, height: probed.height,
    },
    'Transcoding download to a WhatsApp-phone-compatible MP4',
  );
  return transcodeForPhone(inputPath, probed, run, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
}

export async function downloadViaYtDlp(
  url: string,
  format: DownloadFormat,
  maxMb: number,
  options: DownloadViaYtDlpOptions = {},
): Promise<Buffer> {
  if (!AUDIO_FORMATS.has(format) && !VIDEO_FORMATS.has(format)) throw new Error('Invalid download format.');
  if (!Number.isFinite(maxMb) && maxMb !== Infinity) throw new Error('Invalid download size limit.');
  const validate = options.validateUrl || downloadToolDeps.validateUrl;
  const createProxy = options.createProxy || downloadToolDeps.createProxy;
  await validate(url);
  const effectiveBytes = Math.min(
    HARD_MEDIA_MAX_BYTES,
    maxMb === Infinity ? HARD_MEDIA_MAX_BYTES : Math.max(1, Math.floor(maxMb * MIB)),
  );
  const parentDir = downloadToolDeps.path.resolve(
    process.env.ELASTRAX_DOWNLOAD_DIR
      || process.env.ELASTRAX_TEST_DOWNLOAD_DIR
      || downloadToolDeps.path.join(downloadToolDeps.os.tmpdir(), 'elastrax-downloads'),
  );
  const jobId = downloadToolDeps.crypto.randomBytes(16).toString('hex');
  const workDir = downloadToolDeps.path.join(parentDir, jobId);
  const outputId = downloadToolDeps.crypto.randomBytes(8).toString('hex');
  const outputTemplate = downloadToolDeps.path.join(workDir, `${outputId}.%(ext)s`);
  const proxy = createProxy();
  let proxyStarted = false;
  const ytDlpPath = getYtDlpPath();

  try {
    await downloadToolDeps.fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await downloadToolDeps.fs.chmod(parentDir, 0o700);
    await downloadToolDeps.fs.mkdir(workDir, { recursive: false, mode: 0o700 });
    await proxy.start();
    proxyStarted = true;
    const args = [
      '--proxy', proxy.url,
      '--no-playlist',
      '--no-cache-dir',
      '--no-progress',
      '--no-warnings',
      '--no-part',
      '--socket-timeout', '20',
      '--retries', '2',
      '--fragment-retries', '2',
      '--file-access-retries', '1',
      '--max-filesize', `${Math.max(1, Math.floor(effectiveBytes / MIB))}m`,
      '-o', outputTemplate,
    ];
    if (AUDIO_FORMATS.has(format)) {
      args.push('-x', '--audio-format', format);
      const audioQuality = validateAudioQuality(options.audio_quality);
      if (audioQuality !== undefined) args.push('--audio-quality', audioQuality);
      else args.push('--audio-quality', '0');
    } else {
      const fmt = buildVideoFormatSelector(options.max_resolution, options.max_fps);
      args.push('-f', fmt, '--recode-video', format);
    }
    args.push('--', url);
    const run = downloadToolDeps.runProcess || (runOptions => runBoundedProcess(runOptions));
    await run({
      command: ytDlpPath,
      args,
      cwd: workDir,
      kind: 'yt-dlp',
      timeoutMs: options.timeoutMs ?? 300_000,
      signal: options.signal,
      stdoutLimitBytes: 64 * 1024,
      stderrLimitBytes: 64 * 1024,
      env: {
        HOME: workDir,
        XDG_CONFIG_HOME: workDir,
        XDG_CACHE_HOME: workDir,
        TMPDIR: workDir,
        NO_PROXY: '',
        no_proxy: '',
      },
      spawn: downloadToolDeps.spawn,
      watchDirectory: { path: workDir, maxBytes: effectiveBytes },
    });

    const names = await downloadToolDeps.fs.readdir(workDir);
    const matches = names.filter(name => name.startsWith(outputId));
    if (matches.length !== 1) throw new Error(`yt-dlp produced ${matches.length} output files.`);
    const match = matches[0]!;
    if (!/^[a-zA-Z0-9._-]+$/.test(match)) throw new Error('Invalid output filename produced by downloader.');
    const outputPath = downloadToolDeps.path.resolve(workDir, match);
    const relative = downloadToolDeps.path.relative(downloadToolDeps.path.resolve(workDir), outputPath);
    if (!relative || relative.startsWith('..') || downloadToolDeps.path.isAbsolute(relative)) throw new Error('Path traversal detected in downloader output.');
    const info = await downloadToolDeps.fs.stat(outputPath);
    if (!info.isFile()) throw new Error('Downloader output is not a regular file.');
    if (info.size > effectiveBytes) throw new Error(`Download exceeds the ${Math.floor(effectiveBytes / MIB)} MB limit.`);

    // A YouTube MP4 is often AV1/VP9 inside the container (desktop WhatsApp
    // plays it, phones reject it), and `--recode-video mp4` does not touch a
    // file whose container is already MP4. Probe and, when needed, transcode to
    // H.264/AAC/yuv420p, capped at 1080p.
    let finalPath = outputPath;
    if (format === 'mp4') {
      finalPath = await normalizeVideoForWhatsApp(outputPath, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 300_000,
      });
      if (finalPath !== outputPath) {
        const transcoded = await downloadToolDeps.fs.stat(finalPath);
        if (!transcoded.isFile()) throw new Error('Transcoded output is not a regular file.');
        if (transcoded.size > effectiveBytes) {
          throw new Error(`Download exceeds the ${Math.floor(effectiveBytes / MIB)} MB limit after transcoding.`);
        }
      }
    }

    const buffer = await downloadToolDeps.fs.readFile(finalPath);
    if (buffer.length > effectiveBytes) throw new Error(`Download exceeds the ${Math.floor(effectiveBytes / MIB)} MB limit.`);
    return buffer;
  } finally {
    if (proxyStarted) await proxy.close().catch(() => undefined);
    await downloadToolDeps.fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class DownloadTool extends BaseTool<DownloadArgs> {
  readonly name = 'download_media';
  readonly description = 'Download audio/video from a public HTTP(S) URL (YouTube, TikTok, Instagram, etc). Default: mp4 for video, mp3 for audio. MP4 video is converted to the H.264/AAC 1080p profile WhatsApp phones can play.';
  readonly aliases = ['download', 'dl'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/https?:\/\//i, /\b(download|unduh)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The public HTTP(S) media URL to download.' },
            format: {
              type: 'string',
              enum: [...AUDIO_FORMATS, ...VIDEO_FORMATS],
              description: 'Output format. Use mp3 for audio-only, mp4 for video. Default: mp4',
            },
            max_resolution: {
              type: 'string',
              enum: VALID_RESOLUTIONS,
              description: 'Maximum video resolution to download (e.g. "1080p", "720p"). Only for video formats.',
            },
            max_fps: {
              type: 'string',
              enum: VALID_FPS,
              description: 'Maximum frame rate to download (e.g. "30", "60"). Only for video formats.',
            },
            audio_quality: {
              type: 'string',
              description: 'Audio quality 0-10 for audio extraction (0 is best). Only for audio formats.',
            },
          },
          required: ['url'],
        },
      },
    };
  }

  async execute(args: DownloadArgs, ctx: MessageContext, signal?: AbortSignal): Promise<string> {
    const language = ctx.language || 'en';
    const url = String(args.url || '').trim();
    const format = (args.format || 'mp4') as DownloadFormat;
    if (!url) return t(language, 'download.no_url');
    if (!AUDIO_FORMATS.has(format) && !VIDEO_FORMATS.has(format)) {
      return t(language, 'download.error', { msg: t(language, 'download.invalid_format') });
    }
    if (args.max_resolution && VIDEO_FORMATS.has(format)) {
      const res = validateResolution(args.max_resolution);
      if (!res) return t(language, 'download.invalid_resolution');
    }
    if (args.max_fps && VIDEO_FORMATS.has(format) && !validateFps(args.max_fps)) {
      return t(language, 'download.error', { msg: t(language, 'download.invalid_fps') });
    }
    if (args.audio_quality && AUDIO_FORMATS.has(format)) {
      const q = validateAudioQuality(args.audio_quality);
      if (!q) return t(language, 'download.error', { msg: t(language, 'download.invalid_audio_quality') });
    }
    try {
      await downloadToolDeps.validateUrl(url);
    } catch (error) {
      return t(language, 'download.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
    if (!ctx.sendMedia) return t(language, 'download.not_supported');
    /** Kept outside the try so a size failure can name the limit it hit. */
    let effectiveMaxMb: number | null = null;
    try {
      const roles = await ctx.resolveRoles();
      const privileges = await AuthService.getEffectivePrivileges(roles);
      const maxMb = privileges.maxDownloadMb === -1 ? Infinity : privileges.maxDownloadMb || getDownloadMaxMb();
      effectiveMaxMb = maxMb;
      await ctx.react?.('⬇️');
      await ctx.reply(t(language, 'download.starting'));
      log.info({ url: redactUrl(url), format, max_resolution: args.max_resolution, max_fps: args.max_fps, audio_quality: args.audio_quality, chatId: ctx.chatId, senderId: ctx.senderId }, 'Download started');
      const timeoutSignal = AbortSignal.timeout(310_000);
      const operationSignals = [signal, ctx.signal, timeoutSignal].filter((value): value is AbortSignal => !!value);
      const buffer = await downloadViaYtDlp(url, format, maxMb, {
        signal: AbortSignal.any(operationSignals),
        max_resolution: args.max_resolution,
        max_fps: args.max_fps,
        audio_quality: args.audio_quality,
      });
      await ctx.react?.('📤');
      await ctx.sendMedia(buffer, {
        mimetype: FORMAT_MIME[format],
        filename: `download.${format}`,
        ptt: false,
      });
      return t(language, 'download.success');
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error({ err: error, url: redactUrl(url), format }, 'Download failed');
      if (errorMessage.includes('Download exceeds the')) {
        const limitMb = effectiveMaxMb !== null && Number.isFinite(effectiveMaxMb)
          ? String(effectiveMaxMb)
          : String(Math.floor(HARD_MEDIA_MAX_BYTES / MIB));
        return t(language, 'download.too_large', { max: limitMb });
      }
      if (errorMessage.includes('not found') || errorMessage.includes('YTDLP_PATH')) return t(language, 'download.ytdlp_missing');
      if (errorMessage.includes('error while loading shared libraries')) {
        return t(language, 'download.ytdlp_broken', {
          msg: errorMessage.slice(0, 200),
        });
      }
      return t(language, 'download.error', { msg: errorMessage.slice(0, 200) });
    }
  }
}
