import type { BaseTool } from '../tools/BaseTool';

export interface ToolSearchEntry {
  name: string;
  description: string;
  category: string;
  tokens: string[];
  tool: BaseTool;
}

export class ToolSearchIndex {
  private entries: ToolSearchEntry[] = [];
  private inverted = new Map<string, Set<number>>();

  build(tools: BaseTool[]): void {
    const entries = tools.map(tool => {
      const tokens = new Set<string>();
      for (const value of [tool.name, ...tool.aliases, tool.category, tool.description]) {
        for (const token of value.toLowerCase().split(/\W+/)) {
          if (token.length > 2) tokens.add(token);
        }
      }
      return {
        name: tool.name,
        description: tool.description,
        category: tool.category,
        tokens: [...tokens],
        tool,
      };
    });
    const inverted = new Map<string, Set<number>>();
    entries.forEach((entry, index) => {
      for (const token of entry.tokens) {
        const matches = inverted.get(token) ?? new Set<number>();
        matches.add(index);
        inverted.set(token, matches);
      }
    });
    this.entries = entries;
    this.inverted = inverted;
  }

  search(query: string, limit = 5): ToolSearchEntry[] {
    const queryTokens = [...new Set(query.toLowerCase().split(/\W+/).filter(token => token.length > 1))];
    if (queryTokens.length === 0) return [];

    const scores = new Map<number, number>();
    for (const token of queryTokens) {
      for (const index of this.inverted.get(token) ?? []) {
        scores.set(index, (scores.get(index) ?? 0) + 3);
      }
    }

    if (scores.size < limit) {
      for (let index = 0; index < this.entries.length; index++) {
        if (scores.has(index)) continue;
        const entry = this.entries[index]!;
        const partial = queryTokens.some(queryToken => entry.tokens.some(token => token.includes(queryToken) || queryToken.includes(token)));
        if (partial) scores.set(index, 1);
      }
    }

    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1] || this.entries[left[0]]!.name.localeCompare(this.entries[right[0]]!.name))
      .slice(0, Math.max(1, limit))
      .map(([index]) => this.entries[index]!);
  }
}
