import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createNetlifyHandler } from '../../src/adapters/netlify.js';
import { createApp, type CreateAppOptions } from '../../src/app.js';
import type { ApiClient } from '../../src/config.js';
import { seededRng } from '../../src/domain/rng.js';
import type { HttpRequest, HttpResponse } from '../../src/http/types.js';
import { catalogSchema, errorSchema, searchResponseSchema, sessionSchema } from '../../src/routes/openapi.js';
import type { GqlCamping, GqlSearchCampings } from '../../src/upstream/types.js';
import {
  API_KEY,
  API_KEY_PARTNER,
  camping,
  catalogRental,
  catalogSlot,
  fixture,
  memoryLogger,
  testConfig,
} from '../helpers/factories.js';
import { fakeGraphql, gqlData, type Responder } from '../helpers/fakeGraphql.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const julNoFilter = () => fixture<GqlSearchCampings>('search-jul-4p-nofilter.json');

interface Harness {
  call: (
    method: string,
    path: string,
    opts?: { query?: Record<string, string | string[]>; headers?: Record<string, string> },
  ) => Promise<HttpResponse & { json: any }>;
  gql: ReturnType<typeof fakeGraphql>;
  logger: ReturnType<typeof memoryLogger>;
  clock: { now: Date };
  token: () => Promise<string>;
  setClients: (c: ApiClient[]) => void;
}

function harness(
  handlers: Partial<Record<string, Responder>>,
  opts: Partial<CreateAppOptions> & { env?: Record<string, string> } = {},
): Harness {
  const config = testConfig(opts.env);
  const gql = fakeGraphql(handlers);
  const logger = memoryLogger();
  const clock = { now: NOW };
  let clients = config.apiClients;
  const app = createApp({
    config,
    fetchImpl: gql.fetchImpl,
    logger,
    clock: () => clock.now,
    rng: seededRng(7),
    security: () => ({ clients, secrets: config.signingSecrets }),
    ...opts,
  });
  const call: Harness['call'] = async (method, path, o = {}) => {
    const req: HttpRequest = { method, path, query: o.query ?? {}, headers: o.headers ?? {} };
    const res = await app.handle(req);
    return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return {
    call,
    gql,
    logger,
    clock,
    setClients: (c) => (clients = c),
    token: async () =>
      (await call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY } })).json.access_token,
  };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Handlers GraphQL par défaut : catalogue selon le type, recherche fournie, disponibilité fournie. */
const handlers = (
  search: () => GqlSearchCampings,
  availability?: Responder,
): Partial<Record<string, Responder>> => ({
  apiFilterCatalog: (v) =>
    gqlData('searchCampings', {
      filterCategories: v.accommodationType === 'slot' ? catalogSlot() : catalogRental(),
    }),
  apiSearchCampings: () => gqlData('searchCampings', search()),
  apiCampingAvailability: availability ?? (() => gqlData('campingAvailability', null)),
});

const alt = (begin: string, end: string, status = 'flex', accommodationId = 1) =>
  gqlData('campingAvailability', {
    statusCode: status,
    accommodationId,
    info: { arrivalDate: `${begin}T00:00:00.000Z`, departureDate: `${end}T00:00:00.000Z` },
  });

