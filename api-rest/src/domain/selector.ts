import type { GqlCamping, GqlCampingAvailability } from '../upstream/types.js';
import { shuffle, type Rng } from './rng.js';

export type AvailabilityType = 'available' | 'alternative_dates' | 'alternative_capacity';
export type BusinessStatus = 'OK' | 'PARTIAL' | 'NO_AVAILABILITY';

export interface Selected {
  camping: GqlCamping;
  type: AvailabilityType;
  /** Dates proposées (YYYY-MM-DD), renseignées pour les résultats issus de campingAvailability. */
  begin?: string;
  end?: string;
  capacity?: number | null;
}

export interface SelectionResult {
  results: Selected[];
  status: BusinessStatus;
  availabilityCalls: number;
}

/** Appel campingAvailability pour un camping ; doit rejeter en cas d'erreur ou de timeout. */
export type AvailabilityFetcher = (camping: GqlCamping) => Promise<GqlCampingAvailability | null>;

export interface SelectorOptions {
  maxResults: number;
  maxAvailabilityCalls: number;
  concurrency: number;
  rng: Rng;
}

const ORDER: Record<AvailabilityType, number> = {
  available: 0,
  alternative_dates: 1,
  alternative_capacity: 2,
};

/** Partie date UTC d'un instant ISO (§8.6). */
export const utcDatePart = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Capacité de l'hébergement proposé (§8.6). */
export function accommodationCapacity(c: GqlCamping, accommodationId: number): number | null {
  const acc = (c.accommodations ?? []).find((a) => a?.code === accommodationId);
  const raw = acc?.technicalInfos?.capacity?.value;
  const n = raw === null || raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Exécute les tâches avec une concurrence bornée ; renvoie les résultats dans l'ordre d'entrée. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Interprète une réponse campingAvailability (§8.6) ; null si le camping doit être écarté. */
export function interpretAvailability(
  c: GqlCamping,
  r: GqlCampingAvailability | null | undefined,
): Selected | null {
  // Réponse exploitable seulement si statusCode, accommodationId et info sont tous présents (comme le front).
  if (!r || !r.statusCode || r.accommodationId === null || r.accommodationId === undefined || !r.info)
    return null;
  const begin = utcDatePart(r.info.arrivalDate);
  const end = utcDatePart(r.info.departureDate);
  switch (r.statusCode) {
    case 'flex':
      return { camping: c, type: 'alternative_dates', begin, end };
    case 'flexCapacity':
      return {
        camping: c,
        type: 'alternative_capacity',
        begin,
        end,
        capacity: accommodationCapacity(c, r.accommodationId),
      };
    case 'available':
      return { camping: c, type: 'available' };
    default:
      return null;
  }
}

/** Sélection aléatoire et complétion (§8.6, règles R1 à R4). */
export async function selectCampings(
  available: readonly GqlCamping[],
  alternative: readonly GqlCamping[],
  fetchAvailability: AvailabilityFetcher,
  opts: SelectorOptions,
): Promise<SelectionResult> {
  const n = opts.maxResults;

  // R1 : assez de disponibles → tirage de N, aucun appel campingAvailability.
  if (available.length >= n) {
    const results = shuffle(available, opts.rng)
      .slice(0, n)
      .map((camping): Selected => ({ camping, type: 'available' }));
    return { results, status: 'OK', availabilityCalls: 0 };
  }

  // R2 / R3 : tous les disponibles, complétés par des campings « autres dates » vérifiés.
  const results: Selected[] = shuffle(available, opts.rng).map((camping) => ({ camping, type: 'available' }));
  const pool = shuffle(alternative, opts.rng);
  let calls = 0;
  while (results.length < n && pool.length > 0 && calls < opts.maxAvailabilityCalls) {
    const batchSize = Math.min(n - results.length, pool.length, opts.maxAvailabilityCalls - calls);
    const batch = pool.splice(0, batchSize);
    calls += batch.length;
    const answers = await mapLimit(batch, opts.concurrency, async (c) => {
      try {
        return await fetchAvailability(c);
      } catch {
        return null; // erreur GraphQL ou timeout : camping écarté
      }
    });
    batch.forEach((c, i) => {
      const sel = interpretAvailability(c, answers[i]);
      if (sel && results.length < n) results.push(sel);
    });
  }

  // Ordre final : available, puis alternative_dates, puis alternative_capacity (tri stable).
  const ordered = results
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => ORDER[a.r.type] - ORDER[b.r.type] || a.idx - b.idx)
    .map(({ r }) => r);

  const status: BusinessStatus =
    ordered.length === 0 ? 'NO_AVAILABILITY' : ordered.length < n ? 'PARTIAL' : 'OK';
  return { results: ordered, status, availabilityCalls: calls };
}
