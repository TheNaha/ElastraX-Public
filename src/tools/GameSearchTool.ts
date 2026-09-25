import { isExactTrustedHostname } from './BaseTool';
import { logger } from '../utils/logger';
import { SearxSearchToolBase, type SearchToolArgs } from './SearxSearchToolBase';
import type { MessageContext } from '../core/MessageContext';
import type { SearXngRawResult } from './searchUtils';

const log = logger.child({ module: 'GameSearchTool' });

export const GAME_TRUSTED_HOSTS = [
  'fitgirl-repacks.site', 'steamrip.com', 'dodi-repacks.site', 'gog-games.to', 'online-fix.me', 'cs.rin.ru', 'csrin.org', 'elamigos.site', 'rutracker.org', 'ankergames.net', 'forum.torrminatorr.com', 'gamebounty.world', 'kaoskrew.org', 'astral-games.xyz', 'union-crax.xyz', 'steamunderground.net', 'ovagames.com',
] as const;

export function isTrustedGameUrl(value: string): boolean {
  return isExactTrustedHostname(value, GAME_TRUSTED_HOSTS);
}

export class GameSearchTool extends SearxSearchToolBase {
  readonly name = 'game_search';
  readonly description = 'Search for PC games, repacks, and cracks across safe/trusted sites (FitGirl, DODI, SteamRIP, CS.RIN.RU, GOG-Games). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked video games. Do NOT use this for general web search or movies.';
  readonly aliases = ['searchgame', 'findgame'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly optIn = true;
  override readonly alwaysLoad = false;
  override readonly cost = 2;

  protected override readonly queryParamDescription =
    'The name of the video game to search for (e.g. "Elden Ring", "Cyberpunk 2077").';

  protected override readonly trustedSites = [...GAME_TRUSTED_HOSTS];

  protected override readonly generalQuerySuffix = 'crack OR repack OR torrent OR download';

  constructor() {
    super();
  }

  async execute(args: SearchToolArgs, ctx: MessageContext): Promise<string> {
    if (!this.isEnabled()) return 'Game search is disabled until explicitly enabled by the bot owner.';
    return super.execute(args, ctx);
  }

  protected override formatResults(results: SearXngRawResult[], query: string): string {
    return super.formatResults(results.filter((result) => result.url ? isTrustedGameUrl(result.url) : false), query);
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
