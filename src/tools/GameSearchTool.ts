import { logger } from '../utils/logger';
import { SearxSearchToolBase } from './SearxSearchToolBase';

const log = logger.child({ module: 'GameSearchTool' });

export class GameSearchTool extends SearxSearchToolBase {
  readonly name = 'game_search';
  readonly description = 'Search for PC games, repacks, and cracks across safe/trusted sites (FitGirl, DODI, SteamRIP, CS.RIN.RU, GOG-Games). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked video games. Do NOT use this for general web search or movies.';
  readonly aliases = ['searchgame', 'findgame'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;
// (alwaysLoad=true makes triggerPatterns unreachable — discovery is via the
// always-loaded schema, so no trigger list is declared here.)

  protected override readonly queryParamDescription =
    'The name of the video game to search for (e.g. "Elden Ring", "Cyberpunk 2077").';

  // Trusted domains mimicking hizsearch
  protected override readonly trustedSites = [
    'fitgirl-repacks.site',
    'steamrip.com',
    'dodi-repacks.site',
    'gog-games.to',
    'online-fix.me',
    'cs.rin.ru',
    'csrin.org',
    'elamigos.site',
    'rutracker.org',
    'ankergames.net',
    'forum.torrminatorr.com',
    'gamebounty.world',
    'kaoskrew.org',
    'astral-games.xyz',
    'union-crax.xyz',
    'steamunderground.net',
    'ovagames.com'
  ];

  protected override readonly generalQuerySuffix = 'crack OR repack OR torrent OR download';

  constructor() {
    super();
  }

  protected override resultsHeader(query: string): string {
    return `Game Search Results for "${query}":`;
  }

  protected override noResultsMessage(query: string): string {
    return `No game downloads found for: "${query}".`;
  }

  protected override failureMessage(query: string): string {
    log.debug({ query }, 'failure message returned');
    return `Failed to search games for "${query}".`;
  }
}
