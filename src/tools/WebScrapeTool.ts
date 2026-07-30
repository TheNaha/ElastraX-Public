import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'WebScrapeTool' });

export class WebScrapeTool extends BaseTool {
  readonly name = 'web_scrape';
  readonly description = 'Read and extract the full text content of a webpage (news article, blog, docs, etc) from a URL.';
  readonly aliases = ['read', 'scrape'];
  readonly category = 'utility';
  readonly permissions = 'user';
  
  override readonly triggerPatterns = [
    /https?:\/\/[^\s]+/i,
    /\b(scrape|summarize|summarise|read|article|fetch|extract|content|page|website|webpage|link|tldr|tl;dr|ringkas|ringkaskan|baca|artikel|halaman|situs|ambil|isinya)\b/i
  ];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute URL to read' },
          },
          required: ['url'],
        },
      },
    };
  }

  async execute(args: { url?: string }, _ctx: MessageContext): Promise<string> {
    if (!args.url) return 'Error: URL is required.';
    try {
      const url = new URL(args.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
         return 'Error: Only HTTP/HTTPS URLs are supported.';
      }
      log.info({ url: args.url }, 'Scraping URL via jina.ai reader');
      const headers: Record<string, string> = {
        'X-Return-Format': 'markdown'
      };
      
      if (process.env.JINA_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
      }

      const response = await fetch(`https://r.jina.ai/${url.toString()}`, { headers });
      if (!response.ok) return `Error fetching URL: HTTP ${response.status}`;
      const text = await response.text();
      
      // Cap at 25,000 chars to avoid LLM context explosion
      if (text.length > 25000) {
        return text.substring(0, 25000) + '\n\n[Content truncated due to length]';
      }
      return text;
    } catch (e) {
      return `Error scraping URL: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
