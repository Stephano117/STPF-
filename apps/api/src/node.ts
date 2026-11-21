// Point d'entrée Node.js : développement local, serveur dédié, VPS ou tout hébergeur Node.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/node/client.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { withResilience } from './lib/db.ts';
import { S3Storage } from './lib/storage.ts';
import { runMaintenance } from './lib/maintenance.ts';

const config = loadConfig(process.env);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }),
});
const db = withResilience(prisma);
const storage = new S3Storage(config.s3);
const trustProxy = process.env.TRUST_PROXY === 'true';
const webDist = resolve(process.env.WEB_DIST || '../web/dist');

const app = createApp({
  config,
  storage,
  getDb: () => db,
  getIp: (c) => {
    if (trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    return getConnInfo(c).remote.address ?? 'unknown';
  },
  mountStatic: (root) => {
    const indexPath = resolve(webDist, 'index.html');
    if (!existsSync(indexPath)) return;
    // Relu quand le fichier change : après une recompilation de l'interface, le serveur
    // doit servir le nouvel index.html (il référence un bundle /assets/* au nom différent).
    let cached = { mtime: 0, html: '' };
    const index = () => {
      const mtime = statSync(indexPath).mtimeMs;
      if (mtime !== cached.mtime) cached = { mtime, html: readFileSync(indexPath, 'utf8') };
      return cached.html;
    };
    root.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    // index.html (et toute réponse HTML) ne doit jamais être mis en cache : sinon le
    // navigateur continue de charger l'ancien bundle /assets/* (marqué immutable).
    root.use('*', async (c, next) => {
      await next();
      if (c.res.headers.get('content-type')?.includes('text/html')) c.header('Cache-Control', 'no-cache');
    });
    root.use('*', serveStatic({ root: webDist }));
    root.get('*', (c) => c.html(index(), 200, { 'Cache-Control': 'no-cache' }));
  },
});

const port = Number(process.env.PORT || 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[spt] API à l'écoute sur http://localhost:${port} (${config.env})`);
});

// Entretien périodique. Sur un hébergeur qui endort le processus, le cron externe
// (POST /api/maintenance/run) prend le relais : rien ne dépend de cette minuterie.
if (config.env !== 'test') {
  const timer = setInterval(() => {
    runMaintenance({ db, storage, config }).catch((err) => console.error('[spt] maintenance', err));
  }, 6 * 3_600_000);
  timer.unref();
}

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
