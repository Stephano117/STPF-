import { Hono } from 'hono';
import { z } from 'zod';
import { body, logActivity, query, type AppEnv } from '../lib/context.ts';
import { requireAuth } from '../lib/auth.ts';
import {
  assertCanWrite,
  atLeast,
  breadcrumbs,
  canWriteIn,
  getFileAccess,
  getFolder,
  getSpaceAccess,
  nameProblem,
  subtreeIds,
  uniqueName,
} from '../lib/access.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { transaction } from '../lib/db.ts';
import {
  accessibleSpaceIds,
  fileDto,
  purgeFiles,
  restoreFile,
  restoreFolder,
  trashFile,
  trashFolder,
  uploaderSelect,
} from '../lib/fileops.ts';
import { CATEGORY_PATTERNS, extensionOf, isBlockedName, isInlineSafe } from '../lib/mime.ts';

const itemName = z.string().max(200).refine((n) => nameProblem(n) === null, { error: (iss) => nameProblem(String(iss.input)) ?? 'Nom invalide.' });
const nullableId = z.string().min(1).nullable();

export const contentRoutes = new Hono<AppEnv>();
contentRoutes.use('*', requireAuth);

const fileInclude = (userId: string) => ({ uploader: { select: uploaderSelect }, favorites: { where: { userId }, select: { userId: true } } });

// ───────────────────────────── Navigation ─────────────────────────────

contentRoutes.get('/spaces/:id/contents', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { folderId } = query(c, z.object({ folderId: z.string().optional() }));
  const access = await getSpaceAccess(db, user, c.req.param('id'));
  const folder = await getFolder(db, access.space.id, folderId);
  const [folders, files, crumbs] = await Promise.all([
    db.folder.findMany({ where: { spaceId: access.space.id, parentId: folder?.id ?? null, deletedAt: null }, orderBy: { name: 'asc' } }),
    db.file.findMany({
      where: { spaceId: access.space.id, folderId: folder?.id ?? null, deletedAt: null },
      include: fileInclude(user.id),
      orderBy: { name: 'asc' },
    }),
    breadcrumbs(db, folder?.id ?? null),
  ]);
  return c.json({
    space: { id: access.space.id, type: access.space.type, name: access.space.name, role: access.role },
    folder: folder ? { id: folder.id, name: folder.name, parentId: folder.parentId } : null,
    breadcrumbs: crumbs,
    canWrite: canWriteIn(user, access, folder),
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      restricted: f.restricted,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      canWrite: canWriteIn(user, access, f),
      canDelete: f.createdById === user.id,
    })),
    files: files.map((f) => fileDto(f, user)),
  });
});

/** Arborescence des dossiers d'un espace (sélecteur de destination pour « Déplacer »). */
contentRoutes.get('/spaces/:id/tree', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const access = await getSpaceAccess(db, user, c.req.param('id'));
  const folders = await db.folder.findMany({
    where: { spaceId: access.space.id, deletedAt: null },
    select: { id: true, name: true, parentId: true, restricted: true },
    orderBy: { name: 'asc' },
  });
  return c.json({
    rootWritable: canWriteIn(user, access, null),
    folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, canWrite: canWriteIn(user, access, f) })),
  });
});

// ───────────────────────────── Dossiers ─────────────────────────────

contentRoutes.post('/folders', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const data = await body(c, z.object({ spaceId: z.string().min(1), parentId: nullableId.default(null), name: itemName }));
  const access = await getSpaceAccess(db, user, data.spaceId);
  const parent = await getFolder(db, access.space.id, data.parentId);
  assertCanWrite(user, access, parent);
  const folder = await transaction(db, async (tx) => {
    const free = await uniqueName(tx, 'folder', access.space.id, parent?.id ?? null, data.name);
    if (free !== data.name) throw conflict('Un dossier porte déjà ce nom à cet emplacement.', 'NAME_TAKEN');
    const created = await tx.folder.create({
      data: {
        spaceId: access.space.id,
        parentId: parent?.id ?? null,
        name: data.name,
        createdById: user.id,
        // Un sous-dossier hérite de la politique d'écriture de son parent.
        restricted: parent?.restricted ?? false,
      },
    });
    await logActivity(tx, c, { action: 'folder.create', targetType: 'folder', targetId: created.id, targetLabel: created.name, spaceId: access.space.id, private: access.space.type === 'PERSONAL' });
    return created;
  });
  return c.json({ id: folder.id }, 201);
});

