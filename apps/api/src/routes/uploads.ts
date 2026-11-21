// Import de fichiers. Les octets vont directement du navigateur au stockage via des URL
// signées : l'API ne charge jamais un fichier en mémoire.
//
//   1. POST /uploads               → réserve le quota, crée une session d'import (PENDING)
//   2. PUT  <URL signée>           → envoi direct (en un bloc, ou en parties reprenables)
//   3. POST /uploads/:id/complete  → vérifie taille et contenu réel, puis crée le fichier
//
// Tant que l'étape 3 n'a pas réussi, aucun fichier n'apparaît : un transfert interrompu ne
// laisse jamais de document incomplet. Les sessions abandonnées sont nettoyées par la maintenance.

import { Hono } from 'hono';
import { z } from 'zod';
import { body, logActivity, type AppEnv, type Ctx } from '../lib/context.ts';
import { requireAuth } from '../lib/auth.ts';
import { assertCanWrite, assertQuota, getFileAccess, getFolder, getSpaceAccess, nameProblem, uniqueName } from '../lib/access.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { transaction, type Db } from '../lib/db.ts';
import { extensionOf, inspectFile, isBlockedName } from '../lib/mime.ts';
import { randomToken } from '../lib/crypto.ts';

const URL_TTL_SECONDS = 3600;
const MAX_PENDING_PER_USER = 100;

const initSchema = z.object({
  spaceId: z.string().min(1),
  folderId: z.string().min(1).nullable().default(null),
  /** Présent pour importer une nouvelle version d'un fichier existant. */
  fileId: z.string().min(1).optional(),
  name: z.string().max(200),
  size: z.number().int().positive('Le fichier est vide.'),
  mimeType: z.string().max(200).default(''),
});

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use('*', requireAuth);

