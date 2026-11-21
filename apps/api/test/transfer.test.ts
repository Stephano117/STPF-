import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytes, commonFolderId, createTestContext, createUser, download, pdf, resetDatabase, upload, type TestContext } from './helpers.ts';

type U = Awaited<ReturnType<typeof createUser>>;
let ctx: TestContext;
let alice: U, bob: U, eve: U;
let shared: string;
let common: string;

const names = async (u: U, spaceId: string, folderId?: string) =>
  (await u.client.get(`/api/spaces/${spaceId}/contents${folderId ? `?folderId=${folderId}` : ''}`)).body.files.map((f: any) => f.name);
const text = async (u: U, fileId: string) => Buffer.from((await download(u.client, fileId)).data!).toString();
const transfer = (u: U, kind: 'files' | 'folders', id: string, mode: 'move' | 'copy', spaceId: string, folderId: string | null = null) =>
  u.client.post(`/api/${kind}/${id}/transfer`, { mode, spaceId, folderId });

beforeAll(async () => {
  ctx = createTestContext({ userQuotaBytes: 2000 });
  await resetDatabase(ctx.db);
  alice = await createUser(ctx, { email: 'alice@stf.test' });
  bob = await createUser(ctx, { email: 'bob@stf.test' });
  eve = await createUser(ctx, { email: 'eve@stf.test' });
  shared = (await alice.client.post('/api/spaces', { name: 'Équipe' })).body.id;
  const inv = await alice.client.post(`/api/spaces/${shared}/invitations`, { userId: bob.user.id, role: 'EDITOR' });
  await bob.client.post(`/api/invitations/${inv.body.id}/accept`);
  common = await commonFolderId(ctx);
});
afterAll(() => ctx.close());

describe('copie entre espaces', () => {
  it('copie un fichier de mon espace vers un espace partagé : deux fichiers indépendants', async () => {
    const original = await upload(alice.client, { spaceId: alice.personalSpaceId, name: 'note.txt', content: bytes('contenu original') });
    const res = await transfer(alice, 'files', original.body.fileId, 'copy', shared);
    expect(res.status).toBe(201);
    expect(res.body.fileId).not.toBe(original.body.fileId);
    expect(await names(alice, alice.personalSpaceId)).toContain('note.txt'); // l'original reste
    expect(await text(bob, res.body.fileId)).toBe('contenu original'); // Bob lit la copie
    expect((await bob.client.get(`/api/files/${original.body.fileId}`)).status).toBe(404); // pas l'original
    // Supprimer l'original ne touche pas la copie.
    await alice.client.del(`/api/files/${original.body.fileId}`);
    await alice.client.del(`/api/files/${original.body.fileId}/permanent`);
    expect(await text(bob, res.body.fileId)).toBe('contenu original');
  });

  it('celui qui copie devient l’importateur de la copie', async () => {
    const original = await upload(alice.client, { spaceId: shared, name: 'modele.txt', content: bytes('modèle') });
    const copy = await transfer(bob, 'files', original.body.fileId, 'copy', bob.personalSpaceId);
    expect(copy.status).toBe(201);
    expect((await bob.client.del(`/api/files/${copy.body.fileId}`)).status).toBe(200); // sa copie : il peut la supprimer
    expect((await bob.client.del(`/api/files/${original.body.fileId}`)).status).toBe(403); // pas l'original
  });

  it('renomme la copie si le nom est déjà pris à destination', async () => {
    const f = await upload(alice.client, { spaceId: shared, name: 'doublon.txt', content: bytes('a') });
    const copy = await transfer(alice, 'files', f.body.fileId, 'copy', shared);
    expect(copy.body.name).toBe('doublon (2).txt');
  });

  it('refuse la copie sans lecture de la source ou sans écriture à destination', async () => {
    const secret = await upload(alice.client, { spaceId: shared, name: 'equipe.txt', content: bytes('équipe') });
    // Ève n'est pas membre : la source lui est invisible.
    expect((await transfer(eve, 'files', secret.body.fileId, 'copy', eve.personalSpaceId)).status).toBe(404);
    // Bob ne peut pas déposer dans l'espace personnel d'Alice, ni à la racine de l'espace entreprise.
    expect((await transfer(bob, 'files', secret.body.fileId, 'copy', alice.personalSpaceId)).status).toBe(404);
    expect((await transfer(bob, 'files', secret.body.fileId, 'copy', 'company')).status).toBe(403);
    expect((await transfer(bob, 'files', secret.body.fileId, 'copy', 'company', common)).status).toBe(201);
  });

  it('applique le quota de la destination et ne laisse aucun objet orphelin', async () => {
    const big = await upload(alice.client, { spaceId: shared, name: 'gros.txt', content: bytes('x'.repeat(1500)) });
    await upload(bob.client, { spaceId: bob.personalSpaceId, name: 'deja-la.txt', content: bytes('y'.repeat(800)) });
    const before = await ctx.db.fileVersion.count();
    const res = await transfer(bob, 'files', big.body.fileId, 'copy', bob.personalSpaceId);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(await ctx.db.fileVersion.count()).toBe(before);
  });

  it('copie un dossier entier avec ses sous-dossiers', async () => {
    const root = await alice.client.post('/api/folders', { spaceId: alice.personalSpaceId, name: 'Dossier' });
    const sub = await alice.client.post('/api/folders', { spaceId: alice.personalSpaceId, parentId: root.body.id, name: 'Sous' });
    await upload(alice.client, { spaceId: alice.personalSpaceId, folderId: root.body.id, name: 'a.txt', content: bytes('A') });
    await upload(alice.client, { spaceId: alice.personalSpaceId, folderId: sub.body.id, name: 'b.pdf', content: pdf('B') });
    const res = await transfer(alice, 'folders', root.body.id, 'copy', shared);
    expect(res.status).toBe(201);
    expect(await names(bob, shared, res.body.folderId)).toEqual(['a.txt']);
    const subCopy = (await bob.client.get(`/api/spaces/${shared}/contents?folderId=${res.body.folderId}`)).body.folders;
    expect(subCopy.map((f: any) => f.name)).toEqual(['Sous']);
    expect(await names(bob, shared, subCopy[0].id)).toEqual(['b.pdf']);
    expect(await names(alice, alice.personalSpaceId, root.body.id)).toEqual(['a.txt']); // l'original est intact
  });
});