contentRoutes.patch('/folders/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const data = await body(c, z.object({ name: itemName.optional(), parentId: nullableId.optional() }));
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), deletedAt: null } });
  if (!folder) throw notFound('Dossier introuvable.');
  const access = await getSpaceAccess(db, user, folder.spaceId);
  assertCanWrite(user, access, folder);
  const currentParent = await getFolder(db, folder.spaceId, folder.parentId);
  assertCanWrite(user, access, currentParent);

  const moving = data.parentId !== undefined && data.parentId !== folder.parentId;
  const target = moving ? await getFolder(db, folder.spaceId, data.parentId) : currentParent;
  if (moving) {
    assertCanWrite(user, access, target);
    if (target && (await subtreeIds(db, folder.id)).includes(target.id)) {
      throw badRequest('Un dossier ne peut pas être déplacé dans lui-même.');
    }
  }
  const newName = data.name ?? folder.name;
  await transaction(db, async (tx) => {
    const free = await uniqueName(tx, 'folder', folder.spaceId, target?.id ?? null, newName, folder.id);
    if (free !== newName) throw conflict('Un dossier porte déjà ce nom à cet emplacement.', 'NAME_TAKEN');
    await tx.folder.update({ where: { id: folder.id }, data: { name: newName, parentId: target?.id ?? null } });
    if (moving && target && access.space.type === 'COMPANY') {
      // Le dossier déplacé adopte la politique d'écriture de sa destination.
      await tx.folder.updateMany({
        where: { id: { in: await subtreeIds(tx, folder.id) } },
        data: { restricted: target.restricted },
      });
    }
    await logActivity(tx, c, {
      action: moving ? 'folder.move' : 'folder.rename',
      targetType: 'folder',
      targetId: folder.id,
      targetLabel: newName,
      spaceId: folder.spaceId,
      private: access.space.type === 'PERSONAL',
      metadata: { from: folder.name, fromParent: folder.parentId, toParent: target?.id ?? null },
    });
  });
  return c.json({ ok: true });
});

contentRoutes.delete('/folders/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), deletedAt: null } });
  if (!folder) throw notFound('Dossier introuvable.');
  const access = await getSpaceAccess(db, user, folder.spaceId);
  if (folder.createdById !== user.id) throw forbidden('Seul le créateur d’un dossier peut le supprimer.', 'NOT_OWNER');
  await transaction(db, async (tx) => {
    const ids = await subtreeIds(tx, folder.id);
    // Règle n° 8 : un dossier contenant des fichiers importés par d'autres ne peut pas être supprimé.
    const foreign = await tx.file.count({ where: { folderId: { in: ids }, deletedAt: null, uploaderId: { not: user.id } } });
    if (foreign > 0) {
      throw forbidden(`Ce dossier contient ${foreign} fichier(s) importé(s) par d’autres collaborateurs : il ne peut pas être supprimé.`, 'CONTAINS_FOREIGN_FILES');
    }
    await trashFolder(tx, c, folder, { isPrivate: access.space.type === 'PERSONAL' });
  });
  return c.json({ ok: true });
});

contentRoutes.post('/folders/:id/restore', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), deletedAt: { not: null }, deletedById: user.id } });
  if (!folder) throw notFound('Dossier introuvable dans la corbeille.');
  const access = await getSpaceAccess(db, user, folder.spaceId);
  await transaction(db, (tx) => restoreFolder(tx, c, folder, access.space.type === 'PERSONAL'));
  return c.json({ ok: true });
});

