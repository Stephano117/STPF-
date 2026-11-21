// Services locaux de développement, sans rien installer d'autre que Node.js :
//   - PostgreSQL embarqué (données dans apps/api/.local/pg, port 5432)
//   - émulateur S3 (objets dans apps/api/.local/s3, port 9000)
//
//   npm run dev:services      (laisser tourner dans un terminal ; Ctrl+C pour arrêter)

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { startLocalS3 } from './local-s3.ts';

const dataDir = resolve('.local/pg');
const fresh = !existsSync(resolve(dataDir, 'PG_VERSION'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'stf', password: 'stf', port: Number(process.env.POSTGRES_PORT || 5432), persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('stf');

const s3 = await startLocalS3({ dir: resolve('.local/s3'), port: 9000, bucket: process.env.S3_BUCKET || 'stf-files' });

console.log('\n✓ PostgreSQL : postgresql://stf:stf@localhost:5432/stf');
console.log(`✓ Stockage S3 local : ${s3.url}`);
console.log('  Première fois : npm run db:deploy puis npm run create-admin\n');

const stop = async () => {
  await s3.close();
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
