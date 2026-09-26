/**
 * Regression tests for defects found during the consolidation audit.
 *
 * Each test here failed before the corresponding fix and exists to stop the
 * defect from returning silently. They deliberately exercise real production
 * code rather than a mock, because in every one of these cases the original
 * defect was masked by a test double.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { parseExplicitCommand } from '../src/tools/ParameterValidator';
import { getToolByAliasOrName, secureDefinition } from '../src/tools/registry';
import { isUsableProviderMessageId } from '../src/agent/messageId';
import { t } from '../src/utils/i18n';
import { TurnBudget } from '../src/ai/turnBudget';
import { STICKER_WEBP_FILTER, ffmpegConverterDeps } from '../src/utils/FFmpegConverter';
import { StickerUtils } from '../src/utils/StickerUtils';
import type { BoundedProcessOptions } from '../src/providers/process';

const ownerContext = { roles: ['owner'], isGroup: false, platform: 'whatsapp' as const, isOwner: true };

function parse(command: string, args: string): Record<string, unknown> {
  const tool = getToolByAliasOrName(command, ownerContext);
  if (!tool) throw new Error(`tool not found: ${command}`);
  return parseExplicitCommand(tool, args, command) as Record<string, unknown>;
}

describe('slash command positional parsing', () => {
  // The parser assigned the first positional token to `action` because the tool
  // had no ACTION_ARGUMENTS row, and the enum check then rejected the user's own
  // message text. `/broadcast` is documented in three places and was 100% broken.
  test('/broadcast routes the message text into `message`', () => {
    expect(parse('broadcast', 'hello world')).toMatchObject({ action: 'broadcast', message: 'hello world' });
    expect(parse('broadcast', 'urgent: server down')).toMatchObject({ action: 'broadcast', message: 'urgent: server down' });
  });

  test('/leave resolves to the leave action', () => {
    // OwnerTool is group-scoped, so it is only discoverable in a group context.
    const tool = getToolByAliasOrName('leave', { ...ownerContext, isGroup: true });
    if (!tool) throw new Error('leave tool not found');
    expect(parseExplicitCommand(tool, '', 'leave')).toMatchObject({ action: 'leave' });
  });

  // The owner-only privilege surface was unreachable: `role` was missing from
  // ACTION_ARGUMENTS, and the generic positional loop read `effectiveInferred`
  // instead of the resolved action, so `user` was populated where the grammar
  // wanted `role`/`scope`.
  test('/role setpriv and resetpriv reach the owner privilege surface', () => {
    expect(parse('role', 'setpriv premium contextLimit 50')).toMatchObject({
      action: 'setpriv', role: 'premium', field: 'contextLimit', value: '50',
    });
    expect(parse('role', 'resetpriv premium')).toMatchObject({ action: 'resetpriv', role: 'premium' });
  });

  test('/role list, privs and grant use their declared positional fields', () => {
    expect(parse('role', 'list global')).toMatchObject({ action: 'list', scope: 'global' });
    expect(parse('role', 'privs premium')).toMatchObject({ action: 'privs', role: 'premium' });
    expect(parse('role', 'grant 628 admin')).toMatchObject({ action: 'grant', user: '628', role: 'admin' });
  });

  // `number` is the 4th declared property, so the positional loop never reached
  // it and `/remind cancel 3` put "3" into `time`.
  test('/remind cancel targets the reminder number', () => {
    expect(parse('remind', 'cancel 3')).toMatchObject({ action: 'cancel', number: '3' });
    expect(parse('remind', 'list')).toMatchObject({ action: 'list' });
  });
});

describe('provider message id placeholders', () => {
  // Providers substitute 'unknown' when a platform omits an id. Matching those
  // placeholders made every historical row look like the current message, which
  // inlined up to 10 MiB of media per row across the context window.
  test('placeholder ids are not treated as real identities', () => {
    expect(isUsableProviderMessageId('unknown')).toBe(false);
    expect(isUsableProviderMessageId('UNKNOWN')).toBe(false);
    expect(isUsableProviderMessageId('Unknown')).toBe(false);
    expect(isUsableProviderMessageId('')).toBe(false);
    expect(isUsableProviderMessageId('   ')).toBe(false);
    expect(isUsableProviderMessageId('null')).toBe(false);
    expect(isUsableProviderMessageId(null)).toBe(false);
    expect(isUsableProviderMessageId(undefined)).toBe(false);
    expect(isUsableProviderMessageId('6281234567890')).toBe(true);
    expect(isUsableProviderMessageId(' 6281234567890 ')).toBe(true);
  });
});

describe('i18n interpolation', () => {
  // replaceAll with a string replacement expands `$&` in the replacement, so an
  // interpolated value containing `$&` re-injected the placeholder itself.
  test('a value containing $& is not treated as a substitution pattern', () => {
    const out = t('en', 'reminder.fired', { name: 'a$&b', message: 'plain' });
    expect(out).toContain('a$&b');
    expect(out).not.toContain('a{name}b');
  });
});

describe('TurnBudget', () => {
  // constrainTextResult throws once the result-byte budget is exhausted. It was
  // also called from inside the tool loop's catch block, so a throw there
  // escaped the catch and turned an entire turn into an internal error.
  test('constrainTextResult throws once the total byte budget is exhausted', () => {
    const budget = new TurnBudget({ maxToolResultBytes: 64, maxTotalToolResultBytes: 64 });
    budget.constrainTextResult('x'.repeat(64));
    expect(() => budget.constrainTextResult('y')).toThrow();
  });

  test('claimToolCalls reports exhaustion instead of silently truncating', () => {
    const budget = new TurnBudget({ maxToolCalls: 2 });
    budget.claimToolCalls(2);
    expect(() => budget.claimToolCalls(1)).toThrow(/limit exceeded/i);
  });
});

describe('sticker conversion', () => {
  // Every non-flag value StickerUtils passes was rejected by the FFmpeg
  // allowlist, so imageToWebp and videoToWebp always threw before spawning
  // anything and the feature was dead. The pre-existing sticker test mocked the
  // converter away, which is why it stayed green.
  const original = {
    mkdir: ffmpegConverterDeps.fs.mkdir,
    chmod: ffmpegConverterDeps.fs.chmod,
    writeFile: ffmpegConverterDeps.fs.writeFile,
    stat: ffmpegConverterDeps.fs.stat,
    readFile: ffmpegConverterDeps.fs.readFile,
    rm: ffmpegConverterDeps.fs.rm,
    runProcess: ffmpegConverterDeps.runProcess,
  };

  afterEach(() => {
    ffmpegConverterDeps.fs.mkdir = original.mkdir;
    ffmpegConverterDeps.fs.chmod = original.chmod;
    ffmpegConverterDeps.fs.writeFile = original.writeFile;
    ffmpegConverterDeps.fs.stat = original.stat;
    ffmpegConverterDeps.fs.readFile = original.readFile;
    ffmpegConverterDeps.fs.rm = original.rm;
    ffmpegConverterDeps.runProcess = original.runProcess;
  });

  function stubConverter(): { calls: BoundedProcessOptions[] } {
    const calls: BoundedProcessOptions[] = [];
    ffmpegConverterDeps.fs.mkdir = (async () => {}) as never;
    ffmpegConverterDeps.fs.chmod = (async () => {}) as never;
    ffmpegConverterDeps.fs.writeFile = (async () => {}) as never;
    ffmpegConverterDeps.fs.stat = (async () => ({ isFile: () => true, size: 6 })) as never;
    ffmpegConverterDeps.fs.readFile = (async () => Buffer.from('webp')) as never;
    ffmpegConverterDeps.fs.rm = (async () => {}) as never;
    ffmpegConverterDeps.runProcess = (async (options: BoundedProcessOptions) => {
      calls.push(options);
      return undefined;
    }) as never;
    return { calls };
  }

  test('imageToWebp reaches the encoder instead of being rejected by the allowlist', async () => {
    const { calls } = stubConverter();
    const result = await StickerUtils.imageToWebp(Buffer.from('input'));
    expect(result.toString()).toBe('webp');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain(STICKER_WEBP_FILTER);
  });

  test('videoToWebp reaches the encoder with its time-range arguments intact', async () => {
    const { calls } = stubConverter();
    const result = await StickerUtils.videoToWebp(Buffer.from('input'));
    expect(result.toString()).toBe('webp');
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toContain('00:00:05');
    expect(args).toContain('passthrough');
  });
});

describe('secure tool definitions', () => {
  // The trigger-matched and find_tools paths pushed the raw definition, so the
  // model was shown an open schema and then rejected its own arguments.
  test('secureDefinition closes additionalProperties', () => {
    const tool = getToolByAliasOrName('ping', ownerContext);
    if (!tool) throw new Error('ping tool missing');
    expect(tool.definition.function.parameters.additionalProperties).not.toBe(false);
    expect(secureDefinition(tool).function.parameters.additionalProperties).toBe(false);
  });
});
