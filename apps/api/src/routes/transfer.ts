// Déplacement et copie de fichiers et de dossiers, y compris d'un espace à un autre.
//
//   Copier   : il faut pouvoir LIRE la source et ÉCRIRE dans la destination. La copie est un
//              nouveau fichier, dont l'auteur de la copie devient l'importateur.
//   Déplacer : dans le même espace, droit d'écriture (comme un renommage). Vers un AUTRE
//              espace, le fichier quitte son espace d'origine : comme pour une suppression,
//              seul son importateur peut le faire (règle n° 8). Un dossier ne change d'espace
//              que par son créateur, et seulement s'il ne contient que ses propres fichiers.
//
// Les octets sont copiés par le stockage lui-même : rien ne transite par l'application.

import { Hono } from 'hono';
import { z } from 'zod';
import { body, logActivity, type AppEnv } from '../lib/context.ts';
import { requireAuth } from '../lib/auth.ts';
import { assertCanWrite, assertCapacity, getFileAccess, getFolder, getSpaceAccess, subtreeIds, uniqueName } from '../lib/access.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { transaction } from '../lib/db.ts';
import { deleteObjects } from '../lib/fileops.ts';
import { randomToken } from '../lib/crypto.ts';

const MAX_FILES_PER_FOLDER_COPY = 300;

const schema = z.object({
  mode: z.enum(['move', 'copy']),
  spaceId: z.string().min(1),
  folderId: z.string().min(1).nullable().default(null),
});

export const transferRoutes = new Hono<AppEnv>();
transferRoutes.use('*', requireAuth);

function newStorageKey(): string {
  const now = new Date();
  return `o/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomToken(12)}`;
}

/** Copie des objets par lots ; en cas d'échec, les copies déjà faites sont effacées. */
async function copyObjects(storage: AppEnv['Variables']['storage'], pairs: { from: string; to: string }[]): Promise<void> {
  const done: string[] = [];
  try {
    for (let i = 0; i < pairs.length; i += 4) {
      await Promise.all(
        pairs.slice(i, i + 4).map(async (p) => {
          await storage.copy(p.from, p.to);
          done.push(p.to);
        }),
      );
    }
  } catch (err) {
    await Promise.all(done.map((key) => storage.delete(key).catch(() => undefined)));
    throw err;
  }
}

