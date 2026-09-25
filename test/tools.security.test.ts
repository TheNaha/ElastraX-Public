import { describe, expect, test } from 'bun:test';
import { BaseTool, isExactTrustedHostname, type ToolDefinition } from '../src/tools/BaseTool';
import { ParameterValidator, validateJsonSchema } from '../src/tools/ParameterValidator';

class ContractTool extends BaseTool {
  readonly name = 'contract';
  readonly description = 'contract';
  readonly aliases = ['run'];
  readonly category = 'test';
  readonly permissions = 'user';
  override readonly noArgAliases = ['run'];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['run', 'search'] },
            query: { type: 'string' },
            count: { type: 'integer', minimum: 1 },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(): Promise<string> { return 'ok'; }
}

describe('tool dispatch contracts', () => {
  test('no-argument aliases receive their command action', () => {
    const tool = new ContractTool();
    expect(ParameterValidator.parseArgs(tool, '', 'run').action).toBe('run');
    expect(ParameterValidator.parseArgs(tool, '', undefined)).toEqual({});
  });

  test('natural language trailing arguments stay in the final string field', () => {
    const parsed = ParameterValidator.parseArgs(new ContractTool(), 'search natural language tail', 'contract');
    expect(parsed.action).toBe('search');
    expect(parsed.query).toBe('natural language tail');
  });

  test('JSON schema validation rejects unknown and invalid values', () => {
    const result = validateJsonSchema({
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['count', 'mode'],
      additionalProperties: false,
    }, { count: 0, mode: 'c', extra: true });
    expect(result.valid).toBeFalse();
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  test('trusted host checks do not use substring matching', () => {
    expect(isExactTrustedHostname('https://fitgirl-repacks.site/download', ['fitgirl-repacks.site'])).toBeTrue();
    expect(isExactTrustedHostname('https://evilfitgirl-repacks.site/download', ['fitgirl-repacks.site'])).toBeFalse();
    expect(isExactTrustedHostname('https://fitgirl-repacks.site.evil.test/download', ['fitgirl-repacks.site'])).toBeFalse();
  });
});