describe('parcours complet R1 (session → catalogue → recherche)', () => {
  it('3 campings disponibles, 1 seul appel GraphQL, filtres hébergement seuls transmis', async () => {
    const h = harness(handlers(julNoFilter));
    const session = await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY } });
    expect(session.statusCode).toBe(201);
    sessionSchema.parse(session.json);
    expect(session.json).toMatchObject({
      token_type: 'Bearer',
      expires_in: 14400,
      expires_at: '2026-11-21T16:00:00Z',
      client_id: 'chatbot-yv',
    });
    const auth = bearer(session.json.access_token);

    const cat = await h.call('GET', '/v1/search/filters', {
      query: { accommodation_type: 'rental', user_language: 'fr' },
      headers: auth,
    });
    expect(cat.statusCode).toBe(200);
    catalogSchema.parse(cat.json);
    const expected = JSON.parse(
      readFileSync(
        new URL('../../../specs/exemple-reponse-search-filters-rental.json', import.meta.url),
        'utf8',
      ),
    );
    expect({ ...cat.json, generated_at: expected.generated_at }).toEqual(expected);
    expect(cat.headers['Cache-Control']).toBe('private, max-age=86400');

    const res = await h.call('GET', '/v1/search/campings', {
      query: {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: '4',
        filters: 'confort_type:F4:4,swimming:SR7',
        user_language: 'fr',
      },
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    searchResponseSchema.parse(res.json);
    expect(res.json.status).toBe('OK');
    expect(res.json.message).toBeNull();
    expect(res.json.results).toHaveLength(3);
    expect(res.json.meta.upstream_calls).toEqual({ search_campings: 1, camping_availability: 0 });
    expect(res.json.search).toMatchObject({
      nights: 7,
      user_language: 'fr',
      site_base_url: 'https://www.yellohvillage.fr',
      max_results: 3,
    });

    const byCode = new Map(julNoFilter().campings.map((c) => [c!.campingCode, c!]));
    for (const r of res.json.results) {
      const c = byCode.get(r.camping_code)!;
      expect(r.availability_type).toBe('available');
      expect(c.allFilters).toContain('SR7');
      expect(
        c.accommodations!.some((a) => a?.accommodationType === 'rental' && a.filters?.includes('4')),
      ).toBe(true);
      expect(r.camping_url).toBe(`https://www.yellohvillage.fr${c.campingUrl}`);
      expect(r.bookingengine_link).toBe(
        `https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=${r.camping_code}&nb_pers=4&track=chatbot&type=0`,
      );
    }
    expect(res.json.results.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);

    const searches = h.gql.calls.filter((c) => c.operationName === 'apiSearchCampings');
    expect(searches).toHaveLength(1);
    expect(searches[0]!.variables).toEqual({
      accommodationType: 'rental',
      peopleCount: 4,
      campingContentIds: [],
      startDate: '2027-07-10T00:00:00.000Z',
      endDate: '2027-07-17T00:00:00.000Z',
      filters: [{ categoryId: 'confort_type', value: 'F4', webcampId: '4' }],
    });
    expect(searches[0]!.headers).toMatchObject({
      origin: 'https://www.yellohvillage.fr',
      'gql-market-site': '1',
      'gql-locale': 'fr',
    });
    expect(h.gql.count('apiCampingAvailability')).toBe(0);
  });

  it('U35 : recherche en allemand → gql-locale fr, camping_url sur yellohvillage.de', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4', user_language: 'de-DE' },
      headers: bearer(t),
    });
    expect(h.gql.calls[0]!.headers['gql-locale']).toBe('fr');
    expect(res.json.search.user_language).toBe('de');
    expect(res.json.results[0].camping_url.startsWith('https://www.yellohvillage.de/camping/')).toBe(true);
  });

  it('sans langue ni Accept-Language → site anglais ; emplacement → type=1', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '2', accommodationType: 'slot' },
      headers: bearer(t),
    });
    expect(res.json.search.site_base_url).toBe('https://www.yellohvillage.co.uk');
    expect(res.json.search.user_language).toBeNull();
    for (const r of res.json.results) expect(r.bookingengine_link.endsWith('&type=1')).toBe(true);
  });

  it('acceptation 5 : maxResults 1, 2 et 4', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    for (const n of ['1', '2', '4']) {
      const res = await h.call('GET', '/v1/search/campings', {
        query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4', maxResults: n },
        headers: bearer(t),
      });
      expect(res.json.results).toHaveLength(Number(n));
    }
  });

  it('X-Debug-Seed (si autorisé) rend le tirage reproductible', async () => {
    const h = harness(handlers(julNoFilter), { env: { ALLOW_DEBUG_SEED: 'true' } });
    const t = await h.token();
    const draw = async (seed: string) =>
      (
        await h.call('GET', '/v1/search/campings', {
          query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4' },
          headers: { ...bearer(t), 'x-debug-seed': seed },
        })
      ).json.results.map((r: { camping_code: number }) => r.camping_code);
    expect(await draw('abc')).toEqual(await draw('abc'));
  });
});

