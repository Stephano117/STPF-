// Administration. Toutes les routes exigent le rôle ADMIN et sont journalisées.
// Les espaces personnels restent hors de portée : seules leurs tailles (quotas) sont visibles.

import { Hono } from 'hono';
import { z } from 'zod';
import { body, fullName, logActivity, query, type AppEnv } from '../lib/context.ts';
import { requireAdmin, requireAuth } from '../lib/auth.ts';
import { globalUsage, personalQuota, subtreeIds } from '../lib/access.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { transaction, type DbOrTx } from '../lib/db.ts';
import { COMPANY_SPACE_ID, ensurePersonalSpace } from '../lib/bootstrap.ts';
import { fileDto, purgeFiles, restoreFile, trashFile, trashFolder, uploaderSelect } from '../lib/fileops.ts';
import { quotaLevel, runMaintenance } from '../lib/maintenance.ts';
import { hashAuthKey } from '../lib/crypto.ts';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAuth, requireAdmin);

const reason = z.string().trim().min(5, 'Indiquez le motif (5 caractères minimum).').max(500);
const page = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

// ───────────────────────────── Utilisateurs ─────────────────────────────

adminRoutes.get('/users', async (c) => {
  const q = query(c, z.object({ status: z.enum(['', 'PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).default(''), q: z.string().trim().max(100).default('') }));
  const users = await c.get('db').user.findMany({
    where: {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { firstName: { contains: q.q, mode: 'insensitive' } },
              { lastName: { contains: q.q, mode: 'insensitive' } },
              { email: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: {
      id: true, email: true, firstName: true, lastName: true, role: true, status: true,
      canCreateSpaces: true, quotaBytes: true, createdAt: true, lastLoginAt: true, reviewedAt: true,
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });
  return c.json({ users: users.map((u) => ({ ...u, quotaBytes: u.quotaBytes === null ? null : Number(u.quotaBytes) })) });
});

async function activeAdminCount(db: DbOrTx): Promise<number> {
  return db.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
}

const TRANSITIONS = {
  approve: { from: ['PENDING', 'REJECTED'], to: 'ACTIVE', action: 'admin.user_approve' },
  reject: { from: ['PENDING'], to: 'REJECTED', action: 'admin.user_reject' },
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED', action: 'admin.user_suspend' },
  reactivate: { from: ['SUSPENDED'], to: 'ACTIVE', action: 'admin.user_reactivate' },
} as const;

adminRoutes.post('/users/:id/:op{approve|reject|suspend|reactivate}', async (c) => {
  const db = c.get('db');
  const me = c.get('user');
  const op = TRANSITIONS[c.req.param('op') as keyof typeof TRANSITIONS];
  const target = await db.user.findUnique({ where: { id: c.req.param('id') } });
  if (!target) throw notFound('Utilisateur introuvable.');
  if (target.id === me.id) throw forbidden('Vous ne pouvez pas modifier l’état de votre propre compte.');
  await transaction(db, async (tx) => {
    if (op.to === 'SUSPENDED' && target.role === 'ADMIN' && (await activeAdminCount(tx)) <= 1) {
      throw forbidden('Impossible de suspendre le dernier administrateur.');
    }
    // Garde sur l'état d'origine : deux administrateurs ne peuvent pas traiter la même demande.
    const res = await tx.user.updateMany({
      where: { id: target.id, status: { in: [...op.from] } },
      data: { status: op.to, reviewedAt: new Date(), reviewedById: me.id },
    });
    if (res.count === 0) throw conflict('L’état de ce compte a déjà changé. Actualisez la liste.', 'STALE');
    if (op.to === 'ACTIVE') await ensurePersonalSpace(tx, target.id);
    // Suspension ou refus : toutes les sessions sont révoquées immédiatement.
    if (op.to !== 'ACTIVE') await tx.session.deleteMany({ where: { userId: target.id } });
    await logActivity(tx, c, { action: op.action, targetType: 'user', targetId: target.id, targetLabel: `${fullName(target)} <${target.email}>` });
  });
  return c.json({ ok: true });
});

/**
 * Réinitialisation d'un mot de passe oublié. L'administrateur choisit un mot de passe
 * provisoire (étiré dans son navigateur, jamais transmis en clair) et le communique de vive
 * voix ; toutes les sessions du compte sont révoquées et l'opération est journalisée.
 */
adminRoutes.post('/users/:id/password', async (c) => {
  const db = c.get('db');
  const data = await body(c, z.object({ authKey: z.string().regex(/^[0-9a-f]{64}$/) }));
  const target = await db.user.findUnique({ where: { id: c.req.param('id') } });
  if (!target) throw notFound('Utilisateur introuvable.');
  if (target.id === c.get('user').id) throw forbidden('Modifiez votre propre mot de passe depuis votre profil.');
  const passwordHash = await hashAuthKey(data.authKey, c.get('config').passwordIterations);
  await transaction(db, async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await logActivity(tx, c, { action: 'admin.user_password_reset', targetType: 'user', targetId: target.id, targetLabel: `${fullName(target)} <${target.email}>` });
  });
  return c.json({ ok: true });
});

adminRoutes.patch('/users/:id', async (c) => {
  const db = c.get('db');
  const me = c.get('user');
  const data = await body(
    c,
    z.object({
      role: z.enum(['USER', 'ADMIN']).optional(),
      canCreateSpaces: z.boolean().optional(),
      quotaBytes: z.number().int().min(0).max(1e13).nullable().optional(),
    }),
  );
  const target = await db.user.findUnique({ where: { id: c.req.param('id') } });
  if (!target) throw notFound('Utilisateur introuvable.');
  if (data.role && data.role !== target.role && target.id === me.id) throw forbidden('Vous ne pouvez pas modifier votre propre rôle.');
  await transaction(db, async (tx) => {
    if (data.role === 'USER' && target.role === 'ADMIN' && target.status === 'ACTIVE' && (await activeAdminCount(tx)) <= 1) {
      throw forbidden('Impossible de retirer le dernier administrateur.');
    }
    await tx.user.update({
      where: { id: target.id },
      data: { ...data, quotaBytes: data.quotaBytes === undefined ? undefined : data.quotaBytes === null ? null : BigInt(data.quotaBytes) },
    });
    await logActivity(tx, c, { action: 'admin.user_update', targetType: 'user', targetId: target.id, targetLabel: `${fullName(target)} <${target.email}>`, metadata: data });
  });
  return c.json({ ok: true });
});

// ───────────────────────────── Espaces et permissions ─────────────────────────────

async function usageBySpace(db: DbOrTx): Promise<Map<string, { files: number; bytes: number }>> {
  const rows = await db.$queryRaw<{ spaceId: string; files: bigint; bytes: bigint | null }[]>`
    SELECT f."spaceId", count(DISTINCT f."id") AS files, sum(v."size") AS bytes
    FROM "File" f JOIN "FileVersion" v ON v."fileId" = f."id" GROUP BY f."spaceId"`;
  return new Map(rows.map((r) => [r.spaceId, { files: Number(r.files), bytes: Number(r.bytes ?? 0) }]));
}

adminRoutes.get('/spaces', async (c) => {
  const db = c.get('db');
  const [spaces, usage] = await Promise.all([
    db.space.findMany({
      where: { type: { in: ['COMPANY', 'SHARED'] } },
      include: { owner: { select: { id: true, firstName: true, lastName: true, email: true } }, _count: { select: { members: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    usageBySpace(db),
  ]);
  return c.json({
    spaces: spaces.map((s) => ({
      id: s.id, type: s.type, name: s.name, description: s.description, owner: s.owner, memberCount: s._count.members,
      createdAt: s.createdAt, archivedAt: s.archivedAt, fileCount: usage.get(s.id)?.files ?? 0, usedBytes: usage.get(s.id)?.bytes ?? 0,
    })),
  });
});

async function sharedSpace(db: DbOrTx, id: string) {
  const space = await db.space.findFirst({ where: { id, type: 'SHARED' } });
  if (!space) throw notFound('Espace partagé introuvable.');
  return space;
}

adminRoutes.get('/spaces/:id/members', async (c) => {
  const db = c.get('db');
  const space = await sharedSpace(db, c.req.param('id'));
  const members = await db.spaceMember.findMany({
    where: { spaceId: space.id },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return c.json({ members: members.map((m) => ({ ...m.user, role: m.role, since: m.createdAt })) });
});

adminRoutes.put('/spaces/:id/members/:userId', async (c) => {
  const db = c.get('db');
  const space = await sharedSpace(db, c.req.param('id'));
  const data = await body(c, z.object({ role: z.enum(['OWNER', 'MANAGER', 'EDITOR', 'READER']) }));
  const target = await db.user.findFirst({ where: { id: c.req.param('userId'), status: 'ACTIVE' } });
  if (!target) throw badRequest('Collaborateur introuvable ou inactif.');
  await transaction(db, async (tx) => {
    const current = await tx.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: space.id, userId: target.id } } });
    if (current?.role === 'OWNER' && data.role !== 'OWNER') throw forbidden('Désignez d’abord un autre propriétaire.');
    if (data.role === 'OWNER') {
      // Transfert de propriété : l'ancien propriétaire devient gestionnaire.
      await tx.spaceMember.updateMany({ where: { spaceId: space.id, role: 'OWNER' }, data: { role: 'MANAGER' } });
      await tx.space.update({ where: { id: space.id }, data: { ownerId: target.id } });
    }
    await tx.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: target.id } },
      update: { role: data.role },
      create: { spaceId: space.id, userId: target.id, role: data.role },
    });
    await logActivity(tx, c, { action: 'admin.member_set', targetType: 'user', targetId: target.id, targetLabel: fullName(target), spaceId: space.id, metadata: { role: data.role, previous: current?.role ?? null, space: space.name } });
  });
  return c.json({ ok: true });
});

adminRoutes.delete('/spaces/:id/members/:userId', async (c) => {
  const db = c.get('db');
  const space = await sharedSpace(db, c.req.param('id'));
  const current = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: space.id, userId: c.req.param('userId') } } });
  if (!current) throw notFound('Membre introuvable.');
  if (current.role === 'OWNER') throw forbidden('Désignez d’abord un autre propriétaire.');
  await db.spaceMember.delete({ where: { spaceId_userId: { spaceId: space.id, userId: current.userId } } });
  await logActivity(db, c, { action: 'admin.member_remove', targetType: 'user', targetId: current.userId, spaceId: space.id, metadata: { space: space.name } });
  return c.json({ ok: true });
});

adminRoutes.post('/spaces/:id/:op{archive|restore}', async (c) => {
  const db = c.get('db');
  const space = await sharedSpace(db, c.req.param('id'));
  const archive = c.req.param('op') === 'archive';
  await db.space.update({ where: { id: space.id }, data: archive ? { archivedAt: new Date(), archivedById: c.get('user').id } : { archivedAt: null, archivedById: null } });
  await logActivity(db, c, { action: archive ? 'admin.space_archive' : 'admin.space_restore', targetType: 'space', targetId: space.id, targetLabel: space.name, spaceId: space.id });
  return c.json({ ok: true });
});

/** Suppression définitive d'un espace archivé et de tous ses fichiers. Irréversible, motif exigé. */
adminRoutes.delete('/spaces/:id', async (c) => {
  const db = c.get('db');
  const space = await sharedSpace(db, c.req.param('id'));
  const data = await body(c, z.object({ reason, confirmName: z.string() }));
  if (!space.archivedAt) throw badRequest('Archivez l’espace avant de le supprimer définitivement.');
  if (data.confirmName !== space.name) throw badRequest('Le nom de confirmation ne correspond pas à l’espace.');
  const files = await db.file.findMany({ where: { spaceId: space.id }, select: { id: true } });
  const purged = await purgeFiles(db, c, { ids: files.map((f) => f.id) }, 'admin.file_purge', { reason: data.reason, withSpace: space.name });
  await transaction(db, async (tx) => {
    await tx.space.delete({ where: { id: space.id } });
    await logActivity(tx, c, { action: 'admin.space_purge', targetType: 'space', targetId: space.id, targetLabel: space.name, metadata: { reason: data.reason, files: purged } });
  });
  return c.json({ ok: true, purgedFiles: purged });
});

/** Dossier officiel de l'espace entreprise : écriture réservée aux administrateurs. */
adminRoutes.patch('/folders/:id', async (c) => {
  const db = c.get('db');
  const data = await body(c, z.object({ restricted: z.boolean() }));
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), spaceId: COMPANY_SPACE_ID, deletedAt: null } });
  if (!folder) throw notFound('Dossier de l’espace entreprise introuvable.');
  await transaction(db, async (tx) => {
    await tx.folder.updateMany({ where: { id: { in: await subtreeIds(tx, folder.id) } }, data });
    await logActivity(tx, c, { action: 'admin.folder_policy', targetType: 'folder', targetId: folder.id, targetLabel: folder.name, spaceId: COMPANY_SPACE_ID, metadata: data });
  });
  return c.json({ ok: true });
});

