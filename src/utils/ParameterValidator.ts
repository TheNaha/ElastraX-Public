import { BaseTool, type ToolArgs, type ToolDefinition, type ToolParameter } from '../tools/BaseTool';

type CommandArgumentValue = string | number | boolean;
type ToolSchemaProperties = ToolDefinition['function']['parameters']['properties'];
type ParsedCommandArgs = ToolArgs & Record<string, CommandArgumentValue>;

function getSchemaProperty(properties: ToolSchemaProperties, key: string): ToolParameter | undefined {
  return properties[key];
}

export class ParameterValidator {
  static parseArgs(tool: BaseTool, argsStr: string): ParsedCommandArgs {
    const def = tool.definition.function.parameters;
    const properties = def.properties || {};
    const propKeys = Object.keys(properties);

    if (propKeys.length === 0) {
      return {};
    }

    const singleProperty = getSchemaProperty(properties, propKeys[0]);
    if (propKeys.length === 1 && singleProperty?.type === 'string') {
      if (!argsStr && def.required?.includes(propKeys[0])) {
        throw new Error(this.getUsageHelp(tool));
      }
      return { [propKeys[0]]: argsStr };
    }

    const args = this.parseCommandString(argsStr);
    const result: ParsedCommandArgs = {};
    let argIndex = 0;

    for (const key of propKeys) {
      const property = getSchemaProperty(properties, key);
      const type = property?.type;

      if (argIndex < args.length) {
        let value: CommandArgumentValue = args[argIndex];

        if (type === 'number' || type === 'integer') {
          const numericValue = Number(value);
          if (Number.isNaN(numericValue)) {
            throw new Error(`Parameter <${key}> must be a valid number.`);
          }
          value = numericValue;
        } else if (type === 'boolean') {
          value = value === 'true' || value === '1';
        }

        result[key] = value;
        argIndex++;
      } else if (def.required?.includes(key)) {
        throw new Error(this.getUsageHelp(tool));
      }
    }

    return result;
  }

  static parseCommandString(commandString: string): string[] {
    if (!commandString) return [];
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const matches = commandString.matchAll(regex);
    return Array.from(matches, match => match[1] || match[2] || match[0]);
  }

  static getUsageHelp(tool: BaseTool): string {
    const name = tool.aliases.length > 0 ? tool.aliases[0] : tool.name;
    const props = tool.definition.function.parameters?.properties || {};
    let help = `Invalid usage.\n\n*Usage:* /${name}`;

    for (const key of Object.keys(props)) {
      const isRequired = tool.definition.function.parameters.required?.includes(key);
      help += isRequired ? ` <${key}>` : ` [${key}]`;
    }

    help += `\n\n*Description:*\n${tool.description}`;

    const enumEntries = Object.entries(props).filter(([, prop]) => prop.enum && prop.enum.length > 0);
    if (enumEntries.length > 0) {
      help += `\n\n*Available Options:*`;
      for (const [key, prop] of enumEntries) {
        help += `\n  *${key}:* ${prop.enum!.join(' | ')}`;
      }
    }

    return help;
  }
}
