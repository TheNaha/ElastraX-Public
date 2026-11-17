import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import {
  DownloadTool,
  downloadToolDeps,
  downloadViaYtDlp,
  redactUrl,
} from '../src/tools/DownloadTool';
import { HARD_MEDIA_MAX_BYTES, MIB } from '../src/providers/media';
import type { BoundedProcessOptions, BoundedProcessResult } from '../src/providers/process';
import type { MessageContext } from '../src/core/MessageContext';
import type { SafeNetworkTarget } from '../src/providers/ssrf';

const original = {
  fs: downloadToolDeps.fs,
  path: downloadToolDeps.path,
  os: downloadToolDeps.os,
  crypto: downloadToolDeps.crypto,
  validateUrl: downloadToolDeps.validateUrl,
  createProxy: downloadToolDeps.createProxy,
  runProcess: downloadToolDeps.runProcess,
};

const safeTarget = {} as SafeNetworkTarget;
const mocks = {
  mkdir: mock(async () => {}),
  chmod: mock(async () => {}),
  readdir: mock(async () => ['abababababababab.mp4']),
  stat: mock(async () => ({ isFile: () => true, size: 4 })),
  readFile: mock(async () => Buffer.from('data')),
  rm: mock(async () => {}),
  validate: mock(async () => safeTarget),
  proxyStart: mock(async function (this: { url: string }) { return this; }),
  proxyClose: mock(async () => {}),
  runProcess: mock(async (_options: BoundedProcessOptions): Promise<BoundedProcessResult | void> => undefined),
};

const proxy = {
  url: 'http://127.0.0.1:43123',
  start: mocks.proxyStart,
  close: mocks.proxyClose,
};

function installMocks(): void {
  downloadToolDeps.fs = {
    ...original.fs,
    mkdir: mocks.mkdir,
    chmod: mocks.chmod,
    readdir: mocks.readdir,
    stat: mocks.stat,
    readFile: mocks.readFile,
    rm: mocks.rm,
  } as unknown as typeof downloadToolDeps.fs;
  downloadToolDeps.path = original.path;
  downloadToolDeps.os = original.os;
  downloadToolDeps.crypto = {
    ...original.crypto,
    randomBytes: mock((size: number) => Buffer.from('ab'.repeat(size), 'hex')),
  } as typeof downloadToolDeps.crypto;
  downloadToolDeps.validateUrl = mocks.validate as typeof downloadToolDeps.validateUrl;
  downloadToolDeps.createProxy = mock(() => proxy as never);
  downloadToolDeps.runProcess = mocks.runProcess as never;
}