uploadRoutes.post('/uploads', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const cfg = c.get('config');
  const storage = c.get('storage');
  const data = await body(c, initSchema);

  const problem = nameProblem(data.name);
  if (problem) throw badRequest(problem, 'INVALID_NAME');
  if (isBlockedName(data.name)) throw badRequest(`Les fichiers .${extensionOf(data.name)} ne sont pas acceptés.`, 'FILE_REJECTED');

  const access = await getSpaceAccess(db, user, data.spaceId);
  let folderId = data.folderId;
  let name = data.name;
  if (data.fileId) {
    const target = await getFileAccess(db, user, data.fileId);
    if (target.file.spaceId !== access.space.id) throw notFound('Fichier introuvable.');
    assertCanWrite(user, access, target.file.folder);
    if (extensionOf(data.name) !== extensionOf(target.file.name)) {
      throw badRequest(`La nouvelle version doit être du même type que « ${target.file.name} ».`, 'EXTENSION_CHANGE');
    }
    folderId = target.file.folderId;
    name = target.file.name;
  } else {
    assertCanWrite(user, access, await getFolder(db, access.space.id, folderId));
  }

  await assertQuota(db, cfg, user, access.space, data.size);
  if ((await db.upload.count({ where: { userId: user.id, status: 'PENDING' } })) >= MAX_PENDING_PER_USER) {
    throw new AppError(429, 'TOO_MANY_UPLOADS', 'Trop d’imports en cours. Terminez ou annulez les imports en attente.');
  }

  const id = randomToken(12);
  const now = new Date();
  // Clé opaque : aucune donnée fournie par l'utilisateur n'entre dans le chemin de stockage.
  const storageKey = `o/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
  const multipart = data.size >= cfg.multipartThresholdBytes;
  const multipartId = multipart ? await storage.createMultipart(storageKey) : null;

  await db.upload.create({
    data: {
      id,
      userId: user.id,
      spaceId: access.space.id,
      folderId,
      fileId: data.fileId ?? null,
      name,
      size: BigInt(data.size),
      declaredMime: data.mimeType,
      storageKey,
      multipartId,
      partSize: multipart ? cfg.partSizeBytes : null,
      expiresAt: new Date(now.getTime() + cfg.uploadTtlHours * 3_600_000),
    },
  });

  if (multipart) {
    return c.json({ id, mode: 'multipart', partSize: cfg.partSizeBytes, partCount: Math.ceil(data.size / cfg.partSizeBytes) }, 201);
  }
  return c.json({ id, mode: 'single', url: await storage.presignPut(storageKey, URL_TTL_SECONDS) }, 201);
});

async function ownPendingUpload(c: Ctx) {
  const upload = await c.get('db').upload.findFirst({ where: { id: c.req.param('id'), userId: c.get('user').id } });
  if (!upload) throw notFound('Import introuvable.');
  if (upload.status !== 'PENDING') throw conflict('Cet import est déjà terminé ou annulé.', 'UPLOAD_CLOSED');
  if (upload.expiresAt.getTime() < Date.now()) throw new AppError(410, 'UPLOAD_EXPIRED', 'Cet import a expiré. Recommencez l’envoi.');
  return upload;
}

/** État d'un import : sert à reprendre un transfert interrompu sans renvoyer les parties déjà reçues. */
uploadRoutes.get('/uploads/:id', async (c) => {
  const upload = await ownPendingUpload(c);
  const parts = upload.multipartId ? await c.get('storage').listParts(upload.storageKey, upload.multipartId) : [];
  return c.json({
    id: upload.id,
    name: upload.name,
    size: Number(upload.size),
    mode: upload.multipartId ? 'multipart' : 'single',
    partSize: upload.partSize,
    uploadedParts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })),
  });
});

uploadRoutes.post('/uploads/:id/parts', async (c) => {
  const upload = await ownPendingUpload(c);
  if (!upload.multipartId || !upload.partSize) throw badRequest('Cet import n’est pas un envoi en plusieurs parties.');
  const partCount = Math.ceil(Number(upload.size) / upload.partSize);
  const data = await body(c, z.object({ partNumbers: z.array(z.number().int().min(1).max(partCount)).min(1).max(50) }));
  const storage = c.get('storage');
  const urls = await Promise.all(
    data.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await storage.presignPart(upload.storageKey, upload.multipartId!, partNumber, URL_TTL_SECONDS),
    })),
  );
  return c.json({ urls });
});

/** URL de remplacement pour un envoi simple dont l'URL signée a expiré. */
uploadRoutes.post('/uploads/:id/url', async (c) => {
  const upload = await ownPendingUpload(c);
  if (upload.multipartId) throw badRequest('Utilisez les URL de parties pour cet import.');
  return c.json({ url: await c.get('storage').presignPut(upload.storageKey, URL_TTL_SECONDS) });
});

async function rejectUpload(db: Db, c: Ctx, upload: { id: string; storageKey: string }, error: AppError): Promise<never> {
  await db.upload.updateMany({ where: { id: upload.id, status: 'PENDING' }, data: { status: 'ABORTED' } });
  await c.get('storage').delete(upload.storageKey).catch(() => undefined);
  throw error;
}

uploadRoutes.post('/uploads/:id/complete', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const storage = c.get('storage');
  const data = await body(c, z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }));
  const upload = await ownPendingUpload(c);
  const expectedSize = Number(upload.size);

  // 1. L'objet est-il entièrement arrivé ? (Rejouable : un assemblage déjà fait est détecté.)
  let object = await storage.head(upload.storageKey);
  if (!object && upload.multipartId) {
    const parts = await storage.listParts(upload.storageKey, upload.multipartId);
    const received = parts.reduce((sum, p) => sum + p.size, 0);
    const contiguous = parts.every((p, i) => p.partNumber === i + 1);
    if (!contiguous || received !== expectedSize) {
      throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Le transfert est incomplet. Reprenez l’envoi.', { received, expected: expectedSize });
    }
    await storage.completeMultipart(upload.storageKey, upload.multipartId, parts);
    object = await storage.head(upload.storageKey);
  }
  if (!object) throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Le fichier n’a pas été reçu par le stockage. Reprenez l’envoi.');
  if (object.size !== expectedSize) {
    await rejectUpload(db, c, upload, badRequest('La taille reçue ne correspond pas au fichier annoncé. Recommencez l’envoi.', 'SIZE_MISMATCH'));
  }

  // 2. Contrôle du contenu réel (signature des premiers octets), indépendant du navigateur.
  const verdict = inspectFile(upload.name, await storage.readRange(upload.storageKey, 0, 4095));
  if (!verdict.ok) return rejectUpload(db, c, upload, badRequest(verdict.reason, 'FILE_REJECTED'));

  // 3. Les droits sont revérifiés : ils ont pu changer pendant le transfert.
  const access = await getSpaceAccess(db, user, upload.spaceId);
  const isPrivate = access.space.type === 'PERSONAL';

  const result = await transaction(db, async (tx) => {
    const claimed = await tx.upload.updateMany({ where: { id: upload.id, status: 'PENDING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (claimed.count === 0) throw conflict('Cet import est déjà terminé ou annulé.', 'UPLOAD_CLOSED');
    const versionId = randomToken(12);
    const versionData = {
      id: versionId,
      storageKey: upload.storageKey,
      size: upload.size,
      mimeType: verdict.mime,
      sha256: data.sha256 ?? null,
      etag: object.etag,
      uploadedById: user.id,
    };

    if (upload.fileId) {
      const file = await tx.file.findFirst({ where: { id: upload.fileId, deletedAt: null }, include: { folder: true } });
      if (!file) throw notFound('Le fichier d’origine n’existe plus.');
      assertCanWrite(user, access, file.folder);
      // Incrémenter rowVersion verrouille la ligne : deux versions simultanées sont numérotées en série.
      await tx.file.update({ where: { id: file.id }, data: { rowVersion: { increment: 1 } } });
      const last = await tx.fileVersion.aggregate({ where: { fileId: file.id }, _max: { number: true } });
      const number = (last._max.number ?? 0) + 1;
      await tx.fileVersion.create({ data: { ...versionData, fileId: file.id, number } });
      await tx.file.update({ where: { id: file.id }, data: { currentVersionId: versionId, size: upload.size, mimeType: verdict.mime } });
      await logActivity(tx, c, { action: 'file.version_add', targetType: 'file', targetId: file.id, targetLabel: file.name, spaceId: file.spaceId, private: isPrivate, metadata: { version: number, size: expectedSize } });
      return { fileId: file.id, name: file.name, version: number };
    }

    const folder = await getFolder(tx, upload.spaceId, upload.folderId);
    assertCanWrite(user, access, folder);
    const name = await uniqueName(tx, 'file', upload.spaceId, folder?.id ?? null, upload.name);
    const file = await tx.file.create({
      data: {
        spaceId: upload.spaceId,
        folderId: folder?.id ?? null,
        name,
        uploaderId: user.id,
        size: upload.size,
        mimeType: verdict.mime,
        currentVersionId: versionId,
        versions: { create: { ...versionData, number: 1 } },
      },
    });
    await logActivity(tx, c, { action: 'file.upload', targetType: 'file', targetId: file.id, targetLabel: name, spaceId: upload.spaceId, private: isPrivate, metadata: { size: expectedSize } });
    return { fileId: file.id, name, version: 1 };
  });
  return c.json(result, 201);
});

uploadRoutes.delete('/uploads/:id', async (c) => {
  const db = c.get('db');
  const upload = await db.upload.findFirst({ where: { id: c.req.param('id'), userId: c.get('user').id } });
  if (!upload) throw notFound('Import introuvable.');
  const claimed = await db.upload.updateMany({ where: { id: upload.id, status: 'PENDING' }, data: { status: 'ABORTED' } });
  if (claimed.count > 0) await discardUploadObject(c, upload);
  return c.json({ ok: true });
});

export async function discardUploadObject(c: Ctx, upload: { storageKey: string; multipartId: string | null }): Promise<void> {
  const storage = c.get('storage');
  if (upload.multipartId) await storage.abortMultipart(upload.storageKey, upload.multipartId).catch(() => undefined);
  await storage.delete(upload.storageKey).catch(() => undefined);
}
