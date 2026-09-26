/**
 * Per-tool reachability harness.
 *
 * A tool is only "implemented" if a real invocation can actually reach its
 * `execute()`. Two tools in this codebase shipped 100% broken through 1212
 * passing tests, because every test called `tool.execute(args)` directly and so
 * bypassed the parsing, validation and admission layers in between. This harness
 * drives the *real* entry points instead:
 *
 *   slash path : getToolByAliasOrName -> parseExplicitCommand -> validateToolArguments
 *   model path : validateToolArguments(tool, modelSuppliedArgs)
 *
 * It asserts that every action a tool advertises in its schema is reachable
 * through at least one of those paths. It never calls `execute`, so it has no
 * side effects.
 *
 * Run with: bun test --no-env-file test/toolReachability.test.ts
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import {
  tools,
  reloadRegistry,
  getToolByAliasOrName,
  getToolByName,
  getToolCatalog,
} from '../src/tools';
import { parseExplicitCommand, validateToolArguments } from '../src/tools/ParameterValidator';
import { translations } from '../src/utils/i18n';
import type { BaseTool } from '../src/tools/BaseTool';

type ParamSchema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, ParamSchema>;
  required?: string[];
};

function schemaOf(tool: BaseTool): ParamSchema {
  return tool.definition.function.parameters as ParamSchema;
}

/** A value that satisfies one parameter's declared type and enum. */
function sampleFor(property: ParamSchema | undefined, name: string): unknown {
  if (property?.enum && property.enum.length > 0) return property.enum[0];
  switch (property?.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      // A descriptive but inert string. Never a real path, URL or credential.
      return `${name}-sample`;
  }
}

/**
 * Build an argument object that satisfies the schema for one action, using only
 * what the tool itself declares. Values are type-correct, so a rejection here
 * means the tool is genuinely unreachable rather than the sample being wrong.
 */
function argsForAction(tool: BaseTool, action: string): Record<string, unknown> {
  const schema = schemaOf(tool);
  const properties = schema.properties ?? {};
  const args: Record<string, unknown> = {};

  // `action` may be the tool's only parameter, or the first of several.
  const actionSchema = properties.action;
  const actions = actionSchema?.enum?.map(String) ?? [];
  if (actionSchema) {
    args.action = actions.includes(action) ? action : (actions[0] ?? action);
  }

  // A grammar variant tells us which fields belong to this action, and in what
  // order. Without one, fall back to the tool's required fields.
  const variant = tool.commandGrammar?.variants.find(v => String(v.value) === args.action);
  const fieldOrder = variant
    ? variant.arguments.map(a => a.name)
    : (schema.required ?? []).filter(name => name !== 'action');

  for (const field of fieldOrder) {
    if (field === 'action' || field in args) continue;
    args[field] = sampleFor(properties[field], field);
  }
  return args;
}

const ownerContext = { roles: ['owner'], isGroup: true, isOwner: true, platform: 'whatsapp' as const };
const plainUserContext = { roles: ['user'], isGroup: false, isOwner: false, platform: 'whatsapp' as const };

/**
 * Validate a candidate argument object, retrying with a sample for any field the
 * validator reports as missing.
 *
 * Per-action requirements (`ACTION_REQUIREMENTS`, e.g. knowledge.search requires
 * `query`) are enforced by the validator but are not expressible in the tool's
 * top-level `required` list, so a single attempt cannot satisfy them. The retry
 * mirrors what a caller that reads the error would do, and still fails loudly if
 * the requirement names a field the schema does not declare.
 */
function validateWithRetries(tool: BaseTool, seed: Record<string, unknown>): string[] {
  const schema = schemaOf(tool);
  const properties = schema.properties ?? {};
  const args = { ...seed };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = validateToolArguments(tool, args);
    if (result.errors === undefined || result.errors.length === 0) return [];
    const missing: string[] = [];
    for (const error of result.errors) {
      const field = /\$\.([A-Za-z0-9_]+)/.exec(error)?.[1];
      if (field !== undefined && !(field in args)) missing.push(field);
    }
    if (missing.length === 0) return result.errors;
    for (const field of missing) args[field] = sampleFor(properties[field], field);
  }
  return validateToolArguments(tool, args).errors ?? [];
}

