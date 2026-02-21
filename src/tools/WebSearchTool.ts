import { search } from 'duck-duck-scrape';
import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description = 'Searches the web for up-to-date information. Use this whenever you need to look up facts, news, or answer questions that require recent knowledge.';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to look up on the web.',
            },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, _ctx: MessageContext): Promise<string> {
    const query = args.query;
    if (!query) return 'Error: query parameter is missing.';

    logger.info({ query }, 'Executing WebSearchTool');

    try {
      const results = await search(query);
      
      if (!results.results || results.results.length === 0) {
        return `No results found on the web for: ${query}`;
      }

      // Format the top 5 results for the LLM context
      const textResults = results.results.slice(0, 5).map((item, idx) => {
        return `[${idx+1}] Title: ${item.title}\nURL: ${item.url}\nExcerpt: ${item.description}\n`;
      }).join('\n');

      return `Search results for "${query}":\n\n${textResults}`;
    } catch (err) {
      logger.error(err, 'WebSearchTool failed');
      return `Failed to search the web for "${query}" due to an internal error.`;
    }
  }
}
