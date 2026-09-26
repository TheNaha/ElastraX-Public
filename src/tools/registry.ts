import { existsSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { admitPluginManifest, resolveAllowedPluginPermissions } from '../plugins/manifest';
import { BaseTool, type ToolDefinition, type ToolMetadata } from './BaseTool';
import { WebSearchTool } from './WebSearchTool';
import { MenuTool } from './MenuTool';
import { MakeStickerTool } from './MakeStickerTool';
import { GroupAdminTool } from './GroupAdminTool';
import { LanguageTool } from './LanguageTool';
import { ConfigTool } from './ConfigTool';
import { PingTool } from './PingTool';
import { IDTool } from './IDTool';
import { StatsTool } from './StatsTool';
import { TranslateTool } from './TranslateTool';
import { DeleteMessageTool } from './DeleteMessageTool';
import { DownloadTool } from './DownloadTool';
import { MediaConvertTool } from './MediaConvertTool';
import { PDFTool } from './PDFTool';
import { ReminderTool } from './ReminderTool';
import { MenfessTool } from './MenfessTool';
import { RoleTool } from './RoleTool';
import { TranscribeTool } from './TranscribeTool';
import { OwnerTool } from './OwnerTool';
import { FindToolsTool, setToolSearchIndex } from './FindToolsTool';
import { SpeakTool } from './SpeakTool';
import { KnowledgeTool } from './KnowledgeTool';
import { MediaBindTool } from './MediaBindTool';
import { MediaSearchTool } from './MediaSearchTool';
import { MediaRequestTool } from './MediaRequestTool';
import { MediaLibraryTool } from './MediaLibraryTool';
import { MemoryTool } from './MemoryTool';
import { DigestTool } from './DigestTool';
import { WebScrapeTool } from './WebScrapeTool';
import { GameSearchTool } from './GameSearchTool';
import { SoftwareSearchTool } from './SoftwareSearchTool';
import { ToolSearchIndex } from '../agent/ToolSearchIndex';
import { logger } from '../utils/logger';
import { getToolTimeoutMs } from '../config/runtime';
import { withCancellableTimeout } from '../utils/withTimeout';
import type { MessageContext } from '../core/MessageContext';
import { parseExplicitCommand, validateToolArguments, type ValidationResult } from './ParameterValidator';
import type { ToolResult } from './BaseTool';

const log = logger.child({ module: 'ToolRegistry' });

export interface ToolAccessContext {
  roles?: readonly string[];
  isGroup?: boolean;
  isOwner?: boolean;
  platform?: string;
  command?: string;
  hasBinding?: boolean;
  userId?: string;
}

export interface ToolCatalogEntry {
  tool: BaseTool;
  definition: ToolDefinition;
  metadata: ToolMetadata;
  access: ToolMetadata['access'];
  command: ToolMetadata['command'];
}

export type ToolCatalog = ToolCatalogEntry[];
export type ToolAccessContextWithRoles = ToolAccessContext & { roles: readonly string[] };

export const toolsList: BaseTool[] = [];
export const tools = toolsList;
export const toolSearchIndex = new ToolSearchIndex();
setToolSearchIndex(toolSearchIndex);

let toolsMap = new Map<string, BaseTool>();
let aliasMap = new Map<string, BaseTool>();
let cachedAllDefinitions: ToolDefinition[] = [];
let cachedAlwaysLoadedDefinitions: ToolDefinition[] = [];
let discoverableTools: BaseTool[] = [];
let reloadChain: Promise<void> = Promise.resolve();
let reloadSequence = 0;
let registryGeneration = 0;
const mutationQueues = new Map<string, Promise<unknown>>();
const rateWindows = new Map<string, { startedAt: number; cost: number }>();

function hasRole(roles: readonly string[] | undefined, required: string): boolean {
  if (required === 'user') return true;
  const set = new Set(roles ?? ['user']);
  return set.has('owner') || set.has(required);
}

export function getToolCost(tool: BaseTool): number {
  return Math.max(0, tool.cost);
}

export function getToolMutability(tool: BaseTool): ToolMetadata['access']['mutability'] {
  return MUTABILITY_OVERRIDES[tool.name] ?? tool.metadata.access.mutability;
}

export function getToolAccess(tool: BaseTool): ToolMetadata['access'] {
  const access = tool.metadata.access;
  return { ...access, mutability: MUTABILITY_OVERRIDES[tool.name] ?? access.mutability };
}

const COMMAND_POLICIES: Record<string, Record<string, string>> = {
  language: { set: 'admin', reset: 'admin' },
  config: { set: 'admin', reset: 'admin' },
  media_account: { connect: 'user' },
  role: { grant: 'admin', revoke: 'admin', setpriv: 'owner', resetpriv: 'owner' },
  owner_admin: { leave: 'user', botleave: 'user' },
};
const COMMAND_GROUP_ONLY: Record<string, readonly string[]> = {
  owner_admin: ['leave', 'botleave'],
};
const MUTABILITY_OVERRIDES: Record<string, ToolMetadata['access']['mutability']> = {
  owner_admin: 'admin',
  config: 'admin',
  language: 'local-write',
  reminder: 'local-write',
  delete_message: 'external-mutation',
  download_media: 'external-mutation',
  media_convert: 'local-write',
};

function hasRequiredRole(roles: readonly string[] | undefined, required: string): boolean {
  if (required === 'user') return true;
  const set = new Set(roles ?? []);
  return set.has('owner') || set.has(required);
}

export interface ToolAdmission {
  allowed: boolean;
  cost: number;
  remaining: number;
  reason?: string;
}

export function checkToolAdmission(tool: BaseTool, context: ToolAccessContext & { userId?: string } = {}, now = Date.now()): ToolAdmission {
  if (getToolMutability(tool) === 'read') return { allowed: true, cost: 0, remaining: Number.POSITIVE_INFINITY };
  const configured = Number.parseInt(process.env.TOOL_MUTATION_COST_LIMIT ?? '100', 10);
  const limit = Number.isFinite(configured) && configured > 0 ? configured : 100;
  const windowMs = 60_000;
  // `rateWindows` is only ever added to, so without a sweep it grows by one
  // entry per (tool, user) pair for the life of the process. Dropping windows
  // that can no longer influence a decision keeps it bounded; the active one is
  // re-created below on demand.
  if (rateWindows.size > 64) {
    for (const [existingKey, window] of rateWindows) {
      if (now - window.startedAt >= windowMs) rateWindows.delete(existingKey);
    }
  }
  const key = `${tool.name}:${context.userId ?? 'global'}`;
  const current = rateWindows.get(key);
  const state = !current || now - current.startedAt >= windowMs ? { startedAt: now, cost: 0 } : current;
  const cost = Math.max(1, tool.cost);
  if (state.cost + cost > limit) {
    rateWindows.set(key, state);
    return { allowed: false, cost, remaining: Math.max(0, limit - state.cost), reason: 'tool rate limit exceeded' };
  }
  state.cost += cost;
  rateWindows.set(key, state);
  return { allowed: true, cost, remaining: Math.max(0, limit - state.cost) };
}

export function resetToolRateLimits(): void {
  rateWindows.clear();
  mutationQueues.clear();
}

export async function runMutatingTool<T>(tool: BaseTool, context: MessageContext, task: () => Promise<T>): Promise<T> {
  if (getToolMutability(tool) === 'read') return task();
  const admission = checkToolAdmission(tool, { userId: context.senderId });
  if (!admission.allowed) throw new Error(admission.reason ?? 'tool admission denied');
  const key = `${tool.name}:${context.senderId}`;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  mutationQueues.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

export function isToolEnabled(tool: BaseTool): boolean {
  try {
    return tool.isEnabled();
  } catch (error: unknown) {
    log.warn({ err: error, tool: tool.name }, 'Tool enablement check failed; disabling tool');
    return false;
  }
}

export function isToolAccessible(tool: BaseTool, context: ToolAccessContext = {}): boolean {
  if (!isToolEnabled(tool)) return false;
  if (tool.requiresBinding && context.hasBinding === false) return false;
  const isGroup = context.isGroup === true;
  if (context.platform && !tool.metadata.access.platforms.includes(context.platform)) return false;
  if (tool.groupOnly && !isGroup) return false;
  if (tool.dmOnly && isGroup) return false;
  if (context.isOwner === true || context.roles?.includes('owner')) return true;
  return hasRole(context.roles, tool.permissions);
}

export function isCommandAccessible(tool: BaseTool, command: string, context: ToolAccessContext = {}): boolean {
  if (typeof command !== 'string') return false;
  if (!isToolAccessible(tool, context)) return false;
  const normalized = command.trim().replace(/^\/+/, '').toLowerCase();
  const metadata = tool.metadata.command;
  if (metadata.groupOnlyAliases.includes(normalized) && context.isGroup !== true) return false;
  if (COMMAND_GROUP_ONLY[tool.name]?.includes(normalized) && context.isGroup !== true) return false;
  if (metadata.dmOnlyAliases.includes(normalized) && context.isGroup === true) return false;
  const required = COMMAND_POLICIES[tool.name]?.[normalized];
  if (required && !hasRequiredRole(context.roles, required)) return false;
  return true;
}

export function getToolMetadata(tool: BaseTool): ToolMetadata {
  const metadata = tool.metadata;
  const access = getToolAccess(tool);
  const policies = { ...metadata.command.policies };
  for (const [command, requiredPermission] of Object.entries(COMMAND_POLICIES[tool.name] ?? {})) {
    policies[command] = { ...policies[command], requiredPermission };
  }
  for (const command of metadata.command.groupOnlyAliases) policies[command] = { ...policies[command], groupOnly: true };
  for (const command of COMMAND_GROUP_ONLY[tool.name] ?? []) policies[command] = { ...policies[command], groupOnly: true };
  for (const command of metadata.command.dmOnlyAliases) policies[command] = { ...policies[command], dmOnly: true };
  return { ...metadata, access, command: { ...metadata.command, policies } };
}

/**
 * The definition as it should be advertised to a model: `additionalProperties`
 * closed. `validateToolArguments` enforces this server-side regardless, so the
 * risk of skipping it is spurious "Additional properties are not allowed"
 * failures rather than an injection hole — but the model should never be told
 * that unknown keys are acceptable.
 */
export function secureDefinition(tool: BaseTool): ToolDefinition {
  const definition = tool.definition;
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: {
        ...definition.function.parameters,
        additionalProperties: definition.function.parameters.additionalProperties ?? false,
      },
    },
  };
}

