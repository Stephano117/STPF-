// Vérifie l'intégrité d'une sauvegarde en relisant chaque fichier depuis le disque.
//
//   npm run backup:verify                      → dernière sauvegarde de BACKUP_DIR
//   npm run backup:verify -- --snapshot <dossier>
//   npm run backup:verify -- --live            → compare aussi avec le stockage en production
//                                                (objets manquants / orphelins)

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { arg, flag, openDb, openStorage, type Manifest } from './_shared.ts';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const root = resolve(process.env.BACKUP_DIR || './backups');
let snapshotDir = arg('snapshot');
if (!snapshotDir) {
  const dir = join(root, 'snapshots');
  const all = existsSync(dir) ? (await readdir(dir)).sort() : [];
  if (all.length === 0) {
    console.error(`✗ Aucune sauvegarde trouvée dans ${dir}`);
    process.exit(1);
  }
  snapshotDir = join(dir, all[all.length - 1]!);
}
snapshotDir = resolve(snapshotDir);
const objectsDir = arg('objects') ? resolve(arg('objects')!) : resolve(snapshotDir, '..', '..', 'objects');

const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as Manifest;
const problems: string[] = [];
if (!manifest.complete) problems.push('le manifeste indique une sauvegarde incomplète');

for (const [table, info] of Object.entries(manifest.tables)) {
  const path = join(snapshotDir, 'tables', `${table}.jsonl`);
  if (!existsSync(path)) problems.push(`table ${table} : fichier absent`);
  else if ((await sha256File(path)) !== info.sha256) problems.push(`table ${table} : empreinte modifiée`);
}
let bytes = 0;
for (const obj of manifest.objects) {
  const path = join(objectsDir, obj.key);
  if (!existsSync(path)) {
    problems.push(`objet ${obj.key} : absent`);
    continue;
  }
  const size = (await stat(path)).size;
  bytes += size;
  if (size !== obj.size || (await sha256File(path)) !== obj.sha256) problems.push(`objet ${obj.key} : contenu altéré`);
}

console.log(`Sauvegarde : ${snapshotDir}`);
console.log(`  créée le ${manifest.createdAt}`);
console.log(`  ${Object.keys(manifest.tables).length} table(s), ${manifest.objects.length} objet(s), ${(bytes / 1024 / 1024).toFixed(1)} Mo relus`);

if (flag('live')) {
  const { db, close } = openDb();
  const storage = openStorage();
  try {
    const versions = await db.fileVersion.findMany({ select: { storageKey: true, size: true } });
    const backedUp = new Set(manifest.objects.map((o) => o.key));
    let missingInStorage = 0;
    let notBackedUp = 0;
    for (const v of versions) {
      if (!backedUp.has(v.storageKey)) notBackedUp++;
      const head = await storage.head(v.storageKey);
      if (!head || head.size !== Number(v.size)) {
        missingInStorage++;
        problems.push(`production : objet ${v.storageKey} absent ou tronqué dans le stockage`);
      }
    }
    console.log(`  production : ${versions.length} version(s), ${missingInStorage} absente(s) du stockage, ${notBackedUp} postérieure(s) à cette sauvegarde`);
  } finally {
    await close();
  }
}

if (problems.length > 0) {
  console.error(`\n✗ VÉRIFICATION ÉCHOUÉE — ${problems.length} problème(s) :`);
  for (const p of problems.slice(0, 30)) console.error(`   - ${p}`);
  process.exit(1);
}
console.log('\n✓ Sauvegarde intègre : toutes les empreintes correspondent.');
