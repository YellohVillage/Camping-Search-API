import type { ApiClient, Config } from '../config.js';
import type { Rng } from '../domain/rng.js';
import type { Logger } from '../observability/logger.js';
import type { GqlClient } from '../upstream/gqlClient.js';
import type { HttpRequest } from './types.js';

/** Matériel de sécurité courant (clients et secrets), relu à chaque requête (§4.2, révocation). */
export interface SecurityMaterial {
  clients: ApiClient[];
  secrets: Uint8Array[];
}

export interface AppDeps {
  config: Config;
  gqlClient: GqlClient;
  rng: Rng;
  clock: () => Date;
  logger: Logger;
  security: () => SecurityMaterial | Promise<SecurityMaterial>;
}

export interface UpstreamCounters {
  search_campings: number;
  camping_availability: number;
  catalog: number;
}

export interface RequestContext {
  req: HttpRequest;
  requestId: string;
  now: Date;
  deps: AppDeps;
  /** Client authentifié (endpoints protégés). */
  client?: { clientId: string; track: string };
  /** Client GraphQL qui compte les appels de la requête. */
  gql: GqlClient;
  upstream: UpstreamCounters;
  /** Champs ajoutés à la ligne de log de la requête. */
  logFields: Record<string, unknown>;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<RouteResult>;
