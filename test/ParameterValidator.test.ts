import { expect, test, describe } from 'bun:test';
import { ParameterValidator } from '../src/tools/ParameterValidator';
import { BaseTool, ToolDefinition } from '../src/tools/BaseTool';
import { MessageContext } from '../src/core/MessageContext';
import { MediaConvertTool } from '../src/tools/MediaConvertTool';

class MockSingleStringTool extends BaseTool {
  readonly name = 'echo';
  readonly description = 'Echoes text';
  readonly aliases = ['e'];
  readonly category = 'utility';
  readonly permissions = 'user';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'text to echo' }
          },
          required: ['text']
        }
      }
    };
  }

  async execute(args: Record<string, any>, _ctx: MessageContext): Promise<string> {
    return args.text;
  }
}

class MockMultiArgTool extends BaseTool {
  readonly name = 'user';
  readonly description = 'Creates string user';
  readonly aliases = [];
  readonly category = 'utility';
  readonly permissions = 'user';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'username' },
            age: { type: 'number', description: 'age' },
            active: { type: 'boolean', description: 'is active' }
          },
          required: ['username', 'age']
        }
      }
    };
  }

  async execute(_args: Record<string, any>, _ctx: MessageContext): Promise<string> {
    return 'ok';
  }
}

describe('ParameterValidator', () => {
  const singleTool = new MockSingleStringTool();
  const multiTool = new MockMultiArgTool();

  test('should map entire string to a single required string parameter', () => {
    const args = ParameterValidator.parseArgs(singleTool, 'hello world with "quotes"');
    expect(args.text).toBe('hello world with "quotes"');
  });

  test('should throw error if required single string parameter is missing', () => {
    expect(() => ParameterValidator.parseArgs(singleTool, '')).toThrow(/Invalid usage/);
  });

  test('should parse space-separated arguments for multi-arg tool', () => {
    const args = ParameterValidator.parseArgs(multiTool, 'johndoe 25 true');
    expect(args.username).toBe('johndoe');
    expect(args.age).toBe(25);
    expect(args.active).toBe(true);
  });

  test('should respect quotes in multi-arg tool', () => {
    const args = ParameterValidator.parseArgs(multiTool, '"john doe" 30');
    expect(args.username).toBe('john doe');
    expect(args.age).toBe(30);
    expect(args.active).toBeUndefined();
  });

  test('should throw error if multi-arg required parameter is missing', () => {
    expect(() => ParameterValidator.parseArgs(multiTool, 'johndoe')).toThrow(/Invalid usage/);
  });

  test('should coerce types correctly', () => {
    expect(() => ParameterValidator.parseArgs(multiTool, 'johndoe notanumber')).toThrow(/must be a valid number/);
  });
});

describe('generic key=value overrides', () => {
  // MediaConvertTool has no command grammar, so it reaches the generic
  // positional loop - the path where an override token used to be bound to the
  // next positional slot instead.
  const tool = new MediaConvertTool();

  test('binds an override to its own field', () => {
    const args = ParameterValidator.parseArgs(tool, 'mp3 resolution=720p');
    expect(args.format).toBe('mp3');
    expect(args.resolution).toBe('720p');
    expect(args.attachment_id).toBeUndefined();
  });

  test('does not consume the next positional for an overridden field', () => {
    const args = ParameterValidator.parseArgs(tool, 'mp3 resolution=720p fps=30');
    expect(args.format).toBe('mp3');
    expect(args.resolution).toBe('720p');
    expect(args.fps).toBe('30');
    expect(args.attachment_id).toBeUndefined();
  });

  test('leaves a positional that merely contains = alone', () => {
    const args = ParameterValidator.parseArgs(tool, 'mp3 a=b');
    expect(args.format).toBe('mp3');
    expect(args.attachment_id).toBe('a=b');
  });

  test('an undeclared name stays a positional and is reported when nothing can take it', () => {
    // `bogus` is not a property of multiTool, so `bogus=1` is an ordinary
    // positional. It must not be silently dropped.
    const multi = new MockMultiArgTool();
    expect(() => ParameterValidator.parseArgs(multi, 'johndoe 30 true bogus=1')).toThrow(/Unexpected argument/);
  });
});