adminRoutes.delete('/folders/:id', async (c) => {
  const db = c.get('db');
  const data = await body(c, z.object({ reason }));
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), deletedAt: null, space: { type: { not: 'PERSONAL' } } } });
  if (!folder) throw notFound('Dossier introuvable.');
  await transaction(db, (tx) => trashFolder(tx, c, folder, { adminReason: data.reason, isPrivate: false }));
  return c.json({ ok: true });
});

// ───────────────────────────── Fichiers ─────────────────────────────

adminRoutes.get('/files', async (c) => {
  const db = c.get('db');
  const q = query(c, page.extend({ q: z.string().trim().max(100).default(''), spaceId: z.string().optional(), deleted: z.enum(['0', '1']).default('0') }));
  const files = await db.file.findMany({
    where: {
      space: { type: { not: 'PERSONAL' } }, // les espaces personnels sont strictement privés
      ...(q.spaceId ? { spaceId: q.spaceId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
      deletedAt: q.deleted === '1' ? { not: null } : null,
    },
    include: { uploader: { select: uploaderSelect }, space: { select: { name: true, type: true } }, folder: { select: { name: true } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const items = files.slice(0, q.limit);
  return c.json({
    files: items.map((f) => ({ ...fileDto(f, c.get('user')), spaceName: f.space.name, spaceType: f.space.type, folderName: f.folder?.name ?? null })),
    nextCursor: files.length > q.limit ? items[items.length - 1]!.id : null,
  });
});

async function adminFile(db: DbOrTx, id: string) {
  const file = await db.file.findFirst({ where: { id, space: { type: { not: 'PERSONAL' } } } });
  if (!file) throw notFound('Fichier introuvable.');
  return file;
}

/** Droit exceptionnel de suppression administrative : motif obligatoire, journalisé. */
adminRoutes.delete('/files/:id', async (c) => {
  const db = c.get('db');
  const data = await body(c, z.object({ reason }));
  const file = await adminFile(db, c.req.param('id'));
  if (file.deletedAt) throw badRequest('Ce fichier est déjà dans la corbeille.');
  await transaction(db, (tx) => trashFile(tx, c, file, { adminReason: data.reason, isPrivate: false }));
  return c.json({ ok: true });
});

adminRoutes.post('/files/:id/restore', async (c) => {
  const db = c.get('db');
  const file = await adminFile(db, c.req.param('id'));
  if (!file.deletedAt) throw badRequest('Ce fichier n’est pas dans la corbeille.');
  await transaction(db, (tx) => restoreFile(tx, c, file, false, true));
  return c.json({ ok: true });
});

adminRoutes.delete('/files/:id/permanent', async (c) => {
  const db = c.get('db');
  const data = await body(c, z.object({ reason }));
  const file = await adminFile(db, c.req.param('id'));
  if (!file.deletedAt) throw badRequest('Placez d’abord le fichier dans la corbeille.');
  await purgeFiles(db, c, { id: file.id }, 'admin.file_purge', { reason: data.reason });
  return c.json({ ok: true });
});

// ───────────────────────────── Quotas, journaux, état ─────────────────────────────

adminRoutes.get('/quotas', async (c) => {
  const db = c.get('db');
  const cfg = c.get('config');
  const [usage, bySpace, personals, shared] = await Promise.all([
    globalUsage(db),
    usageBySpace(db),
    db.space.findMany({
      where: { type: 'PERSONAL', owner: { isNot: null } },
      select: { id: true, owner: { select: { id: true, firstName: true, lastName: true, email: true, quotaBytes: true, status: true } } },
    }),
    db.space.findMany({ where: { type: { in: ['COMPANY', 'SHARED'] } }, select: { id: true, name: true, type: true, archivedAt: true } }),
  ]);
  return c.json({
    global: { usedBytes: usage.stored, pendingBytes: usage.pending, quotaBytes: cfg.storageQuotaBytes, level: quotaLevel(usage.stored + usage.pending, cfg.storageQuotaBytes) },
    defaults: { userQuotaBytes: cfg.userQuotaBytes, maxFileSizeBytes: cfg.maxFileSizeBytes },
    users: personals
      .map((p) => {
        const used = bySpace.get(p.id)?.bytes ?? 0;
        const quota = personalQuota(cfg, p.owner!);
        return { id: p.owner!.id, name: fullName(p.owner!), email: p.owner!.email, status: p.owner!.status, usedBytes: used, quotaBytes: quota, customQuota: p.owner!.quotaBytes !== null, level: quotaLevel(used, quota) };
      })
      .sort((a, b) => b.usedBytes - a.usedBytes),
    spaces: shared
      .map((s) => ({ id: s.id, name: s.name, type: s.type, archived: !!s.archivedAt, usedBytes: bySpace.get(s.id)?.bytes ?? 0, fileCount: bySpace.get(s.id)?.files ?? 0 }))
      .sort((a, b) => b.usedBytes - a.usedBytes),
  });
});

adminRoutes.get('/logs', async (c) => {
  const q = query(c, page.extend({ action: z.string().max(60).default(''), actor: z.string().trim().max(100).default(''), from: z.string().optional(), to: z.string().optional() }));
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  const logs = await c.get('db').activityLog.findMany({
    where: {
      private: false, // l'activité des espaces personnels n'est pas consultable
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.actor ? { actorLabel: { contains: q.actor, mode: 'insensitive' } } : {}),
      ...(from && !isNaN(+from) ? { createdAt: { gte: from, ...(to && !isNaN(+to) ? { lte: to } : {}) } } : to && !isNaN(+to) ? { createdAt: { lte: to } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const items = logs.slice(0, q.limit);
  return c.json({ logs: items, nextCursor: logs.length > q.limit ? items[items.length - 1]!.id : null });
});

adminRoutes.get('/status', async (c) => {
  const db = c.get('db');
  const cfg = c.get('config');
  const since = new Date(Date.now() - 86_400_000);
  const dbStart = Date.now();
  const sizeRows = await db.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
  const dbMs = Date.now() - dbStart;
  const storageStart = Date.now();
  let storage: { ok: boolean; ms?: number; error?: string };
  try {
    await c.get('storage').check();
    storage = { ok: true, ms: Date.now() - storageStart };
  } catch (err) {
    storage = { ok: false, error: (err as Error).message.slice(0, 200) };
  }
  const [usage, pendingUsers, activeUsers, files, pendingUploads, errors24h, recentErrors, lastMaintenance] = await Promise.all([
    globalUsage(db),
    db.user.count({ where: { status: 'PENDING' } }),
    db.user.count({ where: { status: 'ACTIVE' } }),
    db.file.count({ where: { deletedAt: null } }),
    db.upload.count({ where: { status: 'PENDING' } }),
    db.errorLog.count({ where: { createdAt: { gte: since } } }),
    db.errorLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    db.activityLog.findFirst({ where: { action: 'system.maintenance' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, metadata: true } }),
  ]);
  const dbBytes = Number(sizeRows[0]?.size ?? 0);
  const storageLevel = quotaLevel(usage.stored + usage.pending, cfg.storageQuotaBytes);
  const dbLevel = quotaLevel(dbBytes, cfg.databaseQuotaBytes);
  const alerts: { level: 'warning' | 'critical'; message: string }[] = [];
  if (storageLevel !== 'ok') alerts.push({ level: storageLevel, message: `Stockage des fichiers utilisé à ${Math.round(((usage.stored + usage.pending) / cfg.storageQuotaBytes) * 100)} %.` });
  if (dbLevel !== 'ok') alerts.push({ level: dbLevel, message: `Base de données utilisée à ${Math.round((dbBytes / cfg.databaseQuotaBytes) * 100)} %.` });
  if (!storage.ok) alerts.push({ level: 'critical', message: 'Le stockage des fichiers ne répond pas.' });
  if (!lastMaintenance || lastMaintenance.createdAt.getTime() < Date.now() - 3 * 86_400_000) {
    alerts.push({ level: 'warning', message: 'La maintenance automatique n’a pas tourné depuis plus de 3 jours.' });
  }
  if (errors24h >= 20) alerts.push({ level: 'warning', message: `${errors24h} erreurs enregistrées sur les dernières 24 heures.` });
  return c.json({
    version: cfg.version,
    database: { ok: true, ms: dbMs, usedBytes: dbBytes, quotaBytes: cfg.databaseQuotaBytes, level: dbLevel },
    storage: { ...storage, usedBytes: usage.stored, pendingBytes: usage.pending, quotaBytes: cfg.storageQuotaBytes, level: storageLevel },
    counts: { pendingUsers, activeUsers, files, pendingUploads, errors24h },
    lastMaintenance,
    alerts,
    recentErrors,
  });
});

adminRoutes.post('/maintenance', async (c) => {
  const summary = await runMaintenance({ db: c.get('db'), storage: c.get('storage'), config: c.get('config') });
  await logActivity(c.get('db'), c, { action: 'admin.maintenance_run' });
  return c.json({ ok: true, summary });
});
