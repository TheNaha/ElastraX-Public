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

  abstract get definition(): ToolDefinition;
  abstract execute(args: TArgs, ctx: MessageContext): Promise<ToolResult>;
}
