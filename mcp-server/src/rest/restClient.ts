import { TokenManager } from './tokenManager.js';
import type { AccommodationType, RestCatalog, RestSearchResponse, SearchParams } from './types.js';

/** Erreur renvoyée par l'API REST (format §11 de sa spécification), ou erreur de transport. */
export class RestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'RestApiError';
  }
}

export type FetchFn = typeof fetch;

export interface RestClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  tokenRenewBeforeSeconds: number;
  fetchImpl?: FetchFn;
  userAgent?: string;
}

const RETRY_STATUSES = new Set([502, 503, 504]);

/**
 * Client de l'API REST pour un point d'entrée (une clé d'API).
 * Un 401 entraîne un nouveau token et un seul nouvel essai ; un 502/503/504 ou une erreur réseau, un seul nouvel essai.
 */
export class RestClient {
  readonly tokens: TokenManager;
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: RestClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = new TokenManager({ fetchToken: () => this.createSession() }, opts.tokenRenewBeforeSeconds);
  }

  private async raw(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.opts.userAgent ?? 'yelloh-camping-search-mcp',
          ...(init.headers as Record<string, string>),
        },
        signal: controller.signal,
      });
    } catch {
      // Ni l'URL ni la clé ne figurent dans le message (§8).
      throw new RestApiError(
        controller.signal.aborted ? 504 : 503,
        controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR',
        'Yelloh! Village search is temporarily unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private static async toError(res: Response): Promise<RestApiError> {
    let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* corps illisible */
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    return new RestApiError(
      res.status,
      body.error?.code ?? `HTTP_${res.status}`,
      body.error?.message ?? `HTTP ${res.status}`,
      body.error?.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  private async createSession(): Promise<{ token: string; expiresAt: Date }> {
    const res = await this.raw('/auth/session', {
      method: 'POST',
      headers: { 'X-API-Key': this.opts.apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status !== 201) throw await RestClient.toError(res);
    const json = (await res.json()) as { access_token: string; expires_at: string };
    return { token: json.access_token, expiresAt: new Date(json.expires_at) };
  }

  /** GET authentifié avec nouvel essai unique sur 401 (nouveau token) et sur 502/503/504/réseau. */
  private async get<T>(path: string): Promise<T> {
    let retriedAuth = false;
    let retriedUpstream = false;
    for (;;) {
      const token = await this.tokens.getToken();
      let res: Response;
      try {
        res = await this.raw(path, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (!retriedUpstream && err instanceof RestApiError && err.code === 'NETWORK_ERROR') {
          retriedUpstream = true;
          continue;
        }
        throw err;
      }
      if (res.ok) return (await res.json()) as T;
      if (res.status === 401 && !retriedAuth) {
        retriedAuth = true;
        this.tokens.invalidate();
        continue;
      }
      if (RETRY_STATUSES.has(res.status) && !retriedUpstream) {
        retriedUpstream = true;
        continue;
      }
      throw await RestClient.toError(res);
    }
  }

  getFilters(accommodationType: AccommodationType, userLanguage: string): Promise<RestCatalog> {
    const q = new URLSearchParams({ accommodation_type: accommodationType, user_language: userLanguage });
    return this.get<RestCatalog>(`/search/filters?${q}`);
  }

  searchCampings(p: SearchParams): Promise<RestSearchResponse> {
    const q = new URLSearchParams({
      startDate: p.startDate,
      endDate: p.endDate,
      peopleCount: String(p.peopleCount),
      accommodation_type: p.accommodationType,
      maxResults: String(p.maxResults),
      user_language: p.userLanguage,
    });
    if (p.filters.length > 0) q.set('filters', p.filters.join(','));
    return this.get<RestSearchResponse>(`/search/campings?${q}`);
  }
}
