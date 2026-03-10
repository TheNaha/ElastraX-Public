import { MessageContext } from '../core/MessageContext';
import type { ModelTier } from '../types/ai';

export interface ToolResponse {
  text: string;
  mentions?: string[];
}

export type ToolResult = string | ToolResponse;

export type ToolArgs = Record<string, unknown> & {
  __command?: string;
};

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

export abstract class BaseTool<TArgs extends ToolArgs = ToolArgs> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly aliases: string[];
  abstract readonly category: string;
  abstract readonly permissions: string;

  readonly groupOnly?: boolean = false;
  readonly modelTier?: ModelTier = 'standard';

  /**
   * When true, this tool's definition is always included in the LLM context
   * (not deferred behind the find_tools search). Keep this set for only
   * the 3-5 most universally needed tools to stay under ~600 tokens baseline.
   */
  readonly alwaysLoad?: boolean = false;

  /**
   * Regex patterns that, when matched against the incoming user message or
   * attachment metadata, cause this tool to be pre-loaded alongside the
   * always-loaded set — skipping the extra `find_tools` round-trip.
   */
  readonly triggerPatterns?: RegExp[];

  abstract get definition(): ToolDefinition;
  abstract execute(args: TArgs, ctx: MessageContext): Promise<ToolResult>;
}
