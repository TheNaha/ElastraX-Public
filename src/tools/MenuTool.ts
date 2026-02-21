import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';

type ToolGetter = () => BaseTool[];

export class MenuTool extends BaseTool {
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
    const tools = this.getTools();

    if (command_name) {
      const tool = tools.find(
        (t) => t.name === command_name.toLowerCase() || t.aliases.includes(command_name.toLowerCase())
      );

      if (!tool) {
        return `❌ Command or tool "*${command_name}*" not found. Type /menu to see all commands.`;
      }

      let help = `*Bantuan untuk: /${tool.name}*\n\n`;
      help += `*Deskripsi:* ${tool.description}\n`;
      
      if (tool.aliases.length > 0) {
        help += `*Alias:* ${tool.aliases.join(', ')}\n`;
      }
      
      help += `*Kategori:* ${tool.category}\n`;
      help += `*Izin:* ${tool.permissions}\n\n`;

      const props = tool.definition.function.parameters.properties;
      const required = tool.definition.function.parameters.required || [];
      
      let usage = `/${tool.name}`;
      for (const key of Object.keys(props)) {
        usage += required.includes(key) ? ` <${key}>` : ` [${key}]`;
      }
      
      help += `*Penggunaan:* ${usage}\n\n`;

      if (Object.keys(props).length > 0) {
        help += `*Parameter:*\n`;
        for (const [key, prop] of Object.entries(props)) {
          help += `  - *${key}*: ${prop.description} (Tipe: ${prop.type})\n`;
        }
      }

      return help;
    }

    // Default Main Menu
    let menu = `✨ *ElastraX Menu* ✨\n\n`;
    menu += `Halo ${ctx.senderName}!\n`;
    menu += `Gunakan */help <command>* untuk melihat detail cara menggunakan sebuah command.\n\n`;

    // Group tools by category
    const categories: Record<string, BaseTool[]> = {};
    for (const tool of tools) {
      if (!categories[tool.category]) {
        categories[tool.category] = [];
      }
      categories[tool.category].push(tool);
    }

    for (const [cat, catTools] of Object.entries(categories)) {
      menu += `*╭───「 ${cat.toUpperCase()} 」*\n`;
      for (const tool of catTools) {
        const aliasesStr = tool.aliases.length > 0 ? ` (${tool.aliases.join(', ')})` : '';
        menu += `*│* ❏ /${tool.name}${aliasesStr}\n`;
      }
      menu += `*╰──────────────*\n\n`;
    }

    menu += `_Powered by ElastraX v7 with Native AI_`;
    
    return menu;
  }
}
