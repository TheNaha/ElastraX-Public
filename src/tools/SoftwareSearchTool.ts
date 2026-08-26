import { logger } from '../utils/logger';
import { SearxSearchToolBase } from './SearxSearchToolBase';

const log = logger.child({ module: 'SoftwareSearchTool' });

export class SoftwareSearchTool extends SearxSearchToolBase {
  readonly name = 'software_search';
  readonly description = 'Search for PC software, applications, and cracks across trusted sites (FileCR, FMHY, rsload, etc). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked desktop software or applications. Do NOT use this for video games or general web search.';
  readonly aliases = ['searchsoftware', 'findsoftware'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;
// (alwaysLoad=true makes triggerPatterns unreachable — no trigger list needed.)

  protected override readonly queryParamDescription =
    'The name of the software to search for (e.g. "Photoshop", "Premiere Pro", "IDM").';

  protected override readonly trustedSites = [
    'filecr.com',
    'rsload.net',
    'lrepacks.net',
    'cybermania.ws',
    'm0nkrus.ws',
    'fmhy.net',
    'reddit.com/r/FREEMEDIAHECKYEAH',
    'reddit.com/r/Piracy',
    'rutracker.org',
    'soft98.ir',
    'cracksurl.com',
    'mobilism.org',
    'nsanenewz.com',
    'nsaneforums.com'
  ];

  protected override readonly generalQuerySuffix = 'crack OR patch OR keygen OR torrent OR download';

  constructor() {
    super();
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