transferRoutes.post('/files/:id/transfer', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const cfg = c.get('config');
  const storage = c.get('storage');
  const data = await body(c, schema);
  const { file, access: source } = await getFileAccess(db, user, c.req.param('id'));
  const dest = await getSpaceAccess(db, user, data.spaceId);
  const destFolder = await getFolder(db, dest.space.id, data.folderId);
  assertCanWrite(user, dest, destFolder);
  const sameSpace = dest.space.id === file.spaceId;
  const isPrivate = source.space.type === 'PERSONAL' || dest.space.type === 'PERSONAL';

  if (data.mode === 'copy') {
    const version = await db.fileVersion.findFirst({ where: { id: file.currentVersionId ?? '' } });
    if (!version) throw notFound('Version introuvable.');
    await assertCapacity(db, cfg, user, dest.space, Number(version.size));
    const storageKey = newStorageKey();
    await storage.copy(version.storageKey, storageKey);
    try {
      const created = await transaction(db, async (tx) => {
        const name = await uniqueName(tx, 'file', dest.space.id, destFolder?.id ?? null, file.name);
        const versionId = randomToken(12);
        const copy = await tx.file.create({
          data: {
            spaceId: dest.space.id,
            folderId: destFolder?.id ?? null,
            name,
            uploaderId: user.id,
            size: version.size,
            mimeType: version.mimeType,
            currentVersionId: versionId,
            versions: { create: { id: versionId, number: 1, storageKey, size: version.size, mimeType: version.mimeType, sha256: version.sha256, etag: version.etag, uploadedById: user.id } },
          },
        });
        await logActivity(tx, c, { action: 'file.copy', targetType: 'file', targetId: copy.id, targetLabel: name, spaceId: dest.space.id, private: isPrivate, metadata: { from: file.id, fromSpace: source.space.name, toSpace: dest.space.name } });
        return copy;
      });
      return c.json({ ok: true, fileId: created.id, name: created.name }, 201);
    } catch (err) {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  // Déplacement
  if (sameSpace) {
    assertCanWrite(user, source, file.folder);
    if ((destFolder?.id ?? null) === file.folderId) return c.json({ ok: true, fileId: file.id, name: file.name });
  } else {
    if (file.uploaderId !== user.id) {
      throw forbidden('Seule la personne qui a importé ce fichier peut le déplacer vers un autre espace. Vous pouvez en faire une copie.', 'NOT_UPLOADER');
    }
    const total = await db.fileVersion.aggregate({ _sum: { size: true }, where: { fileId: file.id } });
    await assertCapacity(db, cfg, user, dest.space, dest.space.type === 'PERSONAL' ? Number(total._sum.size ?? 0) : 0);
  }
  const name = await transaction(db, async (tx) => {
    const finalName = await uniqueName(tx, 'file', dest.space.id, destFolder?.id ?? null, file.name, file.id);
    const res = await tx.file.updateMany({
      where: { id: file.id, deletedAt: null, rowVersion: file.rowVersion },
      data: { spaceId: dest.space.id, folderId: destFolder?.id ?? null, name: finalName, rowVersion: { increment: 1 } },
    });
    if (res.count === 0) throw conflict('Ce fichier a été modifié par quelqu’un d’autre. Actualisez puis réessayez.', 'STALE');
    await logActivity(tx, c, { action: 'file.move', targetType: 'file', targetId: file.id, targetLabel: finalName, spaceId: dest.space.id, private: isPrivate, metadata: { from: file.name, fromSpace: source.space.name, toSpace: dest.space.name, fromFolder: file.folderId, toFolder: destFolder?.id ?? null } });
    return finalName;
  });
  return c.json({ ok: true, fileId: file.id, name });
});

transferRoutes.post('/folders/:id/transfer', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const cfg = c.get('config');
  const storage = c.get('storage');
  const data = await body(c, schema);
  const folder = await db.folder.findFirst({ where: { id: c.req.param('id'), deletedAt: null } });
  if (!folder) throw notFound('Dossier introuvable.');
  const source = await getSpaceAccess(db, user, folder.spaceId);
  const dest = await getSpaceAccess(db, user, data.spaceId);
  const destParent = await getFolder(db, dest.space.id, data.folderId);
  assertCanWrite(user, dest, destParent);
  const ids = await subtreeIds(db, folder.id);
  if (destParent && ids.includes(destParent.id)) throw badRequest('Un dossier ne peut pas être placé dans lui-même.');
  const sameSpace = dest.space.id === folder.spaceId;
  const isPrivate = source.space.type === 'PERSONAL' || dest.space.type === 'PERSONAL';
  const restricted = destParent?.restricted ?? false;

  if (data.mode === 'copy') {
    const [folders, files] = await Promise.all([
      db.folder.findMany({ where: { id: { in: ids }, deletedAt: null } }),
      db.file.findMany({ where: { folderId: { in: ids }, deletedAt: null }, include: { versions: true } }),
    ]);
    if (files.length > MAX_FILES_PER_FOLDER_COPY) {
      throw new AppError(413, 'TOO_MANY_FILES', `Ce dossier contient plus de ${MAX_FILES_PER_FOLDER_COPY} fichiers : copiez-le par sous-dossiers.`);
    }
    const current = files.flatMap((f) => {
      const v = f.versions.find((x) => x.id === f.currentVersionId);
      return v ? [{ file: f, version: v, storageKey: newStorageKey() }] : [];
    });
    await assertCapacity(db, cfg, user, dest.space, current.reduce((sum, x) => sum + Number(x.version.size), 0));
    await copyObjects(storage, current.map((x) => ({ from: x.version.storageKey, to: x.storageKey })));
    try {
      const rootId = await transaction(db, async (tx) => {
        // Les dossiers sont recréés parents d'abord, avec de nouveaux identifiants.
        const idMap = new Map<string, string>();
        const pending = [...folders];
        const rootName = await uniqueName(tx, 'folder', dest.space.id, destParent?.id ?? null, folder.name);
        while (pending.length) {
          const before = pending.length;
          for (const f of [...pending]) {
            const isRoot = f.id === folder.id;
            const parentId = isRoot ? (destParent?.id ?? null) : idMap.get(f.parentId ?? '');
            if (!isRoot && parentId === undefined) continue;
            const created = await tx.folder.create({
              data: { spaceId: dest.space.id, parentId: parentId ?? null, name: isRoot ? rootName : f.name, createdById: user.id, restricted },
            });
            idMap.set(f.id, created.id);
            pending.splice(pending.indexOf(f), 1);
          }
          if (pending.length === before) break; // sous-dossiers d'un dossier lui-même à la corbeille
        }
        for (const x of current) {
          const folderId = idMap.get(x.file.folderId ?? '');
          if (!folderId) continue;
          const versionId = randomToken(12);
          await tx.file.create({
            data: {
              spaceId: dest.space.id, folderId, name: x.file.name, uploaderId: user.id, size: x.version.size, mimeType: x.version.mimeType, currentVersionId: versionId,
              versions: { create: { id: versionId, number: 1, storageKey: x.storageKey, size: x.version.size, mimeType: x.version.mimeType, sha256: x.version.sha256, etag: x.version.etag, uploadedById: user.id } },
            },
          });
        }
        const id = idMap.get(folder.id)!;
        await logActivity(tx, c, { action: 'folder.copy', targetType: 'folder', targetId: id, targetLabel: rootName, spaceId: dest.space.id, private: isPrivate, metadata: { from: folder.id, files: current.length, fromSpace: source.space.name, toSpace: dest.space.name } });
        return id;
      });
      return c.json({ ok: true, folderId: rootId }, 201);
    } catch (err) {
      await deleteObjects(db, c, current.map((x) => x.storageKey));
      throw err;
    }
  }

  // Déplacement
  assertCanWrite(user, source, folder);
  assertCanWrite(user, source, await getFolder(db, folder.spaceId, folder.parentId));
  if (!sameSpace) {
    if (folder.createdById !== user.id) throw forbidden('Seul le créateur d’un dossier peut le déplacer vers un autre espace. Vous pouvez en faire une copie.', 'NOT_OWNER');
    const foreign = await db.file.count({ where: { folderId: { in: ids }, uploaderId: { not: user.id } } });
    if (foreign > 0) {
      throw forbidden(`Ce dossier contient ${foreign} fichier(s) importé(s) par d’autres collaborateurs : il ne peut pas changer d’espace. Vous pouvez en faire une copie.`, 'CONTAINS_FOREIGN_FILES');
    }
    const total = await db.fileVersion.aggregate({ _sum: { size: true }, where: { file: { folderId: { in: ids } } } });
    await assertCapacity(db, cfg, user, dest.space, dest.space.type === 'PERSONAL' ? Number(total._sum.size ?? 0) : 0);
  }
  await transaction(db, async (tx) => {
    const name = await uniqueName(tx, 'folder', dest.space.id, destParent?.id ?? null, folder.name, folder.id);
    if (sameSpace && name !== folder.name) throw conflict('Un dossier porte déjà ce nom à cet emplacement.', 'NAME_TAKEN');
    await tx.folder.updateMany({ where: { id: { in: ids } }, data: { spaceId: dest.space.id, ...(dest.space.type === 'COMPANY' || !sameSpace ? { restricted } : {}) } });
    await tx.folder.update({ where: { id: folder.id }, data: { parentId: destParent?.id ?? null, name } });
    await tx.file.updateMany({ where: { folderId: { in: ids } }, data: { spaceId: dest.space.id, rowVersion: { increment: 1 } } });
    await logActivity(tx, c, { action: 'folder.move', targetType: 'folder', targetId: folder.id, targetLabel: name, spaceId: dest.space.id, private: isPrivate, metadata: { fromSpace: source.space.name, toSpace: dest.space.name, fromParent: folder.parentId, toParent: destParent?.id ?? null } });
  });
  return c.json({ ok: true, folderId: folder.id });
});
