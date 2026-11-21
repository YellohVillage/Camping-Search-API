import type { GqlFilterCategory, GqlFilterInput } from '../upstream/types.js';
import { categoryInfo, type Level, type Operator } from './categoryMapping.js';

/**
 * Résolution des filtres (§8.2).
 * Principe : aucune liste d'ids de filtres dans le code. Avant l'appel GraphQL, seul un contrôle de forme
 * est fait ; la cohérence est vérifiée après, avec le catalogue renvoyé par searchCampings.
 */

const FILTER_ID_RE = /^([a-z_]+):([^:,]+)(?::([^:,]+))?$/;

/** Filtre après contrôle syntaxique (§8.2 a). */
export interface ParsedFilter {
  id: string;
  categoryId: string;
  code: string;
  /** Présent si l'id a 3 parties (filtre présumé hébergement). */
  webcampId?: string;
  presumedLevel: Level;
}

/** Filtre après validation de cohérence (§8.2 b). */
export interface ResolvedFilter {
  id: string;
  code: string;
  webcampId: string;
  key: string;
  categoryId: string;
  level: Level;
  operator: Operator;
}

export function parseFilterIds(ids: readonly string[]): { parsed: ParsedFilter[]; invalid: string[] } {
  const parsed: ParsedFilter[] = [];
  const invalid: string[] = [];
  for (const id of ids) {
    const m = FILTER_ID_RE.exec(id);
    if (!m) {
      invalid.push(id);
      continue;
    }
    const [, categoryId, code, webcampId] = m;
    parsed.push({
      id,
      categoryId: categoryId as string,
      code: code as string,
      ...(webcampId !== undefined ? { webcampId } : {}),
      presumedLevel: webcampId !== undefined ? 'accommodation' : 'camping',
    });
  }
  return { parsed, invalid };
}

/** FilterInput GraphQL des filtres présumés hébergement, triés par categoryId puis value. */
export function toFilterInputs(filters: readonly { categoryId: string; code: string; webcampId?: string }[]) {
  return filters
    .filter((f) => f.webcampId !== undefined)
    .map((f): GqlFilterInput => ({
      categoryId: f.categoryId,
      value: f.code,
      webcampId: f.webcampId as string,
    }))
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.value.localeCompare(b.value));
}

/** Validation de cohérence avec le catalogue renvoyé par searchCampings (§8.2 b). */
export function validateFilters(
  parsed: readonly ParsedFilter[],
  filterCategories: readonly (GqlFilterCategory | null)[],
): { resolved: ResolvedFilter[]; unknown: string[] } {
  const resolved: ResolvedFilter[] = [];
  const unknown: string[] = [];
  for (const p of parsed) {
    const info = categoryInfo(p.categoryId);
    const cat = filterCategories.find((c) => c?.categoryId === p.categoryId);
    // 1. catégorie présente dans le catalogue ET dans le tableau §6.1
    // 2. nombre de parties cohérent avec le niveau (type GraphQL et level §6.1 concordants)
    if (!info || !cat || cat.type !== info.level || p.presumedLevel !== info.level) {
      unknown.push(p.id);
      continue;
    }
    // 3. code présent ; 4. webcampId identique pour un filtre hébergement
    const f = (cat.filters ?? []).find(
      (x) => !!x && x.newFilterId === p.code && (info.level === 'camping' || x.id === p.webcampId),
    );
    if (!f) {
      unknown.push(p.id);
      continue;
    }
    resolved.push({
      id: p.id,
      code: p.code,
      webcampId: p.webcampId ?? f.id,
      key: f.key,
      categoryId: p.categoryId,
      level: info.level,
      operator: info.operator,
    });
  }
  return { resolved, unknown };
}
