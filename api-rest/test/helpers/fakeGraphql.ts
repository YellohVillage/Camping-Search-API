import type { FetchFn } from '../../src/upstream/gqlClient.js';

/** Faux serveur GraphQL pour les tests d'intégration : on teste ainsi le vrai client (en-têtes, corps, erreurs). */
export interface RecordedCall {
  operationName: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  query: string;
}

export type Responder = (
  vars: Record<string, unknown>,
  headers: Record<string, string>,
) => unknown | Promise<unknown>;

export function fakeGraphql(handlers: Partial<Record<string, Responder>>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchFn = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      operationName: string;
      variables: Record<string, unknown>;
      query: string;
    };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    calls.push({ operationName: body.operationName, variables: body.variables, headers, query: body.query });
    const h = handlers[body.operationName];
    if (!h)
      return new Response(JSON.stringify({ errors: [{ message: `pas de handler ${body.operationName}` }] }), {
        status: 200,
      });
    const signal = init?.signal;
    const out = await new Promise<unknown>((resolve, reject) => {
      // Comme un vrai fetch : l'abandon (timeout du client) rejette la requête en cours.
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      Promise.resolve(h(body.variables, headers)).then(resolve, reject);
    });
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetchImpl,
    calls,
    count: (op: string) => calls.filter((c) => c.operationName === op).length,
  };
}

export const gqlData = (field: string, value: unknown) => ({ data: { [field]: value } });
