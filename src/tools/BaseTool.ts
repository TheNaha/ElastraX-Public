/**
 * @file src/tools/BaseTool.ts
 * @description Abstract base class and shared type definitions for all ElastraX tools.
 *
 * Every tool in `src/tools/` must extend `BaseTool` and implement its abstract members.
 * This ensures a consistent shape that is consumed by:
 *  - The **LLM function-calling** layer (`definition` → OpenAI tool schema)
 *  - The **slash-command router** (`aliases`, `permissions`, `execute`)
 *  - The **`/menu` help system** (`name`, `description`, `category`, `aliases`)
 *
 * Minimal example:
 * ```ts
 * export class EchoTool extends BaseTool {
 *   readonly name = 'echo';
 *   readonly description = 'Echoes back the user input.';
 *   readonly aliases = ['e'];
 *   readonly category = 'utility';
 *   readonly permissions = 'user';
 *
 *   get definition(): ToolDefinition { ... }
 *
 *   async execute(args, ctx) {
 *     return args.text;
 *   }
 * }
 * ```
 */

import { MessageContext } from '../core/MessageContext';
import type { ModelTier } from '../types/ai';

/** JSON Schema property descriptor for a single tool parameter. */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

/**
 * OpenAI-compatible function-calling tool definition.
 * Serialised and sent to the LLM as part of the `tools` array in the chat-completion payload.
 */
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
   * Command aliases that can trigger this tool directly
   */
  abstract readonly aliases: string[];

  /**
   * The category this tool belongs to (e.g. 'utility', 'media', 'admin')
   */
  abstract readonly category: string;

  /**
   * Permissions required to execute this tool as a command
   */
  abstract readonly permissions: 'user' | 'admin' | 'owner';

  /**
   * If true, this tool can only be executed in a group chat directly
   */
  readonly groupOnly?: boolean = false;

  /**
   * Preferred LLM model tier for responses when this tool is involved.
   * 'fast' = cheap/small model, 'standard' = default, 'powerful' = large model.
   * The ModelRouter will prefer providers matching this tier.
   */
  readonly modelTier?: ModelTier = 'standard';

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
