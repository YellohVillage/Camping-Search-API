import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBookingEngineLink } from '../../src/domain/bookingLink.js';
import { allInError, classify } from '../../src/domain/classifier.js';
import { buildCatalog, buildFilterId } from '../../src/domain/filterCatalog.js';
import { campingHas, keepCamping, matchAll } from '../../src/domain/filterEngine.js';
import { parseFilterIds, toFilterInputs, validateFilters } from '../../src/domain/filterResolver.js';
import { pickHighestQ, resolveSiteBaseUrl, resolveUserLanguage } from '../../src/domain/language.js';
import { stripHtml, toCampingResult, toRating } from '../../src/domain/mappers.js';
import { cryptoRng, seededRng, shuffle } from '../../src/domain/rng.js';
import { accommodationCapacity, interpretAvailability, utcDatePart } from '../../src/domain/selector.js';
import type { GqlFilterCategory } from '../../src/upstream/types.js';
import { camping, catalogRental, catalogSlot, memoryLogger, rf } from '../helpers/factories.js';

const BASE = 'https://booking.yellohvillage.com/multi-list.php';
const SITES = {
  fr: 'https://www.yellohvillage.fr',
  en: 'https://www.yellohvillage.co.uk',
  de: 'https://www.yellohvillage.de',
  es: 'https://www.yellohvillage.es',
  ca: 'https://www.yellohvillage.es',
  nl: 'https://www.yellohvillage.nl',
  it: 'https://www.yellohvillage.it',
};
const UK = 'https://www.yellohvillage.co.uk';

describe('U1 — bookingLink', () => {
  const p = { campingCode: 49, begin: '2027-05-08', end: '2027-05-15', peopleCount: 1, track: 'chatbot' };
  it('lien identique à l’exemple §10.1 (rental → type=0)', () => {
    expect(buildBookingEngineLink({ ...p, accommodationType: 'rental' }, BASE)).toBe(
      'https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=08%2F05%2F2027&end=15%2F05%2F2027&sites[]=49&nb_pers=1&track=chatbot&type=0',
    );
  });
  it('slot → terminé par &type=1, sans paramètre lang', () => {
    const link = buildBookingEngineLink({ ...p, accommodationType: 'slot' }, BASE);
    expect(link.endsWith('&type=1')).toBe(true);
    expect(link).not.toContain('lang=');
  });
  it('track encodé', () => {
    expect(buildBookingEngineLink({ ...p, track: 'a b&c', accommodationType: 'rental' }, BASE)).toContain(
      'track=a%20b%26c',
    );
  });
});

