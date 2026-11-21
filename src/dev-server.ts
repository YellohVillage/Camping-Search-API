import { createServer } from 'node:http';
import { getApp } from './bootstrap.js';
import { normalizeHeaders, queryFromSearchParams } from './http/types.js';

/** Serveur local de développement : `npm run dev` (lit .env), port 8787 par défaut. */
const port = Number(process.env.PORT ?? 8787);
const app = getApp();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  const out = await app.handle({
    method: req.method ?? 'GET',
    path: url.pathname,
    query: queryFromSearchParams(url.searchParams),
    headers: normalizeHeaders(req.headers as Record<string, string | string[] | undefined>),
    ...(body ? { body } : {}),
  });
  res.writeHead(out.statusCode, out.headers);
  res.end(out.statusCode === 204 ? undefined : out.body);
}).listen(port, () => {
  process.stdout.write(`Camping Search API : http://localhost:${port}/v1/health\n`);
});