describe('U34 — catalogue selon la langue', () => {
  it('gql-locale selon user_language / Accept-Language, ids identiques, Vary', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const cases: [Record<string, string>, Record<string, string>, string][] = [
      [{ user_language: 'de' }, {}, 'de'],
      [{ user_language: 'ca' }, {}, 'es'],
      [{ user_language: 'pt' }, {}, 'en'],
      [{}, {}, 'en'],
      [{}, { 'accept-language': 'nl-BE,nl;q=0.9' }, 'nl'],
    ];
    const ids: string[] = [];
    for (const [query, headers, locale] of cases) {
      const res = await h.call('GET', '/v1/search/filters', {
        query: { accommodation_type: 'rental', ...query },
        headers: { ...bearer(t), ...headers },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json.locale).toBe(locale);
      expect(res.headers.Vary).toBe('Accept-Language');
      expect(h.gql.calls.at(-1)!.headers['gql-locale']).toBe(locale);
      ids.push(
        JSON.stringify(
          res.json.sections.flatMap((s: any) =>
            s.categories.flatMap((c: any) => c.filters.map((f: any) => f.id)),
          ),
        ),
      );
    }
    expect(new Set(ids).size).toBe(1);
  });

  it('catalogue emplacement et paramètre manquant', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const slot = await h.call('GET', '/v1/search/filters', {
      query: { accommodationType: 'slot', user_language: 'fr' },
      headers: bearer(t),
    });
    const expected = JSON.parse(
      readFileSync(new URL('../../../specs/exemple-reponse-search-filters-slot.json', import.meta.url), 'utf8'),
    );
    expect({ ...slot.json, generated_at: expected.generated_at }).toEqual(expected);
    const missing = await h.call('GET', '/v1/search/filters', { headers: bearer(t) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json.error).toMatchObject({
      code: 'MISSING_PARAMETER',
      details: { missing: ['accommodation_type'] },
    });
  });
});

describe('R2, R3, R4 (§8.6)', () => {
  const cats = catalogRental();
  const mk = (list: GqlCamping[]) => () => ({ campings: list, filterCategories: cats });

  it('R2 : complétion par des dates alternatives, dates reprises dans le lien, filtres hébergement transmis', async () => {
    const list = [
      camping(1),
      ...[11, 12, 13, 14, 15].map((c) =>
        camping(c, {
          availabilityStatus: 'flex',
          accommodations: [
            {
              code: 9,
              accommodationType: 'rental',
              filters: ['4'],
              technicalInfos: { capacity: { value: '6' } },
            },
          ],
        }),
      ),
      camping(20, {
        availabilityStatus: 'closed',
        accommodations: [{ code: 2, accommodationType: 'rental', filters: ['4'] }],
      }),
    ];
    list[0]!.accommodations = [{ code: 1, accommodationType: 'rental', filters: ['4'] }];
    const h = harness(
      handlers(mk(list), (v) =>
        v.campingCode === 11
          ? alt('2027-07-10', '2027-07-17', 'flexCapacity', 9)
          : alt('2027-07-07', '2027-07-14'),
      ),
    );
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: '4',
        filters: 'confort_type:F4:4',
        user_language: 'fr',
      },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(200);
    searchResponseSchema.parse(res.json);
    expect(res.json.status).toBe('OK');
    expect(res.json.summary).toEqual({
      available_count: 1,
      alternative_dates_count: 5,
      unavailable_count: 1,
      returned_count: 3,
    });
    expect(res.json.results[0]).toMatchObject({
      availability_type: 'available',
      camping_code: 1,
      alternative_begin_date_availability: null,
    });
    const alts = res.json.results.slice(1);
    for (const r of alts) {
      if (r.availability_type === 'alternative_dates') {
        expect(r).toMatchObject({
          alternative_begin_date_availability: '2027-07-07',
          alternative_end_date_availability: '2027-07-14',
          alternative_capacity: null,
        });
        expect(r.bookingengine_link).toContain('begin=07%2F07%2F2027&end=14%2F07%2F2027');
      } else {
        expect(r).toMatchObject({ availability_type: 'alternative_capacity', alternative_capacity: 6 });
      }
    }
    expect(res.json.meta.upstream_calls).toEqual({ search_campings: 1, camping_availability: 2 });
    const avCalls = h.gql.calls.filter((c) => c.operationName === 'apiCampingAvailability');
    expect(avCalls).toHaveLength(2);
    expect(avCalls[0]!.variables).toMatchObject({
      peopleCount: 4,
      fidelityId: null,
      filters: [{ categoryId: 'confort_type', value: 'F4', webcampId: '4' }],
    });
  });

  it('R3 : PARTIAL avec message', async () => {
    const h = harness(
      handlers(mk([camping(1), camping(2, { availabilityStatus: 'flex' })]), () =>
        alt('2027-07-08', '2027-07-15'),
      ),
    );
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4' },
      headers: bearer(t),
    });
    expect(res.json).toMatchObject({
      status: 'PARTIAL',
      message: 'Seulement 2 camping(s) correspondent à vos critères.',
    });
  });

  it('R4 : uniquement des campings fermés → 200 NO_AVAILABILITY « aucun camping disponible »', async () => {
    const h = harness(
      handlers(
        mk([camping(1, { availabilityStatus: 'closed' }), camping(2, { availabilityStatus: 'closed' })]),
      ),
    );
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-02-06', endDate: '2027-02-13', peopleCount: '2' },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({
      status: 'NO_AVAILABILITY',
      message: 'aucun camping disponible',
      results: [],
    });
    expect(res.json.summary.unavailable_count).toBe(2);
  });

  it('erreur sur campingAvailability → camping écarté, réponse 200', async () => {
    const h = harness(
      handlers(
        mk([camping(1, { availabilityStatus: 'flex' }), camping(2, { availabilityStatus: 'flex' })]),
        (v) => (v.campingCode === 1 ? { errors: [{ message: 'boom' }] } : alt('2027-07-08', '2027-07-15')),
      ),
    );
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4', maxResults: '1' },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json.results).toHaveLength(1);
    expect(res.json.results[0].camping_code).toBe(2);
  });
});

