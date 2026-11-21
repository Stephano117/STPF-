// Application HTTP, indépendante de l'hébergeur : la même instance est servie par
// Node.js (src/node.ts) et par Cloudflare Workers (src/worker.ts).

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from './config.ts';
import type { AppEnv, Ctx } from './lib/context.ts';
import type { Db } from './lib/db.ts';
import type { StorageAdapter } from './lib/storage.ts';
import { StorageError } from './lib/storage.ts';
import { AppError } from './lib/errors.ts';
import { csrfGuard, generalRateLimit } from './lib/auth.ts';
import { authRoutes } from './routes/auth.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { contentRoutes } from './routes/content.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { transferRoutes } from './routes/transfer.ts';
import { adminRoutes } from './routes/admin.ts';
import { healthHandler, systemRoutes } from './routes/system.ts';

export interface AppDeps {
  config: Config;
  storage: StorageAdapter;
  /** Fournit le client de base de données de la requête. */
  getDb: (c: Ctx) => Db;
  /** Adresse IP du client, selon la plateforme. */
  getIp: (c: Ctx) => string;
  mountStatic?: (app: Hono<AppEnv>) => void;
}

// Les sérialisations JSON de tailles (BigInt PostgreSQL) restent sous 2^53 octets.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

const REQUEST_TIMEOUT_MS = 25_000;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('config', deps.config);
    c.set('storage', deps.storage);
    c.set('db', deps.getDb(c));
    c.set('ip', deps.getIp(c));
    await next();
  });

  const storageOrigin = new URL(deps.config.s3.endpoint).origin;
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', storageOrigin],
        mediaSrc: ["'self'", storageOrigin],
        frameSrc: [storageOrigin],
        connectSrc: ["'self'", storageOrigin],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'same-origin',
      xFrameOptions: 'DENY',
    }),
  );

  const api = new Hono<AppEnv>();
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Délai de garde : une dépendance bloquée ne doit pas immobiliser la requête.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, 'TIMEOUT', 'Le service met trop de temps à répondre. Réessayez.')), REQUEST_TIMEOUT_MS);
    });
    try {
      await Promise.race([next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  });
  api.use('*', generalRateLimit);
  api.use('*', bodyLimit({ maxSize: 256 * 1024, onError: () => { throw new AppError(413, 'BODY_TOO_LARGE', 'Requête trop volumineuse.'); } }));

  // Authentifiée par jeton (cron externe, sans cookie) : montée avant la garde CSRF.
  api.route('/', systemRoutes);
  api.use('*', csrfGuard);
  api.route('/', authRoutes);
  api.route('/', spaceRoutes);
  api.route('/', contentRoutes);
  api.route('/', uploadRoutes);
  api.route('/', transferRoutes);
  api.route('/admin', adminRoutes);
  api.all('*', () => {
    throw new AppError(404, 'NOT_FOUND', 'Route inconnue.');
  });

  app.route('/api', api);
  app.get('/health', healthHandler);
  // Interface web (fichiers statiques + repli SPA), fournie par la plateforme d'exécution.
  deps.mountStatic?.(app);

  app.onError(async (err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    }
    const isStorage = err instanceof StorageError;
    const status = isStorage ? 502 : 500;
    console.error(`[spt] ${c.req.method} ${c.req.path}`, err);
    try {
      await deps.getDb(c).errorLog.create({
        data: {
          source: isStorage ? 'storage' : 'api',
          message: String((err as Error)?.message ?? err).slice(0, 1000),
          stack: String((err as Error)?.stack ?? '').slice(0, 8000),
          path: `${c.req.method} ${c.req.path}`,
          userId: (c.get('user') as { id: string } | undefined)?.id,
        },
      });
    } catch {
      // La journalisation ne doit jamais masquer l'erreur d'origine.
    }
    return c.json(
      {
        error: {
          code: isStorage ? 'STORAGE_UNAVAILABLE' : 'INTERNAL',
          message: isStorage
            ? 'Le stockage des fichiers est momentanément indisponible. Réessayez dans un instant.'
            : 'Une erreur interne est survenue. Réessayez dans un instant.',
        },
      },
      status,
    );
  });

  return app;
}
