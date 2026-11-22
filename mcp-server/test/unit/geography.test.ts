import { describe, expect, it } from 'vitest';
import { restErrorToTool } from '../../src/errors.js';
import { geographyText, noGeographyResult, toMcpGeographyResult } from '../../src/format/geographyResult.js';
import { searchText, toMcpSearchResult } from '../../src/format/searchResult.js';
import { GeographyCache, normalizeKeywords } from '../../src/rest/geographyCache.js';
import { RestApiError, RestClient } from '../../src/rest/restClient.js';
import { searchGeographyInput } from '../../src/tools/searchGeography.js';
import { searchCampingsInput } from '../../src/tools/searchCampings.js';
import {
  BRETAGNE_IDS,
  fakeRest,
  geographyResponse,
  KEY_CLAUDE,
  searchResponse,
} from '../helpers/fakeRest.js';

const textOf = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe('M12 — geographyResult (§6 bis.4)', () => {
  it('camping_ids recopiés à l’identique ; content_id, locale, meta absents ; other_matches ≤ 5', () => {
    const rest = geographyResponse({
      other_matches: Array.from({ length: 7 }, (_, i) => ({
        name: `Autre ${i}`,
        type: 'poi',
        content_id: i,
        camping_count: 1,
      })),
    });
    const g = toMcpGeographyResult(rest);
    expect(g.camping_ids).toBe(rest.camping_ids);
    expect(g).toMatchObject({
      status: 'OK',
      keywords: 'Bretagne',
      match: { name: 'Bretagne', type: 'geographique', camping_count: 8 },
    });
    expect(g.other_matches).toHaveLength(5);
    const json = JSON.stringify(g);
    for (const k of ['content_id', 'locale', 'meta', 'user_language']) expect(json).not.toContain(k);
  });
  it('texte : lieu trouvé avec la liste des identifiants ; NO_RESULT sans consigne d’avertir l’utilisateur', () => {
    const t = geographyText(toMcpGeographyResult(geographyResponse()));
    expect(t).toContain('Place found: Bretagne (geographique) — 8 campsites.');
    expect(t).toContain(`[${BRETAGNE_IDS.join(',')}]`);
    expect(t).toContain('"Ile de Batz" (poi, 1)');
    const n = geographyText(noGeographyResult('Paris'));
    expect(n).toContain('No place found for "Paris" ("no result")');
    expect(n).toContain('still call search_campings without camping_ids');
    expect(n).toContain('No need to tell the user');
    expect(
      Buffer.byteLength(
        geographyText(
          toMcpGeographyResult(
            geographyResponse({ camping_ids: Array.from({ length: 91 }, (_, i) => 100000 + i) }),
          ),
        ),
      ),
    ).toBeLessThan(2048);
  });
});

describe('M13 — geographyCache', () => {
  it('clé (mots clés normalisés, langue), TTL, taille bornée, TTL 0 = pas de cache', () => {
    let now = 0;
    const c = new GeographyCache<string>(60, 2, () => now);
    c.set('Bretagne', 'fr', 'A');
    expect(c.get('  bretagne ', 'fr-FR')).toBe('A');
    expect(c.get('Bretagne', 'en')).toBeUndefined();
    c.set('Vendée', 'fr', 'B');
    c.set('France', 'fr', 'C');
    expect(c.size).toBe(2);
    expect(c.get('Bretagne', 'fr')).toBeUndefined();
    now = 61_000;
    expect(c.get('France', 'fr')).toBeUndefined();
    const off = new GeographyCache<string>(0, 10);
    off.set('Bretagne', 'fr', 'A');
    expect(off.get('Bretagne', 'fr')).toBeUndefined();
    expect(normalizeKeywords('  Bretagne   sud ')).toBe('Bretagne sud');
  });
});

