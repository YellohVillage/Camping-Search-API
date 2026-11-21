/** Requête HTTP normalisée, indépendante de la plateforme (§12.1). */
export interface HttpRequest {
  method: string;
  /** Chemin sans chaîne de requête, ex. "/v1/search/campings". */
  path: string;
  /** Paramètres de requête ; un paramètre répété donne un tableau. */
  query: Record<string, string | string[]>;
  /** En-têtes, noms en minuscules. */
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Convertit des URLSearchParams en objet de requête normalisé. */
export function queryFromSearchParams(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of params) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/** Met les noms d'en-têtes en minuscules et joint les valeurs multiples. */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