describe('DownloadTool security', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.readdir.mockImplementation(async () => ['abababababababab.mp4']);
    mocks.stat.mockImplementation(async () => ({ isFile: () => true, size: 4 }));
    mocks.readFile.mockImplementation(async () => Buffer.from('data'));
    mocks.runProcess.mockImplementation(async () => undefined);
    installMocks();
  });

  afterEach(() => {
    downloadToolDeps.fs = original.fs;
    downloadToolDeps.path = original.path;
    downloadToolDeps.os = original.os;
    downloadToolDeps.crypto = original.crypto;
    downloadToolDeps.validateUrl = original.validateUrl;
    downloadToolDeps.createProxy = original.createProxy;
    downloadToolDeps.runProcess = original.runProcess;
  });

  test('rejects option-like and non-HTTP URLs before role or process work', async () => {
    mocks.validate.mockRejectedValueOnce(new Error('Invalid URL.'));
    const tool = new DownloadTool();
    const roleSpy = mock(async () => []);
    const ctx = { resolveRoles: roleSpy, reply: mock(async () => {}), react: mock(async () => {}) } as unknown as MessageContext;
    expect(await tool.execute({ url: '--version', format: 'mp4' }, ctx)).toContain('Invalid URL');
    expect(roleSpy).not.toHaveBeenCalled();

    mocks.validate.mockRejectedValueOnce(new Error('Only HTTP and HTTPS URLs are allowed.'));
    expect(await tool.execute({ url: 'file:///etc/passwd', format: 'mp4' }, ctx)).toContain('HTTP and HTTPS');
    expect(downloadToolDeps.runProcess).not.toHaveBeenCalled();
  });

  test('passes the URL after -- through the validating proxy and cleans private jobs', async () => {
    const buffer = await downloadViaYtDlp('https://example.com/video', 'mp4', 50);
    expect(buffer.toString()).toBe('data');
    const options = mocks.runProcess.mock.calls[0]![0];
    expect(options.args).toContain('--');
    expect(options.args[options.args.indexOf('--') + 1]).toBe('https://example.com/video');
    expect(options.args[options.args.indexOf('--proxy') + 1]).toBe(proxy.url);
    expect(options.args).toContain('--max-filesize');
    expect(options.env).toMatchObject({ NO_PROXY: '', no_proxy: '', TMPDIR: expect.any(String) });
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
    expect(mocks.proxyStart).toHaveBeenCalled();
    expect(mocks.proxyClose).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(expect.any(String), { recursive: true, force: true });
  });

  test('clamps unlimited roles to the hard media cap', async () => {
    await downloadViaYtDlp('https://example.com/video', 'mp4', Infinity);
    const options = mocks.runProcess.mock.calls[0]![0];
    expect(options.args).toContain(`${HARD_MEDIA_MAX_BYTES / MIB}m`);
    expect(options.watchDirectory).toEqual({ path: expect.any(String), maxBytes: HARD_MEDIA_MAX_BYTES });
  });

  test('prefers H.264/AAC streams so phones can play the result', async () => {
    await downloadViaYtDlp('https://example.com/video', 'mp4', 50, { max_resolution: '1080p' });
    const options = mocks.runProcess.mock.calls[0]![0];
    const selector = options.args[options.args.indexOf('-f') + 1]!;
    // AV1/VP9 in an MP4 container plays on desktop WhatsApp and is rejected by
    // the phone players, so the selector asks for avc1 first.
    expect(selector.indexOf('vcodec^=avc1')).toBeLessThan(selector.indexOf('[height<=1080]'));
    expect(selector).toContain('acodec^=mp4a');
  });

  test('transcodes an AV1 download to a phone-playable H.264 MP4', async () => {
    mocks.runProcess.mockImplementation(async (options: BoundedProcessOptions) => {
      if (options.kind !== 'ffprobe') return undefined;
      return {
        stdout: Buffer.from(JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'av1', pix_fmt: 'yuv420p', width: 3840, height: 2160 },
            { codec_type: 'audio', codec_name: 'opus' },
          ],
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
        })),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
        stderrTruncated: false,
      };
    });

    await downloadViaYtDlp('https://example.com/video', 'mp4', 50);

    const calls = mocks.runProcess.mock.calls.map(call => call[0]);
    const ffmpegCall = calls.find(call => call.kind === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall!.args).toContain('libx264');
    expect(ffmpegCall!.args).toContain('yuv420p');
    expect(ffmpegCall!.args.slice(ffmpegCall!.args.indexOf('-vf') + 1, ffmpegCall!.args.indexOf('-vf') + 2)).toEqual(['scale=1920:-2']);
    expect(ffmpegCall!.args).toContain('+faststart');
    expect(ffmpegCall!.args).toContain('aac');
    // The mixed AV1/Opus source is transcoded, so the transcoded sibling is what
    // gets read and sent.
    expect(mocks.readFile).toHaveBeenCalledWith(expect.stringContaining('.phone.mp4'));
  });

  test('does not re-encode a download that is already phone-compatible', async () => {
    mocks.runProcess.mockImplementation(async (options: BoundedProcessOptions) => {
      if (options.kind !== 'ffprobe') return undefined;
      return {
        stdout: Buffer.from(JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720 },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
        })),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
        stderrTruncated: false,
      };
    });

    await downloadViaYtDlp('https://example.com/video', 'mp4', 50);
    const kinds = mocks.runProcess.mock.calls.map(call => call[0].kind);
    expect(kinds).toEqual(['yt-dlp', 'ffprobe']);
    expect(mocks.readFile).toHaveBeenCalledWith(expect.not.stringContaining('.phone.mp4'));
  });

  test('rejects understated or oversized output before reading it', async () => {
    mocks.stat.mockImplementationOnce(async () => ({ isFile: () => true, size: 51 * MIB }));
    await expect(downloadViaYtDlp('https://example.com/video', 'mp4', 50)).rejects.toThrow('exceeds');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  test('rejects traversal-like output names and multiple outputs', async () => {
    mocks.readdir.mockImplementationOnce(async () => ['abababababababab/../../../etc/passwd']);
    await expect(downloadViaYtDlp('https://example.com/video', 'mp4', 50)).rejects.toThrow('Invalid output filename');

    mocks.readdir.mockImplementationOnce(async () => ['abababababababab.mp4', 'abababababababab.webm']);
    await expect(downloadViaYtDlp('https://example.com/video', 'mp4', 50)).rejects.toThrow('2 output files');
  });

  test('propagates process failure and still closes the proxy and job', async () => {
    mocks.runProcess.mockRejectedValueOnce(new Error('aborted'));
    await expect(downloadViaYtDlp('https://example.com/video', 'mp4', 50)).rejects.toThrow('aborted');
    expect(mocks.proxyClose).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  test('redacts credentials, query parameters, and fragments from logs', () => {
    expect(redactUrl('https://user:secret@example.com/video?token=abc#part')).toBe('https://example.com/video');
    expect(redactUrl('not a url')).toBe('[invalid-url]');
  });
});
