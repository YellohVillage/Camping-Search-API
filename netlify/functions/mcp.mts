import { getHandler, handleSafely } from '../../mcp-server/src/bootstrap.js';

/**
 * Fonction Netlify du serveur MCP (code dans mcp-server/), servie sur /mcp, /mcp/* et /health.
 * Variables (scope « Functions ») : REST_API_BASE_URL, REST_API_KEY_CLAUDE, REST_API_KEY_CHATGPT — voir mcp-server/README.md.
 * `config` doit rester déclaré ici : Netlify le lit par analyse statique de ce fichier.
 */
export default (request: Request, context?: { ip?: string }) =>
  handleSafely(() => getHandler(), request, { ip: context?.ip });

export const config = {
  path: ['/mcp', '/mcp/*', '/health'],
};