describe('filtres invalides (§8.2, §8.7)', () => {
  it('acceptation 9 : C18 en location → 400 UNKNOWN_FILTER après 1 seul appel ; validé en emplacement', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: '4',
        filters: 'characteristics:C18:18',
      },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(400);
    errorSchema.parse(res.json);
    expect(res.json.error).toMatchObject({
      code: 'UNKNOWN_FILTER',
      message: 'Filtre(s) inconnu(s) pour accommodation_type=rental : characteristics:C18:18.',
      details: { unknown: ['characteristics:C18:18'], accommodation_type: 'rental' },
    });
    expect(h.gql.count('apiSearchCampings')).toBe(1);
    expect(h.gql.count('apiCampingAvailability')).toBe(0);

    const hs = harness({ ...handlers(() => ({ ...julNoFilter(), filterCategories: catalogSlot() })) });
    const ts = await hs.token();
    const ok = await hs.call('GET', '/v1/search/campings', {
      query: {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: '4',
        accommodationType: 'slot',
        filters: 'characteristics:C18:18',
      },
      headers: bearer(ts),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('format invalide → 400 INVALID_FILTER_FORMAT sans aucun appel GraphQL', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4', filters: 'F4' },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'INVALID_FILTER_FORMAT', details: { invalid: ['F4'] } });
    expect(h.gql.calls).toHaveLength(0);
  });
});

describe('erreurs amont (§9.1)', () => {
  const search = (q: Record<string, string> = {}) => ({
    startDate: '2027-07-10',
    endDate: '2027-07-17',
    peopleCount: '4',
    ...q,
  });

  it('errors[] sur searchCampings → 502 ; tous les statuts error → 502', async () => {
    const h = harness({ apiSearchCampings: () => ({ errors: [{ message: 'Context creation failed' }] }) });
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', { query: search(), headers: bearer(t) });
    expect(res.statusCode).toBe(502);
    expect(res.json.error.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(res.json)).not.toContain('Context creation');

    const h2 = harness(
      handlers(() => ({
        campings: [camping(1, { availabilityStatus: 'error' })],
        filterCategories: catalogRental(),
      })),
    );
    const t2 = await h2.token();
    expect(
      (await h2.call('GET', '/v1/search/campings', { query: search(), headers: bearer(t2) })).statusCode,
    ).toBe(502);
  });

  it('timeout → 504', async () => {
    const h = harness(
      { apiSearchCampings: () => new Promise(() => undefined) },
      { env: { GQL_TIMEOUT_MS: '150' } },
    );
    const t = await h.token();
    const res = await h.call('GET', '/v1/search/campings', { query: search(), headers: bearer(t) });
    expect(res.statusCode).toBe(504);
    expect(res.json.error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('catalogue en erreur → 502', async () => {
    const h = harness({ apiFilterCatalog: () => new Response('', { status: 500 }) });
    const t = await h.token();
    expect(
      (
        await h.call('GET', '/v1/search/filters', {
          query: { accommodation_type: 'rental' },
          headers: bearer(t),
        })
      ).statusCode,
    ).toBe(502);
  });
});

describe('sécurité (§4)', () => {
  it('sans token, token mal formé, clé absente ou invalide', async () => {
    const h = harness(handlers(julNoFilter));
    const noToken = await h.call('GET', '/v1/search/filters', { query: { accommodation_type: 'rental' } });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json.error.code).toBe('MISSING_TOKEN');
    expect(noToken.headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');
    expect((await h.call('GET', '/v1/search/campings', { headers: bearer('abc') })).json.error.code).toBe(
      'INVALID_TOKEN',
    );
    expect((await h.call('POST', '/v1/auth/session')).json.error.code).toBe('MISSING_API_KEY');
    const bad = await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': 'ysk_live_inconnue' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json.error.code).toBe('INVALID_API_KEY');
    expect(h.gql.calls).toHaveLength(0);
  });

  it('acceptation 1 : token refusé après expiration (4 h + tolérance de 30 s)', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    h.clock.now = new Date(NOW.getTime() + (4 * 3600 + 31) * 1000);
    const res = await h.call('GET', '/v1/search/filters', {
      query: { accommodation_type: 'rental' },
      headers: bearer(t),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json.error.code).toBe('TOKEN_EXPIRED');
  });

  it('U26 : client désactivé → ses tokens en cours sont refusés', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    h.setClients(testConfig().apiClients.map((c) => ({ ...c, enabled: c.client_id !== 'chatbot-yv' })));
    const res = await h.call('GET', '/v1/search/filters', {
      query: { accommodation_type: 'rental' },
      headers: bearer(t),
    });
    expect(res.json.error.code).toBe('INVALID_TOKEN');
    expect(
      (await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY } })).json.error.code,
    ).toBe('INVALID_API_KEY');
  });

  it('track du client dans les liens ; limite par client (2/min) → 429 + Retry-After + X-RateLimit-*', async () => {
    const h = harness(handlers(julNoFilter));
    const t = (await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY_PARTNER } })).json
      .access_token;
    const q = { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4' };
    const r1 = await h.call('GET', '/v1/search/campings', { query: q, headers: bearer(t) });
    expect(r1.json.results[0].bookingengine_link).toContain('track=partnerx');
    expect(r1.headers).toMatchObject({ 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '1' });
    await h.call('GET', '/v1/search/campings', { query: q, headers: bearer(t) });
    const r3 = await h.call('GET', '/v1/search/campings', { query: q, headers: bearer(t) });
    expect(r3.statusCode).toBe(429);
    expect(r3.json.error.code).toBe('RATE_LIMITED');
    expect(Number(r3.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('au plus 10 demandes de token par minute pour une même clé', async () => {
    const h = harness(handlers(julNoFilter));
    for (let i = 0; i < 10; i++)
      expect(
        (await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY } })).statusCode,
      ).toBe(201);
    const r = await h.call('POST', '/v1/auth/session', { headers: { 'x-api-key': API_KEY } });
    expect(r.statusCode).toBe(429);
    expect(r.headers['Retry-After']).toBeDefined();
  });

  it('journaux : une ligne par requête, sans clé ni token', async () => {
    const h = harness(handlers(julNoFilter));
    const t = await h.token();
    await h.call('GET', '/v1/search/campings', {
      query: { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4' },
      headers: { ...bearer(t), 'x-api-key': API_KEY },
    });
    const dump = JSON.stringify(h.logger.lines);
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(t);
    const last = h.logger.lines.at(-1)!;
    expect(last.fields).toMatchObject({
      client_id: 'chatbot-yv',
      status: 200,
      business_status: 'OK',
      route: '/v1/search/campings',
    });
    expect((last.fields!.upstream_calls as { search_campings: number }).search_campings).toBe(1);
  });

  it('en-têtes de sécurité et X-Request-Id', async () => {
    const h = harness(handlers(julNoFilter));
    const r = await h.call('GET', '/v1/health', { headers: { 'x-request-id': 'req-123' } });
    expect(r.headers).toMatchObject({
      'X-Request-Id': 'req-123',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Type': 'application/json; charset=utf-8',
    });
    const r2 = await h.call('GET', '/v1/health', { headers: { 'x-request-id': 'bad id with spaces' } });
    expect(r2.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('CORS : préflight accepté pour une origine autorisée, aucun en-tête sinon', async () => {
    const h = harness(handlers(julNoFilter), { env: { CORS_ALLOWED_ORIGINS: 'https://app.example' } });
    const pre = await h.call('OPTIONS', '/v1/search/campings', {
      headers: { origin: 'https://app.example' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers).toMatchObject({ 'Access-Control-Allow-Origin': 'https://app.example' });
    expect(pre.headers['Access-Control-Allow-Headers']).not.toContain('X-API-Key');
    const other = await h.call('GET', '/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(other.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('routes diverses', () => {
  it('404, 405 avec Allow, chemin avec / final', async () => {
    const h = harness({});
    expect((await h.call('GET', '/v1/nope')).json.error.code).toBe('NOT_FOUND');
    const r = await h.call('DELETE', '/v1/search/campings');
    expect(r.statusCode).toBe(405);
    expect(r.headers.Allow).toBe('GET');
    expect((await h.call('GET', '/v1/health/')).statusCode).toBe(200);
  });

  it('health simple, deep ok et deep en échec (503)', async () => {
    const ok = harness(handlers(julNoFilter));
    expect((await ok.call('GET', '/v1/health')).json).toEqual({
      status: 'ok',
      version: '1.0.0-test',
      upstream: 'not_checked',
    });
    expect((await ok.call('GET', '/v1/health', { query: { deep: 'true' } })).json.upstream).toBe('ok');
    const ko = harness({ apiFilterCatalog: () => new Response('', { status: 500 }) });
    const r = await ko.call('GET', '/v1/health', { query: { deep: 'true' } });
    expect(r.statusCode).toBe(503);
    expect(r.json.upstream).toBe('error');
  });

  it('openapi.json', async () => {
    const r = await harness({}).call('GET', '/v1/openapi.json');
    expect(r.json.openapi).toBe('3.1.0');
    expect(Object.keys(r.json.paths)).toEqual([
      '/v1/auth/session',
      '/v1/search/filters',
      '/v1/search/campings',
      '/v1/health',
      '/v1/openapi.json',
    ]);
  });

  it('erreur interne → 500 générique', async () => {
    const h = harness(
      {},
      {
        gqlClient: {
          catalog: () => Promise.reject(new Error('secret interne')),
          searchCampings: () => Promise.reject(new Error('x')),
          campingAvailability: () => Promise.reject(new Error('x')),
        },
      },
    );
    const t = await h.token();
    const r = await h.call('GET', '/v1/search/filters', {
      query: { accommodation_type: 'rental' },
      headers: bearer(t),
    });
    expect(r.statusCode).toBe(500);
    expect(r.json.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
    expect(r.body).not.toContain('secret interne');
  });
});

describe('Netlify de bout en bout', () => {
  it('fonction Netlify → application → GraphQL simulé', async () => {
    const config = testConfig();
    const gql = fakeGraphql(handlers(julNoFilter));
    const app = createApp({ config, fetchImpl: gql.fetchImpl, logger: memoryLogger(), clock: () => NOW });
    const fn = createNetlifyHandler(() => app);
    const session = await fn(
      new Request('https://api.example/v1/auth/session', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
        body: '{}',
      }),
    );
    expect(session.status).toBe(201);
    const { access_token } = (await session.json()) as { access_token: string };
    const res = await fn(
      new Request(
        'https://api.example/v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type%3AF4%3A4%2Cswimming%3ASR7&user_language=fr',
        {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; results: unknown[] };
    expect(body.status).toBe('OK');
    expect(body.results).toHaveLength(3);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const pre = await fn(new Request('https://api.example/v1/health', { method: 'OPTIONS' }));
    expect(pre.status).toBe(405);
  });
});
