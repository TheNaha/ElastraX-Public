import { describe, expect, test } from 'bun:test';
import {
  WHATSAPP_MAX_LONG_EDGE,
  needsPhoneTranscode,
  parseVideoProbe,
  phoneTranscodeArgs,
} from '../src/utils/videoCompat';

function probe(overrides: Partial<Parameters<typeof needsPhoneTranscode>[0]> = {}): Parameters<typeof needsPhoneTranscode>[0] {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    vcodec: 'h264',
    acodec: 'aac',
    pixFmt: 'yuv420p',
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

describe('parseVideoProbe', () => {
  test('reads the first video stream, first audio stream and container', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'av1', pix_fmt: 'yuv420p', width: 320, height: 240 },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    });
    expect(parseVideoProbe(json)).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      vcodec: 'av1',
      acodec: 'aac',
      pixFmt: 'yuv420p',
      width: 320,
      height: 240,
    });
  });

  test('reports no audio and a missing container without failing', () => {
    const json = JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] });
    expect(parseVideoProbe(json)).toMatchObject({ acodec: null, container: '', vcodec: 'h264' });
  });

  test('returns null for unparseable output or no video stream', () => {
    expect(parseVideoProbe('not json')).toBeNull();
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }))).toBeNull();
    expect(parseVideoProbe(JSON.stringify({}))).toBeNull();
  });
});

describe('needsPhoneTranscode', () => {
  test('accepts H.264/yuv420p/AAC MP4 at 1080p and 1080x1920', () => {
    expect(needsPhoneTranscode(probe())).toBe(false);
    expect(needsPhoneTranscode(probe({ width: 1080, height: 1920 }))).toBe(false);
    expect(needsPhoneTranscode(probe({ acodec: null }))).toBe(false);
  });

  test('rejects the AV1/VP9-in-MP4 download that phones refuse', () => {
    // This is the exact user-visible bug: the container is MP4 but the codec is
    // not, so desktop/web WhatsApp plays it and the phone does not.
    expect(needsPhoneTranscode(probe({ vcodec: 'av1' }))).toBe(true);
    expect(needsPhoneTranscode(probe({ vcodec: 'vp9' }))).toBe(true);
  });

  test('rejects non-MP4 containers, non-yuv420p, Opus audio and odd dimensions', () => {
    expect(needsPhoneTranscode(probe({ container: 'matroska,webm' }))).toBe(true);
    expect(needsPhoneTranscode(probe({ pixFmt: 'yuv444p' }))).toBe(true);
    expect(needsPhoneTranscode(probe({ acodec: 'opus' }))).toBe(true);
    expect(needsPhoneTranscode(probe({ width: 641 }))).toBe(true);
    expect(needsPhoneTranscode(probe({ height: 0 }))).toBe(true);
  });

  test('rejects anything above a 1920 long edge', () => {
    expect(needsPhoneTranscode(probe({ width: 3840, height: 2160 }))).toBe(true);
    expect(needsPhoneTranscode(probe({ width: 1440, height: 2560 }))).toBe(true);
  });
});

describe('phoneTranscodeArgs', () => {
  test('encodes H.264 yuv420p with AAC and faststart', () => {
    const args = phoneTranscodeArgs(probe());
    expect(args).toContain('libx264');
    expect(args.slice(args.indexOf('-pix_fmt') + 1, args.indexOf('-pix_fmt') + 2)).toEqual(['yuv420p']);
    expect(args).toContain('aac');
    expect(args.slice(args.indexOf('-movflags') + 1, args.indexOf('-movflags') + 2)).toEqual(['+faststart']);
    expect(args).not.toContain('-vf');
  });

  test('caps the long edge without upscaling the short one', () => {
    const landscape = phoneTranscodeArgs(probe({ width: 2560, height: 1440 }));
    expect(landscape[landscape.indexOf('-vf') + 1]).toBe(`scale=${WHATSAPP_MAX_LONG_EDGE}:-2`);
    const portrait = phoneTranscodeArgs(probe({ width: 1440, height: 2560 }));
    expect(portrait[portrait.indexOf('-vf') + 1]).toBe(`scale=-2:${WHATSAPP_MAX_LONG_EDGE}`);
  });

  test('rounds odd dimensions to even and omits audio when there is none', () => {
    const odd = phoneTranscodeArgs(probe({ width: 641, height: 361, acodec: null }));
    expect(odd[odd.indexOf('-vf') + 1]).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(odd).not.toContain('-c:a');
    expect(odd).toContain('+faststart');
  });
});
