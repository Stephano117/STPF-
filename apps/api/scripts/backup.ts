// Sauvegarde complète et indépendante des fournisseurs : base (JSON Lines) + fichiers.
//
//   npm run backup                 → sauvegarde dans BACKUP_DIR (défaut ./backups)
//   npm run backup -- --db-only    → base seule (utilisé par le cron GitHub Actions)
//
// Structure produite :
//   BACKUP_DIR/objects/<clé>             objets du stockage (incrémental : immuables, copiés une fois)
//   BACKUP_DIR/snapshots/<date>/tables/  une table par fichier .jsonl
//   BACKUP_DIR/snapshots/<date>/manifest.json   inventaire + empreintes SHA-256
//
// Le script se termine en erreur (code 1) si la sauvegarde est incomplète ou si une
// empreinte ne correspond pas : une sauvegarde n'est déclarée réussie qu'après relecture.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BACKUP_TABLES, encodeRow, flag, openDb, openStorage, type Manifest } from './_shared.ts';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const root = resolve(process.env.BACKUP_DIR || './backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotDir = join(root, 'snapshots', stamp);
const dbOnly = flag('db-only');
const manifest: Manifest = { format: 'stf-backup-v1', createdAt: new Date().toISOString(), tables: {}, objects: [], complete: false, problems: [] };

const { db, close } = openDb();
try {
  await mkdir(join(snapshotDir, 'tables'), { recursive: true });

  // ── 1. Base de données : export table par table, par pages ────────────────
  for (const table of BACKUP_TABLES) {
    const path = join(snapshotDir, 'tables', `${table}.jsonl`);
    const out = createWriteStream(path);
    const delegate = (db as unknown as Record<string, { findMany: (a: object) => Promise<Record<string, unknown>[]> }>)[table]!;
    let rows = 0;
    for (let skip = 0; ; skip += 1000) {
      const batch = await delegate.findMany({ skip, take: 1000, orderBy: orderFor(table) });
      for (const row of batch) out.write(encodeRow(row) + '\n');
      rows += batch.length;
      if (batch.length < 1000) break;
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    manifest.tables[table] = { rows, sha256: await sha256File(path) };
    console.log(`  base  ${table.padEnd(16)} ${rows} ligne(s)`);
  }

  // ── 2. Fichiers : copie incrémentale avec contrôle d'empreinte ────────────
  if (!dbOnly) {
    const storage = openStorage();
    const versions = await db.fileVersion.findMany({ select: { id: true, fileId: true, storageKey: true, size: true, sha256: true } });
    let copied = 0;
    for (const v of versions) {
      const target = join(root, 'objects', v.storageKey);
      try {
        if (!existsSync(target)) {
          await mkdir(dirname(target), { recursive: true });
          const res = await storage.get(v.storageKey);
          // Écriture dans un fichier temporaire puis renommage : jamais d'objet tronqué.
          await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${target}.part`));
          await rename(`${target}.part`, target);
          copied++;
        }
        const size = (await stat(target)).size;
        const sha256 = await sha256File(target);
        if (size !== Number(v.size)) manifest.problems.push(`${v.storageKey} : taille ${size} ≠ ${v.size} attendue`);
        if (v.sha256 && v.sha256 !== sha256) manifest.problems.push(`${v.storageKey} : empreinte différente de celle enregistrée à l'import`);
        manifest.objects.push({ key: v.storageKey, size, sha256, versionId: v.id, fileId: v.fileId });
      } catch (err) {
        await rm(`${target}.part`, { force: true });
        manifest.problems.push(`${v.storageKey} : ${(err as Error).message}`);
      }
    }
    console.log(`  fichiers  ${manifest.objects.length}/${versions.length} présent(s), dont ${copied} nouvellement copié(s)`);
  }

  manifest.complete = manifest.problems.length === 0;
  await writeFile(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
} finally {
  await close();
}

function orderFor(table: string): object {
  if (table === 'spaceMember') return [{ spaceId: 'asc' }, { userId: 'asc' }];
  if (table === 'favorite' || table === 'recentAccess') return [{ userId: 'asc' }, { fileId: 'asc' }];
  return { id: 'asc' };
}

if (!manifest.complete) {
  console.error(`\n✗ SAUVEGARDE INCOMPLÈTE — ${manifest.problems.length} problème(s) :`);
  for (const p of manifest.problems.slice(0, 20)) console.error(`   - ${p}`);
  console.error('  Relancez le script : les objets déjà copiés ne sont pas retéléchargés.');
  console.error('  (Un quota journalier de téléchargement atteint chez le fournisseur se lève le lendemain.)');
  process.exit(1);
}
console.log(`\n✓ Sauvegarde écrite et contrôlée : ${snapshotDir}`);
console.log(dbOnly ? '  Portée : base de données uniquement (--db-only).' : `  Portée : base + ${manifest.objects.length} objet(s).`);
console.log('  Vérification indépendante : npm run backup:verify');
