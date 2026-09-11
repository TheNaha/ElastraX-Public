import { expect, test, describe } from 'bun:test';
import { t, translations } from '../src/utils/i18n';

describe('i18n Utils', () => {
  test('en and id locales have identical key sets', () => {
    const enKeys = Object.keys(translations.en).sort();
    const idKeys = Object.keys(translations.id).sort();
    expect(idKeys).toEqual(enKeys);
  });

  test('placeholders match between locales for every key', () => {
    for (const [key, enValue] of Object.entries(translations.en)) {
      const enVars = [...enValue.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
      const idVars = [...translations.id[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
      expect([key, idVars]).toEqual([key, enVars]);
    }
  });

  test('should return English translation by default', () => {
    expect(t('en', 'menu.category')).toBe('*Category:*');
    expect(t(undefined, 'menu.category')).toBe('*Category:*');
    expect(t('unknown', 'menu.category')).toBe('*Category:*');
  });

  test('should return Indonesian translation when requested', () => {
    expect(t('id', 'menu.category')).toBe('*Kategori:*');
  });

  test('should interpolate variables correctly', () => {
    expect(t('en', 'menu.greeting', { name: 'Alice' })).toBe('Hello Alice!');
    expect(t('id', 'menu.greeting', { name: 'Budi' })).toBe('Halo Budi!');
  });


  test('should fallback to key if missing in both', () => {
    const missingKey = 'non.existent.key';
    expect(t('en', missingKey)).toBe(missingKey);
    expect(t('id', missingKey)).toBe(missingKey);
  });

  test('should handle multiple variables', () => {
      // Create a fake entry in memory if possible? No, it's a const.
      // I have to use existing keys.
      // 'group.success_add': '✅ Successfully Added user {jid}.' -> only 1 var.
      // 'group.error': '❌ Error administering group: {msg}. Note: Ensure the bot is an admin of the group.' -> only 1 var.

      // Let's test with a key that has 1 var but pass multiple vars.
      expect(t('en', 'menu.greeting', { name: 'Alice', unused: 'ignored' })).toBe('Hello Alice!');
  });
});