// ───────────────────────────── Fichiers ─────────────────────────────

contentRoutes.get('/files/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file, access } = await getFileAccess(db, user, c.req.param('id'));
  const [full, versions, crumbs] = await Promise.all([
    db.file.findUniqueOrThrow({ where: { id: file.id }, include: fileInclude(user.id) }),
    db.fileVersion.findMany({ where: { fileId: file.id }, orderBy: { number: 'desc' } }),
    breadcrumbs(db, file.folderId),
  ]);
  const authors = await db.user.findMany({ where: { id: { in: [...new Set(versions.map((v) => v.uploadedById))] } }, select: uploaderSelect });
  const authorName = new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));
  return c.json({
    file: { ...fileDto(full, user), currentVersionId: file.currentVersionId, canEdit: canWriteIn(user, access, file.folder), previewable: isInlineSafe(file.mimeType) },
    space: { id: access.space.id, type: access.space.type, name: access.space.name },
    breadcrumbs: crumbs,
    versions: versions.map((v) => ({
      id: v.id,
      number: v.number,
      size: Number(v.size),
      mimeType: v.mimeType,
      sha256: v.sha256,
      createdAt: v.createdAt,
      uploadedBy: authorName.get(v.uploadedById) ?? 'Compte supprimé',
      current: v.id === file.currentVersionId,
    })),
  });
});

contentRoutes.get('/files/:id/history', async (c) => {
  const db = c.get('db');
  const { file } = await getFileAccess(db, c.get('user'), c.req.param('id'));
  const events = await db.activityLog.findMany({
    where: { targetType: 'file', targetId: file.id, action: { notIn: ['file.download', 'file.preview'] } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, createdAt: true, action: true, actorLabel: true, metadata: true },
  });
  return c.json({ events: events.map((e) => ({ ...e, actorLabel: e.actorLabel.replace(/\s*<.*>$/, '') })) });
});

/** Délivre une URL signée de courte durée. Les octets ne transitent jamais par l'API. */
contentRoutes.get('/files/:id/download', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const q = query(c, z.object({ versionId: z.string().optional(), inline: z.enum(['0', '1']).default('0'), raw: z.enum(['0', '1']).default('0') }));
  const { file, access } = await getFileAccess(db, user, c.req.param('id'));
  const version = await db.fileVersion.findFirst({ where: { fileId: file.id, id: q.versionId ?? file.currentVersionId ?? '' } });
  if (!version) throw notFound('Version introuvable.');
  // Mode « brut » : octets anonymes (ni nom ni type de fichier) destinés au rendu d'aperçu par
  // l'application. Les gestionnaires de téléchargement n'y reconnaissent pas un document à capturer.
  const raw = q.raw === '1';
  const inline = raw || (q.inline === '1' && isInlineSafe(version.mimeType));
  const cfg = c.get('config');
  const ext = extensionOf(file.name);
  const url = await c.get('storage').presignGet(version.storageKey, cfg.downloadUrlTtlSeconds, {
    filename: raw ? '' : version.id === file.currentVersionId ? file.name : `${file.name.slice(0, file.name.length - (ext ? ext.length + 1 : 0))} (v${version.number})${ext ? `.${ext}` : ''}`,
    // Un type non sûr est toujours servi en téléchargement binaire, jamais interprété.
    contentType: inline && !raw ? version.mimeType : 'application/octet-stream',
    inline,
  });
  await db.recentAccess.upsert({
    where: { userId_fileId: { userId: user.id, fileId: file.id } },
    update: { accessedAt: new Date() },
    create: { userId: user.id, fileId: file.id },
  });
  await logActivity(db, c, {
    // Un aperçu demandé (même rendu par le navigateur à partir des octets) est une consultation.
    action: q.inline === '1' ? 'file.preview' : 'file.download',
    targetType: 'file',
    targetId: file.id,
    targetLabel: file.name,
    spaceId: file.spaceId,
    private: access.space.type === 'PERSONAL',
    metadata: { version: version.number },
  });
  return c.json({ url, expiresInSeconds: cfg.downloadUrlTtlSeconds, mimeType: version.mimeType, inline });
});

