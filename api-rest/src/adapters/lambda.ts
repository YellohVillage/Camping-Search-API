import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import type { App } from '../app.js';
import { handleSafely } from '../http/fatal.js';
import { normalizeHeaders, queryFromSearchParams, type HttpRequest } from '../http/types.js';

/**
 * Adaptateur AWS Lambda (secondaire : la cible de déploiement principale est Netlify).
 * Accepte les événements API Gateway REST (v1), HTTP API (v2) et Function URL (format v2).
 */
type LambdaEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;

const isV2 = (e: LambdaEvent): e is APIGatewayProxyEventV2 => (e as APIGatewayProxyEventV2).version === '2.0';

export function lambdaEventToHttpRequest(event: LambdaEvent): HttpRequest {
  const rawBody = event.body ?? undefined;
  const body = rawBody && event.isBase64Encoded ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody;
  if (isV2(event)) {
    const headers = normalizeHeaders(event.headers);
    if (event.cookies?.length) headers.cookie = event.cookies.join('; ');
    return {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: queryFromSearchParams(new URLSearchParams(event.rawQueryString ?? '')),
      headers,
      ...(body ? { body } : {}),
    };
  }
  const params = new URLSearchParams();
  const multi = event.multiValueQueryStringParameters;
  if (multi) {
    for (const [k, vs] of Object.entries(multi)) for (const v of vs ?? []) params.append(k, v);
  } else {
    for (const [k, v] of Object.entries(event.queryStringParameters ?? {}))
      if (v !== undefined) params.append(k, v);
  }
  return {
    method: event.httpMethod,
    path: event.path,
    query: queryFromSearchParams(params),
    headers: normalizeHeaders({ ...event.headers, ...flatten(event.multiValueHeaders) }),
    ...(body ? { body } : {}),
  };
}

function flatten(h: Record<string, string[] | undefined> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (v) out[k] = v.join(', ');
  return out;
}

export function createLambdaHandler(getApp: () => App) {
  return async (event: LambdaEvent): Promise<APIGatewayProxyResult> => {
    const res = await handleSafely(getApp, lambdaEventToHttpRequest(event));
    return { statusCode: res.statusCode, headers: res.headers, body: res.body };
  };
}
