// Opérations sur les fichiers et dossiers partagées entre l'interface client et l'administration.

import { logActivity, type AuthUser, type Ctx } from './context.ts';
import { transaction, type Db, type DbOrTx, type Tx } from './db.ts';
import { subtreeIds, uniqueName } from './access.ts';
import { categoryOf } from './mime.ts';
import { randomToken } from './crypto.ts';
import { COMPANY_SPACE_ID } from './bootstrap.ts';

export const uploaderSelect = { id: true, firstName: true, lastName: true } as const;

interface FileRow {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  spaceId: string;
  folderId: string | null;
  uploaderId: string;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  uploader?: { id: string; firstName: string; lastName: string } | null;
  favorites?: unknown[];
}

export function fileDto(file: FileRow, user: AuthUser) {
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size),
    mimeType: file.mimeType,
    category: categoryOf(file.mimeType),
    spaceId: file.spaceId,
    folderId: file.folderId,
    uploader: file.uploader ? { id: file.uploader.id, name: `${file.uploader.firstName} ${file.uploader.lastName}` } : null,
    rowVersion: file.rowVersion,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
    isFavorite: (file.favorites?.length ?? 0) > 0,
    // Règle n° 8 : seul l'importateur peut supprimer depuis l'interface client.
    canDelete: file.uploaderId === user.id,
  };
}

/** Espaces dont l'utilisateur peut lire le contenu. */
export async function accessibleSpaceIds(db: DbOrTx, user: AuthUser): Promise<string[]> {
  const [personal, memberships] = await Promise.all([
    db.space.findFirst({ where: { type: 'PERSONAL', ownerId: user.id }, select: { id: true } }),
    db.spaceMember.findMany({ where: { userId: user.id, space: { type: 'SHARED', archivedAt: null } }, select: { spaceId: true } }),
  ]);
  return [COMPANY_SPACE_ID, ...(personal ? [personal.id] : []), ...memberships.map((m) => m.spaceId)];
}

interface TrashOptions {
  /** Suppression administrative : motif obligatoire, consigné au journal. */
  adminReason?: string;
  isPrivate: boolean;
}

export async function trashFile(tx: Tx, c: Ctx, file: { id: string; name: string; spaceId: string }, opts: TrashOptions): Promise<void> {
  const res = await tx.file.updateMany({
    where: { id: file.id, deletedAt: null },
    data: { deletedAt: new Date(), deletedById: c.get('user').id, trashBatchId: randomToken(8), rowVersion: { increment: 1 } },
  });
  if (res.count === 0) return;
  await logActivity(tx, c, {
    action: opts.adminReason ? 'admin.file_delete' : 'file.trash',
    targetType: 'file',
    targetId: file.id,
    targetLabel: file.name,
    spaceId: file.spaceId,
    private: opts.isPrivate,
    metadata: opts.adminReason ? { reason: opts.adminReason } : undefined,
  });
}

export async function trashFolder(tx: Tx, c: Ctx, folder: { id: string; name: string; spaceId: string }, opts: TrashOptions): Promise<void> {
  const ids = await subtreeIds(tx, folder.id);
  const batch = randomToken(8);
  const stamp = { deletedAt: new Date(), deletedById: c.get('user').id, trashBatchId: batch };
  await tx.folder.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: stamp });
  const files = await tx.file.updateMany({ where: { folderId: { in: ids }, deletedAt: null }, data: { ...stamp, rowVersion: { increment: 1 } } });
  await logActivity(tx, c, {
    action: opts.adminReason ? 'admin.folder_delete' : 'folder.trash',
    targetType: 'folder',
    targetId: folder.id,
    targetLabel: folder.name,
    spaceId: folder.spaceId,
    private: opts.isPrivate,
    metadata: { folders: ids.length, files: files.count, ...(opts.adminReason ? { reason: opts.adminReason } : {}) },
  });
}