export function getToolCatalog(context?: ToolAccessContext): ToolCatalogEntry[] {
  return toolsList
    .filter((tool) => !context || isToolAccessible(tool, context))
    .map((tool) => {
      const metadata = getToolMetadata(tool);
      return {
        tool,
        definition: secureDefinition(tool),
        metadata,
        access: metadata.access,
        command: metadata.command,
      };
    });
}

export function isToolInvocationAccessible(tool: BaseTool, args: { action?: unknown; __command?: unknown } | null | undefined, context: ToolAccessContext = {}): boolean {
  const command = typeof args?.__command === 'string' ? args.__command : typeof args?.action === 'string' ? args.action : '';
  if (command && !isCommandAccessible(tool, command, context)) return false;
  return isToolAccessible(tool, context);
}

export function validateAndAuthorizeInvocation(tool: BaseTool, args: unknown, context: ToolAccessContext = {}): ValidationResult {
  if (!isToolInvocationAccessible(tool, args as { action?: unknown; __command?: unknown } | null, context)) {
    return { valid: false, value: args, errors: ['Tool invocation is not authorized for this context.'], issues: [{ path: '$', message: 'Tool invocation is not authorized for this context.', keyword: 'access' }] };
  }
  return validateToolArguments(tool, args);
}

export function getToolDispatchContract(command: string, context?: ToolAccessContext): ToolCatalogEntry | undefined {
  const tool = getToolByAliasOrName(command, context);
  if (!tool) return undefined;
  return getToolCatalog(context).find((entry) => entry.tool === tool);
}

