import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createGqlClient, toGqlDate } from '../src/upstream/gqlClient.js';
import type { GqlSearchCampings, SearchVariables } from '../src/upstream/types.js';

/**
 * npm run fixtures:record — enregistre de vraies réponses GraphQL (réseau requis, hors CI) dans test/fixtures (§16.3).
 * Les recherches sont réduites aux campings utiles et à un sous-ensemble d'hébergements pour limiter la taille.
 */
const cfg = loadConfig({
  ...process.env,
  API_CLIENTS:
    process.env.API_CLIENTS ??
    JSON.stringify([{ client_id: 'fixtures', key_sha256: '0'.repeat(64), track: 'x', enabled: true }]),
  SESSION_SIGNING_SECRET: process.env.SESSION_SIGNING_SECRET ?? Buffer.alloc(32, 1).toString('base64'),
});
const gql = createGqlClient(cfg.gql);
const out = (name: string, data: unknown) =>
  writeFileSync(`test/fixtures/${name}`, JSON.stringify(data) + '\n');

const base = (start: string, end: string, people: number): SearchVariables => ({
  accommodationType: 'rental',
  peopleCount: people,
  campingContentIds: [],
  startDate: toGqlDate(start),
  endDate: toGqlDate(end),
  filters: [],
});

const slim = (s: GqlSearchCampings): GqlSearchCampings => ({
  filterCategories: s.filterCategories,
  campings: s.campings.map((c) => c && { ...c, accommodations: (c.accommodations ?? []).slice(0, 40) }),
});

const onlyGeography = process.argv.includes('--geography');
if (!onlyGeography) {
  for (const t of ['rental', 'slot'] as const) {
    out(
      `catalog-${t}.json`,
      await gql.catalog({ accommodationType: t, peopleCount: 1, campingContentIds: [], filters: [] }, 'fr'),
    );
  }
  out(
    'search-jul-4p-nofilter.json',
    slim(await gql.searchCampings(base('2027-07-10', '2027-07-17', 4), 'fr')),
  );
  out(
    'search-jul-4p-F5.json',
    slim(
      await gql.searchCampings(
        {
          ...base('2027-07-10', '2027-07-17', 4),
          filters: [{ categoryId: 'confort_type', value: 'F5', webcampId: '-1' }],
        },
        'fr',
      ),
    ),
  );
  out('search-apr-4p.json', slim(await gql.searchCampings(base('2027-04-03', '2027-04-10', 4), 'fr')));
  const av = {} as Record<string, unknown>;
  for (const code of [1531, 23, 76]) {
    av[code] = await gql.campingAvailability(
      {
        campingCode: code,
        accommodationType: 'rental',
        peopleCount: 4,
        startDate: toGqlDate('2027-07-10'),
        endDate: toGqlDate('2027-07-17'),
        filters: [],
        fidelityId: null,
      },
      'fr',
    );
  }
  out('availability-jul-4p.json', av);
}

// Recherche géographique (§7 bis, §8.9) : `npm run fixtures:record -- --geography` n'enregistre que ces fixtures.
const autocompleteFixtures: Record<string, string> = {
  france: 'France',
  bretagne: 'Bretagne',
  vendee: 'Vendée',
  'la-marende': 'La Marende',
  'les-pins': 'Les Pins',
  lac: 'lac',
  mediterranee: 'Méditerranée',
  empty: 'zzzzqqq',
};
let bretagneIds: number[] = [];
for (const [name, text] of Object.entries(autocompleteFixtures)) {
  const results = await gql.autocomplete(text, 'fr');
  out(`autocomplete-${name}.json`, results);
  if (name === 'bretagne') bretagneIds = results.find((r) => r?.name === 'Bretagne')?.campingIds as number[];
}
out(
  'search-jul-4p-bretagne.json',
  slim(
    await gql.searchCampings(
      { ...base('2027-07-10', '2027-07-17', 4), campingContentIds: bretagneIds },
      'fr',
    ),
  ),
);
process.stdout.write('Fixtures enregistrées dans test/fixtures/.\n');
