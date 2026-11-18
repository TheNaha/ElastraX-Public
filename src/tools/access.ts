/**
 * @file src/tools/access.ts
 * @description The one predicate for "may this tool be used in this context".
 *
 * It lived in `registry.ts`, but the registry imports every tool module, so a
 * tool that wanted to apply the same rule had to either duplicate it (MenuTool,
 * FindToolsTool — which consequently skipped `requiresBinding`) or import the
 * registry and create a cycle. Keeping it in a module that imports only the
 * `BaseTool` type lets every call site share one answer.
 */

import type { BaseTool } from './BaseTool';
import { roleSatisfies } from '../core/roleAccess';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'ToolAccess' });

export interface ToolAccessContext {
  roles?: readonly string[];
  isGroup?: boolean;
  isOwner?: boolean;
  platform?: string;
  command?: string;
  hasBinding?: boolean;
  userId?: string;
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
  return roleSatisfies(context.roles, tool.permissions);
}
