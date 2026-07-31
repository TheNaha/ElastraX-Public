/**
 * @file src/providers/jellyfin/JellyfinClient.ts
 * @description Typed HTTP client for the Jellyfin REST API.
 *
 * Auth: `X-Api-Key` header with `JELLYFIN_API_KEY` env var.
 * Base URL: `JELLYFIN_API_URL` env var (e.g. `http://jellyfin.local:8096`).
 * External URL: `JELLYFIN_EXTERNAL_URL` env var (user-facing watch links).
 */

import { BaseHttpClient } from '../../utils/BaseHttpClient';

// ─── Response Types ────────────────────────────────────────────────────────────

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy: {
    IsAdministrator: boolean;
    IsDisabled: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface JellyfinAuthResult {
  User: JellyfinUser;
  AccessToken: string;
  ServerId: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;         // 'Movie' | 'Series' | 'Episode' | 'Season' | ...
  Overview?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  Genres?: string[];
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;       // Episode number
  ParentIndexNumber?: number; // Season number
  ProviderIds?: Record<string, string>; // { Tmdb: '12345', Imdb: 'tt12345' }
  ImageTags?: Record<string, string>;
  MediaType?: string;
  [key: string]: unknown;
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}

export interface JellyfinSystemInfo {
  ServerName: string;
  Version: string;
  Id: string;
  OperatingSystem: string;
  [key: string]: unknown;
}

// ─── Client ────────────────────────────────────────────────────────────────────

export class JellyfinClient extends BaseHttpClient {
  private readonly apiKey: string;
  private readonly externalUrl: string;

  constructor(baseUrl?: string, apiKey?: string, externalUrl?: string) {
    const finalBaseUrl = (baseUrl ?? process.env.JELLYFIN_API_URL ?? '').replace(/\/+$/, '');
    const finalApiKey = apiKey ?? process.env.JELLYFIN_API_KEY ?? '';
    super(
      finalBaseUrl,
      { 'X-Emby-Authorization': `MediaBrowser Token="${finalApiKey}"` },
      'JellyfinClient'
    );
    this.apiKey = finalApiKey;
    this.externalUrl = (externalUrl ?? process.env.JELLYFIN_EXTERNAL_URL ?? '').replace(/\/+$/, '');
  }

  get isConfigured(): boolean {
    return super.isConfigured && this.apiKey !== '';
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Authenticate a user by username/password. Returns user info + access token. */
  async authenticateUser(username: string, password: string): Promise<JellyfinAuthResult> {
    return this.post<JellyfinAuthResult>(
      '/Users/AuthenticateByName',
      { Username: username, Pw: password },
      {
        'X-Emby-Authorization': `MediaBrowser Client="ElastraX Bot", Device="Server", DeviceId="elastrax-bot", Version="1.0"`,
      },
    );
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async getUsers(): Promise<JellyfinUser[]> {
    return this.get('/Users');
  }

  async getUserById(userId: string): Promise<JellyfinUser> {
    return this.get(`/Users/${userId}`);
  }

  // ── Library ───────────────────────────────────────────────────────────────

  async searchItems(query: string, opts?: { userId?: string; limit?: number; includeTypes?: string[] }): Promise<JellyfinItemsResponse> {
    const params = new URLSearchParams({
      searchTerm: query,
      Recursive: 'true',
      Limit: String(opts?.limit ?? 20),
    });
    if (opts?.userId) params.set('userId', opts.userId);
    if (opts?.includeTypes?.length) params.set('IncludeItemTypes', opts.includeTypes.join(','));
    return this.get(`/Items?${params}`);
  }

  async getItem(itemId: string): Promise<JellyfinItem> {
    return this.get(`/Items/${itemId}`);
  }

  async getLatestMedia(opts?: { userId?: string; limit?: number; includeTypes?: string[] }): Promise<JellyfinItem[]> {
    const params = new URLSearchParams({
      Limit: String(opts?.limit ?? 20),
    });
    if (opts?.userId) params.set('userId', opts.userId);
    if (opts?.includeTypes?.length) params.set('IncludeItemTypes', opts.includeTypes.join(','));
    return this.get(`/Items/Latest?${params}`);
  }

  async getResumeItems(userId: string, limit = 10): Promise<JellyfinItemsResponse> {
    const params = new URLSearchParams({
      userId,
      Limit: String(limit),
      Recursive: 'true',
      Filters: 'IsResumable',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
    });
    return this.get(`/Items?${params}`);
  }

  // ── Links ─────────────────────────────────────────────────────────────────

  /** Build a user-facing watch link for an item. */
  getWatchLink(itemId: string): string {
    const base = this.externalUrl || this.baseUrl;
    return `${base}/web/index.html#!/details?id=${itemId}`;
  }

  // ── System ────────────────────────────────────────────────────────────────

  async getSystemInfo(): Promise<JellyfinSystemInfo> {
    return this.get('/System/Info');
  }
}
