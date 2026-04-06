/**
 * @file src/providers/seerr/SeerrClient.ts
 * @description Typed HTTP client for the Seerr (Overseerr/Jellyseerr) REST API.
 *
 * Auth: `X-Api-Key` header with `SEERR_API_KEY` env var.
 * Base URL: `SEERR_API_URL` env var (e.g. `https://req.example.com/api/v1`).
 */

import { logger } from '../../utils/logger';

const log = logger.child({ module: 'SeerrClient' });

// ─── Response Types ────────────────────────────────────────────────────────────

export type SeerrMediaType = 'movie' | 'tv' | 'person';

export type SeerrMediaStatus =
  | 1  // UNKNOWN
  | 2  // PENDING
  | 3  // PROCESSING
  | 4  // PARTIALLY_AVAILABLE
  | 5; // AVAILABLE

export interface SeerrSearchResult {
  id: number;
  mediaType: SeerrMediaType;
  title?: string;       // movies
  name?: string;        // tv
  originalTitle?: string;
  originalName?: string;
  overview?: string;
  posterPath?: string;
  releaseDate?: string;       // movies
  firstAirDate?: string;      // tv
  voteAverage?: number;
  mediaInfo?: {
    id: number;
    status: SeerrMediaStatus;
    jellyfinMediaId?: string;
  };
}

export interface SeerrPagedResults<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
}

export interface SeerrMovieDetails {
  id: number;
  title: string;
  overview: string;
  releaseDate: string;
  runtime: number;
  voteAverage: number;
  genres: { id: number; name: string }[];
  posterPath?: string;
  mediaInfo?: { id: number; status: SeerrMediaStatus; jellyfinMediaId?: string };
}

export interface SeerrTvDetails {
  id: number;
  name: string;
  overview: string;
  firstAirDate: string;
  numberOfSeasons: number;
  voteAverage: number;
  genres: { id: number; name: string }[];
  posterPath?: string;
  seasons: { id: number; seasonNumber: number; episodeCount: number }[];
  mediaInfo?: { id: number; status: SeerrMediaStatus; jellyfinMediaId?: string };
}

export interface SeerrRequest {
  id: number;
  status: number; // 1=PENDING, 2=APPROVED, 3=DECLINED
  type: SeerrMediaType;
  media: {
    id: number;
    tmdbId: number;
    tvdbId?: number;
    status: SeerrMediaStatus;
    mediaType: SeerrMediaType;
  };
  requestedBy: { id: number; displayName: string; email?: string };
  createdAt: string;
  updatedAt: string;
}

export interface SeerrRequestCount {
  total: number;
  movie: number;
  tv: number;
  pending: number;
  approved: number;
  declined: number;
  processing: number;
  available: number;
}

export interface SeerrUser {
  id: number;
  email: string;
  displayName: string;
  jellyfinUserId?: string;
  avatar?: string;
  requestCount: number;
  permissions: number;
}

export interface SeerrQuota {
  movie: { used: number; remaining: number; restricted: boolean; limit: number };
  tv: { used: number; remaining: number; restricted: boolean; limit: number };
}

export interface SeerrStatus {
  version: string;
  commitTag: string;
  updateAvailable: boolean;
  commitsBehind: number;
}

export interface SeerrAuthResponse {
  id: number;
  email: string;
  displayName: string;
  jellyfinUserId?: string;
  avatar?: string;
  permissions: number;
}

// ─── Client ────────────────────────────────────────────────────────────────────

export class SeerrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = (baseUrl ?? process.env.SEERR_API_URL ?? '').replace(/\/+$/, '');
    this.apiKey = apiKey ?? process.env.SEERR_API_KEY ?? '';
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '' && this.apiKey !== '';
  }

  // ── HTTP Helpers ──────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Invalid protocol for Seerr API URL: ${parsedUrl.protocol}. Must be http: or https:`);
    }

    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      'Accept': 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    log.debug({ method, path }, 'Seerr API request');

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log.error({ status: resp.status, path, text }, 'Seerr API error');
      throw new Error(`Seerr API ${method} ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
    }

    return resp.json() as Promise<T>;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Authenticate a user via Jellyfin credentials through Seerr. */
  async authenticateJellyfin(username: string, password: string): Promise<SeerrAuthResponse> {
    return this.post<SeerrAuthResponse>('/auth/jellyfin', { username, password });
  }

  // ── Search & Discovery ────────────────────────────────────────────────────

  async search(query: string, page = 1): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/search?query=${encodeURIComponent(query)}&page=${page}`);
  }

  async discoverMovies(page = 1, sortBy = 'popularity.desc'): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/discover/movies?page=${page}&sortBy=${sortBy}`);
  }

  async discoverTv(page = 1, sortBy = 'popularity.desc'): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/discover/tv?page=${page}&sortBy=${sortBy}`);
  }

  async getTrending(page = 1): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/discover/trending?page=${page}`);
  }

  // ── Details ─────────────────────────────────────────────────────────────

  async getMovieDetails(tmdbId: number): Promise<SeerrMovieDetails> {
    return this.get(`/movie/${tmdbId}`);
  }

  async getTvDetails(tmdbId: number): Promise<SeerrTvDetails> {
    return this.get(`/tv/${tmdbId}`);
  }

  async getMovieRecommendations(tmdbId: number, page = 1): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/movie/${tmdbId}/recommendations?page=${page}`);
  }

  async getTvRecommendations(tmdbId: number, page = 1): Promise<SeerrPagedResults<SeerrSearchResult>> {
    return this.get(`/tv/${tmdbId}/recommendations?page=${page}`);
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  async createRequest(mediaType: 'movie' | 'tv', mediaId: number, options?: {
    seasons?: number[] | 'all';
    userId?: number;
  }): Promise<SeerrRequest> {
    const body: Record<string, unknown> = { mediaType, mediaId };
    if (options?.seasons) {
      body.seasons = options.seasons === 'all' ? 'all' : options.seasons;
    }
    if (options?.userId !== undefined) {
      body.userId = options.userId;
    }
    return this.post<SeerrRequest>('/request', body);
  }

  async getRequests(opts?: { filter?: string; take?: number; skip?: number; sort?: string; requestedBy?: number }): Promise<{
    pageInfo: { pages: number; pageSize: number; results: number; page: number };
    results: SeerrRequest[];
  }> {
    const params = new URLSearchParams();
    if (opts?.filter) params.set('filter', opts.filter);
    if (opts?.take !== undefined) params.set('take', String(opts.take));
    if (opts?.skip !== undefined) params.set('skip', String(opts.skip));
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.requestedBy !== undefined) params.set('requestedBy', String(opts.requestedBy));
    const qs = params.toString();
    return this.get(`/request${qs ? `?${qs}` : ''}`);
  }

  async getRequestById(requestId: number): Promise<SeerrRequest> {
    return this.get(`/request/${requestId}`);
  }

  async getRequestCount(): Promise<SeerrRequestCount> {
    return this.get('/request/count');
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async getUserById(userId: number): Promise<SeerrUser> {
    return this.get(`/user/${userId}`);
  }

  async getUserQuota(userId: number): Promise<SeerrQuota> {
    return this.get(`/user/${userId}/quota`);
  }

  async getUsers(take = 50, skip = 0): Promise<{ pageInfo: { pages: number; results: number }; results: SeerrUser[] }> {
    return this.get(`/user?take=${take}&skip=${skip}`);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus(): Promise<SeerrStatus> {
    return this.get('/status');
  }
}
