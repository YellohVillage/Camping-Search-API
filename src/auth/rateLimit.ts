/**
 * Limite de débit en mémoire, par clé et par instance, fenêtre glissante d'une minute (§4.4).
 * Indicative : elle n'est pas partagée entre instances.
 */
export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Secondes avant qu'une requête soit de nouveau acceptée (si refusée). */
  retryAfter: number;
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();

  check(key: string, limit: number, nowMs: number): RateDecision {
    const since = nowMs - WINDOW_MS;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= limit) {
      this.hits.set(key, list);
      const oldest = list[0] as number;
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000)),
      };
    }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.prune(since);
    return { allowed: true, limit, remaining: limit - list.length, retryAfter: 0 };
  }

  private prune(since: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
  }
}