/** Aperçu texte : les premiers 256 Ko, renvoyés en JSON (donc jamais interprétés comme du HTML). */
contentRoutes.get('/files/:id/text', async (c) => {
  const db = c.get('db');
  const { file } = await getFileAccess(db, c.get('user'), c.req.param('id'));
  const version = await db.fileVersion.findFirst({ where: { id: file.currentVersionId ?? '' } });
  if (!version) throw notFound();
  if (!/^text\/|json|xml/.test(version.mimeType)) throw badRequest('Ce fichier n’est pas un fichier texte.');
  const limit = 256 * 1024;
  const bytes = await c.get('storage').readRange(version.storageKey, 0, limit - 1);
  return c.json({ text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated: Number(version.size) > limit });
});

contentRoutes.patch('/files/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const data = await body(
    c,
    z.object({ name: itemName.optional(), folderId: nullableId.optional(), expectedRowVersion: z.number().int().optional() }),
  );
  const { file, access } = await getFileAccess(db, user, c.req.param('id'));
  assertCanWrite(user, access, file.folder);
  const moving = data.folderId !== undefined && data.folderId !== file.folderId;
  const target = moving ? await getFolder(db, file.spaceId, data.folderId) : file.folder;
  if (moving) assertCanWrite(user, access, target);
  const requested = data.name ?? file.name;
  if (data.name && isBlockedName(data.name)) throw badRequest('Cette extension de fichier n’est pas acceptée.');
  if (data.name && extensionOf(data.name) !== extensionOf(file.name)) {
    throw badRequest('L’extension d’un fichier ne peut pas être modifiée.', 'EXTENSION_CHANGE');
  }

  const name = await transaction(db, async (tx) => {
    const finalName = await uniqueName(tx, 'file', file.spaceId, target?.id ?? null, requested, file.id);
    if (!moving && finalName !== requested) throw conflict('Un fichier porte déjà ce nom à cet emplacement.', 'NAME_TAKEN');
    // Verrou optimiste : la mise à jour échoue si le fichier a changé entre-temps.
    const res = await tx.file.updateMany({
      where: { id: file.id, deletedAt: null, rowVersion: data.expectedRowVersion ?? file.rowVersion },
      data: { name: finalName, folderId: target?.id ?? null, rowVersion: { increment: 1 } },
    });
    if (res.count === 0) {
      throw conflict('Ce fichier a été modifié par quelqu’un d’autre. Actualisez puis réessayez.', 'STALE');
    }
    await logActivity(tx, c, {
      action: moving ? 'file.move' : 'file.rename',
      targetType: 'file',
      targetId: file.id,
      targetLabel: finalName,
      spaceId: file.spaceId,
      private: access.space.type === 'PERSONAL',
      metadata: { from: file.name, fromFolder: file.folderId, toFolder: target?.id ?? null },
    });
    return finalName;
  });
  return c.json({ ok: true, name });
});

contentRoutes.delete('/files/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file, access } = await getFileAccess(db, user, c.req.param('id'));
  if (file.uploaderId !== user.id) {
    throw forbidden('Seule la personne qui a importé ce fichier peut le supprimer.', 'NOT_UPLOADER');
  }
  await transaction(db, (tx) => trashFile(tx, c, file, { isPrivate: access.space.type === 'PERSONAL' }));
  return c.json({ ok: true });
});

contentRoutes.post('/files/:id/restore', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file, access } = await getFileAccess(db, user, c.req.param('id'), { includeDeleted: true });
  if (!file.deletedAt) throw badRequest('Ce fichier n’est pas dans la corbeille.');
  if (file.uploaderId !== user.id) throw forbidden('Seule la personne qui a importé ce fichier peut le restaurer.', 'NOT_UPLOADER');
  await transaction(db, (tx) => restoreFile(tx, c, file, access.space.type === 'PERSONAL'));
  return c.json({ ok: true });
});

