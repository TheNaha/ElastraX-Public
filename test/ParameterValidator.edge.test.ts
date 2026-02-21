import { expect, test, describe } from 'bun:test';
import { ParameterValidator } from '../src/utils/ParameterValidator';
import { BaseTool, ToolDefinition } from '../src/tools/BaseTool';
import { MessageContext } from '../src/core/MessageContext';

// Tool with zero properties
class NoArgTool extends BaseTool {
  readonly name = 'ping';
  readonly description = 'Pings the bot';
  readonly aliases = [];
  readonly category = 'utility';
  readonly permissions = 'user' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };
  }
  async execute(): Promise<string> { return 'pong'; }
}

// Tool with an integer parameter
class CountTool extends BaseTool {
  readonly name = 'count';
  readonly description = 'Counts';
  readonly aliases = [];
  readonly category = 'utility';
  readonly permissions = 'user' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'Number of items' },
          },
          required: ['n'],
        },
      },
    };
  }
  async execute(): Promise<string> { return 'ok'; }
}

// Tool with aliases for getUsageHelp coverage
class AliasedTool extends BaseTool {
  readonly name = 'greet';
  readonly description = 'Greets a user';
  readonly aliases = ['hi', 'hello'];
  readonly category = 'utility';
  readonly permissions = 'user' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Name' },
          },
          required: ['username'],
        },
      },
    };
  }
  async execute(): Promise<string> { return 'hi'; }
}

describe('ParameterValidator – edge cases', () => {
  describe('parseCommandString', () => {
    test('should return empty array for empty string', () => {
      expect(ParameterValidator.parseCommandString('')).toEqual([]);
    });

    test('should split simple space-separated tokens', () => {
      const result = ParameterValidator.parseCommandString('a b c');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    test('should handle single-quoted strings', () => {
      const result = ParameterValidator.parseCommandString("'john doe' 25");
      expect(result).toEqual(['john doe', '25']);
    });

    test('should handle mixed quotes and bare tokens', () => {
      const result = ParameterValidator.parseCommandString('"hello world" foo bar');
      expect(result).toEqual(['hello world', 'foo', 'bar']);
    });
  });

  describe('parseArgs – no properties', () => {
    test('should return empty object when tool has no parameters', () => {
      const tool = new NoArgTool();
      const result = ParameterValidator.parseArgs(tool, 'anything');
      expect(result).toEqual({});
    });
  });

  describe('parseArgs – integer coercion', () => {
    test('should coerce integer parameter', () => {
      const tool = new CountTool();
      const result = ParameterValidator.parseArgs(tool, '42');
      expect(result.n).toBe(42);
    });

    test('should throw for non-numeric integer parameter', () => {
      const tool = new CountTool();
      expect(() => ParameterValidator.parseArgs(tool, 'abc')).toThrow(/must be a valid number/);
    });
  });

  describe('getUsageHelp', () => {
    test('should use first alias instead of tool name', () => {
      const tool = new AliasedTool();
      const help = ParameterValidator.getUsageHelp(tool);
      expect(help).toContain('/hi');
      expect(help).not.toContain('/greet');
    });

    test('should use tool name when no aliases are defined', () => {
      const tool = new CountTool();
      const help = ParameterValidator.getUsageHelp(tool);
      expect(help).toContain('/count');
    });

    test('should mark required parameters with angle brackets', () => {
      const tool = new AliasedTool();
      const help = ParameterValidator.getUsageHelp(tool);
      expect(help).toContain('<username>');
    });

    test('should include tool description in help text', () => {
      const tool = new AliasedTool();
      const help = ParameterValidator.getUsageHelp(tool);
      expect(help).toContain('Greets a user');
    });
  });
});
