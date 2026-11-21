import type { RestCatalog } from '../rest/types.js';

/** Catalogue compact pour le LLM (§5.4) : sans `level` ni horodatage. */
export interface CompactCatalog {
  accommodation_type: 'rental' | 'slot';
  sections: {
    section: string;
    label: string;
    label_en: string | null;
    categories: {
      category_id: string;
      operator: 'AND' | 'OR';
      filters: { id: string; label: string; label_en: string | null }[];
    }[];
  }[];
}

export function compactCatalog(c: RestCatalog): CompactCatalog {
  return {
    accommodation_type: c.accommodation_type,
    sections: c.sections.map((s) => ({
      section: s.section,
      label: s.label,
      label_en: null,
      categories: s.categories.map((cat) => ({
        category_id: cat.category_id,
        operator: cat.operator,
        filters: cat.filters.map((f) => ({ id: f.id, label: f.label, label_en: f.label_en })),
      })),
    })),
  };
}

/** Version texte (§5.4) : une ligne `id | label | label_en` par filtre, regroupée par section. */
export function catalogText(c: CompactCatalog): string {
  const lines = [
    `Search filters for accommodation_type=${c.accommodation_type}. Pass the ids (first column) to search_campings, unchanged.`,
    'Within a category marked OR, filters are alternatives; all other selected filters must all be satisfied.',
  ];
  for (const s of c.sections) {
    lines.push('', `## ${s.label} (${s.section})`);
    for (const cat of s.categories) {
      lines.push(`[${cat.category_id}, ${cat.operator}]`);
      for (const f of cat.filters) lines.push(`${f.id} | ${f.label} | ${f.label_en ?? ''}`);
    }
  }
  return lines.join('\n');
}
