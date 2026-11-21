import { createMiddleware } from 'hono/factory';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, AuthUser, Ctx } from './context.ts';
import type { DbOrTx } from './db.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { forbidden, tooMany, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'stf_session';
const DAY_MS = 86_400_000;
const REFRESH_AFTER_MS = 3_600_000;

function cookieOptions(c: Ctx) {
  const cfg = c.get('config');
  return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'Lax' as const, path: '/' };
}

export async function createSession(c: Ctx, db: DbOrTx, userId: string): Promise<void> {
  const cfg = c.get('config');
  const token = randomToken();
  const ttl = cfg.sessionTtlDays * DAY_MS;
  await db.session.create({
    data: {
      tokenHash: await sha256Hex(token),
      userId,
      expiresAt: new Date(Date.now() + ttl),
      ip: c.get('ip'),
      userAgent: (c.req.header('user-agent') ?? '').slice(0, 300),
    },
  });
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions(c), maxAge: Math.floor(ttl / 1000) });
}

export async function destroySession(c: Ctx): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.get('db').session.deleteMany({ where: { tokenHash: await sha256Hex(token) } });
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
}

/** Exige une session valide ET un compte actif : l'état du compte est relu à chaque requête. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) throw unauthorized();
  const db = c.get('db');
  const session = await db.session.findUnique({ where: { tokenHash: await sha256Hex(token) }, include: { user: true } });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
    throw unauthorized('Session expirée. Reconnectez-vous.');
  }
  if (session.user.status !== 'ACTIVE') {
    await db.session.deleteMany({ where: { userId: session.userId } });
    deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
    throw unauthorized('Ce compte n’est pas actif.');
  }
  if (Date.now() - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    const ttl = c.get('config').sessionTtlDays * DAY_MS;
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + ttl) },
    });
    setCookie(c, SESSION_COOKIE, token, { ...cookieOptions(c), maxAge: Math.floor(ttl / 1000) });
  }
  const u = session.user;
  const user: AuthUser = {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    status: u.status,
    canCreateSpaces: u.canCreateSpaces,
    quotaBytes: u.quotaBytes,
  };
  c.set('user', user);
  c.set('sessionId', session.id);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'ADMIN') throw forbidden('Réservé aux administrateurs.');
  await next();
});

/**
 * Protection CSRF pour l'authentification par cookie : toute requête modifiante doit
 * provenir d'une origine autorisée et porter un en-tête qu'un formulaire HTML ne peut
 * pas émettre. Complète l'attribut SameSite=Lax du cookie.
 */
export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('origin');
    const allowed = c.get('config').appOrigins;
    if (!origin || !allowed.includes(origin.replace(/\/+$/, ''))) throw forbidden('Origine de la requête refusée.', 'CSRF');
    if (c.req.header('x-stf-request') !== '1') throw forbidden('En-tête de sécurité manquant.', 'CSRF');
  }
  await next();
});

/**
 * Limitation de débit persistée en base : fiable même quand le code s'exécute sur des
 * instances éphémères (Workers). Réservée aux points sensibles (connexion, inscription).
 */
export async function rateLimit(c: Ctx, key: string, limit: number, windowSeconds: number): Promise<void> {
  const rows = await c.get('db').$queryRaw<{ count: number; windowStart: Date }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, now(), 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."windowStart" < now() - make_interval(secs => ${windowSeconds})
                     THEN 1 ELSE "RateLimit"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimit"."windowStart" < now() - make_interval(secs => ${windowSeconds})
                     THEN now() ELSE "RateLimit"."windowStart" END
    RETURNING "count", "windowStart"`;
  const row = rows[0];
  if (row && row.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((row.windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000));
    c.header('Retry-After', String(retryAfter));
    throw tooMany(retryAfter);
  }
}

// Limite générale en mémoire (par instance) : amortit les rafales à moindre coût.
const buckets = new Map<string, { count: number; reset: number }>();
export const generalRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const now = Date.now();
  const key = c.get('ip');
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    if (buckets.size > 10_000) buckets.clear();
    bucket = { count: 0, reset: now + 60_000 };
    buckets.set(key, bucket);
  }
  if (++bucket.count > 1500) {
    const retryAfter = Math.ceil((bucket.reset - now) / 1000);
    c.header('Retry-After', String(retryAfter));
    throw tooMany(retryAfter);
  }
  await next();
});
