import { describe, expect, it } from 'vitest';
import { createMcpHttpHandler } from '../../src/http/handler.js';
import {
  BRETAGNE_IDS,
  fakeRest,
  KEY_CHATGPT,
  KEY_CLAUDE,
  KEY_DEFAULT,
  mcpClient,
  memoryLogger,
  result,
  searchResponse,
  testConfig,
} from '../helpers/fakeRest.js';

type Args = Record<string, unknown>;
const text = (r: any): string => (r.content as { text: string }[])[0]!.text;
const searchArgs = (over: Args = {}): Args => ({
  start_date: '2027-07-10',
  end_date: '2027-07-17',
  people_count: 4,
  user_language: 'fr',
  ...over,
});

function setup(rest = fakeRest(), env: Record<string, string> = {}) {
  const logger = memoryLogger();
  const handler = createMcpHttpHandler({ config: testConfig(env), fetchImpl: rest.fetchImpl, logger });
  return { handler, rest, logger };
}

const rpc = (
  handler: ReturnType<typeof setup>['handler'],
  path: string,
  init: RequestInit = {},
  ip = '198.51.100.1',
) =>
  handler(
    new Request(`https://mcp.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      ...init,
    }),
    { ip },
  );

describe('initialisation et primitives (§4)', () => {
  it('serverInfo, instructions, outils avec annotations et schémas, ressource, prompt', async () => {
    const { handler } = setup();
    const client = await mcpClient(handler);
    expect(client.getServerVersion()).toEqual({
      name: 'yelloh-camping-search',
      title: 'Yelloh! Village – Recherche de camping',
      version: '0.1.0-test',
    });
    expect(client.getInstructions()).toContain('Never state or estimate prices');
    const caps = client.getServerCapabilities();
    expect(caps).toMatchObject({ tools: {}, resources: {}, prompts: {} });

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['get_search_filters', 'search_campings', 'search_geography']);
    expect(byName.search_geography!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect((byName.search_geography!.inputSchema as any).required).toEqual(['keywords', 'user_language']);
    expect((byName.search_campings!.inputSchema as any).properties.camping_ids.maxItems).toBe(200);
    expect(byName.get_search_filters!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.search_campings!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false });
    const sIn = byName.search_campings!.inputSchema as any;
    expect(sIn.required).toEqual(['start_date', 'end_date', 'people_count', 'user_language']);
    expect(sIn.additionalProperties).toBe(false);
    expect(sIn.properties.max_results).toMatchObject({ maximum: 5, default: 3 });
    expect(sIn.properties.people_count).toMatchObject({ minimum: 1, maximum: 10 });
    expect((byName.get_search_filters!.inputSchema as any).required).toEqual(['user_language']);
    expect(byName.search_campings!.outputSchema).toBeDefined();
    expect(byName.search_campings!.description).toContain('BOTH links');

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate)).toEqual([
      'yelloh://filters/{accommodation_type}/{language}',
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['find_a_camping']);
    await client.close();
  });
});

describe('parcours E1 : catalogue puis recherche', () => {
  it('get_search_filters(rental, fr) puis search_campings avec les ids, deux liens par camping', async () => {
    const { handler, rest, logger } = setup();
    const client = await mcpClient(handler);

    const cat = await client.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    expect(cat.isError).toBeFalsy();
    expect(text(cat)).toContain('confort_type:F4:4 | 4 fleurs | 4 flowers');
    expect(text(cat)).toContain('swimming:SR7 | Toboggan(s) | Slide(s)');
    expect((cat.structuredContent as any).accommodation_type).toBe('rental');
    const filtersCall = rest.calls.find((c) => c.path.endsWith('/search/filters'))!;
    expect(Object.fromEntries(filtersCall.query)).toEqual({
      accommodation_type: 'rental',
      user_language: 'fr',
    });

    const res = await client.callTool({
      name: 'search_campings',
      arguments: searchArgs({ filters: ['confort_type:F4:4', 'swimming:SR7'] }),
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.status).toBe('OK');
    expect(sc.results[0].booking_link).toBe(result().bookingengine_link);
    expect(sc.results[0].camping_page).toBe('https://www.yellohvillage.fr/camping/la_marende');
    expect(text(res)).toContain('Campsite page: https://www.yellohvillage.fr/camping/la_marende');
    expect(text(res)).toContain(`Booking: ${result().bookingengine_link}`);
    const search = rest.calls.find((c) => c.path.endsWith('/search/campings'))!;
    expect(Object.fromEntries(search.query)).toEqual({
      startDate: '2027-07-10',
      endDate: '2027-07-17',
      peopleCount: '4',
      accommodation_type: 'rental',
      maxResults: '3',
      user_language: 'fr',
      filters: 'confort_type:F4:4,swimming:SR7',
    });

    // Une ligne de journal par appel d'outil, sans clé ni token (§9.3, acceptation 5).
    const toolLines = logger.lines.filter((l) => l.msg === 'tool_call');
    expect(toolLines.map((l) => l.fields!.tool)).toEqual(['get_search_filters', 'search_campings']);
    expect(toolLines[1]!.fields).toMatchObject({
      endpoint: 'claude',
      status: 'OK',
      results: 1,
      people_count: 4,
    });
    const dump = JSON.stringify(logger.lines);
    expect(dump).not.toContain(KEY_CLAUDE);
    expect(dump).not.toContain('token-1');
    expect(JSON.stringify(res)).not.toContain('token-1');
    await client.close();
  });

  it('cache du catalogue : de-AT puis de → un seul appel REST ; slot distinct', async () => {
    const { handler, rest } = setup();
    const client = await mcpClient(handler);
    await client.callTool({ name: 'get_search_filters', arguments: { user_language: 'de-AT' } });
    await client.callTool({ name: 'get_search_filters', arguments: { user_language: 'de' } });
    expect(rest.count('/search/filters')).toBe(1);
    const slot = await client.callTool({
      name: 'get_search_filters',
      arguments: { accommodation_type: 'slot', user_language: 'fr' },
    });
    expect(text(slot)).toContain('characteristics:C18:18');
    expect(rest.count('/search/filters')).toBe(2);
    await client.close();
  });

  it('ressource et prompt', async () => {
    const { handler } = setup();
    const client = await mcpClient(handler);
    const r = await client.readResource({ uri: 'yelloh://filters/slot/fr' });
    const content = r.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe('application/json');
    expect(JSON.parse(content.text).accommodation_type).toBe('slot');
    const listed = await client.listResources();
    expect(listed.resources.map((x) => x.uri)).toEqual([
      'yelloh://filters/rental/fr',
      'yelloh://filters/slot/fr',
    ]);
    const p = await client.getPrompt({
      name: 'find_a_camping',
      arguments: { dates: '10-17 juillet 2027', people: '4' },
    });
    const msg = (p.messages[0]!.content as { text: string }).text;
    expect(msg).toContain('Dates: 10-17 juillet 2027');
    expect(msg).toContain('Wishes: none given');
    const p2 = await client.getPrompt({ name: 'find_a_camping', arguments: { wishes: 'mer' } });
    expect((p2.messages[0]!.content as { text: string }).text).toContain('Dates: not given yet');
    await client.close();
  });
});

describe('recherche par lieu (§6 bis) : search_geography puis search_campings', () => {
  it('E10 : camping_ids transmis tels quels de search_geography à campingIDs de l’API REST', async () => {
    const { handler, rest, logger } = setup();
    const client = await mcpClient(handler);
    const geo: any = await client.callTool({
      name: 'search_geography',
      arguments: { keywords: ' Bretagne ', user_language: 'fr' },
    });
    expect(geo.isError).toBeFalsy();
    expect(geo.structuredContent).toMatchObject({
      status: 'OK',
      keywords: 'Bretagne',
      match: { name: 'Bretagne', type: 'geographique', camping_count: 8 },
      camping_ids: BRETAGNE_IDS,
    });
    expect(text(geo)).toContain('Place found: Bretagne');
    const call = rest.calls.find((c) => c.path.endsWith('/search/geography'))!;
    expect(Object.fromEntries(call.query)).toEqual({ keywords: 'Bretagne', user_language: 'fr' });

    const search: any = await client.callTool({
      name: 'search_campings',
      arguments: searchArgs({ filters: ['swimming:SR5'], camping_ids: geo.structuredContent.camping_ids }),
    });
    expect(search.isError).toBeFalsy();
    const s = rest.calls.find((c) => c.path.endsWith('/search/campings'))!;
    expect(s.query.get('campingIDs')).toBe(BRETAGNE_IDS.join(','));
    expect(s.query.get('filters')).toBe('swimming:SR5');

    const lines = logger.lines.filter((l) => l.msg === 'tool_call');
    expect(lines.find((l) => l.fields?.tool === 'search_geography')!.fields).toMatchObject({
      keywords: 'Bretagne',
      status: 'OK',
      match: 'Bretagne',
      camping_count: 8,
      cache: 'miss',
    });
    const searchLog = lines.find((l) => l.fields?.tool === 'search_campings')!.fields!;
    expect(searchLog).toMatchObject({ camping_ids_count: 8 });
    expect(JSON.stringify(searchLog)).not.toContain('2409');
  });

  it('cache : deuxième appel servi sans l’API REST ; NO_RESULT mis en cache aussi', async () => {
    const { handler, rest, logger } = setup();
    const client = await mcpClient(handler);
    await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'Bretagne', user_language: 'fr' },
    });
    await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'bretagne', user_language: 'fr-FR' },
    });
    await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'Paris', user_language: 'fr' },
    });
    await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'Paris', user_language: 'fr' },
    });
    expect(rest.count('/search/geography')).toBe(2);
    expect(logger.lines.filter((l) => l.fields?.cache === 'hit')).toHaveLength(2);
  });

  it('E14 : NO_RESULT → isError false, consigne de chercher sur tout le réseau sans prévenir', async () => {
    const { handler } = setup();
    const client = await mcpClient(handler);
    const r: any = await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'Paris', user_language: 'fr' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      status: 'NO_RESULT',
      keywords: 'Paris',
      match: null,
      camping_ids: [],
      other_matches: [],
    });
    expect(text(r)).toContain('still call search_campings without camping_ids');
  });

  it('M11 : validation du schéma et erreurs de l’API REST', async () => {
    const rest = fakeRest({
      geography: () =>
        Response.json({ error: { code: 'UPSTREAM_ERROR', message: 'x', request_id: 'x' } }, { status: 502 }),
    });
    const { handler } = setup(rest);
    const client = await mcpClient(handler);
    const short: any = await client.callTool({
      name: 'search_geography',
      arguments: { keywords: ' ab ', user_language: 'fr' },
    });
    expect(short.isError).toBe(true);
    expect(rest.count('/search/geography')).toBe(0);
    const up: any = await client.callTool({
      name: 'search_geography',
      arguments: { keywords: 'Bretagne', user_language: 'fr' },
    });
    expect(up.isError).toBe(true);
    expect(text(up)).toContain('temporarily unavailable');
  });
});

describe('résultats R2 et R4', () => {
  it('R2 : alternative_dates présentés comme tels ; R4 : NO_AVAILABILITY sans isError', async () => {
    let call = 0;
    const rest = fakeRest({
      search: () =>
        ++call === 1
          ? Response.json(
              searchResponse({
                summary: {
                  available_count: 0,
                  alternative_dates_count: 5,
                  unavailable_count: 0,
                  returned_count: 1,
                },
                results: [
                  result({
                    name: 'Les 3 Vallées',
                    availability_type: 'alternative_dates',
                    alternative_begin_date_availability: '2027-07-25',
                    alternative_end_date_availability: '2027-08-01',
                  }),
                ],
              }),
            )
          : Response.json(
              searchResponse({
                status: 'NO_AVAILABILITY',
                message: 'aucun camping disponible',
                summary: {
                  available_count: 0,
                  alternative_dates_count: 0,
                  unavailable_count: 25,
                  returned_count: 0,
                },
                results: [],
              }),
            ),
    });
    const { handler } = setup(rest);
    const client = await mcpClient(handler);
    const r2 = await client.callTool({
      name: 'search_campings',
      arguments: searchArgs({ people_count: 10 }),
    });
    expect(text(r2)).toContain('None is available on the requested dates');
    expect(text(r2)).toContain('NOT available on requested dates — available 2027-07-25 → 2027-08-01');
    expect((r2.structuredContent as any).results[0].alternative_begin_date).toBe('2027-07-25');
    const r4 = await client.callTool({ name: 'search_campings', arguments: searchArgs() });
    expect(r4.isError).toBeFalsy();
    expect(text(r4)).toBe(
      'No campsite available ("aucun camping disponible"). Suggest other dates or fewer filters.',
    );
    expect((r4.structuredContent as any).status).toBe('NO_AVAILABILITY');
    await client.close();
  });
});

describe('erreurs (§8)', () => {
  it('M7/M10 : validation du schéma', async () => {
    const { handler, rest } = setup();
    const client = await mcpClient(handler);
    const cases: Args[] = [
      searchArgs({ start_date: '10/07/2027' }),
      searchArgs({ people_count: 11 }),
      searchArgs({ max_results: 6 }),
      searchArgs({ user_language: undefined }),
      searchArgs({ user_language: 'français!' }),
      searchArgs({ unknown_prop: 1 }),
    ];
    for (const args of cases) {
      const r = await client.callTool({ name: 'search_campings', arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Invalid arguments|Input validation error/);
    }
    const order = await client.callTool({
      name: 'search_campings',
      arguments: searchArgs({ end_date: '2027-07-10' }),
    });
    expect(text(order)).toBe('Invalid arguments: end_date must be after start_date.');
    const noLang = await client.callTool({ name: 'get_search_filters', arguments: {} });
    expect(noLang.isError).toBe(true);
    expect(rest.count('/search/')).toBe(0);
    await client.close();
  });

  it('UNKNOWN_FILTER : message actionnable et cache du type vidé', async () => {
    const rest = fakeRest({
      search: () =>
        Response.json(
          {
            error: {
              code: 'UNKNOWN_FILTER',
              message: 'x',
              details: { unknown: ['characteristics:C18:18'], accommodation_type: 'rental' },
            },
          },
          { status: 400 },
        ),
    });
    const { handler } = setup(rest);
    const client = await mcpClient(handler);
    await client.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    const r = await client.callTool({
      name: 'search_campings',
      arguments: searchArgs({ filters: ['characteristics:C18:18'] }),
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      'Unknown filter ids for accommodation_type=rental: characteristics:C18:18. Call get_search_filters again and use only the returned ids.',
    );
    await client.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    expect(rest.count('/search/filters')).toBe(2);
    await client.close();
  });

  it('TOKEN_EXPIRED : nouveau token et nouvel essai transparents ; API indisponible → message générique', async () => {
    let n = 0;
    const rest = fakeRest({
      search: () =>
        ++n === 1
          ? Response.json({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }, { status: 401 })
          : Response.json(searchResponse()),
    });
    const { handler } = setup(rest);
    const client = await mcpClient(handler);
    const ok = await client.callTool({ name: 'search_campings', arguments: searchArgs() });
    expect(ok.isError).toBeFalsy();
    expect(rest.count('/auth/session')).toBe(2);
    await client.close();

    const down = setup(fakeRest({ filters: () => new Response('', { status: 502 }) }));
    const c2 = await mcpClient(down.handler);
    const r = await c2.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Yelloh! Village search is temporarily unavailable. Please try again later.');
    expect(text(r)).not.toContain('api.example');
    await c2.close();
  });
});

describe('M8 — routes et protections HTTP (§9.1)', () => {
  it('chaque point d’entrée utilise sa clé ; /mcp générique seulement si configuré', async () => {
    const { handler, rest } = setup();
    const claude = await mcpClient(handler, '/mcp/claude');
    await claude.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    const chatgpt = await mcpClient(handler, '/mcp/chatgpt');
    await chatgpt.callTool({ name: 'get_search_filters', arguments: { user_language: 'en' } });
    const sessions = rest.calls
      .filter((c) => c.path.endsWith('/auth/session'))
      .map((c) => c.headers['x-api-key']);
    expect(sessions).toEqual([KEY_CLAUDE, KEY_CHATGPT]);
    expect((await rpc(handler, '/mcp')).status).toBe(404);
    const withDefault = setup(fakeRest(), { REST_API_KEY_DEFAULT: KEY_DEFAULT });
    const generic = await mcpClient(withDefault.handler, '/mcp');
    await generic.callTool({ name: 'get_search_filters', arguments: { user_language: 'fr' } });
    expect(withDefault.rest.calls[0]!.headers['x-api-key']).toBe(KEY_DEFAULT);
    await Promise.all([claude.close(), chatgpt.close(), generic.close()]);
  });

  it('GET → 405, Origin non autorisé → 403, corps > 64 Ko → 413, JSON invalide → 400, route inconnue → 404', async () => {
    const { handler } = setup();
    const get = await handler(new Request('https://mcp.example/mcp/claude'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    expect(
      (
        await rpc(handler, '/mcp/claude', {
          headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(403);
    const big = await rpc(handler, '/mcp/claude', { body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    const bigHeader = await rpc(handler, '/mcp/claude', {
      headers: { 'Content-Length': '999999', 'Content-Type': 'application/json' },
    });
    expect(bigHeader.status).toBe(413);
    const bad = await rpc(handler, '/mcp/claude', { body: '{pas du json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    expect((await rpc(handler, '/autre')).status).toBe(404);
  });

  it('origine autorisée : préflight 204 et en-tête CORS ; santé ; en-têtes de sécurité', async () => {
    const { handler } = setup(fakeRest(), { MCP_ALLOWED_ORIGINS: 'http://localhost:6274' });
    const pre = await handler(
      new Request('https://mcp.example/mcp/claude', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:6274' },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
    const res = await rpc(handler, '/mcp/claude', {
      headers: {
        Origin: 'http://localhost:6274',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-request-id': 'req-9',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
    expect(res.headers.get('x-request-id')).toBe('req-9');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const health = await handler(new Request('https://mcp.example/health'));
    expect(await health.json()).toEqual({
      status: 'ok',
      name: 'yelloh-camping-search',
      version: '0.1.0-test',
    });
  });

  it('limite par IP → 429 avec Retry-After', async () => {
    const { handler } = setup(fakeRest(), { MCP_RATE_LIMIT_PER_MINUTE: '2' });
    expect((await rpc(handler, '/mcp/claude', {}, '192.0.2.1')).status).toBe(200);
    expect((await rpc(handler, '/mcp/claude', {}, '192.0.2.1')).status).toBe(200);
    const third = await rpc(handler, '/mcp/claude', {}, '192.0.2.1');
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await rpc(handler, '/mcp/claude', {}, '192.0.2.2')).status).toBe(200);
  });
});
