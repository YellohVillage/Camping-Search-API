import { z } from 'zod';
import { badRequest } from '../http/errors.js';

/** Validation des paramètres (§6 et §7.1). Les codes d'erreur suivent le §11. */

type Query = Record<string, string | string[]>;

const first = (q: Query, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = q[n];
    if (v === undefined) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
};

const all = (q: Query, name: string): string[] => {
  const v = q[name];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
};

export const ACCOMMODATION_TYPES = ['rental', 'slot'] as const;
export type AccommodationType = (typeof ACCOMMODATION_TYPES)[number];

const accommodationTypeSchema = z.enum(ACCOMMODATION_TYPES);
const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

/** Date YYYY-MM-DD valide (calendrier), ou null. */
export function parseIsoDate(s: string): Date | null {
  if (!isoDateRe.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

/** « Aujourd'hui » dans le fuseau métier, au format YYYY-MM-DD. */
export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface FiltersQuery {
  accommodationType: AccommodationType;
  userLanguage?: string;
}

export function parseFiltersQuery(q: Query): FiltersQuery {
  const raw = first(q, 'accommodation_type', 'accommodationType');
  if (raw === undefined || raw === '') {
    throw badRequest('MISSING_PARAMETER', 'Paramètre obligatoire manquant : accommodation_type.', {
      missing: ['accommodation_type'],
    });
  }
  const parsed = accommodationTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('INVALID_ACCOMMODATION_TYPE', 'accommodation_type doit valoir rental ou slot.', {
      accommodation_type: raw,
    });
  }
  const userLanguage = first(q, 'user_language');
  return { accommodationType: parsed.data, ...(userLanguage !== undefined ? { userLanguage } : {}) };
}

export interface SearchQuery {
  startDate: string;
  endDate: string;
  nights: number;
  peopleCount: number;
  accommodationType: AccommodationType;
  filters: string[];
  maxResults: number;
  userLanguage?: string;
}

export interface SearchLimits {
  maxPeople: number;
  maxStayNights: number;
  defaultMaxResults: number;
  maxResultsLimit: number;
  tzBusiness: string;
  now: Date;
}

const MAX_FILTERS = 30;

export function parseSearchQuery(q: Query, limits: SearchLimits): SearchQuery {
  const startRaw = first(q, 'startDate', 'start_date');
  const endRaw = first(q, 'endDate', 'end_date');
  const peopleRaw = first(q, 'peopleCount', 'people_count');

  const missing = [
    ...(startRaw ? [] : ['startDate']),
    ...(endRaw ? [] : ['endDate']),
    ...(peopleRaw ? [] : ['peopleCount']),
  ];
  if (missing.length > 0) {
    throw badRequest(
      'MISSING_PARAMETER',
      `Paramètre(s) obligatoire(s) manquant(s) : ${missing.join(', ')}.`,
      {
        missing,
      },
    );
  }
  const startDate = startRaw as string;
  const endDate = endRaw as string;

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) {
    throw badRequest('INVALID_DATES', 'Les dates doivent être au format YYYY-MM-DD.', { startDate, endDate });
  }
  if (startDate < todayIn(limits.tzBusiness, limits.now)) {
    throw badRequest('INVALID_DATES', 'startDate ne doit pas être dans le passé.', { startDate });
  }
  if (end.getTime() <= start.getTime()) {
    throw badRequest('INVALID_DATES', 'endDate doit être postérieure à startDate.', { startDate, endDate });
  }
  const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (nights > limits.maxStayNights) {
    throw badRequest('INVALID_DATES', `Le séjour ne doit pas dépasser ${limits.maxStayNights} nuits.`, {
      startDate,
      endDate,
      nights,
    });
  }

  const people = Number(peopleRaw);
  if (!/^\d+$/.test(peopleRaw as string) || people < 1 || people > limits.maxPeople) {
    throw badRequest(
      'INVALID_PEOPLE_COUNT',
      `peopleCount doit être un entier entre 1 et ${limits.maxPeople}.`,
      { peopleCount: peopleRaw },
    );
  }

  const typeRaw = first(q, 'accommodationType', 'accommodation_type') ?? 'rental';
  const type = accommodationTypeSchema.safeParse(typeRaw);
  if (!type.success) {
    throw badRequest('INVALID_ACCOMMODATION_TYPE', 'accommodationType doit valoir rental ou slot.', {
      accommodationType: typeRaw,
    });
  }

  const maxRaw = first(q, 'maxResults', 'max_results');
  let maxResults = limits.defaultMaxResults;
  if (maxRaw !== undefined) {
    const n = Number(maxRaw);
    if (!/^\d+$/.test(maxRaw) || n < 1 || n > limits.maxResultsLimit) {
      throw badRequest(
        'INVALID_MAX_RESULTS',
        `maxResults doit être un entier entre 1 et ${limits.maxResultsLimit}.`,
        {
          maxResults: maxRaw,
        },
      );
    }
    maxResults = n;
  }

  const filters = [
    ...new Set(
      all(q, 'filters')
        .flatMap((v) => v.split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (filters.length > MAX_FILTERS) {
    throw badRequest('TOO_MANY_FILTERS', `Au plus ${MAX_FILTERS} filtres sont acceptés.`, {
      count: filters.length,
    });
  }

  const userLanguage = first(q, 'user_language');
  return {
    startDate,
    endDate,
    nights,
    peopleCount: people,
    accommodationType: type.data,
    filters,
    maxResults,
    ...(userLanguage !== undefined ? { userLanguage } : {}),
  };
}
