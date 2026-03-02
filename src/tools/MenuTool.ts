/**
 * @file src/tools/MenuTool.ts
 * @description Interactive help menu tool for ElastraX.
 *
 * Generates a formatted list of all available slash commands (grouped by category)
 * when invoked with no arguments, or detailed usage information for a specific command
 * when a `command_name` argument is provided.
 *
 * The tool receives a `ToolGetter` function at construction time (instead of importing
 * the `tools` array directly) to avoid circular dependencies between `index.ts` and
 * the individual tool files.
 *
 * Slash command aliases: `/help`, `/h`, `/?`
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'MenuTool' });

/** A function that returns the current list of all registered tools (injected to avoid circular imports). */
type ToolGetter = () => BaseTool[];

/** Interactive help and command-discovery tool. */
export class MenuTool extends BaseTool {
  /** Injected supplier for the live tool list — avoids a circular import with `tools/index.ts`. */
  private getTools: ToolGetter;

  constructor(getTools: ToolGetter) {
    super();
    this.getTools = getTools;
  }
  readonly name = 'menu';
  readonly description = 'Displays the main menu of available commands, or detailed help for a specific command.';
  readonly aliases = ['help', 'h', '?'];
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
            command_name: {
              type: 'string',
              description: 'The specific command name to get help for. Leave empty to see the full menu.',
            },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const { command_name } = args;
    const lang = ctx.language;
    const tools = this.getTools();

    log.debug({ command_name: command_name || null, chatId: ctx.chatId }, 'Menu requested');

    if (command_name) {
      const tool = tools.find(
        (tool) => tool.name === command_name.toLowerCase() || tool.aliases.includes(command_name.toLowerCase())
      );

      if (!tool) {
        return t(lang, 'menu.not_found', { name: command_name });
      }

      let help = t(lang, 'menu.help_for', { name: tool.name });
      help += `${t(lang, 'menu.description')} ${tool.description}\n`;

      if (tool.aliases.length > 0) {
        help += `${t(lang, 'menu.aliases')} ${tool.aliases.join(', ')}\n`;
      }

      help += `${t(lang, 'menu.category')} ${tool.category}\n`;
      help += `${t(lang, 'menu.permissions')} ${tool.permissions}\n\n`;

      const props = tool.definition.function.parameters.properties;
      const required = tool.definition.function.parameters.required || [];

      let usage = `/${tool.name}`;
      for (const key of Object.keys(props)) {
        usage += required.includes(key) ? ` <${key}>` : ` [${key}]`;
      }

      help += `${t(lang, 'menu.usage')} ${usage}\n\n`;

      if (Object.keys(props).length > 0) {
        help += `${t(lang, 'menu.parameters')}\n`;
        for (const [key, prop] of Object.entries(props)) {
          help += `  - *${key}*: ${prop.description} (${t(lang, 'menu.param_type')} ${prop.type})`;
          if (prop.enum && prop.enum.length > 0) {
            help += `\n    *${t(lang, 'menu.options')}* ${prop.enum.join(' | ')}`;
          }
          help += '\n';
        }
      }

      return help;
    }

    // Default Main Menu
    let menu = `✨ *ElastraX Menu* ✨\n\n`;
    menu += `${t(lang, 'menu.greeting', { name: ctx.senderName })}\n`;
    menu += t(lang, 'menu.hint');

    // Group tools by category
    const categories: Record<string, BaseTool[]> = {};
    for (const tool of tools) {
      const normalizedCategory = tool.category.toLowerCase();
      if (!categories[normalizedCategory]) {
        categories[normalizedCategory] = [];
      }
      categories[normalizedCategory].push(tool);
    }

    // Sort categories alphabetically
    const sortedCategories = Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [cat, catTools] of sortedCategories) {
      menu += `*╭───「 ${cat.toUpperCase()} 」*\n`;
      // Sort tools within category alphabetically
      const sortedTools = catTools.sort((a, b) => a.name.localeCompare(b.name));
      for (const tool of sortedTools) {
        const aliasesStr = tool.aliases.length > 0 ? ` (${tool.aliases.join(', ')})` : '';
        menu += `*│* ❏ /${tool.name}${aliasesStr}\n`;
      }
      menu += `*╰──────────────*\n\n`;
    }

    menu += t(lang, 'menu.footer');

    return menu;
  }
}
