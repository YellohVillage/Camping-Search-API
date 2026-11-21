import type { Logger } from '../observability/logger.js';
import type { GqlFilter, GqlFilterCategory } from '../upstream/types.js';
import { categoryInfo, LOCATION_FIRST_CATEGORY, type Level, type Operator } from './categoryMapping.js';

export interface CatalogFilter {
  id: string;
  label: string;
  label_en: string | null;
}

export interface CatalogCategory {
  category_id: string;
  level: Level;
  operator: Operator;
  filters: CatalogFilter[];
}

export interface CatalogSection {
  section: string;
  label: string;
  categories: CatalogCategory[];
}

export interface Catalog {
  accommodation_type: 'rental' | 'slot';
  locale: string;
  generated_at: string;
  sections: CatalogSection[];
}

const prio = (p: number | null | undefined) => p ?? 0;

/** Partie d'id valide : non vide, sans `:` ni `,` (§6). */
const validPart = (s: string | null | undefined): s is string => !!s && !s.includes(':') && !s.includes(',');

/** Id autoporteur d'un filtre : `{categoryId}:{newFilterId}` ou `{categoryId}:{newFilterId}:{webcampId}`. */
export function buildFilterId(categoryId: string, level: Level, f: GqlFilter): string | null {
  const parts = [categoryId, f.newFilterId ?? ''];
  if (level === 'accommodation') parts.push(f.id);
  return parts.every(validPart) ? parts.join(':') : null;
}

/**
 * Construit le catalogue `/v1/search/filters` à partir des filterCategories GraphQL (§6, traitement).
 * Ordre : catégories triées par priority (tri stable), sections à la position de leur première catégorie,
 * `destination` en tête de la section `location`, filtres triés par priority (tri stable).
 */
export function buildCatalog(
  filterCategories: readonly (GqlFilterCategory | null)[],
  accommodationType: 'rental' | 'slot',
  locale: string,
  generatedAt: string,
  logger?: Logger,
): Catalog {
  const kept = filterCategories
    .filter((c): c is GqlFilterCategory => !!c && !!categoryInfo(c.categoryId))
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => prio(a.c.priority) - prio(b.c.priority) || a.idx - b.idx)
    .map(({ c }) => c);

  const sections: CatalogSection[] = [];
  for (const cat of kept) {
    const info = categoryInfo(cat.categoryId)!;
    const filters: CatalogFilter[] = [];
    const sorted = (cat.filters ?? [])
      .filter((f): f is GqlFilter => !!f && !!f.newFilterId)
      .map((f, idx) => ({ f, idx }))
      .sort((a, b) => prio(a.f.priority) - prio(b.f.priority) || a.idx - b.idx)
      .map(({ f }) => f);
    for (const f of sorted) {
      const id = buildFilterId(cat.categoryId, info.level, f);
      if (!id) {
        logger?.warn('filtre ignoré : id non conforme', {
          category_id: cat.categoryId,
          filter: f.newFilterId,
        });
        continue;
      }
      filters.push({ id, label: (f.title ?? '').trim(), label_en: f.englishTitle ? f.englishTitle : null });
    }
    if (filters.length === 0) continue;

    let section = sections.find((s) => s.section === info.section);
    if (!section) {
      section = { section: info.section, label: info.sectionLabel, categories: [] };
      sections.push(section);
    }
    const entry: CatalogCategory = {
      category_id: cat.categoryId,
      level: info.level,
      operator: info.operator,
      filters,
    };
    if (cat.categoryId === LOCATION_FIRST_CATEGORY) section.categories.unshift(entry);
    else section.categories.push(entry);
  }

  return { accommodation_type: accommodationType, locale, generated_at: generatedAt, sections };
}
