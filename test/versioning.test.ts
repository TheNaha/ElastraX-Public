import { describe, expect, test } from 'bun:test';
import { APP_RELEASE_TAG, APP_VERSION } from '../src/config/version';
import { translations } from '../src/utils/i18n';

describe('release identity', () => {
  test('package metadata and runtime version agree', async () => {
    const pkg = JSON.parse(await Bun.file('package.json').text()) as {
      name: string;
      version: string;
    };

    expect(pkg.name).toBe('elastrax');
    expect(pkg.version).toBe(APP_VERSION);
    expect(APP_VERSION).toBe('8.0.1');
    expect(APP_RELEASE_TAG).toBe('v8.0.1');
  });

  test('user-facing release branding uses the shared version', () => {
    expect(translations.en['menu.footer']).toContain(`v${APP_VERSION}`);
    expect(translations.id['menu.footer']).toContain(`v${APP_VERSION}`);
  });
});
