import type { GqlAutocompleteResult } from '../upstream/types.js';

/** Sélection du résultat de searchAutocomplete (§7 bis.2). */

export interface GeographyCandidate {
  index: number;
  name: string;
  type: string | null;
  contentId: number | null;
  ids: number[];
}

const validIds = (raw: readonly unknown[]): number[] => [
  ...new Set(raw.filter((v): v is number => Number.isInteger(v) && (v as number) > 0)),
];

const toCandidate = (x: GqlAutocompleteResult, index: number, ids: number[]): GeographyCandidate => ({
  index,
  name: (x.name ?? '').trim(),
  type: x.type ?? null,
  contentId: x.contentId ?? null,
  ids,
});

/**
 * Étape 4 : un seul résultat, de type camping (CampingSuggestion) → l'identifiant de ce camping seul (P7).
 * Étapes 5-6 : sinon, le résultat qui a le plus d'entrées dans campingIds, le premier en cas d'égalité (P8) ;
 * les résultats de type camping sont alors ignorés (liste vide).
 * Renvoie le résultat retenu et les autres résultats ayant au moins un identifiant, ou null (NO_RESULT).
 */
export function selectGeography(
  results: readonly (GqlAutocompleteResult | null)[] | null,
): { match: GeographyCandidate; others: GeographyCandidate[] } | null {
  const list = results ?? [];
  const only = list.length === 1 ? list[0] : undefined;
  if (only && only.__typename === 'CampingSuggestion') {
    const ids = validIds([only.campingId]);
    return ids.length > 0 ? { match: toCandidate(only, 0, ids), others: [] } : null;
  }
  const candidates: GeographyCandidate[] = [];
  list.forEach((x, index) => {
    if (!x) return;
    const ids = validIds(Array.isArray(x.campingIds) ? x.campingIds : []);
    if (ids.length > 0) candidates.push(toCandidate(x, index, ids));
  });
  let best: GeographyCandidate | undefined;
  for (const c of candidates) if (!best || c.ids.length > best.ids.length) best = c; // « > » strict : le premier gagne
  if (!best) return null;
  return { match: best, others: candidates.filter((c) => c !== best) };
}
