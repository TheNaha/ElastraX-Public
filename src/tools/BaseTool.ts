import { MessageContext } from '../core/MessageContext';

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameter>;
      required: string[];
    };
  };
}

export abstract class BaseTool {
  /**
   * The name of the tool as exposed to the LLM (e.g., 'web_search')
   */
  abstract readonly name: string;

  /**
   * High-level description for the LLM explaining when to use this tool
   */
  abstract readonly description: string;

  /**
   * Return the OpenAI-compatible representation of this tool
   */
  abstract get definition(): ToolDefinition;

  /**
   * Execute the tool with the provided arguments and context
   * @param args Parsed JSON arguments output by the LLM
   * @param ctx The MessageContext (useful if the tool needs to interact via WhatsApp directly, like sending files)
   * @returns A string mapping to the Tool Response for the LLM context, or an object to be stringified.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract execute(args: Record<string, any>, ctx: MessageContext): Promise<string>;
}
