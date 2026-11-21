import { describe, expect, it, vi } from 'vitest';
import { handleSafely } from '../../src/bootstrap.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import { restErrorToTool } from '../../src/errors.js';
import { catalogText, compactCatalog } from '../../src/format/compactCatalog.js';
import { searchText, toMcpSearchResult } from '../../src/format/searchResult.js';
import { contentLengthTooLarge, IpRateLimiter, originAllowed } from '../../src/http/guards.js';
import { createLogger, redact } from '../../src/logger.js';
import { CatalogCache, normalizeLanguage } from '../../src/rest/catalogCache.js';
import { RestApiError, RestClient } from '../../src/rest/restClient.js';
import { TokenManager } from '../../src/rest/tokenManager.js';
import { SERVER_INSTRUCTIONS } from '../../src/server.js';
import { fakeRest, KEY_CLAUDE, result, searchResponse, specCatalog } from '../helpers/fakeRest.js';

const textOf = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe('M1 — compactCatalog', () => {
  it('sortie compacte ≤ 8 Ko de texte, tous les ids, sans level ni horodatage', () => {
    const cat = specCatalog('rental');
    const c = compactCatalog(cat);
    const ids = cat.sections.flatMap((s) => s.categories.flatMap((x) => x.filters.map((f) => f.id)));
    expect(ids).toHaveLength(84);
    const text = catalogText(c);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    for (const id of ids) expect(text).toContain(`${id} | `);
    expect(JSON.stringify(c)).not.toContain('"level"');
    expect(JSON.stringify(c)).not.toContain('generated_at');
    expect(c.sections[0]).toMatchObject({ section: 'location', label: 'Localisation', label_en: null });
    expect(text).toContain('confort_type:F4:4 | 4 fleurs | 4 flowers');
    expect(text).toContain('[confort_type, OR]');
  });
});

describe('M2, M3 — searchResult', () => {
  it('M2 : mapping §6.4, liens recopiés à l’identique, champs inutiles retirés', () => {
    const rest = searchResponse();
    const out = toMcpSearchResult(rest);
    expect(out.matching).toEqual({ available: 70, alternative_dates: 4 });
    expect(out.results[0]).toEqual({
      rank: 1,
      availability_type: 'available',
      name: 'La Marende',
      city: 'Argelès-sur-Mer',
      department: 'Pyrénées Orientales',
      region: 'Languedoc-Roussillon',
      stars: 5,
      rating_out_of_10: 9,
      alternative_begin_date: null,
      alternative_end_date: null,
      alternative_capacity: null,
      booking_link: rest.results[0]!.bookingengine_link,
      camping_page: rest.results[0]!.camping_url,
      image_url: rest.results[0]!.image_url,
    });
    const s = JSON.stringify(out);
    for (const k of ['camping_code', 'latitude', 'longitude', 'is_new', 'meta', 'site_base_url'])
      expect(s).not.toContain(k);
  });

  it('libellés nettoyés (espaces superflus venus du GraphQL)', () => {
    const out = toMcpSearchResult(
      searchResponse({ results: [result({ department: 'Puy de Dôme ', city: ' Murol', region: ' ' })] }),
    );
    expect(out.results[0]).toMatchObject({ department: 'Puy de Dôme', city: 'Murol', region: null });
    expect(searchText(out)).toContain('Murol (Puy de Dôme) —');
  });

  it('M3 : textes available, alternative_dates, alternative_capacity, PARTIAL et NO_AVAILABILITY', () => {
    const rest = searchResponse({
      status: 'PARTIAL',
      message: 'Seulement 3 camping(s) correspondent à vos critères.',
      summary: { available_count: 0, alternative_dates_count: 5, unavailable_count: 0, returned_count: 3 },
      results: [
        result(),
        result({
          rank: 2,
          name: 'Les 3 Vallées',
          availability_type: 'alternative_dates',
          alternative_begin_date_availability: '2027-07-25',
          alternative_end_date_availability: '2027-08-01',
          rating: 8.9,
        }),
        result({
          rank: 3,
          name: 'Le Lavedan',
          availability_type: 'alternative_capacity',
          alternative_capacity: 4,
          department: null,
          stars: null,
          rating: null,
        }),
      ],
    });
    const text = searchText(toMcpSearchResult(rest));
    expect(text).toContain(
      'None is available on the requested dates (0 available, 5 with alternative dates)',
    );
    expect(text).toContain(
      '1. La Marende — Argelès-sur-Mer (Pyrénées Orientales) — 5★ — 9.0/10 — available 2027-07-10 → 2027-07-17',
    );
    expect(text).toContain('NOT available on requested dates — available 2027-07-25 → 2027-08-01');
    expect(text).toContain('available on requested dates in an accommodation for 4 people');
    expect(text).toContain('Note: fewer results than requested');
    expect(text.match(/Campsite page: /g)).toHaveLength(3);
    expect(text.match(/Booking: /g)).toHaveLength(3);
    expect(searchText(toMcpSearchResult(searchResponse({ status: 'NO_AVAILABILITY', results: [] })))).toBe(
      'No campsite available ("aucun camping disponible"). Suggest other dates or fewer filters.',
    );
    const two = searchText(
      toMcpSearchResult(
        searchResponse({ results: [result(), result({ rank: 2, alternative_capacity: null })] }),
      ),
    );
    expect(two).toContain('2 campsites found (70 match the criteria)');
  });
});

