import { Hono } from 'hono';
import { z } from 'zod';
import { body, type AppEnv, type Ctx } from '../lib/context.ts';
import { rateLimit } from '../lib/auth.ts';
import { forbidden } from '../lib/errors.ts';
import { runMaintenance } from '../lib/maintenance.ts';

export const systemRoutes = new Hono<AppEnv>();

/**
 * État de santé. `GET /health` teste la base ; `?deep=1` teste aussi le stockage
 * (à réserver aux contrôles espacés : chaque appel consomme une transaction du fournisseur).
 */
export const healthHandler = async (c: Ctx) => {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; ms?: number; error?: string }> = {};
  try {
    await c.get('db').$queryRaw`SELECT 1`;
    checks.database = { ok: true, ms: Date.now() - started };
  } catch (err) {
    checks.database = { ok: false, error: (err as Error).message.slice(0, 200) };
  }
  if (c.req.query('deep') === '1') {
    const t = Date.now();
    try {
      await c.get('storage').check();
      checks.storage = { ok: true, ms: Date.now() - t };
    } catch (err) {
      checks.storage = { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }
  const ok = Object.values(checks).every((v) => v.ok);
  c.header('Cache-Control', 'no-store');
  return c.json({ status: ok ? 'ok' : 'degraded', version: c.get('config').version, time: new Date().toISOString(), checks }, ok ? 200 : 503);
};
systemRoutes.get('/health', healthHandler);

/** Erreurs remontées par le navigateur (error boundary), visibles dans l'administration. */
systemRoutes.post('/client-errors', async (c) => {
  await rateLimit(c, `client-error:${c.get('ip')}`, 30, 3600);
  const data = await body(c, z.object({ message: z.string().max(1000), stack: z.string().max(8000).optional(), path: z.string().max(500).optional() }));
  await c.get('db').errorLog.create({ data: { source: 'web', message: data.message, stack: data.stack, path: data.path } });
  return c.json({ ok: true }, 201);
});

/** Entretien périodique, protégé par un jeton (appelé par un cron externe). */
systemRoutes.post('/maintenance/run', async (c) => {
  const token = c.get('config').maintenanceToken;
  const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.length < 24 || given !== token) throw forbidden('Jeton de maintenance invalide.');
  const summary = await runMaintenance({ db: c.get('db'), storage: c.get('storage'), config: c.get('config') });
  return c.json({ ok: true, summary });
});
