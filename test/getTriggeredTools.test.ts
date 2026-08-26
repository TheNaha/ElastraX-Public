import { describe, expect, test } from 'bun:test';
import { getTriggeredTools } from '../src/tools';

/**
 * Locks the tightened triggerPatterns contract: generic verbs must NOT
 * preload tool schemas (smart-loading token budget), while explicit
 * domain intents still do. Missed cases fall back to find_tools discovery.
 */
function triggeredNames(text: string, mime?: string): string[] {
  return getTriggeredTools(text, mime).map(t => t.name);
}

describe('getTriggeredTools (tightened patterns)', () => {
  test('media_search triggers on domain nouns/intents', () => {
    expect(triggeredNames('any good movies lately?')).toContain('media_search');
    expect(triggeredNames('aku mau nonton sesuatu')).toContain('media_search');
    expect(triggeredNames('new anime this season')).toContain('media_search');
  });

  test('media_search does NOT trigger on generic search verbs', () => {
    expect(triggeredNames('search the web for bun docs')).not.toContain('media_search');
    expect(triggeredNames('find my previous message about cats')).not.toContain('media_search');
    expect(triggeredNames('cari kata itu di kamus')).not.toContain('media_search');
  });

  test('memory triggers on explicit memory verbs only', () => {
    expect(triggeredNames('remember that my favorite color is blue')).toContain('memory');
    expect(triggeredNames('jangan lupa aku sibuk besok')).toContain('memory');
  });

  test('save/simpan no longer collides between memory and download', () => {
    const names = triggeredNames('save this file for me please');
    expect(names).not.toContain('memory');
    expect(names).not.toContain('download_media');
  });

  test('download_media keeps URL and explicit download intent', () => {
    expect(triggeredNames('https://example.com/video.mp4')).toContain('download_media');
    expect(triggeredNames('unduh video ini')).toContain('download_media');
  });

  test('web_scrape needs URL or explicit scrape/summarize intent', () => {
    expect(triggeredNames('summarize this article for me')).toContain('web_scrape');
    expect(triggeredNames('read page 3 of the book')).not.toContain('web_scrape');
  });

  test('reminder owns remind verbs, memory does not steal them', () => {
    const names = triggeredNames('remind me at 5pm to stretch');
    expect(names).toContain('reminder');
    expect(names).not.toContain('memory');
  });

  test('plain chat preloads none of the tightened tools', () => {
    const names = triggeredNames('haha lol that is funny');
    expect(names).not.toContain('media_search');
    expect(names).not.toContain('memory');
    expect(names).not.toContain('download_media');
    expect(names).not.toContain('web_scrape');
  });
});