describe('M4 — errors (§8)', () => {
  const e = (code: string, status = 400, details?: Record<string, unknown>, retryAfter?: number) =>
    restErrorToTool(new RestApiError(status, code, `msg ${code}`, details, retryAfter), 'rental');
  it('chaque cas donne isError et un message actionnable', () => {
    expect(e('INVALID_DATES')).toEqual({
      content: [
        {
          type: 'text',
          text: 'msg INVALID_DATES Ask the user for valid dates (not in the past, max 90 nights).',
        },
      ],
      isError: true,
    });
    expect(textOf(e('INVALID_PEOPLE_COUNT'))).toBe('people_count must be between 1 and 10.');
    expect(
      textOf(e('UNKNOWN_FILTER', 400, { unknown: ['characteristics:C18:18'], accommodation_type: 'rental' })),
    ).toBe(
      'Unknown filter ids for accommodation_type=rental: characteristics:C18:18. Call get_search_filters again and use only the returned ids.',
    );
    expect(textOf(e('UNKNOWN_FILTER', 400, {}))).toContain('accommodation_type=rental');
    expect(textOf(e('INVALID_FILTER_FORMAT', 400, { invalid: ['F4'] }))).toBe(
      'Malformed filter ids: F4. Use ids exactly as returned by get_search_filters.',
    );
    expect(textOf(e('INVALID_FILTER_FORMAT', 400))).toContain('Malformed filter ids: .');
    expect(textOf(e('RATE_LIMITED', 429, undefined, 12))).toBe('Too many requests, retry in 12 seconds.');
    expect(textOf(e('RATE_LIMITED', 429))).toContain('60 seconds');
    expect(textOf(e('TOKEN_EXPIRED', 401))).toBe('Service temporarily unavailable.');
    expect(textOf(e('UPSTREAM_ERROR', 502))).toBe(
      'Yelloh! Village search is temporarily unavailable. Please try again later.',
    );
    expect(textOf(e('TOO_MANY_FILTERS'))).toContain('max 30');
    expect(textOf(e('INVALID_MAX_RESULTS'))).toBe('Invalid arguments: msg INVALID_MAX_RESULTS');
    expect(textOf(restErrorToTool(new Error('x')))).toContain('temporarily unavailable');
  });
});

describe('M5 — tokenManager', () => {
  it('réutilisation, renouvellement anticipé et partage des demandes simultanées', async () => {
    let now = new Date('2026-11-21T12:00:00Z');
    let n = 0;
    const source = {
      fetchToken: vi.fn(async () => ({
        token: `t${++n}`,
        expiresAt: new Date(now.getTime() + 4 * 3600_000),
      })),
    };
    const tm = new TokenManager(source, 300, () => now);
    const [a, b] = await Promise.all([tm.getToken(), tm.getToken()]);
    expect([a, b]).toEqual(['t1', 't1']);
    expect(source.fetchToken).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + (4 * 3600 - 301) * 1000);
    expect(await tm.getToken()).toBe('t1');
    now = new Date(now.getTime() + 2000);
    expect(await tm.getToken()).toBe('t2');
    tm.invalidate();
    expect(await tm.getToken()).toBe('t3');
  });

  it('401 → nouveau token et un seul nouvel essai ; deux 401 → erreur', async () => {
    let searches = 0;
    const once = fakeRest({
      search: () =>
        ++searches === 1 ? new Response('{}', { status: 401 }) : Response.json(searchResponse()),
    });
    const rc = new RestClient({
      baseUrl: 'https://api.example/v1',
      apiKey: KEY_CLAUDE,
      timeoutMs: 1000,
      tokenRenewBeforeSeconds: 300,
      fetchImpl: once.fetchImpl,
    });
    await expect(
      rc.searchCampings({
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: 4,
        accommodationType: 'rental',
        filters: [],
        maxResults: 3,
        userLanguage: 'fr',
      }),
    ).resolves.toMatchObject({ status: 'OK' });
    expect(once.count('/auth/session')).toBe(2);
    const always = fakeRest({
      filters: () => Response.json({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }, { status: 401 }),
    });
    const rc2 = new RestClient({
      baseUrl: 'https://api.example/v1',
      apiKey: KEY_CLAUDE,
      timeoutMs: 1000,
      tokenRenewBeforeSeconds: 300,
      fetchImpl: always.fetchImpl,
    });
    await expect(rc2.getFilters('rental', 'fr')).rejects.toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
    expect(always.count('/search/filters')).toBe(2);
  });
});