describe('U2–U7 — filterEngine (§8.4)', () => {
  const SR7 = rf('swimming:SR7', { level: 'camping', operator: 'AND' });
  const N305 = rf('destination:N305', { level: 'camping', operator: 'AND' });
  const N306 = rf('destination:N306', { level: 'camping', operator: 'AND' });
  const F4 = rf('confort_type:F4:4', { level: 'accommodation', operator: 'OR' });
  const F5 = rf('confort_type:F5:-1', { level: 'accommodation', operator: 'OR' });
  const PETS = rf('animals_allowed:pets:pets', { level: 'accommodation', operator: 'AND' });
  const SO104 = rf('sports_activities_on_site:SO104', {
    level: 'camping',
    operator: 'AND',
    key: 'Mini-golf',
  });

  it('U2 : swimming:SR7 seul garde les campings avec SR7 dans allFilters', () => {
    expect(keepCamping(camping(1, { allFilters: ['SR7', 'N305'] }), [SR7], 'rental')).toBe(true);
    expect(keepCamping(camping(2, { allFilters: ['N305'] }), [SR7], 'rental')).toBe(false);
    expect(keepCamping(camping(3, { allFilters: null }), [SR7], 'rental')).toBe(false);
  });

  it('U3 : activités comparées par key dans filterCategories, pas par allFilters', () => {
    const byKey = camping(1, {
      allFilters: [],
      filterCategories: [{ categoryId: 'sports_activities_on_site', filters: [{ key: 'Mini-golf' }] }],
    });
    const byCode = camping(2, { allFilters: ['SO104'], filterCategories: [] });
    const otherCat = camping(3, {
      filterCategories: [{ categoryId: 'sports_activities', filters: [{ key: 'Mini-golf' }] }],
    });
    expect(campingHas(byKey, SO104)).toBe(true);
    expect(campingHas(byCode, SO104)).toBe(false);
    expect(campingHas(otherCat, SO104)).toBe(false);
    expect(campingHas(camping(4, { filterCategories: null }), SO104)).toBe(false);
  });

  it('U4 : OU dans confort_type', () => {
    const premium = camping(1, {
      accommodations: [{ code: 1, accommodationType: 'rental', filters: ['-1'] }],
    });
    const fleurs03 = camping(2, {
      accommodations: [{ code: 2, accommodationType: 'rental', filters: ['0-3'] }],
    });
    expect(keepCamping(premium, [F4, F5], 'rental')).toBe(true);
    expect(keepCamping(fleurs03, [F4, F5], 'rental')).toBe(false);
  });

  it('U5 : 4 fleurs + animaux exigent le même hébergement', () => {
    const split = camping(1, {
      accommodations: [
        { code: 1, accommodationType: 'rental', filters: ['4'] },
        { code: 2, accommodationType: 'rental', filters: ['pets', '-1'] },
      ],
    });
    const same = camping(2, {
      accommodations: [{ code: 3, accommodationType: 'rental', filters: ['pets', '4'] }],
    });
    expect(keepCamping(split, [F4, PETS], 'rental')).toBe(false);
    expect(keepCamping(same, [F4, PETS], 'rental')).toBe(true);
  });

  it('U6 : destination:N305 + destination:N306 → ET (intersection)', () => {
    expect(keepCamping(camping(1, { allFilters: ['N305'] }), [N305, N306], 'rental')).toBe(false);
    expect(keepCamping(camping(2, { allFilters: ['N305', 'N306'] }), [N305, N306], 'rental')).toBe(true);
  });

  it('U7 : hébergements d’un autre type ignorés ; camping sans hébergement compatible écarté', () => {
    const slotOnly = camping(1, {
      accommodations: [{ code: 1, accommodationType: 'slot', filters: ['4'] }, null],
    });
    expect(keepCamping(slotOnly, [F4], 'rental')).toBe(false);
    expect(keepCamping(slotOnly, [F4], 'slot')).toBe(true);
    expect(keepCamping(camping(2, { accommodations: null }), [F4], 'rental')).toBe(false);
    expect(keepCamping(camping(3, { accommodations: null }), [], 'rental')).toBe(true);
  });

  it('matchAll : sans filtre → vrai', () => {
    expect(matchAll([], () => false)).toBe(true);
  });
});