export function getToolsForContext(context: ToolAccessContext = {}): BaseTool[] {
  return toolsList.filter((tool) => isToolAccessible(tool, context));
}

export function getDiscoverableTools(context?: ToolAccessContext): BaseTool[] {
  const allowed = context ? getToolsForContext(context) : discoverableTools;
  return allowed.filter((tool) => !tool.alwaysLoad);
}

export function getToolByName(name: string, context?: ToolAccessContext): BaseTool | undefined {
  if (typeof name !== 'string') return undefined;
  const tool = toolsMap.get(name.trim().replace(/^\/+/, '').toLowerCase());
  if (!tool || (context && !isToolAccessible(tool, context))) return undefined;
  return tool;
}

export function getToolByAliasOrName(command: string, context?: ToolAccessContext): BaseTool | undefined {
  if (typeof command !== 'string') return undefined;
  const normalized = command.trim().replace(/^\/+/, '').toLowerCase();
  const tool = aliasMap.get(normalized);
  if (!tool || (context && !isCommandAccessible(tool, normalized, context))) return undefined;
  return tool;
}

export type AuthorizedToolInvocation = { tool: BaseTool; args?: unknown };
export async function authorizeToolInvocation(command: string, ctx: MessageContext, args?: unknown): Promise<AuthorizedToolInvocation | undefined> {
  const tool = await getAuthorizedTool(command, ctx);
  if (!tool) return undefined;
  if (args !== undefined) {
    const roles = typeof ctx.resolveRoles === 'function' ? await ctx.resolveRoles() : [];
    const context: ToolAccessContext = { roles, isGroup: ctx.isGroup, isOwner: roles.includes('owner'), platform: ctx.platform, userId: ctx.senderId };
    if (!validateAndAuthorizeInvocation(tool, args, context).valid) return undefined;
  }
  return { tool, args };
}