describe('M6 — catalogCache', () => {
  it('TTL, clé (type, langue normalisée), vidage par type', () => {
    let now = 0;
    const cache = new CatalogCache(86400, () => now);
    const cat = specCatalog('rental');
    cache.set('rental', 'de-AT', cat);
    expect(cache.get('rental', 'de')).toBe(cat);
    expect(cache.get('rental', 'fr')).toBeUndefined();
    expect(cache.get('slot', 'de')).toBeUndefined();
    cache.set('rental', 'fr', cat);
    cache.set('slot', 'fr', cat);
    cache.invalidateType('rental');
    expect(cache.get('rental', 'fr')).toBeUndefined();
    expect(cache.get('slot', 'fr')).toBe(cat);
    now = 86400_000;
    expect(cache.get('slot', 'fr')).toBeUndefined();
    expect(normalizeLanguage('PT-br')).toBe('pt');
  });
});

describe('M9 — restClient', () => {
  const base = {
    baseUrl: 'https://api.example/v1',
    apiKey: KEY_CLAUDE,
    timeoutMs: 1000,
    tokenRenewBeforeSeconds: 300,
  };
  const params = {
    startDate: '2027-07-10',
    endDate: '2027-07-17',
    peopleCount: 4,
    accommodationType: 'slot' as const,
    filters: ['a:b', 'c:d:e'],
    maxResults: 2,
    userLanguage: 'de-AT',
  };

  it('paramètres transmis tels quels, clé en en-tête, token Bearer', async () => {
    const f = fakeRest();
    await new RestClient({ ...base, fetchImpl: f.fetchImpl }).searchCampings(params);
    const session = f.calls[0]!;
    expect(session).toMatchObject({ method: 'POST', path: '/v1/auth/session' });
    expect(session.headers['x-api-key']).toBe(KEY_CLAUDE);
    const search = f.calls[1]!;
    expect(search.headers.authorization).toBe('Bearer token-1');
    expect(Object.fromEntries(search.query)).toEqual({
      startDate: '2027-07-10',
      endDate: '2027-07-17',
      peopleCount: '4',
      accommodation_type: 'slot',
      maxResults: '2',
      user_language: 'de-AT',
      filters: 'a:b,c:d:e',
    });
    const f2 = fakeRest();
    await new RestClient({ ...base, fetchImpl: f2.fetchImpl }).searchCampings({ ...params, filters: [] });
    expect(f2.calls[1]!.query.has('filters')).toBe(false);
  });

  it('nouvel essai unique sur 503 et sur erreur réseau ; timeout ; corps d’erreur illisible', async () => {
    let n = 0;
    const flaky = fakeRest({
      filters: () => (++n === 1 ? new Response('', { status: 503 }) : Response.json(specCatalog())),
    });
    await expect(
      new RestClient({ ...base, fetchImpl: flaky.fetchImpl }).getFilters('rental', 'fr'),
    ).resolves.toBeTruthy();
    const down = fakeRest({ filters: () => new Response('<html>', { status: 502 }) });
    await expect(
      new RestClient({ ...base, fetchImpl: down.fetchImpl }).getFilters('rental', 'fr'),
    ).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
    expect(down.count('/search/filters')).toBe(2);
    let m = 0;
    const net = fakeRest();
    const netFetch: typeof fetch = async (u, i) => {
      if (String(u).includes('/search/') && ++m === 1) throw new TypeError('fetch failed');
      return net.fetchImpl(u, i);
    };
    await expect(
      new RestClient({ ...base, fetchImpl: netFetch }).getFilters('rental', 'fr'),
    ).resolves.toBeTruthy();
    const hang: typeof fetch = (_u, i) =>
      new Promise((_r, rej) => i?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const err = await new RestClient({ ...base, timeoutMs: 20, fetchImpl: hang })
      .getFilters('rental', 'fr')
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504 });
    expect(String(err.message)).not.toContain('api.example');
    const badKey = fakeRest({
      session: () =>
        Response.json({ error: { code: 'INVALID_API_KEY', message: 'Clé invalide' } }, { status: 401 }),
    });
    await expect(
      new RestClient({ ...base, fetchImpl: badKey.fetchImpl }).getFilters('rental', 'fr'),
    ).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
  });
});