contentRoutes.delete('/files/:id/permanent', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file } = await getFileAccess(db, user, c.req.param('id'), { includeDeleted: true });
  if (file.uploaderId !== user.id) throw forbidden('Seule la personne qui a importé ce fichier peut le supprimer.', 'NOT_UPLOADER');
  if (!file.deletedAt) throw badRequest('Placez d’abord le fichier dans la corbeille.');
  await purgeFiles(db, c, { id: file.id }, 'file.purge');
  return c.json({ ok: true });
});

contentRoutes.put('/files/:id/favorite', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file } = await getFileAccess(db, user, c.req.param('id'));
  await db.favorite.upsert({
    where: { userId_fileId: { userId: user.id, fileId: file.id } },
    update: {},
    create: { userId: user.id, fileId: file.id },
  });
  return c.json({ ok: true });
});

contentRoutes.delete('/files/:id/favorite', async (c) => {
  await c.get('db').favorite.deleteMany({ where: { userId: c.get('user').id, fileId: c.req.param('id') } });
  return c.json({ ok: true });
});

/** Rétablit une version antérieure comme version courante (aucune donnée n'est détruite). */
contentRoutes.post('/files/:id/versions/:versionId/restore', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { file, access } = await getFileAccess(db, user, c.req.param('id'));
  assertCanWrite(user, access, file.folder);
  const version = await db.fileVersion.findFirst({ where: { id: c.req.param('versionId'), fileId: file.id } });
  if (!version) throw notFound('Version introuvable.');
  if (version.id === file.currentVersionId) return c.json({ ok: true });
  await transaction(db, async (tx) => {
    const res = await tx.file.updateMany({
      where: { id: file.id, deletedAt: null, rowVersion: file.rowVersion },
      data: { currentVersionId: version.id, size: version.size, mimeType: version.mimeType, rowVersion: { increment: 1 } },
    });
    if (res.count === 0) throw conflict('Ce fichier a été modifié par quelqu’un d’autre. Actualisez puis réessayez.', 'STALE');
    await logActivity(tx, c, {
      action: 'file.version_restore',
      targetType: 'file',
      targetId: file.id,
      targetLabel: file.name,
      spaceId: file.spaceId,
      private: access.space.type === 'PERSONAL',
      metadata: { version: version.number },
    });
  });
  return c.json({ ok: true });
});

// ───────────────────────────── Favoris, récents, corbeille, recherche ─────────────────────────────

