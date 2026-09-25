import { isExactTrustedHostname } from './BaseTool';
import { logger } from '../utils/logger';
import { SearxSearchToolBase, type SearchToolArgs } from './SearxSearchToolBase';
import type { MessageContext } from '../core/MessageContext';
import type { SearXngRawResult } from './searchUtils';

const log = logger.child({ module: 'SoftwareSearchTool' });

export const SOFTWARE_TRUSTED_HOSTS = [
  'filecr.com', 'rsload.net', 'lrepacks.net', 'cybermania.ws', 'm0nkrus.ws', 'fmhy.net', 'reddit.com/r/FREEMEDIAHECKYEAH', 'reddit.com/r/Piracy', 'rutracker.org', 'soft98.ir', 'cracksurl.com', 'mobilism.org', 'nsanenewz.com', 'nsaneforums.com',
] as const;

export function isTrustedSoftwareUrl(value: string): boolean {
  return isExactTrustedHostname(value, SOFTWARE_TRUSTED_HOSTS);
}

export class SoftwareSearchTool extends SearxSearchToolBase {
  readonly name = 'software_search';
  readonly description = 'Search for PC software, applications, and cracks across trusted sites (FileCR, FMHY, rsload, etc). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked desktop software or applications. Do NOT use this for video games or general web search.';
  readonly aliases = ['searchsoftware', 'findsoftware'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly optIn = true;
  override readonly alwaysLoad = false;
  override readonly cost = 2;

  protected override readonly queryParamDescription =
    'The name of the software to search for (e.g. "Photoshop", "Premiere Pro", "IDM").';

  protected override readonly trustedSites = [...SOFTWARE_TRUSTED_HOSTS];

  protected override readonly generalQuerySuffix = 'crack OR patch OR keygen OR torrent OR download';

  constructor() {
    super();
  }

  async execute(args: SearchToolArgs, ctx: MessageContext): Promise<string> {
    if (!this.isEnabled()) return 'Software search is disabled until explicitly enabled by the bot owner.';
    return super.execute(args, ctx);
  }

  protected override formatResults(results: SearXngRawResult[], query: string): string {
    return super.formatResults(results.filter((result) => result.url ? isTrustedSoftwareUrl(result.url) : false), query);
  }

  protected override resultsHeader(query: string): string {
    return `Software Search Results for "${query}":`;
  }

  protected override noResultsMessage(query: string): string {
    return `No software downloads found for: "${query}".`;
  }

  protected override failureMessage(query: string): string {
    log.debug({ query }, 'failure message returned');
    return `Failed to search software for "${query}".`;
  }
}
