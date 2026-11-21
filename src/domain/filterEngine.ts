import type { GqlCamping } from '../upstream/types.js';
import { KEY_MATCH_CATEGORIES } from './categoryMapping.js';
import type { ResolvedFilter } from './filterResolver.js';

/** Filtrage local (§8.4), reproduction exacte de l'algorithme du front yellohvillage.fr. */

/** Tous les filtres AND passent ET chaque groupe OR (par catégorie) a au moins un filtre qui passe. */
export function matchAll(filters: readonly ResolvedFilter[], pred: (f: ResolvedFilter) => boolean): boolean {
  const andOk = filters.filter((f) => f.operator === 'AND').every(pred);
  const orGroups = new Map<string, ResolvedFilter[]>();
  for (const f of filters) {
    if (f.operator !== 'OR') continue;
    orGroups.set(f.categoryId, [...(orGroups.get(f.categoryId) ?? []), f]);
  }
  return andOk && [...orGroups.values()].every((group) => group.some(pred));
}

export function campingHas(c: GqlCamping, f: ResolvedFilter): boolean {
  if (KEY_MATCH_CATEGORIES.has(f.categoryId)) {
    return (
      c.filterCategories
        ?.find((fc) => fc?.categoryId === f.categoryId)
        ?.filters?.some((x) => x?.key === f.key) ?? false
    );
  }
  return c.allFilters?.includes(f.code) ?? false;
}

export function keepCamping(
  c: GqlCamping,
  filters: readonly ResolvedFilter[],
  type: 'rental' | 'slot',
): boolean {
  const acc = filters.filter((f) => f.level === 'accommodation');
  const camp = filters.filter((f) => f.level === 'camping');
  return (
    matchAll(camp, (f) => campingHas(c, f)) &&
    (acc.length === 0 ||
      (c.accommodations ?? []).some(
        (a) =>
          !!a &&
          a.accommodationType === type &&
          matchAll(acc, (f) => a.filters?.includes(f.webcampId) ?? false),
      ))
  );
}
