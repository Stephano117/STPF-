// Restauration d'une sauvegarde vers la base et le stockage désignés par l'environnement.
// Sert aussi à MIGRER vers un autre fournisseur ou un serveur propriétaire.
//
//   1. Créez une base vide et appliquez le schéma :  npm run db:deploy
//   2. npm run restore -- --snapshot backups/snapshots/<date> --yes
//
// Options : --db-only, --files-only, --objects <dossier> (défaut : BACKUP_DIR/objects)
// Garde-fou : refuse d'écrire dans une base qui contient déjà des utilisateurs.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { arg, BACKUP_TABLES, decodeRow, flag, openDb, openStorage, type Manifest } from './_shared.ts';

const snapshotArg = arg('snapshot');
if (!snapshotArg || !flag('yes')) {
  console.error('Usage : npm run restore -- --snapshot <dossier de sauvegarde> --yes');
  console.error('        (--yes confirme l’écriture dans la base et le stockage configurés)');
  process.exit(2);
}
const snapshotDir = resolve(snapshotArg);
const objectsDir = arg('objects') ? resolve(arg('objects')!) : resolve(snapshotDir, '..', '..', 'objects');
const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as Manifest;
if (manifest.format !== 'stf-backup-v1') throw new Error('Format de sauvegarde inconnu.');

type Row = Record<string, unknown>;
type Delegate = { createMany: (a: { data: Row[] }) => Promise<{ count: number }>; count: () => Promise<number> };

async function readTable(table: string): Promise<Row[]> {
  const rows: Row[] = [];
  const rl = createInterface({ input: createReadStream(join(snapshotDir, 'tables', `${table}.jsonl`)), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(decodeRow(line));
  return rows;
}

/** Les dossiers parents doivent être insérés avant leurs enfants. */
function parentsFirst(rows: Row[]): Row[] {
  const byParent = new Map<string | null, Row[]>();
  for (const r of rows) {
    const key = (r.parentId as string | null) ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), r]);
  }
  const ordered: Row[] = [];
  const queue: (string | null)[] = [null];
  while (queue.length) {
    for (const r of byParent.get(queue.shift()!) ?? []) {
      ordered.push(r);
      queue.push(r.id as string);
    }
  }
  return ordered;
}

const { db, close } = openDb();
let failed = false;
try {
  if (!flag('files-only')) {
    const delegates = db as unknown as Record<string, Delegate>;
    if ((await delegates.user!.count()) > 0) {
      console.error('✗ La base cible contient déjà des utilisateurs. Restaurez dans une base vide (npm run db:deploy sur une base neuve).');
      process.exit(1);
    }
    // La migration initiale crée l'espace entreprise : on le retire pour restaurer celui de la sauvegarde.
    await db.folder.deleteMany({});
    await db.space.deleteMany({});
    for (const table of BACKUP_TABLES) {
      let rows = await readTable(table);
      if (table === 'folder') rows = parentsFirst(rows);
      // Prisma refuse `null` littéral pour une colonne JSON : l'absence de valeur suffit.
      if (table === 'activityLog') for (const r of rows) if (r.metadata === null) delete r.metadata;
      for (let i = 0; i < rows.length; i += 500) await delegates[table]!.createMany({ data: rows.slice(i, i + 500) });
      const expected = manifest.tables[table]?.rows ?? 0;
      const actual = await delegates[table]!.count();
      const ok = actual === expected;
      if (!ok) failed = true;
      console.log(`  ${ok ? '✓' : '✗'} base  ${table.padEnd(16)} ${actual}/${expected} ligne(s)`);
    }
  }

  if (!flag('db-only')) {
    const storage = openStorage();
    let uploaded = 0;
    let present = 0;
    for (const obj of manifest.objects) {
      const path = join(objectsDir, obj.key);
      if (!existsSync(path)) {
        console.error(`  ✗ objet absent de la sauvegarde : ${obj.key}`);
        failed = true;
        continue;
      }
      const existing = await storage.head(obj.key);
      if (existing?.size === obj.size) {
        present++;
        continue;
      }
      const size = (await stat(path)).size;
      await storage.put(obj.key, Readable.toWeb(createReadStream(path)) as unknown as BodyInit, size);
      const check = await storage.head(obj.key);
      if (check?.size !== obj.size) {
        console.error(`  ✗ envoi non confirmé : ${obj.key}`);
        failed = true;
      } else uploaded++;
    }
    console.log(`  fichiers : ${uploaded} envoyé(s), ${present} déjà présent(s), sur ${manifest.objects.length}`);
  }
} finally {
  await close();
}

if (failed) {
  console.error('\n✗ RESTAURATION INCOMPLÈTE — voir les lignes marquées ✗ ci-dessus.');
  process.exit(1);
}
console.log('\n✓ Restauration terminée et contrôlée. Les utilisateurs devront se reconnecter (sessions non restaurées).');
