import { randomInt } from 'node:crypto';

/** Générateur aléatoire injectable (§8.6). */
export interface Rng {
  /** Entier dans [0, max). */
  int(max: number): number;
}

export const cryptoRng: Rng = { int: (max) => randomInt(max) };

/** Générateur à graine (mulberry32), pour les tests et l'en-tête X-Debug-Seed. */
export function seededRng(seed: number | string): Rng {
  let a =
    typeof seed === 'number'
      ? seed >>> 0
      : [...seed].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0) as number, 2166136261);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (max) => Math.floor(next() * max) };
}

/** Mélange de Fisher-Yates (copie). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
