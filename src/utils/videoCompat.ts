/**
 * @file src/utils/videoCompat.ts
 * @description Decide whether a downloaded video is playable by WhatsApp on a
 *              phone, and build the ffmpeg pass that makes it so.
 *
 * WhatsApp's desktop/web clients play anything Chromium can decode (VP9, AV1),
 * but the mobile players are strict: H.264 video in an MP4 container, yuv420p
 * pixel format, AAC audio, even dimensions, and at most 1080p. A YouTube
 * download that merged an AV1/VP9 stream into an `.mp4` plays on desktop and is
 * rejected on the phone with "something is wrong with the video file".
 *
 * This module is pure: callers probe the file (ffprobe), ask
 * {@link needsPhoneTranscode}, and execute {@link phoneTranscodeArgs}.
 */

/** Longest edge WhatsApp accepts (1920x1080 landscape, 1080x1920 portrait). */
export const WHATSAPP_MAX_LONG_EDGE = 1920;

export interface ProbedVideo {
  /** ffprobe `format.format_name`, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  vcodec: string;
  /** `null` when the file has no audio stream. */
  acodec: string | null;
  pixFmt: string;
  width: number;
  height: number;
}

/**
 * Parse `ffprobe -print_format json -show_streams -show_format` output.
 *
 * Returns `null` when there is no video stream, so a caller can tell "not a
 * video" apart from "probe failed".
 */
export function parseVideoProbe(json: string): ProbedVideo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const streams = (parsed as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return null;
  const records = streams.filter(
    (stream): stream is Record<string, unknown> => !!stream && typeof stream === 'object',
  );
  const video = records.find(stream => stream.codec_type === 'video');
  if (!video) return null;
  const audio = records.find(stream => stream.codec_type === 'audio');
  const format = (parsed as { format?: { format_name?: unknown } }).format;
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : Number.parseInt(String(value), 10) || 0;
  return {
    container: typeof format?.format_name === 'string' ? format.format_name : '',
    vcodec: typeof video.codec_name === 'string' ? video.codec_name : '',
    acodec: audio && typeof audio.codec_name === 'string' ? audio.codec_name : null,
    pixFmt: typeof video.pix_fmt === 'string' ? video.pix_fmt : '',
    width: number(video.width),
    height: number(video.height),
  };
}

/** Whether the probed file needs a transcode before WhatsApp phones can play it. */
export function needsPhoneTranscode(info: ProbedVideo): boolean {
  if (!info.width || !info.height) return true;
  if (!info.container.split(',').includes('mp4')) return true;
  if (info.vcodec !== 'h264') return true;
  if (info.pixFmt !== '' && info.pixFmt !== 'yuv420p') return true;
  if (info.acodec !== null && info.acodec !== 'aac') return true;
  if (info.width % 2 !== 0 || info.height % 2 !== 0) return true;
  return Math.max(info.width, info.height) > WHATSAPP_MAX_LONG_EDGE;
}

/**
 * ffmpeg arguments (input/output paths excluded) for a phone-playable MP4.
 *
 * `-movflags +faststart` puts the moov atom before the media data so a player
 * can start before the whole file is available. `-pix_fmt yuv420p` and the
 * even-dimension scale are H.264 requirements that the mobile decoders enforce.
 */
export function phoneTranscodeArgs(info: ProbedVideo): string[] {
  const args = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
  if (Math.max(info.width, info.height) > WHATSAPP_MAX_LONG_EDGE) {
    // Cap the *longest* edge at 1920 and let `-2` round the other one to an even
    // number. Capping the height for a landscape video would upscale 1440p to
    // 1920 tall (3414x1920), which is both larger and still not the same shape.
    args.push('-vf', info.width >= info.height
      ? `scale=${WHATSAPP_MAX_LONG_EDGE}:-2`
      : `scale=-2:${WHATSAPP_MAX_LONG_EDGE}`);
  } else if (info.width % 2 !== 0 || info.height % 2 !== 0) {
    args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  if (info.acodec !== null) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  return args;
}
