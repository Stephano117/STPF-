// Règles d'accès. TOUTES les décisions de permission passent par ce module, côté serveur.
//
//   Espace PERSONNEL  : visible de son seul propriétaire. Un administrateur n'y a aucun accès.
//   Espace ENTREPRISE : lecture pour tout compte actif. Écriture : administrateurs partout ;
//                       collaborateurs dans tous les dossiers, sauf les dossiers officiels.
//                       La racine (structure officielle) est réservée aux administrateurs.
//   Espace PARTAGÉ    : selon le rôle du membre (propriétaire > gestionnaire > éditeur > lecteur).
//
//   Suppression d'un fichier : uniquement par l'utilisateur qui l'a importé (règle n° 8).

import type { Config } from '../config.ts';
import type { AuthUser } from './context.ts';
import type { DbOrTx } from './db.ts';
import { AppError, forbidden, notFound } from './errors.ts';

export type Role = 'OWNER' | 'MANAGER' | 'EDITOR' | 'READER';
const RANK: Record<Role, number> = { READER: 1, EDITOR: 2, MANAGER: 3, OWNER: 4 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export interface SpaceLite {
  id: string;
  type: 'COMPANY' | 'SHARED' | 'PERSONAL';
  name: string;
  description: string;
  ownerId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface FolderPolicy {
  id: string;
  restricted: boolean;
}

export interface SpaceAccess {
  space: SpaceLite;
  role: Role;
}

/** Renvoie l'accès de l'utilisateur à l'espace, ou lève 404 s'il n'en a aucun. */
export async function getSpaceAccess(db: DbOrTx, user: AuthUser, spaceId: string): Promise<SpaceAccess> {
  const space = await db.space.findUnique({ where: { id: spaceId } });
  if (!space || space.archivedAt) throw notFound('Espace introuvable.');
  if (space.type === 'PERSONAL') {
    if (space.ownerId !== user.id) throw notFound('Espace introuvable.');
    return { space, role: 'OWNER' };
  }
  if (space.type === 'COMPANY') {
    return { space, role: user.role === 'ADMIN' ? 'MANAGER' : 'READER' };
  }
  const member = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: user.id } } });
  if (!member) throw notFound('Espace introuvable.');
  return { space, role: member.role };
}

/** L'utilisateur peut-il créer ou modifier du contenu à cet emplacement ? */
export function canWriteIn(user: AuthUser, access: SpaceAccess, folder: FolderPolicy | null): boolean {
  if (access.space.type === 'COMPANY') {
    if (user.role === 'ADMIN') return true;
    if (!folder) return false;
    return !folder.restricted;
  }
  return atLeast(access.role, 'EDITOR');
}

export function assertCanWrite(user: AuthUser, access: SpaceAccess, folder: FolderPolicy | null): void {
  if (!canWriteIn(user, access, folder)) {
    throw forbidden('Vous n’avez pas le droit de modifier le contenu de cet emplacement.', 'READ_ONLY');
  }
}

export async function getFolder(db: DbOrTx, spaceId: string, folderId: string | null | undefined) {
  if (!folderId) return null;
  const folder = await db.folder.findFirst({ where: { id: folderId, spaceId, deletedAt: null } });
  if (!folder) throw notFound('Dossier introuvable.');
  return folder;
}

/** Charge un fichier non supprimé avec l'accès de l'utilisateur à son espace. */
export async function getFileAccess(db: DbOrTx, user: AuthUser, fileId: string, opts: { includeDeleted?: boolean } = {}) {
  const file = await db.file.findUnique({ where: { id: fileId }, include: { folder: true } });
  if (!file || (file.deletedAt && !opts.includeDeleted)) throw notFound('Fichier introuvable.');
  const access = await getSpaceAccess(db, user, file.spaceId);
  return { file, access };
}

