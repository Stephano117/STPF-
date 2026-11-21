// Démarre un vrai PostgreSQL (embarqué) et un émulateur S3 pour toute la durée des tests.
// Les tests exercent donc les vraies requêtes SQL, transactions et transferts HTTP.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { startLocalS3 } from '../scripts/local-s3.ts';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export function migrate(databaseUrl: string): void {
  execFileSync(process.execPath, ['../../node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: '' },
    stdio: 'pipe',
  });
}

export default async function setup(project: TestProject) {
  const dir = await mkdtemp(join(tmpdir(), 'stf-test-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), user: 'stf', password: 'stf', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stf');
  await pg.createDatabase('stf_restore');
  const base = `postgresql://stf:stf@127.0.0.1:${port}`;
  migrate(`${base}/stf`);
  migrate(`${base}/stf_restore`);

  const s3 = await startLocalS3({ dir: join(dir, 's3'), bucket: 'stf-test' });
  const s3Restore = await startLocalS3({ dir: join(dir, 's3-restore'), bucket: 'stf-test' });

  project.provide('databaseUrl', `${base}/stf`);
  project.provide('restoreDatabaseUrl', `${base}/stf_restore`);
  project.provide('s3Endpoint', s3.url);
  project.provide('s3RestoreEndpoint', s3Restore.url);
  project.provide('tmpDir', dir);

  return async () => {
    await s3.close();
    await s3Restore.close();
    await pg.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    restoreDatabaseUrl: string;
    s3Endpoint: string;
    s3RestoreEndpoint: string;
    tmpDir: string;
  }
}