export async function executeAuthorizedCommand(command: string, argsString: string, ctx: MessageContext): Promise<ToolResult | undefined> {
  const tool = await getAuthorizedTool(command, ctx);
  if (!tool) return undefined;
  let args: Record<string, unknown>;
  try {
    args = parseExplicitCommand(tool, argsString, command) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error(`Invalid ${command} arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
  const roles = typeof ctx.resolveRoles === 'function' ? await ctx.resolveRoles() : [];
  const context: ToolAccessContext = { roles, isGroup: ctx.isGroup, isOwner: roles.includes('owner'), platform: ctx.platform, userId: ctx.senderId };
  const validation = validateAndAuthorizeInvocation(tool, args, context);
  if (!validation.valid) throw new Error(`Invalid ${command} arguments: ${validation.errors.join('; ')}`);
  return runMutatingTool(tool, ctx, () => withCancellableTimeout(
    signal => tool.execute(args, ctx, signal),
    getToolTimeoutMs(),
    `tool ${tool.name}`,
    ctx.signal,
  ));
}

export function getAuthorizedTool(command: string, ctx: MessageContext): Promise<BaseTool | undefined> {
  return (async () => {
    const tool = getToolByAliasOrName(command);
    if (!tool) return undefined;
    if (tool.groupOnly && !ctx.isGroup) return undefined;
    if (tool.dmOnly && ctx.isGroup) return undefined;
    if (tool.metadata && ctx.platform && tool.metadata.access.platforms.length > 0 && !tool.metadata.access.platforms.includes(ctx.platform)) return undefined;
    const normalized = command.trim().replace(/^\/+/, '').toLowerCase();
    if (tool.metadata) {
      if (tool.metadata.command.dmOnlyAliases.includes(normalized) && ctx.isGroup) return undefined;
      if (tool.metadata.command.groupOnlyAliases.includes(normalized) && !ctx.isGroup) return undefined;
    }
    if (COMMAND_GROUP_ONLY[tool.name]?.includes(normalized) && !ctx.isGroup) return undefined;
    const commandRoles = typeof ctx.resolveRoles === 'function' ? await ctx.resolveRoles() : [];
    const required = COMMAND_POLICIES[tool.name]?.[normalized];
    if (required && !hasRequiredRole(commandRoles, required)) return undefined;
    if (typeof ctx.checkPermissions === 'function' && !(await ctx.checkPermissions(tool.permissions))) return undefined;
    return tool;
  })();
}

export function getToolDefinitions(context?: ToolAccessContext): ToolDefinition[] {
  if (!context) return cachedAllDefinitions;
  return getToolsForContext(context).map((tool) => secureDefinition(tool));
}

export function getAlwaysLoadedDefinitions(context?: ToolAccessContext): ToolDefinition[] {
  if (!context) return cachedAlwaysLoadedDefinitions;
  return getToolsForContext(context).filter((tool) => tool.alwaysLoad).map((tool) => secureDefinition(tool));
}

export function getTriggeredTools(text: string, mimeType?: string, context?: ToolAccessContext): BaseTool[] {
  const source = context ? getDiscoverableTools(context) : discoverableTools;
  const matched: BaseTool[] = [];
  for (const tool of source) {
    const patterns = tool.triggerPatterns;
    if (!patterns) continue;
    const isTriggered = patterns.some((pattern) => {
      pattern.lastIndex = 0;
      const textMatch = pattern.test(text);
      pattern.lastIndex = 0;
      const mimeMatch = !!mimeType && pattern.test(mimeType);
      pattern.lastIndex = 0;
      return textMatch || mimeMatch;
    });
    if (isTriggered) matched.push(tool);
  }
  return matched;
}

export function getToolSearchIndex(): ToolSearchIndex {
  return toolSearchIndex;
}

export function getToolSearchResults(query: string, limit = 20): ReturnType<ToolSearchIndex['search']> {
  return toolSearchIndex.search(query, limit);
}

function validCommandKey(value: string): boolean {
  return /^(?:\?|[a-z0-9])[a-z0-9_?.-]{0,63}$/i.test(value);
}

function pluginConstructor(value: unknown): (new () => BaseTool) | null {
  if (typeof value !== 'function') return null;
  try {
    if (value.prototype instanceof BaseTool) return value as new () => BaseTool;
  } catch {
    return null;
  }
  return null;
}

export function pluginHasValidMetadata(tool: unknown): tool is BaseTool {
  if (!(tool instanceof BaseTool)) return false;
  if (!validCommandKey(tool.name) || !Array.isArray(tool.aliases)) return false;
  if (tool.aliases.some((alias) => typeof alias !== 'string' || !validCommandKey(alias))) return false;
  return tool.aliases.every((alias) => validCommandKey(alias));
}

function instantiatePluginExports(module: Record<string, unknown>, file: string, seen: Set<new () => BaseTool>, seenInstances: Set<BaseTool>): BaseTool[] {
  const values = [module.default, ...Object.values(module)];
  const result: BaseTool[] = [];
  for (const value of values) {
    const constructor = pluginConstructor(value);
    if (!constructor && !(value instanceof BaseTool)) continue;
    if (constructor && seen.has(constructor)) continue;
    if (value instanceof BaseTool && seenInstances.has(value)) continue;
    if (constructor) seen.add(constructor);
    try {
      const instance = value instanceof BaseTool ? value : new constructor!();
      if (!pluginHasValidMetadata(instance)) {
        log.warn({ plugin: file }, 'Ignoring plugin with invalid tool metadata');
        continue;
      }
      const aliases = instance.aliases.filter((alias): alias is string => typeof alias === 'string' && validCommandKey(alias));
      if (aliases.length !== instance.aliases.length) {
        log.warn({ plugin: file, tool: instance.name }, 'Ignoring plugin with invalid aliases');
        continue;
      }
      if (value instanceof BaseTool) seenInstances.add(value);
      result.push(instance);
    } catch (error: unknown) {
      log.warn({ err: error, plugin: file }, 'Plugin constructor failed');
    }
  }
  return result;
}

/** What the loader accepted, refused, or could not review. Surfaced for operators. */
export type PluginLoadReport = {
  manifestName: string | null;
  version: string | null;
  tools: string[];
  status: 'loaded' | 'loaded-unreviewed' | 'refused';
  reason?: string;
};

const pluginReports: PluginLoadReport[] = [];

export function getPluginLoadReports(): readonly PluginLoadReport[] {
  return pluginReports;
}

async function loadPluginTools(): Promise<BaseTool[]> {
  const pluginsDir = join(import.meta.dir, '..', 'plugins');
  if (!existsSync(pluginsDir)) {
    // No plugin directory is a normal deployment, not an error. Creating it here
    // made plugin loading throw on a read-only container and silently reduced the
    // bot to core tools.
    return [];
  }
  let root: string;
  try {
    root = realpathSync(pluginsDir);
  } catch {
    return [];
  }
  const allowedPermissions = resolveAllowedPluginPermissions(process.env.PLUGIN_ALLOWED_PERMISSIONS);
  const files = readdirSync(pluginsDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort();
  const loaded: BaseTool[] = [];
  const seenConstructors = new Set<new () => BaseTool>();
  const seenInstances = new Set<BaseTool>();
  for (const file of files) {
    const filePath = join(pluginsDir, file);
    try {
      if (realpathSync(filePath).startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`) === false) continue;
      const module = await import(`${filePath}?update=${Date.now()}-${++reloadSequence}`);
      const admission = admitPluginManifest(
        (module as Record<string, unknown>).pluginManifest,
        allowedPermissions,
      );
      if (!admission.allowed) {
        pluginReports.push({
          manifestName: null, version: null, tools: [], status: 'refused',
          reason: `${file}: ${admission.reason}`,
        });
        log.warn({ plugin: file, reason: admission.reason }, 'Refused plugin');
        continue;
      }
      const tools = instantiatePluginExports(module as Record<string, unknown>, file, seenConstructors, seenInstances);
      loaded.push(...tools);
      pluginReports.push({
        manifestName: admission.manifest?.name ?? null,
        version: admission.manifest?.version ?? null,
        tools: tools.map(tool => tool.name),
        status: admission.manifest ? 'loaded' : 'loaded-unreviewed',
        ...(admission.reason ? { reason: admission.reason } : {}),
      });
    } catch (error: unknown) {
      log.error({ err: error, file }, 'Failed to load plugin');
    }
  }
  return loaded;
}