export async function breadcrumbs(db: DbOrTx, folderId: string | null): Promise<{ id: string; name: string }[]> {
  if (!folderId) return [];
  const rows = await db.$queryRaw<{ id: string; name: string; depth: number }[]>`
    WITH RECURSIVE chain AS (
      SELECT "id", "name", "parentId", 0 AS depth FROM "Folder" WHERE "id" = ${folderId}
      UNION ALL
      SELECT f."id", f."name", f."parentId", chain.depth + 1 FROM "Folder" f JOIN chain ON f."id" = chain."parentId"
      WHERE chain.depth < 64
    )
    SELECT "id", "name", depth FROM chain ORDER BY depth DESC`;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Identifiants du dossier et de tous ses descendants. */
export async function subtreeIds(db: DbOrTx, folderId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT "id", 0 AS depth FROM "Folder" WHERE "id" = ${folderId}
      UNION ALL
      SELECT f."id", tree.depth + 1 FROM "Folder" f JOIN tree ON f."parentId" = tree."id" WHERE tree.depth < 64
    )
    SELECT "id" FROM tree`;
  return rows.map((r) => r.id);
}

function splitName(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/** Renvoie un nom libre dans le dossier : « rapport.pdf » → « rapport (2).pdf ». */
export async function uniqueName(
  db: DbOrTx,
  kind: 'file' | 'folder',
  spaceId: string,
  folderId: string | null,
  name: string,
  excludeId?: string,
): Promise<string> {
  const [base, ext] = kind === 'file' ? splitName(name) : [name, ''];
  const where = { spaceId, deletedAt: null, name: { startsWith: base, mode: 'insensitive' as const }, ...(excludeId ? { id: { not: excludeId } } : {}) };
  const siblings =
    kind === 'file'
      ? await db.file.findMany({ where: { ...where, folderId }, select: { name: true } })
      : await db.folder.findMany({ where: { ...where, parentId: folderId }, select: { name: true } });
  const taken = new Set(siblings.map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ───────────────────────────── Quotas ─────────────────────────────

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

export async function globalUsage(db: DbOrTx): Promise<{ stored: number; pending: number }> {
  const [versions, pending] = await Promise.all([
    db.fileVersion.aggregate({ _sum: { size: true } }),
    db.upload.aggregate({ _sum: { size: true }, where: { status: 'PENDING' } }),
  ]);
  return { stored: num(versions._sum.size), pending: num(pending._sum.size) };
}

export async function spaceUsage(db: DbOrTx, spaceId: string): Promise<number> {
  const [versions, pending] = await Promise.all([
    db.fileVersion.aggregate({ _sum: { size: true }, where: { file: { spaceId } } }),
    db.upload.aggregate({ _sum: { size: true }, where: { status: 'PENDING', spaceId } }),
  ]);
  return num(versions._sum.size) + num(pending._sum.size);
}

export function personalQuota(cfg: Config, user: { quotaBytes: bigint | null }): number {
  return user.quotaBytes !== null ? Number(user.quotaBytes) : cfg.userQuotaBytes;
}

/** Refuse un import qui ferait dépasser la capacité de la plateforme ou le quota personnel. */
export async function assertQuota(db: DbOrTx, cfg: Config, user: AuthUser, space: SpaceLite, size: number): Promise<void> {
  if (size > cfg.maxFileSizeBytes) {
    throw new AppError(413, 'FILE_TOO_LARGE', `Fichier trop volumineux (maximum ${formatBytes(cfg.maxFileSizeBytes)}).`);
  }
  await assertCapacity(db, cfg, user, space, size);
}

/** Vérifie la capacité globale et le quota personnel pour `size` octets supplémentaires. */
export async function assertCapacity(db: DbOrTx, cfg: Config, user: AuthUser, space: SpaceLite, size: number): Promise<void> {
  const usage = await globalUsage(db);
  if (usage.stored + usage.pending + size > cfg.storageQuotaBytes) {
    throw new AppError(413, 'STORAGE_FULL', 'L’espace de stockage de la plateforme est saturé. Contactez un administrateur.');
  }
  if (space.type === 'PERSONAL') {
    const used = await spaceUsage(db, space.id);
    if (used + size > personalQuota(cfg, user)) {
      throw new AppError(413, 'QUOTA_EXCEEDED', 'Le quota de votre espace personnel est atteint.');
    }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// ───────────────────────────── Noms ─────────────────────────────

const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/** Valide un nom de fichier ou de dossier (message d'erreur ou null). */
export function nameProblem(name: string): string | null {
  if (name !== name.trim() || name.length === 0) return 'Le nom ne peut pas être vide ni commencer ou finir par un espace.';
  if (name.length > 200) return 'Le nom est trop long (200 caractères maximum).';
  if (FORBIDDEN_CHARS.test(name)) return 'Le nom contient un caractère interdit ( \\ / : * ? " < > | ).';
  if (name === '.' || name === '..') return 'Nom réservé.';
  return null;
}