describe('guards, logger, configuration, instructions', () => {
  it('limite par IP, origine, taille', () => {
    const rl = new IpRateLimiter(2);
    expect(rl.check('a', 0).allowed).toBe(true);
    expect(rl.check('a', 1).allowed).toBe(true);
    const r = rl.check('a', 2);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(rl.check('b', 3).allowed).toBe(true);
    expect(rl.check('a', 60_001).allowed).toBe(true);
    for (let i = 0; i < 10_001; i++) rl.check(`ip${i}`, 200_000);
    expect(originAllowed(null, [])).toBe(true);
    expect(originAllowed('https://x', ['https://x'])).toBe(true);
    expect(originAllowed('https://y', ['https://x'])).toBe(false);
    expect(contentLengthTooLarge('70000', 65536)).toBe(true);
    expect(contentLengthTooLarge(null, 65536)).toBe(false);
  });

  it('logger : niveau, secrets masqués', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l));
    log.debug('x');
    log.info('m', { authorization: 'Bearer t', nested: { 'x-api-key': KEY_CLAUDE }, list: [{ token: 't' }] });
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain(KEY_CLAUDE);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      authorization: '[redacted]',
      list: [{ token: '[redacted]' }],
    });
    expect(redact('s')).toBe('s');
  });

  it('configuration : défauts, surcharges et erreurs sans divulguer les clés', () => {
    const env = {
      REST_API_BASE_URL: 'https://api.example/v1/',
      REST_API_KEY_CLAUDE: KEY_CLAUDE,
      REST_API_KEY_CHATGPT: KEY_CLAUDE,
    };
    const c = loadConfig(env);
    expect(c).toMatchObject({
      restApiBaseUrl: 'https://api.example/v1',
      restApiTimeoutMs: 12000,
      catalogTtlSeconds: 86400,
      tokenRenewBeforeSeconds: 300,
      maxResultsLimit: 5,
      rateLimitPerMinute: 30,
      maxBodyBytes: 65536,
    });
    expect(c.apiKeys.generic).toBeUndefined();
    const c2 = loadConfig({
      ...env,
      REST_API_KEY_DEFAULT: KEY_CLAUDE,
      MCP_ALLOWED_ORIGINS: 'https://a, https://b',
      LOG_LEVEL: 'debug',
    });
    expect(c2.apiKeys.generic).toBe(KEY_CLAUDE);
    expect(c2.allowedOrigins).toEqual(['https://a', 'https://b']);
    expect(loadConfig({ ...env, REST_API_BASE_URL: 'http://localhost:8787/v1' }).restApiBaseUrl).toBe(
      'http://localhost:8787/v1',
    );
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, REST_API_BASE_URL: 'pas une url' })).toThrow(/URL valide/);
    expect(() => loadConfig({ ...env, REST_API_BASE_URL: 'http://api.example/v1' })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env, REST_API_KEY_CHATGPT: '' })).toThrow(
      /REST_API_KEY_CHATGPT est obligatoire/,
    );
    try {
      loadConfig({ ...env, REST_API_KEY_CLAUDE: 'ysk_live_trop_courte_secret' });
    } catch (e) {
      expect(String(e)).toMatch(/format/);
      expect(String(e)).not.toContain('trop_courte_secret');
    }
    expect(() => loadConfig({ ...env, MCP_MAX_RESULTS_LIMIT: '11' })).toThrow(/MCP_MAX_RESULTS_LIMIT/);
    expect(() => loadConfig({ ...env, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
  });

  it('instructions serveur ≤ 1 500 caractères', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1500);
  });

  it('handleSafely : configuration invalide → 500 JSON-RPC générique, détail en journal', async () => {
    const lines: string[] = [];
    const res = await handleSafely(
      () => {
        throw new ConfigError('REST_API_BASE_URL est obligatoire');
      },
      new Request('https://mcp.example/mcp/claude', { method: 'POST' }),
      {},
      (l) => lines.push(l),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('REST_API_BASE_URL');
    expect(JSON.parse(body)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({ error_name: 'ConfigError', route: '/mcp/claude' });
  });
});
