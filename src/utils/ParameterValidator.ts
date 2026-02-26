/**
 * @file src/utils/ParameterValidator.ts
 * @description Parses and validates raw slash-command argument strings into typed
 *              JSON payloads that match a tool's OpenAI JSON Schema definition.
 *
 * When a user types `/search cats and dogs`, the slash-command router extracts
 * `"cats and dogs"` and calls `ParameterValidator.parseArgs(tool, "cats and dogs")`.
 * The validator maps the raw string onto the tool's declared parameters using
 * simple heuristics:
 *
 *  - **Single string parameter** — the entire argument string is used verbatim
 *    (preserves natural language phrasing like search queries).
 *  - **Multiple parameters** — the string is split respecting quoted sub-strings
 *    (e.g., `add "John Doe" admin` → `['John Doe', 'admin']`).
 *  - **Type coercion** — numeric and boolean fields are cast from the raw string.
 *  - **Required field validation** — throws a user-friendly usage-help message
 *    if a required parameter is missing.
 */

import { BaseTool } from '../tools/BaseTool';

export class ParameterValidator {
  /**
   * Parses and validates raw string arguments into a structured JSON payload according to the tool's OpenAI JSON Schema.
   * Enables explicit slash commands to map intuitively to LLM functions.
   */
  static parseArgs(tool: BaseTool, argsStr: string): Record<string, any> {
    const def = tool.definition.function.parameters;
    const properties = def.properties || {};
    const propKeys = Object.keys(properties);

    if (propKeys.length === 0) {
      return {};
    }

    // Special case: Only 1 string property. Map the entire unparsed string to it (preserves natural phrasing).
    if (propKeys.length === 1 && properties[propKeys[0]].type === 'string') {
      if (!argsStr && def.required?.includes(propKeys[0])) {
         throw new Error(this.getUsageHelp(tool));
      }
      return { [propKeys[0]]: argsStr };
    }

    // Parse strictly by spaces (handling quotes correctly) for multi-arg tools
    const args = this.parseCommandString(argsStr);
    
    const result: Record<string, any> = {};
    let argIndex = 0;

    for (const key of propKeys) {
      const type = properties[key].type;
      
      if (argIndex < args.length) {
        let val: any = args[argIndex];
        
        // Basic Type Coercion
        if (type === 'number' || type === 'integer') {
          val = Number(val);
          if (isNaN(val)) throw new Error(`Parameter <${key}> must be a valid number.`);
        } else if (type === 'boolean') {
          val = val === 'true' || val === '1';
        }

        result[key] = val;
        argIndex++;
      } else if (def.required?.includes(key)) {
        throw new Error(this.getUsageHelp(tool));
      }
    }

    return result;
  }

  /**
   * Safely splits argument strings containing quotes.
   * E.g., `user "john doe" 25` -> `['user', 'john doe', '25']`
   */
  static parseCommandString(commandString: string): string[] {
    if (!commandString) return [];
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const matches = commandString.matchAll(regex);
    return Array.from(matches, m => m[1] || m[2] || m[0]);
  }

  /**
   * Generates a helpful string to send back to the user if they format a command incorrectly.
   */
  static getUsageHelp(tool: BaseTool): string {
    const name = tool.aliases.length > 0 ? tool.aliases[0] : tool.name;
    const props = tool.definition.function.parameters?.properties || {};
    let help = `❌ Invalid usage.\n\n*Usage:* /${name}`;
    
    for (const [key, _prop] of Object.entries(props)) {
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
