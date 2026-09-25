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

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface ToolParameter {
  type: string | JsonSchemaType[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
  additionalProperties?: boolean | ToolParameter;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  default?: unknown;
  nullable?: boolean;
  oneOf?: ToolParameter[];
  anyOf?: ToolParameter[];
  const?: unknown;
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
      additionalProperties?: boolean | ToolParameter;
      [key: string]: unknown;
    };
  };
}

export type CommandArgumentKind = 'string' | 'number' | 'integer' | 'boolean' | 'json';

export interface CommandArgumentSpec {
  name: string;
  kind?: CommandArgumentKind;
  required?: boolean;
  rest?: boolean;
  enum?: readonly string[];
}

export interface CommandVariant {
  value: string;
  arguments: CommandArgumentSpec[];
  description?: string;
}

export interface ToolCommandGrammar {
  discriminator?: string;
  variants: CommandVariant[];
  defaultVariant?: string;
  trailing?: 'last' | 'none';
}

export type ToolMutability = 'read' | 'local-write' | 'external-mutation' | 'admin';

export interface ToolAccessMetadata {
  requiredPermission: string;
  groupOnly: boolean;
  dmOnly: boolean;
  enabled: boolean;
  optIn: boolean;
  platforms: readonly string[];
  mutability: ToolMutability;
  cost: number;
  requiresBinding?: boolean;
  roomBound?: boolean;
}

export interface ToolCommandPolicy {
  requiredPermission?: string;
  groupOnly?: boolean;
  dmOnly?: boolean;
}

export interface ToolCommandMetadata {
  name: string;
  aliases: string[];
  noArgAliases: string[];
  groupOnlyAliases: string[];
  dmOnlyAliases: string[];
  policies: Record<string, ToolCommandPolicy>;
  grammar?: ToolCommandGrammar;
}

export interface ToolMetadata {
  access: ToolAccessMetadata;
  command: ToolCommandMetadata;
}

export abstract class BaseTool<TArgs extends ToolArgs = ToolArgs> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly aliases: string[];
  abstract readonly category: string;
  abstract readonly permissions: string;

  readonly groupOnly: boolean = false;
  readonly dmOnly: boolean = false;
  readonly optIn: boolean = false;
  readonly modelTier: ModelTier = 'standard';
  readonly alwaysLoad: boolean = false;
  readonly triggerPatterns?: RegExp[];
  readonly platforms: readonly string[] = ['whatsapp', 'discord'];
  readonly mutability: ToolMutability = 'read';
  readonly cost: number = 1;
  readonly requiresBinding: boolean = false;
  readonly roomBound: boolean = false;
  readonly commandGrammar?: ToolCommandGrammar;
  readonly noArgAliases: readonly string[] = [];
  readonly groupOnlyAliases: readonly string[] = [];
  readonly dmOnlyAliases: readonly string[] = [];

  abstract get definition(): ToolDefinition;
  abstract execute(args: TArgs, ctx: MessageContext, signal?: AbortSignal): Promise<ToolResult>;

  get metadata(): ToolMetadata {
    const action = this.definition.function.parameters.properties.action;
    const inferredGrammar: ToolCommandGrammar | undefined = this.commandGrammar ?? (action?.enum && action.enum.length > 0
      ? {
          discriminator: 'action',
          variants: action.enum.map((value) => ({ value: String(value), arguments: Object.entries(this.definition.function.parameters.properties).filter(([key]) => key !== 'action').map(([name, parameter]) => ({ name, kind: (Array.isArray(parameter.type) ? parameter.type[0] : parameter.type) as CommandArgumentKind, required: this.definition.function.parameters.required?.includes(name) ?? false })) })),
        }
      : undefined);
    return {
      access: {
        requiredPermission: this.permissions,
        groupOnly: this.groupOnly,
        dmOnly: this.dmOnly,
        enabled: this.isEnabled(),
        optIn: this.optIn,
        platforms: [...this.platforms],
        mutability: this.mutability,
        cost: this.cost,
        requiresBinding: this.requiresBinding,
        roomBound: this.roomBound,
      },
      command: {
        name: this.name,
        aliases: [...this.aliases],
        noArgAliases: [...this.noArgAliases],
        groupOnlyAliases: [...this.groupOnlyAliases],
        dmOnlyAliases: [...this.dmOnlyAliases],
        policies: {},
        grammar: inferredGrammar,
      },
    };
  }

  get access(): ToolAccessMetadata {
    return this.metadata.access;
  }

  get accessMetadata(): ToolAccessMetadata {
    return this.access;
  }

  get commandMetadata(): ToolCommandMetadata {
    return this.metadata.command;
  }

  isEnabled(): boolean {
    const enabled = [process.env.ENABLE_PIRACY_TOOLS, process.env.ENABLE_PIRACY_SEARCH, process.env.ENABLE_GAME_SEARCH, process.env.ENABLE_SOFTWARE_SEARCH].some((value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim()));
    return !this.optIn || enabled;
  }
}

export function isExactTrustedHostname(value: string, trustedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return trustedHosts.some((entry) => {
    const raw = entry.trim().toLowerCase();
    if (!raw) return false;
    let trusted = raw;
    if (/^https?:\/\//.test(raw)) {
      try {
        const trustedUrl = new URL(raw);
        trusted = `${trustedUrl.hostname}${trustedUrl.pathname === '/' ? '' : trustedUrl.pathname}`;
      } catch {
        return false;
      }
    }
    const slash = trusted.indexOf('/');
    const hostWithPort = (slash === -1 ? trusted : trusted.slice(0, slash)).replace(/\.$/, '');
    const portMatch = hostWithPort.match(/^([^:]+):(\d+)$/);
    const wildcard = hostWithPort.startsWith('*.');
    const baseHost = wildcard ? hostWithPort.slice(2) : (portMatch?.[1] ?? hostWithPort);
    const hostnameMatches = wildcard
      ? hostname.endsWith(`.${baseHost}`)
      : hostname === baseHost || hostname.endsWith(`.${baseHost}`);
    if (!hostnameMatches) return false;
    if (portMatch && parsed.port !== portMatch[2]) return false;
    if (slash === -1) return true;
    const path = trusted.slice(slash).replace(/\/$/, '').toLowerCase();
    return path === '' || parsed.pathname.toLowerCase() === path || parsed.pathname.toLowerCase().startsWith(`${path}/`);
  });
}
