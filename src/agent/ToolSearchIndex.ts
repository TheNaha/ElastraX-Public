/**
 * @file src/agent/ToolSearchIndex.ts
 * @description In-memory search index over registered tools for on-demand discovery.
 *
 * The agent sends only a small set of "always-loaded" tools to the LLM.
 * When the model calls `find_tools`, this index is queried to locate matching
 * tools by name, alias, category, and description keywords.
 *
 * No external dependencies — simple normalised keyword matching is sufficient
 * for the expected scale (20-100 tools).
 */

import type { BaseTool } from '../tools/BaseTool';

export interface ToolSearchEntry {
  name: string;
  description: string;
  category: string;
  /** All searchable tokens (lowercased): name parts, aliases, category, description words. */
  tokens: string[];
  tool: BaseTool;
}

export class ToolSearchIndex {
  private entries: ToolSearchEntry[] = [];

  /** Build the index from a list of discoverable tools. */
  build(tools: BaseTool[]): void {
    this.entries = tools.map((tool) => {
      const tokens = new Set<string>();

      // Tool name parts (e.g. "download_media" → ["download", "media"])
      for (const part of tool.name.split(/[_\-\s]+/)) {
        if (part) tokens.add(part.toLowerCase());
      }

      // Aliases
      for (const alias of tool.aliases) {
        for (const part of alias.split(/[_\-\s]+/)) {
          if (part) tokens.add(part.toLowerCase());
        }
      }

      // Category
      tokens.add(tool.category.toLowerCase());

      // Description keywords (skip very short words)
      for (const word of tool.description.split(/\W+/)) {
        if (word.length > 2) tokens.add(word.toLowerCase());
      }

      return {
        name: tool.name,
        description: tool.description,
        category: tool.category,
        tokens: [...tokens],
        tool,
      };
    });
  }

  /**
   * Search for tools matching a free-text query.
   * Returns entries ranked by number of matching tokens (descending).
   */
  search(query: string, limit = 5): ToolSearchEntry[] {
    const queryTokens = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 1);

    if (queryTokens.length === 0) return [];

    const scored: { entry: ToolSearchEntry; score: number }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      for (const qt of queryTokens) {
        // Exact token match (highest weight)
        if (entry.tokens.includes(qt)) {
          score += 3;
          continue;
        }
        // Substring match (partial)
        if (entry.tokens.some((t) => t.includes(qt) || qt.includes(t))) {
          score += 1;
        }
      }
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }
}
