import { createServer } from 'node:http';
import { getHandler, handleSafely } from './bootstrap.js';

/** Serveur local : `npm run dev` (lit .env), port 8788 par défaut. Point d'entrée : http://localhost:8788/mcp/claude */
const port = Number(process.env.PORT ?? 8788);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
  const out = await handleSafely(() => getHandler(), request, { ip: req.socket.remoteAddress ?? 'local' });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(out.status === 204 ? undefined : Buffer.from(await out.arrayBuffer()));
}).listen(port, () => {
  process.stdout.write(`Serveur MCP : http://localhost:${port}/mcp/claude (santé : /health)\n`);
});
