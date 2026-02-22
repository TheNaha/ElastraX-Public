import { expect, test, describe, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { StickerUtils } from '../src/utils/StickerUtils';
import { FFmpegConverter } from '../src/utils/FFmpegConverter';

// Mock node-webpmux
const mockLoad = mock(async () => {});
const mockSave = mock(async () => Buffer.from('webp_with_exif'));

class MockImage {
    exif: any = null;
    load = mockLoad;
    save = mockSave;
}

mock.module('node-webpmux', () => ({
  default: {
    Image: MockImage
  }
}));

describe('StickerUtils', () => {
    let convertSpy: any;

    beforeEach(() => {
        mockLoad.mockClear();
        mockSave.mockClear();

        // Spy on static method
        convertSpy = spyOn(FFmpegConverter, 'convert').mockImplementation(async () => Buffer.from('webp'));
    });

    afterEach(() => {
        convertSpy.mockRestore();
    });

    test('imageToWebp should call FFmpegConverter with correct args', async () => {
        const input = Buffer.from('image');
        const result = await StickerUtils.imageToWebp(input);

        expect(result).toBeDefined();
        expect(convertSpy).toHaveBeenCalled();
        const args = convertSpy.mock.calls[0];
        expect(args[0]).toEqual(input);
        expect(args[2]).toBe('img');
        expect(args[3]).toBe('webp');
        // Check FFmpeg args roughly
        expect(args[1]).toContain('libwebp');
    });

    test('videoToWebp should call FFmpegConverter with correct args', async () => {
        const input = Buffer.from('video');
        const result = await StickerUtils.videoToWebp(input);

        expect(result).toBeDefined();
        expect(convertSpy).toHaveBeenCalled();
        const args = convertSpy.mock.calls[0];
        expect(args[0]).toEqual(input);
        expect(args[2]).toBe('mp4');
        expect(args[3]).toBe('webp');
        // Check FFmpeg args roughly
        expect(args[1]).toContain('-loop');
        expect(args[1]).toContain('0');
        expect(args[1]).toContain('-t');
        expect(args[1]).toContain('00:00:05');
    });

    test('writeExif should add metadata', async () => {
        const input = Buffer.from('webp');
        const metadata = { packname: 'Pack', author: 'Author' };

        const result = await StickerUtils.writeExif(input, metadata);

        expect(result).toBeDefined();
        expect(mockLoad).toHaveBeenCalledWith(input);
        expect(mockSave).toHaveBeenCalled();
    });
});
