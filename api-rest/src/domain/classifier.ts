import type { GqlCamping } from '../upstream/types.js';

export interface Classified {
  available: GqlCamping[];
  alternative: GqlCamping[];
  unavailable: GqlCamping[];
}

/**
 * Classement (§8.5) : `available` → AVAILABLE ; `flex` → ALTERNATIVE ;
 * toute autre valeur (closed, error, null, statut non prévu) → UNAVAILABLE.
 * L'ordre du GraphQL est conservé dans chaque liste.
 */
export function classify(campings: readonly GqlCamping[]): Classified {
  const out: Classified = { available: [], alternative: [], unavailable: [] };
  for (const c of campings) {
    if (c.availabilityStatus === 'available') out.available.push(c);
    else if (c.availabilityStatus === 'flex') out.alternative.push(c);
    else out.unavailable.push(c);
  }
  return out;
}

/** Vrai si tous les campings reçus sont en `error` (§8.5 → 502). */
export const allInError = (campings: readonly (GqlCamping | null)[]) =>
  campings.length > 0 && campings.every((c) => !c || c.availabilityStatus === 'error');
