import { normalizeLanguage } from './catalogCache.js';

/** Normalisation des mots clés, identique à l'API REST (§6 bis.3) : espaces de bord retirés, espaces multiples réduits. */
export const normalizeKeywords = (k: string) => k.trim().replace(/\s+/g, ' ');

/**
 * Cache des recherches par lieu en mémoire d'instance (§3) : clé (mots clés normalisés en minuscules, langue normalisée),
 * durée `ttlSeconds` (0 désactive le cache), au plus `maxEntries` entrées (les plus anciennes sont retirées).
 * Ne contient que des noms de lieux et des identifiants publics.
 */
export class GeographyCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxEntries: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(keywords: string, lang: string) {
    return `${normalizeLanguage(lang)}:${normalizeKeywords(keywords).toLowerCase()}`;
  }

  get(keywords: string, lang: string): T | undefined {
    const k = this.key(keywords, lang);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(k);
      return undefined;
    }
    return e.value;
  }

  set(keywords: string, lang: string, value: T): void {
    if (this.ttlSeconds <= 0 || this.maxEntries <= 0) return;
    const k = this.key(keywords, lang);
    this.entries.delete(k);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(k, { value, expiresAt: this.now() + this.ttlSeconds * 1000 });
  }

  get size(): number {
    return this.entries.size;
  }
}
