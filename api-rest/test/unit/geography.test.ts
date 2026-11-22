import { describe, expect, it } from 'vitest';
import { selectGeography } from '../../src/domain/geography.js';
import { ApiError } from '../../src/http/errors.js';
import type { GqlAutocompleteResult } from '../../src/upstream/types.js';
import { parseCampingIds, parseGeographyQuery, parseSearchQuery } from '../../src/validation/schemas.js';
import { fixture } from '../helpers/factories.js';

const ac = (name: string) => fixture<GqlAutocompleteResult[]>(`autocomplete-${name}.json`);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return `${e.status} ${e.code}`;
    throw e;
  }
  return 'OK';
}

describe('U36 — sélection du résultat de searchAutocomplete (§7 bis.2)', () => {
  it('France : 5 résultats (91, 5, 38, 1, 4) → le premier, 91 identifiants', () => {
    const s = selectGeography(ac('france'))!;
    expect(s.match).toMatchObject({ index: 0, name: 'France', type: 'geographique', contentId: 434 });
    expect(s.match.ids).toHaveLength(91);
    expect(s.others.map((o) => o.ids.length)).toEqual([5, 38, 1, 4]);
  });

  it('égalité de taille (Vendée : 5, 3, 5, 5, 5, 5) → le premier', () => {
    const s = selectGeography(ac('vendee'))!;
    expect(s.match.index).toBe(0);
    expect(s.match.name).toBe('Vendée');
    expect(s.match.ids).toHaveLength(5);
  });

  it('P7 : un seul résultat de type camping (La Marende) → son seul identifiant', () => {
    const s = selectGeography(ac('la-marende'))!;
    expect(s.match).toMatchObject({ name: 'La Marende', type: 'camping', ids: [58552] });
    expect(s.others).toEqual([]);
  });

  it('P7 : campings parmi d’autres résultats (Les Pins) → ignorés, la ville est retenue', () => {
    const s = selectGeography(ac('les-pins'))!;
    expect(s.match).toMatchObject({ index: 2, name: 'Saint-Brevin-les-Pins', type: 'geographique' });
    expect(s.match.ids).toHaveLength(2);
    expect(s.others.map((o) => o.name)).toEqual(['Offre Découverte Surf Les Grands Pins']);
  });

  it('P7 : uniquement des campings (lac) → aucun résultat', () => {
    expect(ac('lac').length).toBeGreaterThan(1);
    expect(selectGeography(ac('lac'))).toBeNull();
  });

  it('P8 : le plus d’entrées, quel que soit le type (Méditerranée → article poi)', () => {
    expect(selectGeography(ac('mediterranee'))!.match).toMatchObject({ type: 'poi', index: 0 });
  });

  it('doublons, valeurs invalides, résultats nuls ou vides', () => {
    const r: (GqlAutocompleteResult | null)[] = [
      null,
      {
        __typename: 'Suggestion',
        contentId: 1,
        name: ' A ',
        type: 'poi',
        campingIds: [3, 3, 0, -1, null, 4],
      },
      { __typename: 'Suggestion', contentId: 2, name: 'B', type: 'poi', campingIds: null },
      { __typename: 'Futur', contentId: 3, name: 'C', type: 'x', campingIds: [9] },
    ];
    const s = selectGeography(r)!;
    expect(s.match).toMatchObject({ name: 'A', ids: [3, 4] });
    expect(s.others.map((o) => o.name)).toEqual(['C']);
    expect(selectGeography(ac('empty'))).toBeNull();
    expect(selectGeography(null)).toBeNull();
    expect(
      selectGeography([
        { __typename: 'CampingSuggestion', contentId: 1, name: 'X', type: 'camping', campingId: null },
      ]),
    ).toBeNull();
  });
});

describe('U37 — paramètres de /v1/search/geography (§7 bis.1)', () => {
  it('normalisation, alias q et langue', () => {
    expect(parseGeographyQuery({ keywords: '  Bretagne   sud ' }, 3)).toEqual({ keywords: 'Bretagne sud' });
    expect(parseGeographyQuery({ q: 'Aÿr', user_language: 'fr' }, 3)).toEqual({
      keywords: 'Aÿr',
      userLanguage: 'fr',
    });
  });
  it('erreurs sans appel GraphQL', () => {
    expect(code(() => parseGeographyQuery({}, 3))).toBe('400 MISSING_PARAMETER');
    expect(code(() => parseGeographyQuery({ keywords: 'ab' }, 3))).toBe('400 INVALID_KEYWORDS');
    expect(code(() => parseGeographyQuery({ keywords: '  a  ' }, 3))).toBe('400 INVALID_KEYWORDS');
    expect(code(() => parseGeographyQuery({ keywords: '' }, 3))).toBe('400 INVALID_KEYWORDS');
    expect(code(() => parseGeographyQuery({ keywords: 'x'.repeat(101) }, 3))).toBe('400 INVALID_KEYWORDS');
    expect(code(() => parseGeographyQuery({ keywords: 'x'.repeat(100) }, 3))).toBe('OK');
    try {
      parseGeographyQuery({ keywords: 'ab' }, 3);
    } catch (e) {
      expect((e as ApiError).details).toEqual({ min_length: 3, max_length: 100, length: 2 });
    }
  });
});

describe('U39 — paramètre campingIDs (§7.1)', () => {
  it('liste, paramètre répété, alias et dédoublonnage dans l’ordre', () => {
    expect(parseCampingIds({ campingIDs: '2409, 2495,2409' }, 200)).toEqual([2409, 2495]);
    expect(parseCampingIds({ campingIDs: ['2409', '2495'] }, 200)).toEqual([2409, 2495]);
    expect(parseCampingIds({ campingIds: '7' }, 200)).toEqual([7]);
    expect(parseCampingIds({ camping_ids: '8' }, 200)).toEqual([8]);
    expect(parseCampingIds({}, 200)).toEqual([]);
  });
  it('valeurs invalides et trop d’identifiants → 400 INVALID_CAMPING_IDS', () => {
    for (const v of ['abc', '0', '-5', '1.5', '1234567890', '2409,x'])
      expect(
        code(() => parseCampingIds({ campingIDs: v }, 200)),
        v,
      ).toBe('400 INVALID_CAMPING_IDS');
    const many = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
    expect(code(() => parseCampingIds({ campingIDs: many }, 200))).toBe('400 INVALID_CAMPING_IDS');
    expect(code(() => parseCampingIds({ campingIDs: many }, 201))).toBe('OK');
  });
  it('intégré à la validation de la recherche', () => {
    const q = parseSearchQuery(
      { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4', campingIDs: '2409,2495' },
      {
        maxPeople: 10,
        maxStayNights: 90,
        defaultMaxResults: 3,
        maxResultsLimit: 10,
        tzBusiness: 'Europe/Paris',
        now: new Date('2026-11-21T12:00:00Z'),
        maxCampingIds: 200,
      },
    );
    expect(q.campingIds).toEqual([2409, 2495]);
  });
});
