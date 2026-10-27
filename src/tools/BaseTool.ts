import { MessageContext } from '../core/MessageContext';
import { SUPPORTED_PLATFORMS } from '../core/platforms';
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

/**
 * Per-instance metadata cache.
 *
 * A `WeakMap` rather than a field on the class, so the class shape stays the
 * same and a plain object can still stand in for a tool in tests.
 */
const METADATA_CACHE = new WeakMap<object, ToolMetadata>();

export abstract class BaseTool<TArgs extends ToolArgs = ToolArgs> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly aliases: string[];
  abstract readonly category: string;
  abstract readonly permissions: string;

  readonly groupOnly: boolean = false;
  readonly dmOnly: boolean = false;
  /**
   * Whether this tool is opt-in.
   *
   * An opt-in tool is only registered when the operator has explicitly
   * enabled it, so it is absent from `/menu`, from the model's tool list, and
   * its slash command reads as "unknown command" rather than advertising a
   * feature the bot cannot deliver.
   */
  readonly optIn: boolean = false;

  /**
   * The environment variable that enables this opt-in tool.
   *
   * Every opt-in tool used to share a single four-way OR over
   * `ENABLE_PIRACY_TOOLS`, `ENABLE_PIRACY_SEARCH`, `ENABLE_GAME_SEARCH` and
   * `ENABLE_SOFTWARE_SEARCH`, so turning on *one* of them turned on all of
   * them. Each opt-in tool now names the flag that governs it.
   */
  readonly optInFlag: string | null = null;
  readonly modelTier: ModelTier = 'standard';
  readonly alwaysLoad: boolean = false;
  readonly triggerPatterns?: RegExp[];
  /**
   * Platforms this tool may run on.
   *
   * Derived from the shared platform list so a newly shipped provider is not
   * silently excluded. The list used to be a literal `['whatsapp', 'discord']`
   * and no tool overrode it, so `isToolAccessible()` rejected every tool on
   * Telegram: the model was offered an empty tool list and every slash command
   * answered "unknown command". A tool that genuinely cannot work on a
   * platform must narrow this list explicitly.
   */
  readonly platforms: readonly string[] = SUPPORTED_PLATFORMS;
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

  /**
   * Cached metadata.
   *
   * `metadata` used to be recomputed on every access, and building it reads
   * `this.definition` up to four times — the definition getter allocates a
   * fresh JSON-schema object each time. The agent makes three full registry
   * passes per inbound message, and every pass touches the metadata of every
   * registered tool, so a single message built roughly 370 schema objects and
   * performed roughly 370 `process.env` reads (via `isEnabled()`) just to
   * decide which tools were reachable.
   *
   * A tool's shape does not change after construction, so the metadata is
   * computed once per instance and kept in a module-level `WeakMap`. The only
   * field that can change is `enabled`, which depends on the environment;
   * `isEnabled()` is therefore still read fresh on every access, but the
   * expensive schema work is not repeated.
   */
  get metadata(): ToolMetadata {
    const cached = METADATA_CACHE.get(this);
    if (cached) {
      // Only `enabled` can change (it reads the environment), so the rest of
      // the metadata is served from the cache.
      return {
        ...cached,
        access: { ...cached.access, enabled: this.isEnabled() },
      };
    }
    const definition = this.definition;
    const action = definition.function.parameters.properties.action;
    const inferredGrammar: ToolCommandGrammar | undefined = this.commandGrammar ?? (action?.enum && action.enum.length > 0
      ? {
          discriminator: 'action',
          variants: action.enum.map((value) => ({
            value: String(value),
            arguments: Object.entries(definition.function.parameters.properties)
              .filter(([key]) => key !== 'action')
              .map(([name, parameter]) => ({
                name,
                kind: (Array.isArray(parameter.type) ? parameter.type[0] : parameter.type) as CommandArgumentKind,
                required: definition.function.parameters.required?.includes(name) ?? false,
              })),
          })),
        }
      : undefined);
    const metadata: ToolMetadata = {
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
    METADATA_CACHE.set(this, metadata);
    return metadata;
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
    // A tool that is not opt-in is always available, so it does not read the
    // environment at all. This matters: the agent asks every registered tool
    // for its metadata several times per inbound message, and each of those
    // used to perform four `process.env` reads.
    if (!this.optIn) return true;
    const flag = this.optInFlag;
    if (!flag) return false;
    return /^(1|true|yes|on)$/i.test(String(process.env[flag] ?? '').trim());
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
