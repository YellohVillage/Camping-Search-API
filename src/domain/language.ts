/** Détermination de la langue de l'utilisateur (§10.3). */

const LANG_RE = /^[A-Za-z0-9-]{1,35}$/;

/** Langue de plus fort poids `q` d'un en-tête Accept-Language. */
export function pickHighestQ(acceptLanguage: string | undefined): string | undefined {
  if (!acceptLanguage) return undefined;
  let best: { tag: string; q: number; idx: number } | undefined;
  acceptLanguage.split(',').forEach((part, idx) => {
    const [tagRaw, ...params] = part.trim().split(';');
    const tag = tagRaw?.trim();
    if (!tag || tag === '*') return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (Number.isNaN(q) || q <= 0) return;
    if (!best || q > best.q) best = { tag, q, idx };
  });
  return best?.tag;
}

/** Code de langue normalisé (sous-étiquette principale en minuscules), ou null. */
export function resolveUserLanguage(
  userLanguage: string | undefined,
  acceptLanguage: string | undefined,
): string | null {
  const raw = userLanguage !== undefined && userLanguage !== '' ? userLanguage : pickHighestQ(acceptLanguage);
  if (!raw || !LANG_RE.test(raw)) return null;
  const primary = raw.split('-')[0]?.toLowerCase();
  return primary ? primary : null;
}

/** Valeur de la table pour la langue, sinon la valeur « Autre ». */
export function lookupLanguage(lang: string | null, table: Record<string, string>, fallback: string): string {
  if (lang && Object.prototype.hasOwnProperty.call(table, lang)) return table[lang] as string;
  return fallback;
}

export function resolveSiteBaseUrl(
  userLanguage: string | undefined,
  acceptLanguage: string | undefined,
  table: Record<string, string>,
  fallback: string,
): { lang: string | null; base: string } {
  const lang = resolveUserLanguage(userLanguage, acceptLanguage);
  return { lang, base: lookupLanguage(lang, table, fallback) };
}
