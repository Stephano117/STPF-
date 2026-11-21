import { Hono } from 'hono';
import { z } from 'zod';
import { body, fullName, logActivity, type AppEnv } from '../lib/context.ts';
import { createSession, destroySession, rateLimit, requireAuth } from '../lib/auth.ts';
import { hashAuthKey, needsRehash, verifyAuthKey } from '../lib/crypto.ts';
import { AppError, badRequest, forbidden } from '../lib/errors.ts';
import { ensurePersonalSpace } from '../lib/bootstrap.ts';
import { personalQuota, spaceUsage } from '../lib/access.ts';

const authKey = z.string().regex(/^[0-9a-f]{64}$/, 'Clé d’authentification invalide.');
const email = z.string().trim().toLowerCase().pipe(z.email('Adresse e-mail invalide.').max(200));
const text = (max: number) => z.string().trim().min(1, 'Champ requis.').max(max);

const registerSchema = z.object({
  firstName: text(80),
  lastName: text(80),
  email,
  authKey,
});

const loginSchema = z.object({ email, authKey });

// Empreinte factice : égalise le temps de réponse quand le compte n'existe pas.
let dummyHash: Promise<string> | null = null;

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/register', async (c) => {
  await rateLimit(c, `register:${c.get('ip')}`, 30, 3600);
  const data = await body(c, registerSchema);
  const cfg = c.get('config');
  const db = c.get('db');

  if (cfg.allowedEmailDomains.length > 0 && !cfg.allowedEmailDomains.includes(data.email.split('@')[1] ?? '')) {
    throw badRequest('Utilisez votre adresse e-mail professionnelle.', 'EMAIL_DOMAIN');
  }

  const passwordHash = await hashAuthKey(data.authKey, cfg.passwordIterations);
  const existing = await db.user.findUnique({ where: { email: data.email }, select: { id: true } });
  // Réponse identique que l'adresse soit déjà connue ou non (pas d'énumération de comptes).
  if (!existing) {
    const user = await db.user.create({
      data: {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        passwordHash,
        status: 'PENDING',
      },
    });
    await logActivity(db, c, {
      action: 'user.register',
      targetType: 'user',
      targetId: user.id,
      targetLabel: `${fullName(user)} <${user.email}>`,
      actor: { id: user.id, label: `${fullName(user)} <${user.email}>` },
    });
  }
  return c.json({ status: 'PENDING' }, 201);
});

authRoutes.post('/auth/login', async (c) => {
  const data = await body(c, loginSchema);
  await rateLimit(c, `login-ip:${c.get('ip')}`, 150, 900);
  await rateLimit(c, `login:${data.email}`, 8, 900);
  const cfg = c.get('config');
  const db = c.get('db');

  const user = await db.user.findUnique({ where: { email: data.email } });
  if (!user) {
    dummyHash ??= hashAuthKey('00'.repeat(32), cfg.passwordIterations);
    await verifyAuthKey(data.authKey, await dummyHash);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect.');
  }
  if (!(await verifyAuthKey(data.authKey, user.passwordHash))) {
    await logActivity(db, c, {
      action: 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      actor: { id: null, label: user.email },
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect.');
  }
  // L'état du compte n'est révélé qu'après vérification du mot de passe.
  if (user.status === 'PENDING') throw forbidden('Votre compte est en attente de validation par un administrateur.', 'ACCOUNT_PENDING');
  if (user.status === 'REJECTED') throw forbidden('Votre demande d’inscription a été refusée.', 'ACCOUNT_REJECTED');
  if (user.status === 'SUSPENDED') throw forbidden('Votre compte est suspendu. Contactez un administrateur.', 'ACCOUNT_SUSPENDED');

  await createSession(c, db, user.id);
  await db.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      ...(needsRehash(user.passwordHash, cfg.passwordIterations)
        ? { passwordHash: await hashAuthKey(data.authKey, cfg.passwordIterations) }
        : {}),
    },
  });
  await ensurePersonalSpace(db, user.id);
  await logActivity(db, c, { action: 'auth.login', actor: { id: user.id, label: `${fullName(user)} <${user.email}>` } });
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', requireAuth, async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const [personal, pendingInvitations] = await Promise.all([
    db.space.findFirst({ where: { type: 'PERSONAL', ownerId: user.id }, select: { id: true } }),
    db.spaceInvitation.count({ where: { inviteeId: user.id, status: 'PENDING', space: { archivedAt: null } } }),
  ]);
  const cfg = c.get('config');
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      canCreateSpaces: user.canCreateSpaces,
    },
    personalSpaceId: personal?.id ?? null,
    pendingInvitations,
    limits: { maxFileSizeBytes: cfg.maxFileSizeBytes },
  });
});

authRoutes.get('/auth/usage', requireAuth, async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const personal = await db.space.findFirst({ where: { type: 'PERSONAL', ownerId: user.id }, select: { id: true } });
  return c.json({
    personal: { used: personal ? await spaceUsage(db, personal.id) : 0, quota: personalQuota(c.get('config'), user) },
  });
});

authRoutes.patch('/auth/profile', requireAuth, async (c) => {
  const data = await body(c, z.object({ firstName: text(80), lastName: text(80) }));
  await c.get('db').user.update({ where: { id: c.get('user').id }, data });
  await logActivity(c.get('db'), c, { action: 'user.profile_update', targetType: 'user', targetId: c.get('user').id });
  return c.json({ ok: true });
});

authRoutes.post('/auth/password', requireAuth, async (c) => {
  const data = await body(c, z.object({ currentAuthKey: authKey, newAuthKey: authKey }));
  const db = c.get('db');
  const me = c.get('user');
  await rateLimit(c, `password:${me.id}`, 8, 900);
  const user = await db.user.findUniqueOrThrow({ where: { id: me.id } });
  if (!(await verifyAuthKey(data.currentAuthKey, user.passwordHash))) {
    throw badRequest('Le mot de passe actuel est incorrect.', 'INVALID_CREDENTIALS');
  }
  await db.$transaction([
    db.user.update({ where: { id: me.id }, data: { passwordHash: await hashAuthKey(data.newAuthKey, c.get('config').passwordIterations) } }),
    // Les autres sessions sont révoquées ; la session courante est conservée.
    db.session.deleteMany({ where: { userId: me.id, id: { not: c.get('sessionId') } } }),
  ]);
  await logActivity(db, c, { action: 'auth.password_change', targetType: 'user', targetId: me.id });
  return c.json({ ok: true });
});