contentRoutes.get('/favorites', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const spaceIds = await accessibleSpaceIds(db, user);
  const rows = await db.favorite.findMany({
    where: { userId: user.id, file: { deletedAt: null, spaceId: { in: spaceIds } } },
    include: { file: { include: { ...fileInclude(user.id), space: { select: { name: true, type: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return c.json({ files: rows.map((r) => ({ ...fileDto(r.file, user), spaceName: r.file.space.name, spaceType: r.file.space.type })) });
});

contentRoutes.get('/recents', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const spaceIds = await accessibleSpaceIds(db, user);
  const rows = await db.recentAccess.findMany({
    where: { userId: user.id, file: { deletedAt: null, spaceId: { in: spaceIds } } },
    include: { file: { include: { ...fileInclude(user.id), space: { select: { name: true, type: true } } } } },
    orderBy: { accessedAt: 'desc' },
    take: 50,
  });
  return c.json({
    files: rows.map((r) => ({ ...fileDto(r.file, user), spaceName: r.file.space.name, spaceType: r.file.space.type, accessedAt: r.accessedAt })),
  });
});

contentRoutes.get('/trash', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const spaceIds = await accessibleSpaceIds(db, user);
  const [folders, files] = await Promise.all([
    db.folder.findMany({
      where: { deletedById: user.id, deletedAt: { not: null }, spaceId: { in: spaceIds } },
      include: { parent: { select: { trashBatchId: true } }, space: { select: { name: true } } },
      orderBy: { deletedAt: 'desc' },
    }),
    db.file.findMany({
      where: { uploaderId: user.id, deletedAt: { not: null }, spaceId: { in: spaceIds } },
      include: { ...fileInclude(user.id), folder: { select: { trashBatchId: true } }, space: { select: { name: true, type: true } } },
      orderBy: { deletedAt: 'desc' },
    }),
  ]);
  return c.json({
    retentionDays: c.get('config').trashRetentionDays,
    // Seule la racine de chaque lot supprimé est listée : restaurer un dossier restaure son contenu.
    folders: folders
      .filter((f) => !f.parent || f.parent.trashBatchId !== f.trashBatchId)
      .map((f) => ({ id: f.id, name: f.name, deletedAt: f.deletedAt, spaceName: f.space.name })),
    files: files
      .filter((f) => !f.folder || f.folder.trashBatchId !== f.trashBatchId)
      .map((f) => ({ ...fileDto(f, user), spaceName: f.space.name, spaceType: f.space.type })),
  });
});

function categoryFilter(category: string) {
  const toCondition = (pattern: string) => {
    const core = pattern.replace(/%/g, '');
    if (pattern.startsWith('%') && pattern.endsWith('%')) return { mimeType: { contains: core } };
    if (pattern.endsWith('%')) return { mimeType: { startsWith: core } };
    return { mimeType: core };
  };
  if (category === 'other') {
    return { NOT: Object.values(CATEGORY_PATTERNS).flat().map(toCondition) };
  }
  // Le PDF et les archives sont testés avant « document », comme dans categoryOf.
  const patterns = CATEGORY_PATTERNS[category];
  if (!patterns) return {};
  if (category === 'document') {
    return { OR: patterns.map(toCondition), NOT: [...CATEGORY_PATTERNS.archive!, ...CATEGORY_PATTERNS.pdf!].map(toCondition) };
  }
  return { OR: patterns.map(toCondition) };
}

contentRoutes.get('/search', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const q = query(
    c,
    z.object({
      q: z.string().trim().max(100).default(''),
      category: z.enum(['', 'document', 'pdf', 'image', 'video', 'audio', 'archive', 'other']).default(''),
      spaceId: z.string().optional(),
      mine: z.enum(['0', '1']).default('0'),
      since: z.enum(['', '7', '30', '365']).default(''),
    }),
  );
  if (!q.q && !q.category && q.mine === '0' && !q.since) return c.json({ files: [], folders: [] });
  let spaceIds = await accessibleSpaceIds(db, user);
  if (q.spaceId) spaceIds = spaceIds.filter((id) => id === q.spaceId);
  const [files, folders] = await Promise.all([
    db.file.findMany({
      where: {
        spaceId: { in: spaceIds },
        deletedAt: null,
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
        ...(q.mine === '1' ? { uploaderId: user.id } : {}),
        ...(q.since ? { updatedAt: { gte: new Date(Date.now() - Number(q.since) * 86_400_000) } } : {}),
        ...(q.category ? categoryFilter(q.category) : {}),
      },
      include: { ...fileInclude(user.id), space: { select: { name: true, type: true } }, folder: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    q.q && !q.category && q.mine === '0' && !q.since
      ? db.folder.findMany({
          where: { spaceId: { in: spaceIds }, deletedAt: null, name: { contains: q.q, mode: 'insensitive' } },
          include: { space: { select: { name: true, type: true } } },
          orderBy: { name: 'asc' },
          take: 30,
        })
      : [],
  ]);
  return c.json({
    files: files.map((f) => ({ ...fileDto(f, user), spaceName: f.space.name, spaceType: f.space.type, folderName: f.folder?.name ?? null })),
    folders: folders.map((f) => ({ id: f.id, name: f.name, spaceId: f.spaceId, spaceName: f.space.name, spaceType: f.space.type })),
  });
});
