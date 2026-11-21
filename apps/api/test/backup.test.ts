// Sauvegarde → vérification → restauration vers une AUTRE base et un AUTRE stockage,
// puis contrôle que l'application restaurée sert exactement les mêmes documents.
// Les vrais scripts (npm run backup / backup:verify / restore) sont exécutés tels quels.

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bytes, Client, createTestContext, createUser, download, pdf, resetDatabase, testEnv, upload, type TestContext } from './helpers.ts';

let ctx: TestContext;
let alice: Awaited<ReturnType<typeof createUser>>;
let sharedFileId: string;
const backupDir = join(inject('tmpDir'), 'backups');
const contents = { perso: pdf('document personnel'), v1: bytes('première version'), v2: bytes('seconde version, plus longue') };

function run(script: string, args: string[], env: Record<string, string>) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`, ...args], {
    env: { ...process.env, ...testEnv(), BACKUP_DIR: backupDir, DIRECT_URL: '', ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const latestSnapshot = () => {
  const dir = join(backupDir, 'snapshots');
  return join(dir, readdirSync(dir).sort().at(-1)!);
};

beforeAll(async () => {
  ctx = createTestContext();
  await resetDatabase(ctx.db);
  alice = await createUser(ctx, { email: 'alice@stf.test' });
  const bob = await createUser(ctx, { email: 'bob@stf.test' });
  await upload(alice.client, { spaceId: alice.personalSpaceId, name: 'perso.pdf', content: contents.perso });
  const spaceId = (await alice.client.post('/api/spaces', { name: 'Équipe' })).body.id;
  const inv = await alice.client.post(`/api/spaces/${spaceId}/invitations`, { userId: bob.user.id, role: 'EDITOR' });
  await bob.client.post(`/api/invitations/${inv.body.id}/accept`);
  const folder = await alice.client.post('/api/folders', { spaceId, name: 'Dossier' });
  const sub = await alice.client.post('/api/folders', { spaceId, parentId: folder.body.id, name: 'Sous-dossier' });
  const file = await upload(bob.client, { spaceId, folderId: sub.body.id, name: 'note.txt', content: contents.v1 });
  await upload(alice.client, { spaceId, name: 'note.txt', content: contents.v2, fileId: file.body.fileId });
  sharedFileId = file.body.fileId;
});
afterAll(() => ctx.close());

describe('sauvegarde et restauration', () => {
  it('produit une sauvegarde complète et vérifiée', () => {
    const res = run('backup', [], {});
    expect(res.out).toContain('Sauvegarde écrite et contrôlée');
    expect(res.code).toBe(0);
    const verify = run('backup-verify', ['--live'], {});
    expect(verify.out).toContain('Sauvegarde intègre');
    expect(verify.out).toContain('3 objet(s)');
    expect(verify.code).toBe(0);
  });

  it('restaure vers une base et un stockage vierges, à l’identique', async () => {
    const target = { DATABASE_URL: inject('restoreDatabaseUrl'), S3_ENDPOINT: inject('s3RestoreEndpoint') };
    const res = run('restore', ['--snapshot', latestSnapshot(), '--yes'], target);
    expect(res.out).toContain('Restauration terminée et contrôlée');
    expect(res.code).toBe(0);

    // L'application, branchée sur les ressources restaurées, sert les mêmes documents.
    const base = createTestContext();
    const restored = createTestContext({
      databaseUrl: target.DATABASE_URL,
      s3: { ...base.config.s3, endpoint: target.S3_ENDPOINT, internalEndpoint: target.S3_ENDPOINT },
    });
    await base.close();
    try {
      // Le journal d'activité est restauré intégralement (compté avant toute nouvelle activité).
      expect(await restored.db.activityLog.count()).toBe(await ctx.db.activityLog.count());
      const client = new Client(restored);
      expect((await client.login('alice@stf.test')).status).toBe(200); // les mots de passe sont conservés
      const current = await download(client, sharedFileId);
      expect(Buffer.from(current.data!).toString()).toBe('seconde version, plus longue');
      const detail = (await client.get(`/api/files/${sharedFileId}`)).body;
      expect(detail.breadcrumbs.map((b: any) => b.name)).toEqual(['Dossier', 'Sous-dossier']);
      expect(detail.versions).toHaveLength(2);
      const v1 = detail.versions.find((v: any) => v.number === 1);
      expect(Buffer.from((await download(client, sharedFileId, `?versionId=${v1.id}`)).data!).toString()).toBe('première version');
      const perso = (await client.get(`/api/spaces/${alice.personalSpaceId}/contents`)).body.files;
      expect(perso.map((f: any) => f.name)).toEqual(['perso.pdf']);
      expect((await client.get('/api/spaces')).body.shared.map((s: any) => s.name)).toEqual(['Équipe']);
    } finally {
      await restored.close();
    }

    // Garde-fou : une seconde restauration dans une base non vide est refusée.
    const again = run('restore', ['--snapshot', latestSnapshot(), '--yes'], target);
    expect(again.code).toBe(1);
    expect(again.out).toContain('contient déjà des utilisateurs');
  });

  it('la restauration exige une confirmation explicite', () => {
    expect(run('restore', ['--snapshot', latestSnapshot()], {}).code).toBe(2);
  });

  it('détecte une sauvegarde altérée', () => {
    const snapshot = latestSnapshot();
    const objects = join(backupDir, 'objects', 'o');
    const year = join(objects, readdirSync(objects)[0]!);
    const month = join(year, readdirSync(year)[0]!);
    const victim = join(month, readdirSync(month)[0]!);
    writeFileSync(victim, 'contenu corrompu');
    const res = run('backup-verify', ['--snapshot', snapshot], {});
    expect(res.code).toBe(1);
    expect(res.out).toContain('VÉRIFICATION ÉCHOUÉE');
  });

  it('signale une sauvegarde incomplète quand un objet manque dans le stockage', async () => {
    const version = await ctx.db.fileVersion.findFirstOrThrow({ where: { fileId: sharedFileId, number: 2 } });
    await ctx.storage.delete(version.storageKey);
    // L'objet local est aussi retiré pour forcer un nouveau téléchargement.
    const res = run('backup', [], { BACKUP_DIR: join(inject('tmpDir'), 'backups-2') });
    expect(res.code).toBe(1);
    expect(res.out).toContain('SAUVEGARDE INCOMPLÈTE');
  });
});