describe('M11, M14 — schémas, client REST et erreurs', () => {
  it('search_geography : au moins 3 caractères hors espaces, au plus 100, user_language obligatoire', () => {
    const ok = (a: object) => searchGeographyInput.safeParse(a).success;
    expect(ok({ keywords: 'Bretagne', user_language: 'fr' })).toBe(true);
    expect(ok({ keywords: '  ab ', user_language: 'fr' })).toBe(false);
    expect(ok({ keywords: 'ab', user_language: 'fr' })).toBe(false);
    expect(ok({ keywords: 'x'.repeat(101), user_language: 'fr' })).toBe(false);
    expect(ok({ keywords: 'Bretagne' })).toBe(false);
    expect(ok({ keywords: 'Bretagne', user_language: 'fr', extra: 1 })).toBe(false);
  });
  it('search_campings : camping_ids entiers ≥ 1, au plus 200, vide par défaut', () => {
    const schema = searchCampingsInput(5);
    const base = { start_date: '2027-07-10', end_date: '2027-07-17', people_count: 4, user_language: 'fr' };
    expect(schema.parse(base).camping_ids).toEqual([]);
    expect(schema.safeParse({ ...base, camping_ids: [0] }).success).toBe(false);
    expect(schema.safeParse({ ...base, camping_ids: [1.5] }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, camping_ids: Array.from({ length: 201 }, (_, i) => i + 1) }).success,
    ).toBe(false);
  });
  it('restClient : keywords et user_language transmis ; campingIDs dédoublonnés, absents si vide ; 404 NO_RESULT levé', async () => {
    const rest = fakeRest();
    const client = new RestClient({
      baseUrl: 'https://api.example/v1',
      apiKey: KEY_CLAUDE,
      timeoutMs: 1000,
      tokenRenewBeforeSeconds: 300,
      fetchImpl: rest.fetchImpl,
    });
    await client.searchGeography('Bretagne', 'fr');
    const g = rest.calls.at(-1)!;
    expect(g.path).toBe('/v1/search/geography');
    expect(Object.fromEntries(g.query)).toEqual({ keywords: 'Bretagne', user_language: 'fr' });
    await expect(client.searchGeography('Paris', 'fr')).rejects.toMatchObject({
      status: 404,
      code: 'NO_RESULT',
    });

    const p = {
      startDate: '2027-07-10',
      endDate: '2027-07-17',
      peopleCount: 4,
      accommodationType: 'rental' as const,
      filters: [],
      maxResults: 3,
      userLanguage: 'fr',
    };
    await client.searchCampings({ ...p, campingIds: [2409, 2495, 2409] });
    expect(rest.calls.at(-1)!.query.get('campingIDs')).toBe('2409,2495');
    await client.searchCampings({ ...p, campingIds: [] });
    expect(rest.calls.at(-1)!.query.has('campingIDs')).toBe(false);
  });
  it('erreurs : INVALID_KEYWORDS et INVALID_CAMPING_IDS actionnables', () => {
    const k = restErrorToTool(new RestApiError(400, 'INVALID_KEYWORDS', 'x'));
    expect(k.isError).toBe(true);
    expect(textOf(k)).toBe('The place keywords must be 3 to 100 characters long. Use the place name only.');
    const c = restErrorToTool(new RestApiError(400, 'INVALID_CAMPING_IDS', 'x', { invalid: ['abc'] }));
    expect(textOf(c)).toBe(
      'Invalid camping_ids: abc. Pass the camping_ids returned by search_geography, unchanged.',
    );
  });
  it('searchResult : camping_ids_count, phrase sur la zone si NO_AVAILABILITY restreint', () => {
    const r = toMcpSearchResult(
      searchResponse({
        status: 'NO_AVAILABILITY',
        results: [],
        search: { ...searchResponse().search, camping_ids: BRETAGNE_IDS },
      }),
    );
    expect(r.search.camping_ids_count).toBe(8);
    expect(searchText(r)).toContain('restricted to the place found by search_geography');
    const all = toMcpSearchResult(searchResponse({ status: 'NO_AVAILABILITY', results: [] }));
    expect(all.search.camping_ids_count).toBe(0);
    expect(searchText(all)).not.toContain('search_geography');
  });
});
