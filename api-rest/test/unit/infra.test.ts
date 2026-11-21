import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { lambdaEventToHttpRequest, createLambdaHandler } from '../../src/adapters/lambda.js';
import { createNetlifyHandler, toHttpRequest } from '../../src/adapters/netlify.js';
import type { App } from '../../src/app.js';
import { createLogger, redact } from '../../src/observability/logger.js';
import {
  createGqlClient,
  toGqlDate,
  UpstreamError,
  UpstreamTimeoutError,
} from '../../src/upstream/gqlClient.js';
import { testConfig } from '../helpers/factories.js';

describe('U28 — garde : aucun id de filtre en dur dans src/', () => {
  const ID_RE = /^(SR|SO|N|C|F|BA|BE)\d+$/;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const srcDir = new URL('../../src', import.meta.url).pathname;

  it('aucun littéral d’id de filtre (SR7, F4, C18…, pets, pmr) dans le code applicatif', () => {
    const offenders: string[] = [];
    for (const file of files(srcDir)) {
      // Le tableau de catégories §6.1 est le seul référentiel autorisé : la catégorie `pmr` y figure
      // (son nom coïncide avec l'id du filtre qu'elle contient).
      const isCategoryTable = file.endsWith('categoryMapping.ts');
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(['"`])([^'"`\n]{1,40})\1/g)) {
        const lit = m[2] as string;
        if (ID_RE.test(lit) || lit === 'pets' || (lit === 'pmr' && !isCategoryTable))
          offenders.push(`${file}: ${lit}`);
      }
      for (const m of text.matchAll(/^\s*(pets|pmr)\s*:/gm))
        if (!(isCategoryTable && m[1] === 'pmr')) offenders.push(`${file}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('client GraphQL (§9.1)', () => {
  const cfg = testConfig().gql;
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const vars = { accommodationType: 'rental' as const, peopleCount: 1, campingContentIds: [], filters: [] };

  it('en-têtes obligatoires, gql-locale demandé, pas de gql-bypass-cache par défaut', async () => {
    const fetchImpl = vi.fn(async () => ok({ searchCampings: { filterCategories: [null] } }));
    await createGqlClient(cfg, fetchImpl).catalog(vars, 'de');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({
      Origin: 'https://www.yellohvillage.fr',
      'gql-market-site': '1',
      'gql-locale': 'de',
    });
    expect(init.headers).not.toHaveProperty('gql-bypass-cache');
    expect(JSON.parse(String(init.body)).operationName).toBe('apiFilterCatalog');
  });

  it('gql-bypass-cache si configuré', async () => {
    const fetchImpl = vi.fn(async () => ok({ campingAvailability: null }));
    await createGqlClient({ ...cfg, bypassCache: true }, fetchImpl).campingAvailability(
      { ...vars, campingCode: 1, startDate: 'a', endDate: 'b', fidelityId: null },
      'fr',
    );
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      'gql-bypass-cache': 'true',
    });
  });

  it('une seule nouvelle tentative sur 503, puis erreur', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    await expect(createGqlClient(cfg, fetchImpl).searchCampings(vars, 'fr')).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('nouvelle tentative après erreur réseau, puis succès', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return ok({ searchCampings: { campings: null, filterCategories: null } });
    });
    await expect(createGqlClient(cfg, fetchImpl).searchCampings(vars, 'fr')).resolves.toEqual({
      campings: [],
      filterCategories: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pas de nouvelle tentative sur 400 ; errors[] → UpstreamError ; corps illisible ; données absentes', async () => {
    const f400 = vi.fn(async () => new Response('', { status: 400 }));
    await expect(createGqlClient(cfg, f400).searchCampings(vars, 'fr')).rejects.toThrow(/HTTP 400/);
    expect(f400).toHaveBeenCalledTimes(1);
    const fErr = async () => new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200 });
    await expect(createGqlClient(cfg, fErr).searchCampings(vars, 'fr')).rejects.toThrow(/boom/);
    const fBad = async () => new Response('<html>', { status: 200 });
    await expect(createGqlClient(cfg, fBad).searchCampings(vars, 'fr')).rejects.toThrow(/illisible/);
    const fNull = async () => ok({ searchCampings: null });
    await expect(createGqlClient(cfg, fNull).searchCampings(vars, 'fr')).rejects.toThrow(/vide/);
    await expect(createGqlClient(cfg, fNull).catalog(vars, 'fr')).rejects.toThrow(/vide/);
    const fNoData = async () => new Response('{}', { status: 200 });
    await expect(createGqlClient(cfg, fNoData).searchCampings(vars, 'fr')).rejects.toThrow(/sans données/);
  });

  it('timeout → UpstreamTimeoutError', async () => {
    const fetchImpl = (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    await expect(
      createGqlClient({ ...cfg, timeoutMs: 20 }, fetchImpl).searchCampings(vars, 'fr'),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('toGqlDate', () => {
    expect(toGqlDate('2027-07-10')).toBe('2027-07-10T00:00:00.000Z');
  });
});

describe('logger', () => {
  it('JSON, niveau minimal, secrets masqués', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l));
    log.debug('ignoré');
    log.info('req', { client_id: 'c', authorization: 'Bearer x', nested: { 'x-api-key': 'k' } });
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj).toMatchObject({
      level: 'info',
      msg: 'req',
      client_id: 'c',
      authorization: '[redacted]',
      nested: { 'x-api-key': '[redacted]' },
    });
    expect(redact([{ token: 't' }])).toEqual([{ token: '[redacted]' }]);
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(3);
  });
});

describe('adaptateurs', () => {
  const fakeApp = (): App & { last?: unknown } => {
    const app: App & { last?: unknown } = {
      async handle(req) {
        app.last = req;
        return { statusCode: 200, headers: { 'X-Test': '1' }, body: '{"ok":true}' };
      },
    };
    return app;
  };

  it('Netlify : chemin /v1 conservé, requête répétée, en-têtes en minuscules', () => {
    const r = toHttpRequest(
      new Request('https://h.example/v1/search/campings?filters=a:b&filters=c:d&x=1', {
        headers: { 'X-Api-Key': 'k' },
      }),
      undefined,
    );
    expect(r).toMatchObject({
      method: 'GET',
      path: '/v1/search/campings',
      query: { filters: ['a:b', 'c:d'], x: '1' },
    });
    expect(r.headers['x-api-key']).toBe('k');
  });

  it('Netlify : préfixe /.netlify/functions/api retiré, /v1 rétabli', () => {
    expect(
      toHttpRequest(new Request('https://h.example/.netlify/functions/api/search/filters'), undefined).path,
    ).toBe('/v1/search/filters');
    expect(
      toHttpRequest(new Request('https://h.example/.netlify/functions/api/v1/health'), undefined).path,
    ).toBe('/v1/health');
    expect(toHttpRequest(new Request('https://h.example/.netlify/functions/api'), undefined).path).toBe(
      '/v1',
    );
  });

  it('Netlify : handler Request → Response, corps des POST transmis', async () => {
    const app = fakeApp();
    const res = await createNetlifyHandler(() => app)(
      new Request('https://h.example/v1/auth/session', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('1');
    expect(await res.json()).toEqual({ ok: true });
    expect(app.last).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('Lambda : événement HTTP API v2', async () => {
    const r = lambdaEventToHttpRequest({
      version: '2.0',
      rawPath: '/v1/search/campings',
      rawQueryString: 'filters=a:b&filters=c:d',
      headers: { 'X-Request-Id': 'abc' },
      cookies: ['a=1'],
      requestContext: { http: { method: 'GET' } },
      body: Buffer.from('{"a":1}').toString('base64'),
      isBase64Encoded: true,
    } as never);
    expect(r).toMatchObject({
      method: 'GET',
      path: '/v1/search/campings',
      query: { filters: ['a:b', 'c:d'] },
      body: '{"a":1}',
    });
    expect(r.headers).toMatchObject({ 'x-request-id': 'abc', cookie: 'a=1' });
  });

  it('Lambda : événement REST v1 (multiValue et simple) et handler', async () => {
    const r = lambdaEventToHttpRequest({
      httpMethod: 'GET',
      path: '/v1/health',
      headers: { Accept: 'application/json' },
      multiValueHeaders: { 'X-Multi': ['a', 'b'] },
      multiValueQueryStringParameters: { deep: ['true'] },
      body: null,
      isBase64Encoded: false,
    } as never);
    expect(r).toMatchObject({
      path: '/v1/health',
      query: { deep: 'true' },
      headers: { accept: 'application/json', 'x-multi': 'a, b' },
    });
    const r2 = lambdaEventToHttpRequest({
      httpMethod: 'GET',
      path: '/v1/x',
      headers: null,
      queryStringParameters: { a: '1' },
      body: null,
    } as never);
    expect(r2.query).toEqual({ a: '1' });
    const app = fakeApp();
    const out = await createLambdaHandler(() => app)({
      httpMethod: 'GET',
      path: '/v1/health',
      headers: {},
      body: null,
    } as never);
    expect(out).toEqual({ statusCode: 200, headers: { 'X-Test': '1' }, body: '{"ok":true}' });
  });
});
