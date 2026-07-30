/**
 * @file src/tools/DownloadTool.ts
 * @description Media downloader powered by yt-dlp.
 *
 * Downloads audio or video from URLs supported by yt-dlp (YouTube, Instagram,
 * TikTok, Twitter/X, SoundCloud, Vimeo, and 1000+ other sites) and sends the
 * result back to the chat.
 *
 * Configuration:
 *   YTDLP_PATH      — Path to the yt-dlp binary (default: 'yt-dlp' from PATH).
 *   DOWNLOAD_MAX_MB — Maximum file size to send (default: 50 MB).
 *
 * Works conversationally ("download this YouTube video as mp3": AI calls this tool)
 * and via slash command: /download [format] [url]
 *
 * Slash command aliases: /download, /dl
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { getDownloadMaxMb } from '../config/runtime';
import { PrivilegeService } from '../utils/PrivilegeService';

const log = logger.child({ module: 'DownloadTool' });

type AudioFormat = 'mp3' | 'aac' | 'm4a' | 'ogg' | 'opus';
type VideoFormat = 'mp4' | 'mkv' | 'webm';
type DownloadFormat = AudioFormat | VideoFormat;
type DownloadArgs = ToolArgs & {
  url?: string;
  format?: DownloadFormat;
};

const MIME_MAP: Record<DownloadFormat, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

const AUDIO_FORMATS = new Set<string>(['mp3', 'aac', 'm4a', 'ogg', 'opus']);

export const downloadToolDeps = {
  spawn,
  fs,
  path,
  os,
  crypto,
};

function isAudioFormat(fmt: string): fmt is AudioFormat {
  return AUDIO_FORMATS.has(fmt);
}

async function downloadViaYtDlp(url: string, format: DownloadFormat, maxMb: number): Promise<Buffer> {
  const ytdlpBin = process.env.YTDLP_PATH || 'yt-dlp';

  // Security: Use a unique subdirectory for each job to prevent interference
  // and simplify cleanup of potential multiple output files.
  const baseTmpDir = downloadToolDeps.path.join(downloadToolDeps.os.tmpdir(), 'elastrax-dl');
  const jobId = downloadToolDeps.crypto.randomBytes(16).toString('hex');
  const workDir = downloadToolDeps.path.join(baseTmpDir, jobId);

  await downloadToolDeps.fs.mkdir(workDir, { recursive: true });

  try {
    const id = downloadToolDeps.crypto.randomBytes(8).toString('hex');
    const outTemplate = downloadToolDeps.path.join(workDir, `${id}.%(ext)s`);

    // Security: Place URL last after '--' to prevent argument injection
    const args: string[] = [
      '-o', outTemplate,
      '--no-playlist',
      '--max-filesize', maxMb === Infinity ? '0' : `${maxMb + 5}m`,
    ];

    if (isAudioFormat(format)) {
      args.push('-x', '--audio-format', format, '--audio-quality', '0');
    } else {
      args.push(
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--recode-video', format,
      );
    }

    // Append URL last, protected by --
    args.push('--', url);

    await new Promise<void>((resolve, reject) => {
      const child = downloadToolDeps.spawn(ytdlpBin, args, { shell: false });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => reject(new Error(`yt-dlp not found. Install it or set YTDLP_PATH. Details: ${err.message}`)));
      child.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-300)}`));
        }
      });
    });

    // Find the output file (extension may differ from requested format)
    const files = await downloadToolDeps.fs.readdir(workDir);
    const match = files.find(f => f.startsWith(id));
    if (!match) throw new Error('yt-dlp produced no output file.');

    // Security: Validate the filename to prevent path traversal
    // Only allow alphanumeric, dots, hyphens, and underscores.
    if (!/^[a-zA-Z0-9._-]+$/.test(match)) {
      throw new Error('Invalid output filename produced by downloader.');
    }

    const outPath = downloadToolDeps.path.join(workDir, match);

    // Security: Double-check that the resolved path is still within workDir
    const resolvedPath = downloadToolDeps.path.resolve(outPath);
    if (!resolvedPath.startsWith(downloadToolDeps.path.resolve(workDir))) {
      throw new Error('Path traversal detected in downloader output.');
    }

    return await downloadToolDeps.fs.readFile(outPath);
  } finally {
    // Security: Cleanup the entire unique directory
    await downloadToolDeps.fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class DownloadTool extends BaseTool<DownloadArgs> {
  readonly name = 'download_media';
  readonly description = 'Download audio/video from a URL (YouTube, TikTok, Instagram, etc). Default: mp4 for video, mp3 for audio.';
  readonly aliases = ['download', 'dl'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/https?:\/\//i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the media to download.',
            },
            format: {
              type: 'string',
              enum: ['mp3', 'mp4', 'm4a', 'aac', 'ogg', 'opus', 'mkv', 'webm'],
              description: 'Output format. Use mp3 for audio-only, mp4 for video. Default: mp4',
            },
          },
          required: ['url'],
        },
      },
    };
  }

  async execute(args: DownloadArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const url = String(args.url || '').trim();
    const format: DownloadFormat = (args.format || 'mp4') as DownloadFormat;
    const roles = await ctx.resolveRoles();
    const privileges = await PrivilegeService.getEffective(roles);
    let maxMb = privileges.maxDownloadMb;
    if (maxMb === -1) maxMb = Infinity; // Infinite download size override
    else if (!maxMb) maxMb = getDownloadMaxMb();

    if (!url) return t(lang, 'download.no_url');
    if (!ctx.sendMedia) return t(lang, 'download.not_supported');

    // Security: Input validation
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return t(lang, 'download.error', { msg: 'Only HTTP/HTTPS URLs are allowed.' });
      }
    } catch {
      return t(lang, 'download.error', { msg: 'Invalid URL format.' });
    }

    // Security: Strict format validation
    if (!Object.prototype.hasOwnProperty.call(MIME_MAP, format)) {
      return t(lang, 'download.error', { msg: 'Invalid format requested.' });
    }

    try {
      await ctx.react?.('⬇️');
      await ctx.reply(t(lang, 'download.starting'));

      log.info({ url, format, chatId: ctx.chatId, senderId: ctx.senderId }, 'Download started');

      const buffer = await downloadViaYtDlp(url, format, maxMb);

      const sizeMb = buffer.length / (1024 * 1024);
      log.debug({ url, format, sizeMb: sizeMb.toFixed(1) }, 'Download completed');

      if (sizeMb > maxMb) {
        return t(lang, 'download.too_large', {
          size: sizeMb.toFixed(1),
          max: maxMb === Infinity ? 'Unlimited' : String(maxMb),
        });
      }

      await ctx.react?.('📤');
      const mime = MIME_MAP[format] || 'application/octet-stream';
      await ctx.sendMedia(buffer, {
        mimetype: mime,
        filename: `download.${format}`,
        // If it's audio, optionally send as voice note if it's voice-sized
        ptt: false,
      });

      return t(lang, 'download.success');
    } catch (err: unknown) {
      log.error({ err, url, format }, 'Download failed');
      const errorMessage = getErrorMessage(err);
      if (errorMessage.includes('not found') || errorMessage.includes('YTDLP_PATH')) {
        return t(lang, 'download.ytdlp_missing');
      }
      return t(lang, 'download.error', { msg: errorMessage.slice(0, 200) });
    }
  }
}
