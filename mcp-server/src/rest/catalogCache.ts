import type { AccommodationType, RestCatalog } from './types.js';

/** Sous-étiquette principale en minuscules : `de-AT` → `de` (§5.3). */
export const normalizeLanguage = (lang: string) => (lang.split('-')[0] ?? lang).toLowerCase();

/**
 * Cache du catalogue en mémoire d'instance, clé (type d'hébergement, langue normalisée), durée `ttlSeconds` (§5.3).
 * Ne contient que de la configuration publique.
 */
export class CatalogCache {
  private entries = new Map<string, { catalog: RestCatalog; expiresAt: number }>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(type: AccommodationType, lang: string) {
    return `${type}:${normalizeLanguage(lang)}`;
  }

  get(type: AccommodationType, lang: string): RestCatalog | undefined {
    const e = this.entries.get(this.key(type, lang));
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(this.key(type, lang));
      return undefined;
    }
    return e.catalog;
  }

  set(type: AccommodationType, lang: string, catalog: RestCatalog): void {
    this.entries.set(this.key(type, lang), { catalog, expiresAt: this.now() + this.ttlSeconds * 1000 });
  }

  /** Vide toutes les langues d'un type (après UNKNOWN_FILTER, §6.3). */
  invalidateType(type: AccommodationType): void {
    for (const k of this.entries.keys()) if (k.startsWith(`${type}:`)) this.entries.delete(k);
  }
}