export async function restoreFile(tx: Tx, c: Ctx, file: { id: string; name: string; spaceId: string; folderId: string | null }, isPrivate: boolean, admin = false) {
  // Si le dossier d'origine est lui-même à la corbeille (ou supprimé), retour à la racine.
  let folderId = file.folderId;
  if (folderId) {
    const folder = await tx.folder.findFirst({ where: { id: folderId, deletedAt: null }, select: { id: true } });
    if (!folder) folderId = null;
  }
  const name = await uniqueName(tx, 'file', file.spaceId, folderId, file.name, file.id);
  await tx.file.update({
    where: { id: file.id },
    data: { deletedAt: null, deletedById: null, trashBatchId: null, folderId, name, rowVersion: { increment: 1 } },
  });
  await logActivity(tx, c, {
    action: admin ? 'admin.file_restore' : 'file.restore',
    targetType: 'file',
    targetId: file.id,
    targetLabel: name,
    spaceId: file.spaceId,
    private: isPrivate,
  });
}

export async function restoreFolder(
  tx: Tx,
  c: Ctx,
  folder: { id: string; name: string; spaceId: string; parentId: string | null; trashBatchId: string | null },
  isPrivate: boolean,
) {
  let parentId = folder.parentId;
  if (parentId) {
    const parent = await tx.folder.findFirst({ where: { id: parentId, deletedAt: null }, select: { id: true } });
    if (!parent) parentId = null;
  }
  const name = await uniqueName(tx, 'folder', folder.spaceId, parentId, folder.name, folder.id);
  const clear = { deletedAt: null, deletedById: null, trashBatchId: null };
  if (folder.trashBatchId) {
    await tx.folder.updateMany({ where: { trashBatchId: folder.trashBatchId }, data: clear });
    await tx.file.updateMany({ where: { trashBatchId: folder.trashBatchId }, data: { ...clear, rowVersion: { increment: 1 } } });
  }
  await tx.folder.update({ where: { id: folder.id }, data: { ...clear, parentId, name } });
  await logActivity(tx, c, { action: 'folder.restore', targetType: 'folder', targetId: folder.id, targetLabel: name, spaceId: folder.spaceId, private: isPrivate });
}

/**
 * Suppression définitive. Les lignes sont retirées de la base dans une transaction PUIS
 * les objets sont effacés du stockage : si le stockage échoue, il reste des objets
 * orphelins (signalés au journal et par le script de vérification), jamais une ligne
 * pointant vers un document disparu.
 */
export async function purgeFiles(
  db: Db,
  c: Ctx,
  where: { id: string } | { ids: string[] },
  action: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const ids = 'ids' in where ? where.ids : [where.id];
  if (ids.length === 0) return 0;
  const { keys, files } = await transaction(db, async (tx) => {
    const found = await tx.file.findMany({
      where: { id: { in: ids } },
      include: { versions: { select: { storageKey: true } }, space: { select: { type: true } } },
    });
    for (const f of found) {
      await logActivity(tx, c, {
        action,
        targetType: 'file',
        targetId: f.id,
        targetLabel: f.name,
        spaceId: f.spaceId,
        private: f.space.type === 'PERSONAL',
        metadata: { size: Number(f.size), versions: f.versions.length, ...extra },
      });
    }
    await tx.file.deleteMany({ where: { id: { in: found.map((f) => f.id) } } });
    return { keys: found.flatMap((f) => f.versions.map((v) => v.storageKey)), files: found };
  });
  await deleteObjects(db, c, keys);
  return files.length;
}

export async function deleteObjects(db: Db, c: Ctx, keys: string[]): Promise<void> {
  const storage = c.get('storage');
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch {
      failed.push(key);
    }
  }
  if (failed.length > 0) {
    await db.errorLog.create({
      data: { source: 'storage', message: `Objets orphelins à nettoyer (${failed.length})`, stack: failed.join('\n').slice(0, 8000) },
    });
  }
}