function buildCoreTools(): BaseTool[] {
  return [
    new WebSearchTool(), new GameSearchTool(), new SoftwareSearchTool(), new MenuTool(() => toolsList),
    new PingTool(), new IDTool(), new StatsTool(), new TranslateTool(), new ReminderTool(), new DeleteMessageTool(),
    new TranscribeTool(), new MemoryTool(), new DigestTool(), new WebScrapeTool(), new MakeStickerTool(),
    new DownloadTool(), new MediaConvertTool(), new PDFTool(), new GroupAdminTool(), new LanguageTool(), new ConfigTool(),
    new RoleTool(), new MenfessTool(), new MediaBindTool(), new MediaSearchTool(), new MediaRequestTool(),
    new MediaLibraryTool(), new OwnerTool(), new FindToolsTool(), new SpeakTool(), new KnowledgeTool(),
  ];
}

function applyCandidates(candidates: BaseTool[]): void {
  const nextToolsMap = new Map<string, BaseTool>();
  const nextAliasMap = new Map<string, BaseTool>();
  const nextList: BaseTool[] = [];
  for (const tool of candidates) {
    const name = tool.name.toLowerCase();
    if (!validCommandKey(name) || !Array.isArray(tool.aliases)) continue;
    if (nextToolsMap.has(name)) {
      log.warn({ toolName: tool.name }, 'Duplicate tool name rejected');
      continue;
    }
    if (tool.aliases.some((alias) => typeof alias !== 'string')) {
      log.warn({ toolName: tool.name }, 'Tool with invalid alias rejected');
      continue;
    }
    const aliases = [...new Set(tool.aliases.map((alias) => alias.toLowerCase()))];
    if (aliases.some((alias) => !validCommandKey(alias)) || aliases.length !== tool.aliases.length) {
      log.warn({ toolName: tool.name }, 'Tool with invalid alias rejected');
      continue;
    }
    const collision = aliases.find((alias) => nextAliasMap.has(alias));
    if (collision) {
      log.warn({ toolName: tool.name, alias: collision }, 'Tool alias collision rejected');
      continue;
    }
    nextToolsMap.set(name, tool);
    nextAliasMap.set(name, tool);
    for (const alias of aliases) nextAliasMap.set(alias, tool);
    nextList.push(tool);
  }
  const nextDiscoverable = nextList.filter((tool) => !tool.alwaysLoad);
  const nextDefinitions = nextList.map((tool) => secureDefinition(tool));
  const nextAlways = nextList.filter((tool) => tool.alwaysLoad).map((tool) => secureDefinition(tool));
  toolsList.length = 0;
  toolsList.push(...nextList);
  toolsMap = nextToolsMap;
  aliasMap = nextAliasMap;
  discoverableTools = nextDiscoverable;
  cachedAllDefinitions = nextDefinitions;
  cachedAlwaysLoadedDefinitions = nextAlways;
  toolSearchIndex.build(nextDiscoverable);
  log.info({ toolCount: nextList.length, discoverable: nextDiscoverable.length }, 'Tool registry reloaded');
}

async function reloadRegistryInternal(): Promise<void> {
  applyCandidates([...buildCoreTools(), ...(await loadPluginTools())].filter((tool) => isToolEnabled(tool)));
}

export function reloadRegistry(): Promise<void> {
  registryGeneration++;
  const run = reloadChain.then(() => reloadRegistryInternal());
  reloadChain = run.catch(() => undefined);
  return run;
}

const initialGeneration = registryGeneration;
applyCandidates(buildCoreTools().filter((tool) => isToolEnabled(tool)));
export const registryReady: Promise<void> = loadPluginTools().then((plugins) => {
  if (registryGeneration === initialGeneration) applyCandidates([...buildCoreTools(), ...plugins].filter((tool) => isToolEnabled(tool)));
}).catch((error: unknown) => {
  log.error({ err: error }, 'Initial plugin load failed');
});

export function getRegistryState() {
  return {
    tools: [...toolsList],
    definitions: [...cachedAllDefinitions],
    alwaysLoadedDefinitions: [...cachedAlwaysLoadedDefinitions],
    discoverable: [...discoverableTools],
  };
}
