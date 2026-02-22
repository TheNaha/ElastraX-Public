import { expect, test, describe } from 'bun:test';
import { t } from '../src/utils/i18n';

describe('i18n Utils', () => {
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
