// Point d'entrée Cloudflare Workers. Seul fichier (avec wrangler.jsonc) propre à Cloudflare :
// le reste de l'application est identique à la version Node.js.

import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient as WorkerPrismaClient } from './generated/workerd/client.ts';
import type { PrismaClient } from './generated/node/client.ts';
import { createApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { withResilience, type Db } from './lib/db.ts';
import { S3Storage } from './lib/storage.ts';
import { runMaintenance } from './lib/maintenance.ts';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  [key: string]: unknown;
}

type ExecutionContext = import('hono').ExecutionContext;

/**
 * Un client par requête : sur Workers, une connexion ne peut pas être partagée entre
 * requêtes. Il est fermé après l'envoi de la réponse.
 */
function openDb(config: Config): { db: Db; close: () => Promise<void> } {
  const client = new WorkerPrismaClient({ adapter: new PrismaNeon({ connectionString: config.databaseUrl }) }) as unknown as PrismaClient;
  return { db: withResilience(client), close: () => client.$disconnect() };
}

const requestDb = new WeakMap<Request, Db>();
let cached: { config: Config; storage: S3Storage; app: ReturnType<typeof createApp> } | null = null;

function setup(env: Env) {
  if (cached) return cached;
  const vars: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') vars[key] = value;
  const config = loadConfig({ NODE_ENV: 'production', ...vars });
  const storage = new S3Storage(config.s3);
  const app = createApp({
    config,
    storage,
    getDb: (c) => requestDb.get(c.req.raw)!,
    getIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    mountStatic: (root) => {
      root.get('*', async (c) => {
        const res = await (c.env as unknown as Env).ASSETS.fetch(c.req.raw);
        // Copie : les en-têtes de sécurité sont ajoutés par l'application.
        return new Response(res.body, res);
      });
    },
  });
  cached = { config, storage, app };
  return cached;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { app, config } = setup(env);
    const { db, close } = openDb(config);
    requestDb.set(request, db);
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      ctx.waitUntil(close().catch(() => undefined));
    }
  },

  /** Cron Trigger (voir wrangler.jsonc) : entretien quotidien. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const { config, storage } = setup(env);
    const { db, close } = openDb(config);
    ctx.waitUntil(
      runMaintenance({ db, storage, config })
        .catch((err) => console.error('[spt] maintenance', err))
        .finally(close),
    );
  },
};
