import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { ApiClient } from '../config.js';

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Recherche le client actif correspondant à une clé d'API (§4.2) :
 * sha256(clé) comparé en temps constant à chaque empreinte active.
 */
export function findClientByApiKey(apiKey: string, clients: readonly ApiClient[]): ApiClient | undefined {
  const digest = Buffer.from(sha256Hex(apiKey), 'hex');
  let found: ApiClient | undefined;
  for (const c of clients) {
    if (!c.enabled) continue;
    const expected = Buffer.from(c.key_sha256, 'hex');
    // Pas de sortie anticipée : on parcourt toutes les entrées.
    if (expected.length === digest.length && timingSafeEqual(expected, digest) && !found) found = c;
  }
  return found;
}

/** Vrai si au moins une entrée active existe pour ce client_id (§4.3). */
export const isClientActive = (clientId: string, clients: readonly ApiClient[]) =>
  clients.some((c) => c.client_id === clientId && c.enabled);

/** Limite de débit d'un client : la plus élevée de ses entrées, sinon la valeur globale (§4.2). */
export function clientRateLimit(
  clientId: string,
  clients: readonly ApiClient[],
  globalLimit: number,
): number {
  const values = clients
    .filter((c) => c.client_id === clientId && c.rate_limit_per_minute !== undefined)
    .map((c) => c.rate_limit_per_minute as number);
  return values.length > 0 ? Math.max(...values) : globalLimit;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Nouvelle clé : `ysk_live_` + 40 caractères base62 aléatoires (≥ 238 bits). */
export function generateApiKey(): string {
  let s = '';
  for (let i = 0; i < 40; i++) s += BASE62[randomInt(BASE62.length)];
  return `ysk_live_${s}`;
}
