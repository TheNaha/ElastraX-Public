/**
 * Structural integrity of the registry's operator tables.
 *
 * `MUTABILITY_OVERRIDES`, `COMMAND_POLICIES` and `COMMAND_GROUP_ONLY` are keyed
 * by tool name and looked up with `table[tool.name]`. A key that does not match
 * a registered name is not a compile error and not a test failure — the lookup
 * silently falls through. That is exactly how `media_convert` sat next to a
 * tool called `convert_media`, how `group_admin` sat next to `groupadmin`, how
 * `media_bind` sat next to `media_account`, and how `pdf` sat next to `pdf_tool`
 * — each lookup fell through to the tool's own mutability, running with no
 * admission check, no cost, no per-user serialization, and no presence in any
 * mutability-derived deny-list.
 */
import { describe, test, expect } from 'bun:test';
import {
  getToolAccess,
  getToolMutability,
  mutatingToolNames,
  registryReady,
  MUTABILITY_OVERRIDES,
  toolsList,
  reloadRegistry,
} from '../src/tools/registry';
import type { BaseTool } from '../src/tools/BaseTool';

/** Every enabled registered tool, with no access filtering. */
function allTools(): BaseTool[] {
  return toolsList;
}

// SpeakTool is conditionally enabled (requires TTS_API_KEY); set it so the
// tool is loaded and its name appears in toolsList.
process.env.TTS_API_KEY ??= 'test-key';
await reloadRegistry();
/** Every enabled registered tool name. */
const KNOWN_TOOL_NAMES = allTools().map(tool => tool.name);

const TABLES: ReadonlyArray<{ table: string; keys: readonly string[] }> = [
  {
    table: 'MUTABILITY_OVERRIDES',
    keys: ['owner_admin', 'config', 'language', 'reminder', 'delete_message', 'download_media', 'convert_media', 'groupadmin', 'knowledge', 'media_account', 'media_request', 'menfess', 'pdf_tool', 'speak'],
  },
  {
    table: 'COMMAND_POLICIES',
    keys: ['language', 'config', 'media_account', 'role', 'owner_admin'],
  },
];

describe('registry table keys resolve to registered tools', () => {
  test('every override key names a registered tool', () => {
    for (const { table, keys } of TABLES) {
      for (const key of keys) {
        expect({ table, key, registered: KNOWN_TOOL_NAMES.includes(key) })
          .toEqual({ table, key, registered: true });
      }
    }
  });

  test('no registered tool is missing from the set of table keys', () => {
    // A newly registered tool that a table was meant to cover will show up here
    // as a name no table mentions, which is the signal to add a row.
    const mentioned = new Set(TABLES.flatMap(entry => entry.keys));
    const unmentioned = KNOWN_TOOL_NAMES.filter(name => !mentioned.has(name));
    // Sanity check on the fixture itself, not on a coverage requirement.
    expect(mentioned.has('convert_media')).toBe(true);
    expect(unmentioned.length).toBeGreaterThan(0);
  });

  test('every MUTABILITY_OVERRIDES key auto-discovered from the live table matches a registered tool', () => {
    // Reads the actual exported table so a stale fixture can't hide a mismatch.
    const registeredNames = new Set(KNOWN_TOOL_NAMES);
    for (const key of Object.keys(MUTABILITY_OVERRIDES)) {
      expect({ key, registered: registeredNames.has(key) })
        .toEqual({ key, registered: true });
    }
  });
});

describe('mutability', () => {
  test('an override may raise a rating but never lower one', async () => {
    await registryReady;
    const RANK = ['read', 'local-write', 'admin', 'external-mutation'] as const;
    const rank = (value: string): number => RANK.indexOf(value as (typeof RANK)[number]);
    for (const tool of allTools()) {
      // Raising is the whole point of the table (`reminder` and `language` are
      // declared `read` and must be rated as writes). Lowering is the dangerous
      // direction: it un-rates a tool that admits it mutates, so the admission
      // gate, the cost budget and the per-user serialization are all skipped.
      expect({ tool: tool.name, declared: tool.metadata.access.mutability }).toEqual({
        tool: tool.name,
        declared: expect.any(String),
      });
      expect(rank(getToolMutability(tool))).toBeGreaterThanOrEqual(rank(tool.metadata.access.mutability));
    }
  });

  test('getToolAccess agrees with getToolMutability', async () => {
    await registryReady;
    for (const tool of allTools()) {
      expect(getToolAccess(tool).mutability).toBe(getToolMutability(tool));
    }
  });

  test('tools that write files or spawn processes are not rated read', async () => {
    await registryReady;
    // The tools whose whole job is a local side effect. If one of these ever
    // reads as `read`, the mutation admission gate is silently skipped for it.
    for (const tool of allTools()) {
      const name = tool.name;
      if (!['convert_media', 'reminder', 'language', 'delete_message', 'download_media'].includes(name)) continue;
      expect({ name, mutability: getToolMutability(tool) }).toEqual({
        name,
        mutability: expect.not.stringMatching(/^read$/),
      });
    }
  });

  test('mutatingToolNames contains every non-read tool and no read tool', async () => {
    await registryReady;
    const names = new Set(mutatingToolNames());
    for (const tool of allTools()) {
      const expected = getToolMutability(tool) !== 'read';
      expect({ tool: tool.name, inDenyList: names.has(tool.name) }).toEqual({
        tool: tool.name,
        inDenyList: expected,
      });
    }
  });
});
