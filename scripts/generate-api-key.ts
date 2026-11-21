import { generateApiKey, sha256Hex } from '../src/auth/apiKeys.js';

/** npm run keys:generate -- --client <client_id> [--track <track>] [--rate-limit <n>] */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const clientId = arg('client');
if (!clientId || !/^[a-z0-9-]{3,40}$/.test(clientId)) {
  process.stderr.write(
    'Usage : npm run keys:generate -- --client <client_id> [--track <track>] [--rate-limit <n>]\n',
  );
  process.stderr.write('client_id : [a-z0-9-]{3,40}\n');
  process.exit(1);
}
const key = generateApiKey();
const rate = arg('rate-limit');
const entry = {
  client_id: clientId,
  key_sha256: sha256Hex(key),
  track: arg('track') ?? clientId,
  enabled: true,
  ...(rate ? { rate_limit_per_minute: Number(rate) } : {}),
};
process.stdout.write(
  [
    `Clé d'API (à transmettre au client par un canal sûr, elle ne sera plus affichée) :`,
    `  ${key}`,
    ``,
    `Entrée à ajouter au tableau JSON API_CLIENTS :`,
    `  ${JSON.stringify(entry)}`,
    ``,
  ].join('\n'),
);
