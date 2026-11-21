import type { GqlConfig } from '../config.js';
import { AVAILABILITY_QUERY, CATALOG_QUERY, SEARCH_QUERY } from './queries.js';
import type {
  AvailabilityVariables,
  GqlCampingAvailability,
  GqlFilterCategory,
  GqlSearchCampings,
  SearchVariables,
} from './types.js';

/** Erreur amont : HTTP ≠ 200, `errors[]` dans le corps, réponse illisible ou erreur réseau (§9.1). */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class UpstreamTimeoutError extends Error {
  constructor(message = 'Délai dépassé pour le GraphQL Yelloh! Village') {
    super(message);
    this.name = 'UpstreamTimeoutError';
  }
}

export interface GqlClient {
  /** Catalogue des filtres (sans dates), `gql-locale` fourni par l'appelant. */
  catalog(vars: SearchVariables, locale: string): Promise<GqlFilterCategory[]>;
  /** Recherche (appel unique, §8.1). */
  searchCampings(vars: SearchVariables, locale: string): Promise<GqlSearchCampings>;
  /** Vérification d'un camping « autres dates » (§8.6). */
  campingAvailability(vars: AvailabilityVariables, locale: string): Promise<GqlCampingAvailability | null>;
}

export type FetchFn = typeof fetch;

const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGqlClient(cfg: GqlConfig, fetchImpl: FetchFn = fetch): GqlClient {
  const headersFor = (locale: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: cfg.origin,
    'gql-market-site': cfg.marketSite,
    'gql-locale': locale,
    'User-Agent': cfg.userAgent,
    ...(cfg.bypassCache ? { 'gql-bypass-cache': 'true' } : {}),
  });

  async function attempt(body: string, locale: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      return await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: headersFor(locale),
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError();
      throw new UpstreamError(`Erreur réseau vers le GraphQL : ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(
    operationName: string,
    query: string,
    variables: object,
    locale: string,
  ): Promise<T> {
    const body = JSON.stringify({ operationName, variables, query });
    let res: Response;
    try {
      res = await attempt(body, locale);
      if (RETRY_STATUSES.has(res.status)) {
        await sleep(RETRY_DELAY_MS);
        res = await attempt(body, locale);
      }
    } catch (err) {
      // Une seule nouvelle tentative, uniquement sur erreur réseau (pas sur timeout).
      if (!(err instanceof UpstreamError)) throw err;
      await sleep(RETRY_DELAY_MS);
      res = await attempt(body, locale);
    }
    if (res.status !== 200) throw new UpstreamError(`Le GraphQL a répondu HTTP ${res.status}`);
    let json: { data?: T; errors?: { message?: string }[] };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new UpstreamError('Réponse GraphQL illisible');
    }
    if (json.errors && json.errors.length > 0) {
      throw new UpstreamError(`Erreur GraphQL : ${json.errors[0]?.message ?? 'inconnue'}`);
    }
    if (!json.data) throw new UpstreamError('Réponse GraphQL sans données');
    return json.data;
  }

  return {
    async catalog(vars, locale) {
      const data = await call<{ searchCampings: { filterCategories: (GqlFilterCategory | null)[] } | null }>(
        'apiFilterCatalog',
        CATALOG_QUERY,
        vars,
        locale,
      );
      if (!data.searchCampings) throw new UpstreamError('Réponse searchCampings vide');
      return data.searchCampings.filterCategories.filter((c): c is GqlFilterCategory => !!c);
    },
    async searchCampings(vars, locale) {
      const data = await call<{ searchCampings: GqlSearchCampings | null }>(
        'apiSearchCampings',
        SEARCH_QUERY,
        vars,
        locale,
      );
      if (!data.searchCampings) throw new UpstreamError('Réponse searchCampings vide');
      return {
        campings: data.searchCampings.campings ?? [],
        filterCategories: data.searchCampings.filterCategories ?? [],
      };
    },
    async campingAvailability(vars, locale) {
      const data = await call<{ campingAvailability: GqlCampingAvailability | null }>(
        'apiCampingAvailability',
        AVAILABILITY_QUERY,
        vars,
        locale,
      );
      return data.campingAvailability;
    },
  };
}

/** Date YYYY-MM-DD → instant ISO à minuit UTC (§9.2). */
export const toGqlDate = (isoDate: string) => `${isoDate}T00:00:00.000Z`;
