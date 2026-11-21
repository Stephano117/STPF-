import { Hono } from 'hono';
import { z } from 'zod';
import { body, fullName, logActivity, query, type AppEnv } from '../lib/context.ts';
import { requireAuth } from '../lib/auth.ts';
import { atLeast, getSpaceAccess, spaceUsage, type Role } from '../lib/access.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { COMPANY_SPACE_ID, ensurePersonalSpace } from '../lib/bootstrap.ts';
import { transaction } from '../lib/db.ts';

const name = z.string().trim().min(1, 'Nom requis.').max(100);
const description = z.string().trim().max(500).default('');
const assignableRole = z.enum(['MANAGER', 'EDITOR', 'READER']);

export const spaceRoutes = new Hono<AppEnv>();
spaceRoutes.use('*', requireAuth);

const userSummary = { id: true, firstName: true, lastName: true, email: true } as const;

spaceRoutes.get('/spaces', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const personalSpaceId = await ensurePersonalSpace(db, user.id);
  const memberships = await db.spaceMember.findMany({
    where: { userId: user.id, space: { type: 'SHARED', archivedAt: null } },
    include: { space: { include: { owner: { select: userSummary }, _count: { select: { members: true } } } } },
    orderBy: { space: { name: 'asc' } },
  });
  return c.json({
    companySpaceId: COMPANY_SPACE_ID,
    personalSpaceId,
    shared: memberships.map((m) => ({
      id: m.space.id,
      name: m.space.name,
      description: m.space.description,
      role: m.role,
      owner: m.space.owner,
      memberCount: m.space._count.members,
      createdAt: m.space.createdAt,
    })),
  });
});

spaceRoutes.post('/spaces', async (c) => {
  const user = c.get('user');
  if (!user.canCreateSpaces) throw forbidden('Vous n’êtes pas autorisé à créer des espaces partagés.');
  const data = await body(c, z.object({ name, description }));
  const db = c.get('db');
  const space = await transaction(db, async (tx) => {
    const created = await tx.space.create({ data: { type: 'SHARED', name: data.name, description: data.description, ownerId: user.id } });
    await tx.spaceMember.create({ data: { spaceId: created.id, userId: user.id, role: 'OWNER' } });
    await logActivity(tx, c, { action: 'space.create', targetType: 'space', targetId: created.id, targetLabel: created.name, spaceId: created.id });
    return created;
  });
  return c.json({ id: space.id }, 201);
});

spaceRoutes.get('/spaces/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { space, role } = await getSpaceAccess(db, user, c.req.param('id'));
  const base = { id: space.id, type: space.type, name: space.name, description: space.description, role, createdAt: space.createdAt };
  if (space.type !== 'SHARED') return c.json({ space: base, members: [], invitations: [], usage: await spaceUsage(db, space.id) });
  const [members, invitations, usage] = await Promise.all([
    db.spaceMember.findMany({ where: { spaceId: space.id }, include: { user: { select: userSummary } }, orderBy: { createdAt: 'asc' } }),
    atLeast(role, 'MANAGER')
      ? db.spaceInvitation.findMany({ where: { spaceId: space.id, status: 'PENDING' }, include: { invitee: { select: userSummary } }, orderBy: { createdAt: 'desc' } })
      : [],
    spaceUsage(db, space.id),
  ]);
  return c.json({
    space: base,
    members: members.map((m) => ({ ...m.user, role: m.role, since: m.createdAt })),
    invitations: invitations.map((i) => ({ id: i.id, role: i.role, createdAt: i.createdAt, invitee: i.invitee })),
    usage,
  });
});

spaceRoutes.patch('/spaces/:id', async (c) => {
  const db = c.get('db');
  const { space, role } = await getSpaceAccess(db, c.get('user'), c.req.param('id'));
  if (space.type !== 'SHARED' || !atLeast(role, 'MANAGER')) throw forbidden();
  const data = await body(c, z.object({ name, description }));
  await db.space.update({ where: { id: space.id }, data });
  await logActivity(db, c, { action: 'space.update', targetType: 'space', targetId: space.id, targetLabel: data.name, spaceId: space.id });
  return c.json({ ok: true });
});

