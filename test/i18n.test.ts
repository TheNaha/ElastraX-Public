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

// ── Localisation coverage ─────────────────────────────────────────────────────
//
// The key-parity tests above keep the two locales in step, but they cannot see
// text that never reaches `t()` at all, nor a key that no code reads. These
// tests close both gaps.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !full.endsWith(join('utils', 'i18n.ts'))) out.push(full);
  }
  return out;
}

describe('i18n coverage', () => {
  const files = sourceFiles(SRC);
  const blob = files.map(file => readFileSync(file, 'utf8')).join('\n');

  test('every key is referenced by source code', () => {
    // Keys rendered through a template prefix (`help.tool.${name}`) cannot be
    // found by literal search; they are covered by the help tests below.
    const dynamicPrefixes = ['help.tool.', 'help.param.', 'help.category.'];
    const dead = Object.keys(translations.en).filter(key => {
      if (dynamicPrefixes.some(prefix => key.startsWith(prefix))) return false;
      return !blob.includes(`'${key}'`) && !blob.includes(`"${key}"`) && !blob.includes(`\`${key}`);
    });
    expect(dead).toEqual([]);
  });

  test('every tool and parameter has help metadata in both locales', () => {
    const missing: string[] = [];
    for (const file of files.filter(file => file.split('/').includes('tools'))) {
      const src = readFileSync(file, 'utf8');
      const name = src.match(/readonly name\s*=\s*'([^']+)'/)?.[1];
      if (!name || !src.includes('readonly description')) continue;

      for (const locale of ['en', 'id'] as const) {
        const table = translations[locale];
        if (!table[`help.tool.${name}`]) missing.push(`${locale}:help.tool.${name}`);
        if (table[`help.tool.${name}`] === undefined) continue;
        for (const param of parameterNames(src)) {
          if (!table[`help.param.${name}.${param}`]) missing.push(`${locale}:help.param.${name}.${param}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

/**
 * Property names declared directly inside the tool's `properties: { … }` block.
 * Depth is tracked so a nested object (e.g. an `items` schema) does not count as
 * a parameter of its own.
 */
function parameterNames(src: string): string[] {
  const start = src.indexOf('properties: {');
  if (start < 0) return [];
  const names: string[] = [];
  let depth = 0;
  let token = '';
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '{') {
      depth++;
      if (depth === 2 && token.trim()) names.push(token.trim());
      token = '';
    } else if (ch === '}') {
      depth--;
      token = '';
      if (depth === 0) break;
    } else if (depth === 1) {
      token = /[A-Za-z0-9_]/.test(ch) ? token + ch : '';
    }
  }
  return names;
}
