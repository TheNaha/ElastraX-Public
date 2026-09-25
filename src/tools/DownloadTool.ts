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
import { getDownloadMaxMb } from '../config/runtime';
import { AuthService } from '../utils/AuthService';
import { HARD_MEDIA_MAX_BYTES, MIB } from '../providers/media';
import { runBoundedProcess, type BoundedProcessOptions } from '../providers/process';
import { SsrfSafeProxy, validateSsrfUrl, type SafeNetworkTarget } from '../providers/ssrf';

const log = logger.child({ module: 'DownloadTool' });

type AudioFormat = 'mp3' | 'aac' | 'm4a' | 'ogg' | 'opus';
type VideoFormat = 'mp4' | 'mkv' | 'webm';
type DownloadFormat = AudioFormat | VideoFormat;
type DownloadArgs = ToolArgs & { url?: string; format?: DownloadFormat };

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

export interface DownloadViaYtDlpOptions {
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
  runProcess: undefined as undefined | ((options: BoundedProcessOptions) => Promise<void>),
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
    if (AUDIO_FORMATS.has(format)) args.push('-x', '--audio-format', format, '--audio-quality', '0');
    else args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--recode-video', format);
    args.push('--', url);
    const run = downloadToolDeps.runProcess || (runOptions => runBoundedProcess(runOptions));
    await run({
      command: process.env.YTDLP_PATH || 'yt-dlp',
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
    const buffer = await downloadToolDeps.fs.readFile(outputPath);
    if (buffer.length > effectiveBytes) throw new Error(`Download exceeds the ${Math.floor(effectiveBytes / MIB)} MB limit.`);
    return buffer;
  } finally {
    if (proxyStarted) await proxy.close().catch(() => undefined);
    await downloadToolDeps.fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class DownloadTool extends BaseTool<DownloadArgs> {
  readonly name = 'download_media';
  readonly description = 'Download audio/video from a public HTTP(S) URL (YouTube, TikTok, Instagram, etc). Default: mp4 for video, mp3 for audio.';
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
      return t(language, 'download.error', { msg: 'Invalid format requested.' });
    }
    try {
      await downloadToolDeps.validateUrl(url);
    } catch (error) {
      return t(language, 'download.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
    if (!ctx.sendMedia) return t(language, 'download.not_supported');
    try {
      const roles = await ctx.resolveRoles();
      const privileges = await AuthService.getEffectivePrivileges(roles);
      const maxMb = privileges.maxDownloadMb === -1 ? Infinity : privileges.maxDownloadMb || getDownloadMaxMb();
      await ctx.react?.('⬇️');
      await ctx.reply(t(language, 'download.starting'));
      log.info({ url: redactUrl(url), format, chatId: ctx.chatId, senderId: ctx.senderId }, 'Download started');
      const timeoutSignal = AbortSignal.timeout(310_000);
      const operationSignals = [signal, ctx.signal, timeoutSignal].filter((value): value is AbortSignal => !!value);
      const buffer = await downloadViaYtDlp(url, format, maxMb, { signal: AbortSignal.any(operationSignals) });
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
      if (errorMessage.includes('not found') || errorMessage.includes('YTDLP_PATH')) return t(language, 'download.ytdlp_missing');
      return t(language, 'download.error', { msg: errorMessage.slice(0, 200) });
    }
  }
}