describe('U8, U23, U27 — filterResolver (§8.2)', () => {
  it('U8 : contrôle syntaxique et FilterInput', () => {
    const { parsed, invalid } = parseFilterIds(['confort_type:F4:4', 'swimming:SR7']);
    expect(invalid).toEqual([]);
    expect(parsed[0]).toMatchObject({
      categoryId: 'confort_type',
      code: 'F4',
      webcampId: '4',
      presumedLevel: 'accommodation',
    });
    expect(parsed[1]).toMatchObject({ categoryId: 'swimming', code: 'SR7', presumedLevel: 'camping' });
    expect(parsed[1]).not.toHaveProperty('webcampId');
    expect(toFilterInputs(parsed)).toEqual([{ categoryId: 'confort_type', value: 'F4', webcampId: '4' }]);
  });

  it('U8 : validation après appel (niveau, opérateur, key) et webcampId faux → inconnu', () => {
    const { parsed } = parseFilterIds([
      'confort_type:F4:4',
      'confort_type:F4:999',
      'sports_activities_on_site:SO104',
    ]);
    const { resolved, unknown } = validateFilters(parsed, catalogRental());
    expect(unknown).toEqual(['confort_type:F4:999']);
    expect(resolved[0]).toMatchObject({ level: 'accommodation', operator: 'OR', webcampId: '4', code: 'F4' });
    expect(resolved[1]).toMatchObject({ level: 'camping', operator: 'AND', key: 'Mini-golf' });
  });

  it('FilterInput triés par categoryId puis value', () => {
    const { parsed } = parseFilterIds([
      'confort_type:F5:-1',
      'animals_allowed:pets:pets',
      'confort_type:F4:4',
    ]);
    expect(toFilterInputs(parsed).map((f) => `${f.categoryId}:${f.value}`)).toEqual([
      'animals_allowed:pets',
      'confort_type:F4',
      'confort_type:F5',
    ]);
  });

  it('U23 : filtre propre aux emplacements inconnu en location, validé en emplacement', () => {
    const { parsed } = parseFilterIds(['characteristics:C18:18']);
    expect(validateFilters(parsed, catalogRental()).unknown).toEqual(['characteristics:C18:18']);
    const slot = validateFilters(parsed, catalogSlot());
    expect(slot.unknown).toEqual([]);
    expect(slot.resolved[0]).toMatchObject({ categoryId: 'characteristics', code: 'C18', webcampId: '18' });
  });

  it('U27 : formats invalides rejetés avant tout appel', () => {
    const { invalid } = parseFilterIds(['F4', 'confort_type::4', 'a:b:c:d', 'Confort:F4', 'x:y,z', '']);
    expect(invalid).toEqual(['F4', 'confort_type::4', 'a:b:c:d', 'Confort:F4', 'x:y,z', '']);
  });

  it('U27 : ids bien formés mais incohérents → inconnus après appel', () => {
    const ids = ['confort_type:F4', 'swimming:SR7:x', 'inconnue:X1', 'bathroom:BA1:1', 'swimming:SR999'];
    const { parsed, invalid } = parseFilterIds(ids);
    expect(invalid).toEqual([]);
    expect(validateFilters(parsed, catalogRental()).unknown).toEqual(ids);
  });

  it('catégorie dont le type GraphQL ne concorde pas avec le niveau §6.1 → inconnue', () => {
    const cats: GqlFilterCategory[] = [
      {
        categoryId: 'swimming',
        type: 'accommodation',
        priority: 1,
        filters: [{ id: 'x', title: 't', key: 'k', priority: 1, newFilterId: 'SR7', englishTitle: null }],
      },
    ];
    expect(validateFilters(parseFilterIds(['swimming:SR7']).parsed, cats).unknown).toEqual(['swimming:SR7']);
  });
});

describe('U9 — classifier (§8.5)', () => {
  it('available / flex / autres statuts', () => {
    const statuses = ['available', 'flex', 'closed', 'error', null, 'full', 'flexCapacity', 'zzz'];
    const out = classify(statuses.map((s, i) => camping(i, { availabilityStatus: s })));
    expect(out.available.map((c) => c.campingCode)).toEqual([0]);
    expect(out.alternative.map((c) => c.campingCode)).toEqual([1]);
    expect(out.unavailable.map((c) => c.campingCode)).toEqual([2, 3, 4, 5, 6, 7]);
  });
  it('allInError', () => {
    expect(allInError([camping(1, { availabilityStatus: 'error' }), null])).toBe(true);
    expect(allInError([camping(1, { availabilityStatus: 'error' }), camping(2)])).toBe(false);
    expect(allInError([])).toBe(false);
  });
});