describe('tool reachability', () => {
  beforeAll(async () => {
    await reloadRegistry();
  });

  test('the registry is populated', () => {
    expect(tools.length).toBeGreaterThan(20);
  });

  describe('model path (validateToolArguments)', () => {
    // The path a tool call from the LLM takes. A schema that rejects its own
    // documented actions means the model can never successfully call the tool.
    for (const tool of tools) {
      test(`${tool.name}: every advertised action validates`, () => {
        const schema = schemaOf(tool);
        const actions = schema.properties?.action?.enum;
        if (!actions || actions.length === 0) {
          // No action discriminator: a single-shot tool. Required params must
          // still be individually satisfiable.
          const errors = validateWithRetries(tool, argsForAction(tool, ''));
          expect(errors, `${tool.name}: ${errors.join('; ')}`).toEqual([]);
          return;
        }
        for (const raw of actions) {
          const action = String(raw);
          const errors = validateWithRetries(tool, argsForAction(tool, action));
          expect(
            errors,
            `${tool.name}: action "${action}" is advertised in the schema but rejected by validation: ${errors.join('; ')}`,
          ).toEqual([]);
        }
      });
    }
  });

  describe('slash path (parseExplicitCommand)', () => {
    /**
     * Distinguish the two ways a slash parse can fail:
     *
     *  - a *routing* failure: the action was never recognised, so the parser
     *    either rejected the action token or ran out of arguments. This is the
     *    defect class that made /broadcast and /role setpriv unreachable.
     *  - a *value* failure: the action routed correctly but our synthetic sample
     *    for some other field has the wrong shape. That is a limitation of the
     *    generated sample, not an unreachable tool.
     */
    function routingFailure(message: string | null): boolean {
      if (message === null) return false;
      return /Invalid usage|<action>|Unexpected argument|Additional argument/i.test(message);
    }

    function attempt(tool: BaseTool, args: string, command: string): string | null {
      try {
        parseExplicitCommand(tool, args, command);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    // Each action must be reachable by typing the action token, or by typing the
    // tool name with the action omitted. Both routes are accepted because tools
    // legitimately support one or the other depending on their grammar.
    for (const tool of tools) {
      const actions = (schemaOf(tool).properties?.action?.enum ?? []).map(String);
      if (actions.length === 0) continue;

      test(`${tool.name}: actions are reachable by an explicit action token`, () => {
        for (const action of actions) {
          const args = argsForAction(tool, action);
          const positional = Object.entries(args)
            .filter(([key]) => key !== 'action')
            .map(([, value]) => String(value))
            .join(' ');

          const viaAction = attempt(tool, `${action}${positional ? ` ${positional}` : ''}`, tool.name);
          const viaTool = attempt(tool, positional, tool.name);

          expect(
            routingFailure(viaAction) && routingFailure(viaTool),
            `${tool.name}: action "${action}" is not routable by either "/${tool.name} ${action} …" `
            + `(error: ${viaAction?.split('\n')[0] ?? 'none'}) `
            + `or "/${tool.name} …" (error: ${viaTool?.split('\n')[0] ?? 'none'})`,
          ).toBe(false);
        }
      });

      // A command name that is itself an action value ("/broadcast", "/leave",
      // "/connect") must route to that action with the remaining tokens as its
      // arguments. This is the form that was 100% broken: typing
      // `/broadcast hello world` assigned "hello" to `action` and the enum
      // rejected it. Only the matching action is probed — the command *is* that
      // action, so asking it to route elsewhere is meaningless.
      test(`${tool.name}: an action-shaped command name routes to that action`, () => {
        for (const command of [tool.name, ...tool.aliases]) {
          const action = command.toLowerCase();
          if (!actions.includes(action)) continue;
          const args = argsForAction(tool, action);
          const positional = Object.entries(args)
            .filter(([key]) => key !== 'action')
            .map(([, value]) => String(value))
            .join(' ');
          const error = attempt(tool, positional, command);
          expect(
            routingFailure(error),
            `${tool.name}: typing "/${command} ${positional}" does not route to action "${action}" `
            + `(error: ${error?.split('\n')[0] ?? 'none'})`,
          ).toBe(false);
        }
      });
    }
  });

  describe('command surface integrity', () => {
    test('every alias resolves to exactly one tool', () => {
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const tool of tools) {
        for (const alias of [tool.name, ...tool.aliases]) {
          const key = alias.toLowerCase();
          const owner = seen.get(key);
          if (owner && owner !== tool.name) {
            collisions.push(`"${key}" claimed by both ${owner} and ${tool.name}`);
          }
          seen.set(key, tool.name);
        }
      }
      expect(collisions).toEqual([]);
    });

    test('every alias is resolvable in at least one valid context', () => {
      // An alias may legitimately be scoped: `groupOnlyAliases` are group-only
      // (/leave) and `dmOnlyAliases` are DM-only (/connect). "Resolvable" therefore
      // means resolvable in at least one context, not in every context.
      const unresolved: string[] = [];
      for (const tool of tools) {
        for (const alias of tool.aliases) {
          const inGroup = Boolean(getToolByAliasOrName(alias, { ...ownerContext, isGroup: true }));
          const inDm = Boolean(getToolByAliasOrName(alias, { ...ownerContext, isGroup: false }));
          if (!inGroup && !inDm) {
            unresolved.push(`${tool.name}.aliases contains "${alias}" which resolves in neither a group nor a DM`);
          }
        }
      }
      expect(unresolved).toEqual([]);
    });

    test('context-scoped aliases are refused outside their scope', () => {
      // Guards the mirror image: a group-only command must not work in a DM, and
      // a DM-only command must not work in a group.
      const leaked: string[] = [];
      for (const tool of tools) {
        for (const alias of tool.groupOnlyAliases) {
          if (getToolByAliasOrName(alias, { ...ownerContext, isGroup: false })) {
            leaked.push(`${tool.name}.groupOnlyAliases contains "${alias}" but it resolves in a DM`);
          }
        }
        for (const alias of tool.dmOnlyAliases) {
          if (getToolByAliasOrName(alias, { ...ownerContext, isGroup: true })) {
            leaked.push(`${tool.name}.dmOnlyAliases contains "${alias}" but it resolves in a group`);
          }
        }
      }
      expect(leaked).toEqual([]);
    });

    test('every noArgAlias is a real name or alias of its own tool', () => {
      const bogus: string[] = [];
      for (const tool of tools) {
        const surface = new Set([tool.name, ...tool.aliases].map(a => a.toLowerCase()));
        for (const alias of tool.noArgAliases) {
          if (!surface.has(alias.toLowerCase())) {
            bogus.push(`${tool.name}.noArgAliases contains "${alias}", which is not a name or alias of the tool`);
          }
        }
      }
      expect(bogus).toEqual([]);
    });

    test('every tool declares a name, description, category and permission', () => {
      const incomplete: string[] = [];
      for (const tool of tools) {
        if (!tool.name?.trim()) incomplete.push('a tool has an empty name');
        if (!tool.description?.trim()) incomplete.push(`${tool.name} has an empty description`);
        if (!tool.category?.trim()) incomplete.push(`${tool.name} has an empty category`);
        if (!tool.permissions?.trim()) incomplete.push(`${tool.name} has an empty permission`);
      }
      expect(incomplete).toEqual([]);
    });

    test('the tool catalog is non-empty for a plain user', () => {
      expect(getToolCatalog(plainUserContext).length).toBeGreaterThan(0);
    });
  });

  describe('schema hygiene', () => {
    test('no tool advertises additionalProperties: true', () => {
      const loose = tools
        .filter(tool => (schemaOf(tool) as { additionalProperties?: unknown }).additionalProperties === true)
        .map(tool => tool.name);
      expect(loose).toEqual([]);
    });

    test('every required parameter is declared in properties', () => {
      const broken: string[] = [];
      for (const tool of tools) {
        const schema = schemaOf(tool);
        for (const required of schema.required ?? []) {
          if (!(required in (schema.properties ?? {}))) {
            broken.push(`${tool.name} requires "${required}" but does not declare it`);
          }
        }
      }
      expect(broken).toEqual([]);
    });

    test('every tool name is unique', () => {
      const counts = new Map<string, number>();
      for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      const dupes = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
      expect(dupes).toEqual([]);
    });
  });

  describe('i18n coverage', () => {
    // A missing key does not throw — t() returns the key itself — so a missing
    // translation shows up in the chat as a raw key. That is only catchable
    // here.
    test('every translation table has the same keys in en and id', () => {
      const en = Object.keys(translations.en).sort();
      const id = Object.keys(translations.id).sort();
      expect(id).toEqual(en);
    });
  });

  describe('permission reachability', () => {
    test('owner-only tools are not advertised to a plain user', () => {
      const leaked = tools
        .filter(tool => tool.permissions === 'owner')
        .filter(tool => Boolean(getToolByName(tool.name, plainUserContext)))
        .map(tool => tool.name);
      expect(leaked).toEqual([]);
    });
  });
});
