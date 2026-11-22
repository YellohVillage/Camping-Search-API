import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, type McpConfig } from '../../src/config.js';
import { createMcpHttpHandler } from '../../src/http/handler.js';
import type { Logger } from '../../src/logger.js';
import type { RestCatalog, RestGeographyResponse, RestSearchResponse } from '../../src/rest/types.js';

export const KEY_CLAUDE = `ysk_live_${'C'.repeat(40)}`;
export const KEY_CHATGPT = `ysk_live_${'G'.repeat(40)}`;
export const KEY_DEFAULT = `ysk_live_${'D'.repeat(40)}`;

export const specCatalog = (type: 'rental' | 'slot' = 'rental'): RestCatalog =>
  JSON.parse(
    readFileSync(
      new URL(`../../../specs/exemple-reponse-search-filters-${type}.json`, import.meta.url),
      'utf8',
    ),
  ) as RestCatalog;

export function testConfig(env: Record<string, string> = {}): McpConfig {
  return loadConfig(
    {
      REST_API_BASE_URL: 'https://api.example/v1',
      REST_API_KEY_CLAUDE: KEY_CLAUDE,
      REST_API_KEY_CHATGPT: KEY_CHATGPT,
      LOG_LEVEL: 'error',
      ...env,
    },
    '0.1.0-test',
  );
}

export function result(
  over: Partial<RestSearchResponse['results'][number]> = {},
): RestSearchResponse['results'][number] {
  return {
    rank: 1,
    availability_type: 'available',
    camping_code: 6934,
    name: 'La Marende',
    stars: 5,
    rating: 9,
    city: 'Argelès-sur-Mer',
    department: 'Pyrénées Orientales',
    region: 'Languedoc-Roussillon',
    latitude: 42.57,
    longitude: 3.04,
    image_url: 'https://img.yellohvillage.fr/la_marende.jpg',
    camping_url: 'https://www.yellohvillage.fr/camping/la_marende',
    is_new: false,
    special_offer: null,
    alternative_begin_date_availability: null,
    alternative_end_date_availability: null,
    alternative_capacity: null,
    bookingengine_link:
      'https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&track=claude&type=0',
    ...over,
  };
}

export function searchResponse(over: Partial<RestSearchResponse> = {}): RestSearchResponse {
  return {
    status: 'OK',
    message: null,
    search: {
      start_date: '2027-07-10',
      end_date: '2027-07-17',
      nights: 7,
      people_count: 4,
      accommodation_type: 'rental',
      filters: [],
      max_results: 3,
      user_language: 'fr',
      site_base_url: 'https://www.yellohvillage.fr',
    },
    summary: { available_count: 70, alternative_dates_count: 4, unavailable_count: 0, returned_count: 1 },
    results: [result()],
    meta: { request_id: 'x' },
    ...over,
  };
}

export const BRETAGNE_IDS = [2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962];

/** Réponse réelle de /v1/search/geography?keywords=Bretagne (spécification REST §7 bis.3). */
export function geographyResponse(over: Partial<RestGeographyResponse> = {}): RestGeographyResponse {
  return {
    status: 'OK',
    keywords: 'Bretagne',
    user_language: 'fr',
    locale: 'fr',
    match: { name: 'Bretagne', type: 'geographique', content_id: 446, camping_count: 8 },
    camping_ids: BRETAGNE_IDS,
    other_matches: [
      {
        name: 'Où partir en camping en Bretagne en 2026 ?',
        type: 'poi',
        content_id: 136654,
        camping_count: 5,
      },
      { name: 'Ile de Batz', type: 'poi', content_id: 54985, camping_count: 1 },
    ],
    meta: { request_id: 'g' },
    ...over,
  };
}

export const noResult = (keywords: string) =>
  Response.json(
    {
      error: {
        code: 'NO_RESULT',
        message: 'no result',
        details: { keywords, locale: 'fr' },
        request_id: 'x',
      },
    },
    { status: 404 },
  );

export interface RestCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

type Route = (call: RestCall) => Response | Promise<Response>;

/** Fausse API REST : session, catalogue (exemples de specs/) et recherche, surchargeables. */
export function fakeRest(over: { session?: Route; filters?: Route; search?: Route; geography?: Route } = {}) {
  const calls: RestCall[] = [];
  let tokenSeq = 0;
  const routes: Required<typeof over> = {
    session: () =>
      Response.json(
        {
          access_token: `token-${++tokenSeq}`,
          token_type: 'Bearer',
          expires_in: 14400,
          expires_at: '2099-01-01T00:00:00Z',
        },
        { status: 201 },
      ),
    filters: (c) => Response.json(specCatalog(c.query.get('accommodation_type') as 'rental' | 'slot')),
    search: () => Response.json(searchResponse()),
    geography: (c) =>
      c.query.get('keywords') === 'Bretagne'
        ? Response.json(geographyResponse())
        : noResult(c.query.get('keywords')!),
    ...over,
  };
  const fetchImpl: typeof fetch = async (u, init) => {
    const url = new URL(String(u));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, headers };
    calls.push(call);
    if (url.pathname.endsWith('/auth/session')) return routes.session(call);
    if (url.pathname.endsWith('/search/filters')) return routes.filters(call);
    if (url.pathname.endsWith('/search/campings')) return routes.search(call);
    if (url.pathname.endsWith('/search/geography')) return routes.geography(call);
    return Response.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
  };
  return { fetchImpl, calls, count: (suffix: string) => calls.filter((c) => c.path.endsWith(suffix)).length };
}

export function memoryLogger(): Logger & {
  lines: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ level, msg, fields });
  return { lines, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

/** Client MCP officiel du SDK branché sur le handler HTTP, sans réseau. */
export async function mcpClient(
  handler: ReturnType<typeof createMcpHttpHandler>,
  path = '/mcp/claude',
): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`https://mcp.example${path}`), {
      fetch: (u, init) => handler(new Request(u, init), { ip: '203.0.113.7' }),
    }),
  );
  return client;
}