describe('U22 — mappers', () => {
  it('note 89.5721 → 9.0 ; null → null', () => {
    expect(toRating(89.5721)).toBe(9);
    expect(toRating(88.81)).toBe(8.9);
    expect(toRating(null)).toBeNull();
  });
  it('dates alternatives → partie date UTC', () => {
    expect(utcDatePart('2027-07-07T00:00:00.000Z')).toBe('2027-07-07');
  });
  it('stripHtml', () => {
    expect(stripHtml('<p>-10&nbsp;% <b>sur</b> le s&eacute;jour&#33;<br/>Fin</p>')).toBe(
      '-10 % sur le séjour! Fin',
    );
    expect(stripHtml('<p> </p>')).toBeNull();
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml('a &#x41; &amp; b')).toBe('a A & b');
  });
  it('résultat available : dates demandées dans le lien, champs alternatifs nuls', () => {
    const r = toCampingResult(
      { camping: camping(6934, { specialOffer: { description: '<b>Promo</b>' } }), type: 'available' },
      1,
      {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: 4,
        accommodationType: 'rental',
        track: 'chatbot',
        siteBaseUrl: 'https://www.yellohvillage.it',
        bookingEngineUrl: BASE,
      },
    );
    expect(r).toMatchObject({
      rank: 1,
      city: 'Ville 6934',
      rating: 8.5,
      camping_url: 'https://www.yellohvillage.it/camping/camping_6934',
      special_offer: 'Promo',
      alternative_begin_date_availability: null,
      alternative_capacity: null,
    });
    expect(r.bookingengine_link).toContain('begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4');
  });
  it('résultat alternative_dates : dates proposées dans le lien', () => {
    const r = toCampingResult(
      { camping: camping(1531), type: 'alternative_dates', begin: '2027-07-07', end: '2027-07-14' },
      2,
      {
        startDate: '2027-07-10',
        endDate: '2027-07-17',
        peopleCount: 4,
        accommodationType: 'slot',
        track: 'chatbot',
        siteBaseUrl: 'https://www.yellohvillage.fr',
        bookingEngineUrl: BASE,
      },
    );
    expect(r.alternative_begin_date_availability).toBe('2027-07-07');
    expect(r.bookingengine_link).toContain('begin=07%2F07%2F2027&end=14%2F07%2F2027');
    expect(r.bookingengine_link.endsWith('&type=1')).toBe(true);
  });
});

describe('U33 — langue et site de camping_url (§10.3)', () => {
  const base = (u?: string, al?: string) => resolveSiteBaseUrl(u, al, SITES, UK).base;
  it('table de correspondance', () => {
    expect(base('fr')).toBe(SITES.fr);
    expect(base('en-US')).toBe(UK);
    expect(base('de')).toBe(SITES.de);
    expect(base('es')).toBe(SITES.es);
    expect(base('ca-ES')).toBe(SITES.es);
    expect(base('nl-BE')).toBe(SITES.nl);
    expect(base('it')).toBe(SITES.it);
    expect(base('pt')).toBe(UK);
  });
  it('replis et priorités', () => {
    expect(base(undefined, undefined)).toBe(UK);
    expect(base(undefined, 'de-DE,de;q=0.9,en;q=0.5')).toBe(SITES.de);
    expect(base(undefined, 'en;q=0.5, nl-BE;q=0.8')).toBe(SITES.nl);
    expect(base('it', 'de-DE')).toBe(SITES.it);
    expect(base('pas une langue !')).toBe(UK);
    expect(base('x'.repeat(36))).toBe(UK);
    expect(resolveUserLanguage('', 'fr-FR')).toBe('fr');
    expect(pickHighestQ('*, fr;q=0')).toBeUndefined();
    expect(resolveSiteBaseUrl('ca-ES', undefined, SITES, UK)).toEqual({ lang: 'ca', base: SITES.es });
  });
});

