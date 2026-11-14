import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { timeoutSignal } from '../utils/withTimeout';
import { validateSsrfUrl } from '../providers/ssrf';
import { redactUrl } from './DownloadTool';

const log = logger.child({ module: 'WebScrapeTool' });
const esc = (s: string) => s.replace(/([*`_[\]\\])/g, '\\$1');

type WebScrapeArgs = ToolArgs & {
  url?: string;
  query?: string;
  prompt?: string;
};

export class WebScrapeTool extends BaseTool<WebScrapeArgs> {
  readonly name = 'web_scrape';
  readonly description = 'Read and extract the full text content of a webpage (news article, blog, docs, etc) from a URL.';
  readonly aliases = ['read', 'scrape'];
  readonly category = 'utility';
  readonly permissions = 'user';
  
  override readonly triggerPatterns = [
    /https?:\/\/[^\s]+/i,
    // Bare "read/page/link/content/fetch/baca" removed — matches ordinary chat.
    /\b(scrape|summarize|summarise|article|website|webpage|tldr|tl;dr|ringkas|ringkasan|ringkaskan|artikel|halaman web|situs)\b/i
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
            query: { type: 'string', description: 'Optional search query context for the scrape' },
            prompt: { type: 'string', description: 'Optional instructions for extracting/summarizing content' },
          },
          required: ['url'],
        },
      },
    };
  }

  async execute(args: WebScrapeArgs, _ctx: MessageContext): Promise<string> {
    const query = args.query;
    if (!args.url) return 'Error: URL is required.';
    try {
      const url = new URL(args.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
         return 'Error: Only HTTP/HTTPS URLs are supported.';
      }
      // SSRF guard: match DownloadTool policy so internal/loopback/metadata
      // URLs are rejected before being forwarded to the reader service.
      try {
        await validateSsrfUrl(url);
      } catch {
        return 'Error: URL is not allowed.';
      }
      log.info({ url: redactUrl(args.url) }, 'Scraping URL via jina.ai reader');
      const headers: Record<string, string> = {
        'X-Return-Format': 'markdown'
      };
      
      if (process.env.JINA_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
      }

      const signal = timeoutSignal(15_000);

      const response = await fetch(`https://r.jina.ai/${url.toString()}`, { headers, signal });
      if (!response.ok) return `Error fetching URL: HTTP ${response.status}`;
      const text = await response.text();
      
      // Cap at 25,000 chars to avoid LLM context explosion
      if (text.length > 25000) {
        return text.substring(0, 25000) + '\n\n[Content truncated due to length]';
      }
      return text;
    } catch (e) {
      const msg = getErrorMessage(e);
      const qPart = query ? ` for "${esc(query)}"` : '';
      return `Error scraping URL${qPart}: ${msg}`;
    }
  }
}
