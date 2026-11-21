// Tâches d'entretien, sans processus permanent : déclenchées par un cron (Workers Cron
// Trigger, GitHub Actions ou minuterie Node) via POST /api/maintenance/run.

import type { Config } from '../config.ts';
import type { Ctx } from './context.ts';
import type { Db } from './db.ts';
import type { StorageAdapter } from './storage.ts';
import { purgeFiles } from './fileops.ts';
import { globalUsage } from './access.ts';

export interface MaintenanceDeps {
  db: Db;
  storage: StorageAdapter;
  config: Config;
}

/** Contexte minimal pour les opérations lancées hors requête utilisateur. */
function systemContext(deps: MaintenanceDeps): Ctx {
  const values: Record<string, unknown> = { db: deps.db, storage: deps.storage, config: deps.config, ip: null, user: undefined };
  return { get: (key: string) => values[key] } as unknown as Ctx;
}

export async function runMaintenance(deps: MaintenanceDeps) {
  const { db, storage, config } = deps;
  const c = systemContext(deps);
  const now = new Date();
  const system = { actor: { id: null, label: 'Système' } };

  // 1. Imports abandonnés : libère le quota réservé et efface les objets partiels.
  const stale = await db.upload.findMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, take: 200 });
  for (const upload of stale) {
    const claimed = await db.upload.updateMany({ where: { id: upload.id, status: 'PENDING' }, data: { status: 'ABORTED' } });
    if (claimed.count === 0) continue;
    if (upload.multipartId) await storage.abortMultipart(upload.storageKey, upload.multipartId).catch(() => undefined);
    await storage.delete(upload.storageKey).catch(() => undefined);
  }

  // 2. Corbeille : purge définitive après le délai de conservation (journalisée fichier par fichier).
  const cutoff = new Date(now.getTime() - config.trashRetentionDays * 86_400_000);
  const expired = await db.file.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true }, take: 200 });
  const purgedFiles = await purgeFiles(db, c, { ids: expired.map((f) => f.id) }, 'system.trash_purge', { retentionDays: config.trashRetentionDays });
  let purgedFolders = 0;
  if (expired.length < 200) {
    // Les dossiers ne sont retirés qu'une fois tous leurs fichiers expirés purgés.
    purgedFolders = (await db.folder.deleteMany({ where: { deletedAt: { lt: cutoff }, files: { none: {} } } })).count;
  }

  // 3. Données techniques périmées.
  const [sessions] = await Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 86_400_000) } } }),
    db.errorLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } }),
    db.upload.deleteMany({ where: { status: { not: 'PENDING' }, createdAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } } }),
  ]);

  const usage = await globalUsage(db);
  const summary = {
    abortedUploads: stale.length,
    purgedFiles,
    purgedFolders,
    expiredSessions: sessions.count,
    storageUsedBytes: usage.stored,
    storageQuotaBytes: config.storageQuotaBytes,
  };
  await db.activityLog.create({ data: { action: 'system.maintenance', actorLabel: system.actor.label, metadata: summary } });
  return summary;
}

export function quotaLevel(used: number, quota: number): 'ok' | 'warning' | 'critical' {
  const ratio = quota > 0 ? used / quota : 0;
  return ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'warning' : 'ok';
}