describe('U24, U32 — filterCatalog (§6)', () => {
  const expected = (t: string) =>
    JSON.parse(
      readFileSync(new URL(`../../../specs/exemple-reponse-search-filters-${t}.json`, import.meta.url), 'utf8'),
    );

  it('U24 : catalogues identiques aux exemples de specs/ (rental et slot)', () => {
    for (const [t, raw] of [
      ['rental', catalogRental()],
      ['slot', catalogSlot()],
    ] as const) {
      const exp = expected(t);
      expect(buildCatalog(raw, t, 'fr', exp.generated_at)).toEqual(exp);
    }
  });

  it('U32 : ordre par priority (tri stable), destination en tête de location, permutation des priorités', () => {
    const cats = catalogRental().map((c) => ({ ...c }));
    const def = buildCatalog(cats, 'rental', 'fr', 'x');
    expect(def.sections.map((s) => s.section)).toEqual([
      'location',
      'children_club',
      'swimming',
      'comfort',
      'accommodation',
      'services',
      'activities',
      'nearby_activities',
    ]);
    expect(def.sections[0]?.categories[0]?.category_id).toBe('destination');
    const swimming = cats.find((c) => c.categoryId === 'swimming')!;
    swimming.priority = 1;
    expect(buildCatalog(cats, 'rental', 'fr', 'x').sections[0]?.section).toBe('swimming');
  });

  it('catégories non exposées, filtres sans newFilterId et ids non conformes ignorés', () => {
    const logger = memoryLogger();
    const cats: (GqlFilterCategory | null)[] = [
      {
        categoryId: 'bathroom',
        type: 'accommodation',
        priority: 1,
        filters: [{ id: '1', title: 'b', key: 'b', priority: 1, newFilterId: 'BA1', englishTitle: null }],
      },
      {
        categoryId: 'pmr',
        type: 'accommodation',
        priority: 1,
        filters: [
          { id: 'a:b', title: 'bad', key: 'k', priority: 1, newFilterId: 'P1', englishTitle: '' },
          { id: 'x', title: ' ok ', key: 'k', priority: 2, newFilterId: 'P2', englishTitle: '' },
          { id: 'y', title: 'none', key: 'k', priority: 3, newFilterId: null, englishTitle: null },
          null,
        ],
      },
      { categoryId: 'wellness', type: 'camping', priority: 5, filters: [] },
      null,
    ];
    const out = buildCatalog(cats, 'rental', 'fr', 'x', logger);
    expect(out.sections).toEqual([
      {
        section: 'accommodation',
        label: 'Hébergement',
        categories: [
          {
            category_id: 'pmr',
            level: 'accommodation',
            operator: 'AND',
            filters: [{ id: 'pmr:P2:x', label: 'ok', label_en: null }],
          },
        ],
      },
    ]);
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('buildFilterId', () => {
    const f = { id: '4', title: '', key: '', priority: 0, newFilterId: 'F4', englishTitle: null };
    expect(buildFilterId('confort_type', 'accommodation', f)).toBe('confort_type:F4:4');
    expect(buildFilterId('swimming', 'camping', { ...f, newFilterId: 'SR7' })).toBe('swimming:SR7');
  });
});

describe('rng', () => {
  it('seededRng est déterministe ; shuffle ne modifie pas l’entrée', () => {
    const a = shuffle([1, 2, 3, 4, 5], seededRng('graine'));
    const b = shuffle([1, 2, 3, 4, 5], seededRng('graine'));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    const src = [1, 2, 3];
    shuffle(src, seededRng(42));
    expect(src).toEqual([1, 2, 3]);
    const v = cryptoRng.int(10);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(10);
  });
});

describe('interprétation campingAvailability', () => {
  const c = camping(5, {
    accommodations: [
      { code: 1, accommodationType: 'rental', filters: [], technicalInfos: { capacity: { value: '6' } } },
    ],
  });
  it('statuts', () => {
    expect(
      interpretAvailability(c, {
        statusCode: 'flex',
        accommodationId: 1,
        info: { arrivalDate: '2027-07-07T00:00:00.000Z', departureDate: '2027-07-14T00:00:00.000Z' },
      }),
    ).toMatchObject({ type: 'alternative_dates', begin: '2027-07-07', end: '2027-07-14' });
    expect(
      interpretAvailability(c, {
        statusCode: 'flexCapacity',
        accommodationId: 1,
        info: { arrivalDate: '2027-07-10T00:00:00.000Z', departureDate: '2027-07-17T00:00:00.000Z' },
      }),
    ).toMatchObject({ type: 'alternative_capacity', capacity: 6 });
    expect(
      interpretAvailability(c, {
        statusCode: 'available',
        accommodationId: 1,
        info: { arrivalDate: '2027-07-10T00:00:00.000Z', departureDate: '2027-07-17T00:00:00.000Z' },
      }),
    ).toMatchObject({ type: 'available' });
    expect(
      interpretAvailability(c, {
        statusCode: 'full',
        accommodationId: 1,
        info: { arrivalDate: '2027-07-10T00:00:00.000Z', departureDate: '2027-07-17T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(interpretAvailability(c, null)).toBeNull();
  });
  it('capacité introuvable → null', () => {
    expect(accommodationCapacity(c, 999)).toBeNull();
    expect(
      accommodationCapacity(
        camping(6, {
          accommodations: [
            {
              code: 1,
              accommodationType: 'rental',
              filters: [],
              technicalInfos: { capacity: { value: null } },
            },
          ],
        }),
        1,
      ),
    ).toBeNull();
  });
});
