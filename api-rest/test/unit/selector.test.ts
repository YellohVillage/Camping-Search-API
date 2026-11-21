import { describe, expect, it, vi } from 'vitest';
import { seededRng } from '../../src/domain/rng.js';
import { selectCampings, type AvailabilityFetcher } from '../../src/domain/selector.js';
import type { GqlCampingAvailability } from '../../src/upstream/types.js';
import { availability, camping } from '../helpers/factories.js';

const opts = (over = {}) => ({
  maxResults: 3,
  maxAvailabilityCalls: 8,
  concurrency: 4,
  rng: seededRng(1),
  ...over,
});
const avail = (n: number) => Array.from({ length: n }, (_, i) => camping(100 + i));
const flex = (n: number) =>
  Array.from({ length: n }, (_, i) => camping(200 + i, { availabilityStatus: 'flex' }));

/** Fetcher qui répond selon une table campingCode → réponse (ou erreur). */
const fetcherFrom = (
  table: Record<number, GqlCampingAvailability | Error | null>,
  fallback = availability('flex'),
) =>
  vi.fn<AvailabilityFetcher>(async (c) => {
    const v = c.campingCode in table ? table[c.campingCode] : fallback;
    if (v instanceof Error) throw v;
    return v ?? null;
  });

describe('selector (§8.6)', () => {
  it('U10 — R1 : 10 disponibles, N=3 → 3 distincts, tous available, aucun appel', async () => {
    const f = fetcherFrom({});
    const r = await selectCampings(avail(10), flex(5), f, opts());
    expect(r.status).toBe('OK');
    expect(r.results).toHaveLength(3);
    expect(new Set(r.results.map((s) => s.camping.campingCode)).size).toBe(3);
    expect(r.results.every((s) => s.type === 'available')).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect(r.availabilityCalls).toBe(0);
  });

  it('R1 : tirages différents selon la graine (hasard)', async () => {
    const draws = new Set<string>();
    for (let s = 0; s < 10; s++) {
      const r = await selectCampings(avail(30), [], fetcherFrom({}), opts({ rng: seededRng(s) }));
      draws.add(r.results.map((x) => x.camping.campingCode).join(','));
    }
    expect(draws.size).toBeGreaterThan(1);
  });

  it('U11 — R2 : 1 disponible + 5 flex → 1 available + 2 alternative_dates, exactement 2 appels', async () => {
    const f = fetcherFrom({});
    const r = await selectCampings(avail(1), flex(5), f, opts());
    expect(r.status).toBe('OK');
    expect(r.results.map((s) => s.type)).toEqual(['available', 'alternative_dates', 'alternative_dates']);
    expect(r.results[1]).toMatchObject({ begin: '2027-07-07', end: '2027-07-14' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.availabilityCalls).toBe(2);
  });

  it('U12 — remplacement : un candidat unavailable est écarté et un autre est appelé', async () => {
    const pool = flex(4);
    const f = vi.fn<AvailabilityFetcher>(async () => availability('flex'));
    f.mockImplementationOnce(async () => availability('unavailable'));
    const r = await selectCampings(avail(1), pool, f, opts());
    expect(r.results).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(3);
    const called = f.mock.calls.map((c) => c[0].campingCode);
    expect(new Set(called).size).toBe(3);
  });

  it('U13 — flexCapacity → alternative_capacity avec la capacité de l’hébergement proposé', async () => {
    const c = camping(300, {
      availabilityStatus: 'flex',
      accommodations: [
        { code: 77, accommodationType: 'rental', filters: [], technicalInfos: { capacity: { value: '6' } } },
      ],
    });
    const r = await selectCampings(
      [],
      [c],
      fetcherFrom({ 300: availability('flexCapacity', { accommodationId: 77 }) }),
      opts({ maxResults: 1 }),
    );
    expect(r.results[0]).toMatchObject({ type: 'alternative_capacity', capacity: 6 });
  });

  it('U14 — borne MAX_AVAILABILITY_CALLS respectée', async () => {
    const f = fetcherFrom({}, availability('unavailable'));
    const r = await selectCampings([], flex(20), f, opts({ maxAvailabilityCalls: 5 }));
    expect(f).toHaveBeenCalledTimes(5);
    expect(r.availabilityCalls).toBe(5);
    expect(r.status).toBe('NO_AVAILABILITY');
  });

  it('U15 — R3 : 1 disponible + 1 flex valide, N=3 → 2 résultats, PARTIAL', async () => {
    const r = await selectCampings(avail(1), flex(1), fetcherFrom({}), opts());
    expect(r.status).toBe('PARTIAL');
    expect(r.results).toHaveLength(2);
  });

  it('U16 — R4 : uniquement des fermés (aucun disponible ni flex) → NO_AVAILABILITY', async () => {
    const f = fetcherFrom({});
    const r = await selectCampings([], [], f, opts());
    expect(r.status).toBe('NO_AVAILABILITY');
    expect(r.results).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('U17 — R4 bis : tous les flex répondent unavailable → NO_AVAILABILITY', async () => {
    const r = await selectCampings([], flex(3), fetcherFrom({}, availability('unavailable')), opts());
    expect(r.status).toBe('NO_AVAILABILITY');
    expect(r.availabilityCalls).toBe(3);
  });

  it('U18 — N=1, 2 et 4 respectés', async () => {
    for (const n of [1, 2, 4]) {
      const r = await selectCampings(avail(10), [], fetcherFrom({}), opts({ maxResults: n }));
      expect(r.results).toHaveLength(n);
      const r2 = await selectCampings(avail(0), flex(10), fetcherFrom({}), opts({ maxResults: n }));
      expect(r2.results).toHaveLength(n);
    }
  });

  it('U30 — flex avec info mais accommodationId null → écarté et remplacé', async () => {
    const pool = flex(2);
    const f = vi.fn<AvailabilityFetcher>(async () => availability('flex'));
    f.mockImplementationOnce(async () => availability('flex', { accommodationId: null }));
    const r = await selectCampings([], pool, f, opts({ maxResults: 1 }));
    expect(r.results).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('erreur ou timeout de campingAvailability → camping écarté, pas d’exception', async () => {
    const pool = flex(2);
    const f = vi.fn<AvailabilityFetcher>(async () => availability('flex'));
    f.mockImplementationOnce(async () => {
      throw new Error('timeout');
    });
    const r = await selectCampings([], pool, f, opts({ maxResults: 1 }));
    expect(r.results).toHaveLength(1);
  });

  it('U31 — ordre final : available, puis alternative_dates, puis alternative_capacity', async () => {
    const pool = [
      camping(401, { availabilityStatus: 'flex' }),
      camping(402, { availabilityStatus: 'flex' }),
      camping(403, { availabilityStatus: 'flex' }),
    ];
    const table = {
      401: availability('flexCapacity'),
      402: availability('available'),
      403: availability('flex'),
    };
    const r = await selectCampings(
      [],
      pool,
      fetcherFrom(table),
      opts({ maxResults: 3, rng: { int: () => 0 } }),
    );
    expect(r.results.map((s) => s.type)).toEqual(['available', 'alternative_dates', 'alternative_capacity']);
  });

  it('concurrence bornée par AVAILABILITY_CONCURRENCY', async () => {
    let inFlight = 0;
    let max = 0;
    const f = vi.fn<AvailabilityFetcher>(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return availability('flex');
    });
    await selectCampings([], flex(10), f, opts({ maxResults: 6, concurrency: 2 }));
    expect(max).toBeLessThanOrEqual(2);
  });
});