describe('déplacement entre espaces', () => {
  it('l’importateur déplace son fichier vers un autre espace, versions comprises', async () => {
    const f = await upload(alice.client, { spaceId: alice.personalSpaceId, name: 'rapport.txt', content: bytes('v1') });
    await upload(alice.client, { spaceId: alice.personalSpaceId, name: 'rapport.txt', content: bytes('v2'), fileId: f.body.fileId });
    const res = await transfer(alice, 'files', f.body.fileId, 'move', shared);
    expect(res.status).toBe(200);
    expect(res.body.fileId).toBe(f.body.fileId);
    expect(await names(alice, alice.personalSpaceId)).not.toContain('rapport.txt');
    expect(await text(bob, f.body.fileId)).toBe('v2');
    expect((await bob.client.get(`/api/files/${f.body.fileId}`)).body.versions).toHaveLength(2);
  });

  it('règle n° 8 : un autre membre ne peut pas sortir un fichier de l’espace, mais peut le copier', async () => {
    const f = await upload(alice.client, { spaceId: shared, name: 'a-alice.txt', content: bytes('alice') });
    const move = await transfer(bob, 'files', f.body.fileId, 'move', bob.personalSpaceId);
    expect(move.status).toBe(403);
    expect(move.body.error.code).toBe('NOT_UPLOADER');
    expect(await names(alice, shared)).toContain('a-alice.txt');
    // À l'intérieur du même espace, un éditeur peut déplacer.
    const folder = await bob.client.post('/api/folders', { spaceId: shared, name: 'Rangement' });
    expect((await transfer(bob, 'files', f.body.fileId, 'move', shared, folder.body.id)).status).toBe(200);
    expect(await names(alice, shared, folder.body.id)).toEqual(['a-alice.txt']);
  });

  it('le déplacement vers un espace personnel respecte son quota', async () => {
    const f = await upload(bob.client, { spaceId: shared, name: 'lourd.txt', content: bytes('z'.repeat(1500)) });
    const res = await transfer(bob, 'files', f.body.fileId, 'move', bob.personalSpaceId);
    expect(res.status).toBe(413);
    expect(await names(alice, shared)).toContain('lourd.txt');
  });

  it('un dossier ne change d’espace que par son créateur et sans fichiers d’autrui', async () => {
    const mine = await alice.client.post('/api/folders', { spaceId: shared, name: 'Projet' });
    await upload(alice.client, { spaceId: shared, folderId: mine.body.id, name: 'plan.txt', content: bytes('plan') });
    expect((await transfer(bob, 'folders', mine.body.id, 'move', bob.personalSpaceId)).body.error.code).toBe('NOT_OWNER');
    const foreign = await upload(bob.client, { spaceId: shared, folderId: mine.body.id, name: 'de-bob.txt', content: bytes('bob') });
    expect((await transfer(alice, 'folders', mine.body.id, 'move', alice.personalSpaceId)).body.error.code).toBe('CONTAINS_FOREIGN_FILES');
    await bob.client.del(`/api/files/${foreign.body.fileId}`);
    await bob.client.del(`/api/files/${foreign.body.fileId}/permanent`);
    const ok = await transfer(alice, 'folders', mine.body.id, 'move', alice.personalSpaceId);
    expect(ok.status).toBe(200);
    expect(await names(alice, alice.personalSpaceId, mine.body.id)).toEqual(['plan.txt']);
    expect((await bob.client.get(`/api/spaces/${shared}/contents?folderId=${mine.body.id}`)).status).toBe(404);
  });

  it('un dossier ne peut pas être placé dans lui-même', async () => {
    const a = await alice.client.post('/api/folders', { spaceId: shared, name: 'Parent' });
    const b = await alice.client.post('/api/folders', { spaceId: shared, parentId: a.body.id, name: 'Enfant' });
    expect((await transfer(alice, 'folders', a.body.id, 'move', shared, b.body.id)).status).toBe(400);
    expect((await transfer(alice, 'folders', a.body.id, 'copy', shared, b.body.id)).status).toBe(400);
  });

  it('les transferts sont journalisés', async () => {
    const actions = (await ctx.db.activityLog.findMany({ select: { action: true } })).map((l) => l.action);
    for (const a of ['file.copy', 'file.move', 'folder.copy', 'folder.move']) expect(actions).toContain(a);
  });
});