// Archivage : l'espace disparaît pour ses membres mais rien n'est détruit.
// Seul un administrateur peut ensuite le restaurer ou le purger (opération journalisée).
spaceRoutes.delete('/spaces/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { space, role } = await getSpaceAccess(db, user, c.req.param('id'));
  if (space.type !== 'SHARED' || role !== 'OWNER') throw forbidden('Seul le propriétaire peut archiver un espace.');
  await db.space.update({ where: { id: space.id }, data: { archivedAt: new Date(), archivedById: user.id } });
  await logActivity(db, c, { action: 'space.archive', targetType: 'space', targetId: space.id, targetLabel: space.name, spaceId: space.id });
  return c.json({ ok: true });
});

// ───────────────────────────── Membres et invitations ─────────────────────────────

/** Annuaire des collaborateurs actifs, pour inviter. */
spaceRoutes.get('/directory', async (c) => {
  const { q } = query(c, z.object({ q: z.string().trim().max(100).default('') }));
  const where = {
    status: 'ACTIVE' as const,
    id: { not: c.get('user').id },
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' as const } },
            { lastName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const users = await c.get('db').user.findMany({
    where,
    select: userSummary,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 20,
  });
  return c.json({ users });
});

spaceRoutes.post('/spaces/:id/invitations', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { space, role } = await getSpaceAccess(db, user, c.req.param('id'));
  if (space.type !== 'SHARED' || !atLeast(role, 'MANAGER')) throw forbidden('Seuls le propriétaire et les gestionnaires peuvent inviter.');
  const data = await body(c, z.object({ userId: z.string().min(1), role: assignableRole }));
  if (data.role === 'MANAGER' && role !== 'OWNER') throw forbidden('Seul le propriétaire peut nommer un gestionnaire.');
  const invitee = await db.user.findFirst({ where: { id: data.userId, status: 'ACTIVE' } });
  if (!invitee) throw badRequest('Collaborateur introuvable.');
  const [member, pending] = await Promise.all([
    db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: space.id, userId: invitee.id } } }),
    db.spaceInvitation.findFirst({ where: { spaceId: space.id, inviteeId: invitee.id, status: 'PENDING' } }),
  ]);
  if (member) throw conflict('Cette personne est déjà membre de l’espace.');
  if (pending) throw conflict('Une invitation est déjà en attente pour cette personne.');
  const invitation = await db.spaceInvitation.create({
    data: { spaceId: space.id, inviteeId: invitee.id, invitedById: user.id, role: data.role },
  });
  await logActivity(db, c, {
    action: 'space.invite',
    targetType: 'user',
    targetId: invitee.id,
    targetLabel: fullName(invitee),
    spaceId: space.id,
    metadata: { role: data.role, space: space.name },
  });
  return c.json({ id: invitation.id }, 201);
});

spaceRoutes.delete('/spaces/:id/invitations/:invitationId', async (c) => {
  const db = c.get('db');
  const { space, role } = await getSpaceAccess(db, c.get('user'), c.req.param('id'));
  if (!atLeast(role, 'MANAGER')) throw forbidden();
  const res = await db.spaceInvitation.updateMany({
    where: { id: c.req.param('invitationId'), spaceId: space.id, status: 'PENDING' },
    data: { status: 'CANCELLED', respondedAt: new Date() },
  });
  if (res.count === 0) throw notFound('Invitation introuvable.');
  await logActivity(db, c, { action: 'space.invite_cancel', targetType: 'invitation', targetId: c.req.param('invitationId'), spaceId: space.id });
  return c.json({ ok: true });
});

