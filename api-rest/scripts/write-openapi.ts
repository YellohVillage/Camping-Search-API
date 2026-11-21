import { writeFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { buildOpenApiDocument } from '../src/routes/openapi.js';

/** npm run openapi : écrit openapi.json à la racine du dépôt. */
writeFileSync('openapi.json', JSON.stringify(buildOpenApiDocument(pkg.version), null, 2) + '\n');
process.stdout.write('openapi.json écrit.\n');
