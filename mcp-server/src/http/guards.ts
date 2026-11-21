/** Protections du point d'entrée /mcp (§9.1). */

/** Limite de débit en mémoire par adresse IP et par instance, fenêtre glissante d'une minute (indicative). */
export class IpRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limitPerMinute: number) {}

  check(ip: string, nowMs: number): { allowed: boolean; retryAfter: number } {
    const since = nowMs - 60_000;
    const list = (this.hits.get(ip) ?? []).filter((t) => t > since);
    if (list.length >= this.limitPerMinute) {
      this.hits.set(ip, list);
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(((list[0] as number) + 60_000 - nowMs) / 1000)),
      };
    }
    list.push(nowMs);
    this.hits.set(ip, list);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
    }
    return { allowed: true, retryAfter: 0 };
  }
}

/** Origin absent (client serveur) ou présent dans la liste autorisée (protection contre le DNS rebinding). */
export const originAllowed = (origin: string | null, allowed: readonly string[]) =>
  origin === null || allowed.includes(origin);

/** Taille du corps : en-tête Content-Length puis taille réelle. */
export const contentLengthTooLarge = (header: string | null, max: number) =>
  header !== null && Number.isFinite(Number(header)) && Number(header) > max;