spaceRoutes.get('/invitations', async (c) => {
  const invitations = await c.get('db').spaceInvitation.findMany({
    where: { inviteeId: c.get('user').id, status: 'PENDING', space: { archivedAt: null } },
    include: { space: { select: { id: true, name: true, description: true } }, invitedBy: { select: userSummary } },
    orderBy: { createdAt: 'desc' },
  });
  return c.json({
    invitations: invitations.map((i) => ({ id: i.id, role: i.role, createdAt: i.createdAt, space: i.space, invitedBy: i.invitedBy })),
  });
});

spaceRoutes.post('/invitations/:id/:answer{accept|decline}', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const accept = c.req.param('answer') === 'accept';
  const spaceId = await transaction(db, async (tx) => {
    const invitation = await tx.spaceInvitation.findFirst({
      where: { id: c.req.param('id'), inviteeId: user.id, status: 'PENDING', space: { archivedAt: null } },
      include: { space: true },
    });
    if (!invitation) throw notFound('Invitation introuvable ou déjà traitée.');
    // Verrou : deux réponses simultanées ne peuvent pas toutes deux réussir.
    const claimed = await tx.spaceInvitation.updateMany({
      where: { id: invitation.id, status: 'PENDING' },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED', respondedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict('Invitation déjà traitée.');
    if (accept) {
      await tx.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: invitation.spaceId, userId: user.id } },
        update: {},
        create: { spaceId: invitation.spaceId, userId: user.id, role: invitation.role },
      });
    }
    await logActivity(tx, c, {
      action: accept ? 'space.invite_accept' : 'space.invite_decline',
      targetType: 'space',
      targetId: invitation.spaceId,
      targetLabel: invitation.space.name,
      spaceId: invitation.spaceId,
    });
    return invitation.spaceId;
  });
  return c.json({ ok: true, spaceId });
});

spaceRoutes.patch('/spaces/:id/members/:userId', async (c) => {
  const db = c.get('db');
  const { space, role } = await getSpaceAccess(db, c.get('user'), c.req.param('id'));
  const data = await body(c, z.object({ role: assignableRole }));
  const target = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: space.id, userId: c.req.param('userId') } } });
  if (!target) throw notFound('Membre introuvable.');
  assertCanManage(role, target.role as Role, data.role);
  await db.spaceMember.update({ where: { spaceId_userId: { spaceId: space.id, userId: target.userId } }, data: { role: data.role } });
  await logActivity(db, c, { action: 'space.member_role', targetType: 'user', targetId: target.userId, spaceId: space.id, metadata: { from: target.role, to: data.role } });
  return c.json({ ok: true });
});

spaceRoutes.delete('/spaces/:id/members/:userId', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { space, role } = await getSpaceAccess(db, user, c.req.param('id'));
  if (space.type !== 'SHARED') throw forbidden();
  const targetId = c.req.param('userId');
  const target = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: space.id, userId: targetId } } });
  if (!target) throw notFound('Membre introuvable.');
  const leaving = targetId === user.id;
  if (target.role === 'OWNER') throw forbidden('Le propriétaire ne peut pas quitter son espace. Archivez-le si nécessaire.');
  if (!leaving) assertCanManage(role, target.role as Role);
  await db.spaceMember.delete({ where: { spaceId_userId: { spaceId: space.id, userId: targetId } } });
  await logActivity(db, c, { action: leaving ? 'space.leave' : 'space.member_remove', targetType: 'user', targetId, spaceId: space.id, targetLabel: space.name });
  return c.json({ ok: true });
});

/** Un gestionnaire gère éditeurs et lecteurs ; seul le propriétaire gère les gestionnaires. */
function assertCanManage(actor: Role, target: Role, newRole?: Role): void {
  if (!atLeast(actor, 'MANAGER')) throw forbidden();
  if (target === 'OWNER') throw forbidden('Le rôle du propriétaire ne peut pas être modifié.');
  if (actor !== 'OWNER' && (target === 'MANAGER' || newRole === 'MANAGER')) {
    throw forbidden('Seul le propriétaire peut gérer les gestionnaires.');
  }
}
