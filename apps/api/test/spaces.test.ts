import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytes, commonFolderId, createTestContext, createUser, download, pdf, resetDatabase, upload, type TestContext } from './helpers.ts';

type U = Awaited<ReturnType<typeof createUser>>;
let ctx: TestContext;
let admin: U, owner: U, manager: U, editor: U, reader: U, outsider: U;
let shared: string;

async function invite(by: U, spaceId: string, target: U, role: string) {
  const res = await by.client.post(`/api/spaces/${spaceId}/invitations`, { userId: target.user.id, role });
  if (res.status !== 201) return res;
  return target.client.post(`/api/invitations/${res.body.id}/accept`);
}

beforeAll(async () => {
  ctx = createTestContext();
  await resetDatabase(ctx.db);
  admin = await createUser(ctx, { email: 'admin@stf.test', role: 'ADMIN' });
  owner = await createUser(ctx, { email: 'owner@stf.test' });
  manager = await createUser(ctx, { email: 'manager@stf.test' });
  editor = await createUser(ctx, { email: 'editor@stf.test' });
  reader = await createUser(ctx, { email: 'reader@stf.test' });
  outsider = await createUser(ctx, { email: 'outsider@stf.test' });
  shared = (await owner.client.post('/api/spaces', { name: 'Projet Alpha', description: 'Équipe projet' })).body.id;
});
afterAll(() => ctx.close());

describe('espaces partagés : invitations et rôles', () => {
  it('invite des collaborateurs qui acceptent et obtiennent leur rôle', async () => {
    expect((await invite(owner, shared, manager, 'MANAGER')).status).toBe(200);
    expect((await invite(owner, shared, editor, 'EDITOR')).status).toBe(200);
    expect((await invite(manager, shared, reader, 'READER')).status).toBe(200);
    const detail = (await owner.client.get(`/api/spaces/${shared}`)).body;
    const roles = Object.fromEntries(detail.members.map((m: any) => [m.email, m.role]));
    expect(roles).toEqual({ 'owner@stf.test': 'OWNER', 'manager@stf.test': 'MANAGER', 'editor@stf.test': 'EDITOR', 'reader@stf.test': 'READER' });
    expect((await reader.client.get('/api/spaces')).body.shared.map((s: any) => s.name)).toEqual(['Projet Alpha']);
  });

  it('une invitation ne donne aucun accès tant qu’elle n’est pas acceptée, et peut être refusée', async () => {
    const res = await owner.client.post(`/api/spaces/${shared}/invitations`, { userId: outsider.user.id, role: 'READER' });
    expect(res.status).toBe(201);
    expect((await outsider.client.get(`/api/spaces/${shared}/contents`)).status).toBe(404);
    expect((await outsider.client.get('/api/invitations')).body.invitations).toHaveLength(1);
    // Personne d'autre ne peut répondre à sa place.
    expect((await editor.client.post(`/api/invitations/${res.body.id}/accept`)).status).toBe(404);
    expect((await outsider.client.post(`/api/invitations/${res.body.id}/decline`)).status).toBe(200);
    expect((await outsider.client.post(`/api/invitations/${res.body.id}/accept`)).status).toBe(404);
    expect((await outsider.client.get(`/api/spaces/${shared}/contents`)).status).toBe(404);
  });

  it('respecte la hiérarchie : lecteur et éditeur n’invitent pas, un gestionnaire ne nomme pas de gestionnaire', async () => {
    const body = { userId: outsider.user.id, role: 'READER' };
    expect((await reader.client.post(`/api/spaces/${shared}/invitations`, body)).status).toBe(403);
    expect((await editor.client.post(`/api/spaces/${shared}/invitations`, body)).status).toBe(403);
    expect((await manager.client.post(`/api/spaces/${shared}/invitations`, { ...body, role: 'MANAGER' })).status).toBe(403);
    expect((await manager.client.patch(`/api/spaces/${shared}/members/${editor.user.id}`, { role: 'MANAGER' })).status).toBe(403);
    expect((await manager.client.patch(`/api/spaces/${shared}/members/${owner.user.id}`, { role: 'READER' })).status).toBe(403);
    expect((await manager.client.del(`/api/spaces/${shared}/members/${owner.user.id}`)).status).toBe(403);
    expect((await editor.client.del(`/api/spaces/${shared}/members/${reader.user.id}`)).status).toBe(403);
    expect((await editor.client.del(`/api/spaces/${shared}`)).status).toBe(403);
  });

  it('un lecteur consulte et télécharge mais ne modifie rien', async () => {
    const file = await upload(editor.client, { spaceId: shared, name: 'specs.pdf', content: pdf('specs') });
    expect(file.status).toBe(201);
    expect((await reader.client.get(`/api/spaces/${shared}/contents`)).body.canWrite).toBe(false);
    expect((await download(reader.client, file.body.fileId)).status).toBe(200);
    expect((await upload(reader.client, { spaceId: shared, name: 'intrus.pdf', content: pdf() })).status).toBe(403);
    expect((await upload(reader.client, { spaceId: shared, name: 'specs.pdf', content: pdf('v2'), fileId: file.body.fileId })).status).toBe(403);
    expect((await reader.client.patch(`/api/files/${file.body.fileId}`, { name: 'renomme.pdf' })).status).toBe(403);
    expect((await reader.client.post('/api/folders', { spaceId: shared, name: 'Dossier' })).status).toBe(403);
  });

  it('règle n° 8 : seul l’importateur supprime ; les autres peuvent modifier mais pas supprimer', async () => {
    const file = await upload(editor.client, { spaceId: shared, name: 'livrable.pdf', content: pdf('livrable') });
    const id = file.body.fileId;
    // Propriétaire et gestionnaire de l'espace : modification oui, suppression non.
    expect((await owner.client.patch(`/api/files/${id}`, { name: 'livrable-final.pdf' })).status).toBe(200);
    expect((await upload(manager.client, { spaceId: shared, name: 'x.pdf', content: pdf('v2'), fileId: id })).status).toBe(201);
    for (const user of [owner, manager, reader]) {
      const res = await user.client.del(`/api/files/${id}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_UPLOADER');
    }
    expect((await owner.client.get(`/api/spaces/${shared}/contents`)).body.files.find((f: any) => f.id === id).canDelete).toBe(false);
    // Un administrateur n'a pas davantage ce droit par l'interface client (il n'est pas membre).
    expect((await admin.client.del(`/api/files/${id}`)).status).toBe(404);
    // L'importateur, lui, peut supprimer — et lui seul peut restaurer ou purger.
    expect((await editor.client.del(`/api/files/${id}`)).status).toBe(200);
    expect((await owner.client.post(`/api/files/${id}/restore`)).status).toBe(403);
    expect((await owner.client.del(`/api/files/${id}/permanent`)).status).toBe(403);
    expect((await editor.client.post(`/api/files/${id}/restore`)).status).toBe(200);
  });

  it('un dossier contenant les fichiers d’autrui ne peut pas être supprimé par son créateur', async () => {
    const folder = await owner.client.post('/api/folders', { spaceId: shared, name: 'Commun' });
    await upload(editor.client, { spaceId: shared, folderId: folder.body.id, name: 'de-editor.txt', content: bytes('e') });
    const res = await owner.client.del(`/api/folders/${folder.body.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CONTAINS_FOREIGN_FILES');
    expect((await editor.client.del(`/api/folders/${folder.body.id}`)).body.error.code).toBe('NOT_OWNER');
  });

  it('un membre retiré perd immédiatement tout accès, y compris aux fichiers qu’il connaissait', async () => {
    const temp = await createUser(ctx, { email: 'temp@stf.test' });
    await invite(owner, shared, temp, 'EDITOR');
    const file = await upload(temp.client, { spaceId: shared, name: 'temp.txt', content: bytes('t') });
    expect((await owner.client.del(`/api/spaces/${shared}/members/${temp.user.id}`)).status).toBe(200);
    expect((await temp.client.get(`/api/spaces/${shared}/contents`)).status).toBe(404);
    expect((await temp.client.get(`/api/files/${file.body.fileId}/download`)).status).toBe(404);
    expect((await temp.client.del(`/api/files/${file.body.fileId}`)).status).toBe(404);
    expect((await temp.client.get('/api/search?q=temp')).body.files).toEqual([]);
  });

  it('un non-membre ne voit ni l’espace ni ses fichiers', async () => {
    const file = await upload(editor.client, { spaceId: shared, name: 'confidentiel.pdf', content: pdf() });
    expect((await outsider.client.get(`/api/spaces/${shared}`)).status).toBe(404);
    expect((await outsider.client.get(`/api/spaces/${shared}/contents`)).status).toBe(404);
    expect((await outsider.client.get(`/api/spaces/${shared}/tree`)).status).toBe(404);
    expect((await outsider.client.get(`/api/files/${file.body.fileId}`)).status).toBe(404);
    expect((await outsider.client.get(`/api/files/${file.body.fileId}/download`)).status).toBe(404);
    expect((await outsider.client.get(`/api/files/${file.body.fileId}/text`)).status).toBe(404);
    expect((await outsider.client.get(`/api/files/${file.body.fileId}/history`)).status).toBe(404);
    expect((await outsider.client.put(`/api/files/${file.body.fileId}/favorite`)).status).toBe(404);
    expect((await outsider.client.get('/api/search?q=confidentiel')).body.files).toEqual([]);
    expect((await upload(outsider.client, { spaceId: shared, name: 'x.pdf', content: pdf() })).status).toBe(404);
  });

  it('un utilisateur non autorisé ne peut pas créer d’espace', async () => {
    await ctx.db.user.update({ where: { id: outsider.user.id }, data: { canCreateSpaces: false } });
    expect((await outsider.client.post('/api/spaces', { name: 'Interdit' })).status).toBe(403);
  });
});

describe('espace personnel : strictement privé', () => {
  it('reste invisible aux autres collaborateurs et à l’administrateur', async () => {
    const folder = await owner.client.post('/api/folders', { spaceId: owner.personalSpaceId, name: 'Privé' });
    const file = await upload(owner.client, { spaceId: owner.personalSpaceId, folderId: folder.body.id, name: 'journal-intime.txt', content: bytes('secret') });
    const id = file.body.fileId;
    for (const other of [editor, admin]) {
      expect((await other.client.get(`/api/spaces/${owner.personalSpaceId}`)).status).toBe(404);
      expect((await other.client.get(`/api/spaces/${owner.personalSpaceId}/contents`)).status).toBe(404);
      expect((await other.client.get(`/api/files/${id}`)).status).toBe(404);
      expect((await other.client.get(`/api/files/${id}/download`)).status).toBe(404);
      expect((await other.client.get(`/api/files/${id}/text`)).status).toBe(404);
      expect((await other.client.patch(`/api/files/${id}`, { name: 'vole.txt' })).status).toBe(404);
      expect((await other.client.del(`/api/files/${id}`)).status).toBe(404);
      expect((await other.client.patch(`/api/folders/${folder.body.id}`, { name: 'Vu' })).status).toBe(404);
      expect((await other.client.post('/api/folders', { spaceId: owner.personalSpaceId, name: 'Intrusion' })).status).toBe(404);
      expect((await upload(other.client, { spaceId: owner.personalSpaceId, name: 'depot.txt', content: bytes('x') })).status).toBe(404);
      expect((await other.client.get('/api/search?q=journal')).body.files).toEqual([]);
    }
  });

  it('l’administration ne peut ni lister, ni supprimer, ni lire le journal d’un espace personnel', async () => {
    const file = await ctx.db.file.findFirstOrThrow({ where: { name: 'journal-intime.txt' } });
    const listing = (await admin.client.get('/api/admin/files?q=journal')).body.files;
    expect(listing).toEqual([]);
    expect((await admin.client.del(`/api/admin/files/${file.id}`, { reason: 'curiosité déplacée' })).status).toBe(404);
    expect((await admin.client.get('/api/admin/spaces')).body.spaces.some((s: any) => s.type === 'PERSONAL')).toBe(false);
    const logs = (await admin.client.get('/api/admin/logs?limit=200')).body.logs;
    expect(logs.some((l: any) => l.targetLabel === 'journal-intime.txt' || l.targetLabel === 'Privé')).toBe(false);
    // Les quotas (tailles seules) restent visibles pour piloter la capacité.
    const quotas = (await admin.client.get('/api/admin/quotas')).body;
    expect(quotas.users.find((u: any) => u.email === 'owner@stf.test').usedBytes).toBeGreaterThan(0);
  });

  it('un espace personnel ne peut pas recevoir de membres', async () => {
    expect((await owner.client.post(`/api/spaces/${owner.personalSpaceId}/invitations`, { userId: editor.user.id, role: 'READER' })).status).toBe(403);
  });
});

describe('espace entreprise', () => {
  it('est lisible par tous ; la racine est réservée aux administrateurs', async () => {
    const root = (await reader.client.get('/api/spaces/company/contents')).body;
    expect(root.canWrite).toBe(false);
    expect(root.folders.map((f: any) => f.name).sort()).toEqual(['Documents communs']);
    expect((await reader.client.post('/api/folders', { spaceId: 'company', name: 'Sauvage' })).status).toBe(403);
    expect((await upload(reader.client, { spaceId: 'company', name: 'racine.pdf', content: pdf() })).status).toBe(403);
    expect((await admin.client.post('/api/folders', { spaceId: 'company', name: 'Procédures' })).status).toBe(201);
  });

  it('tout collaborateur écrit dans les dossiers communs', async () => {
    const common = await commonFolderId(ctx);
    expect((await upload(reader.client, { spaceId: 'company', folderId: common, name: 'note-de-service.pdf', content: pdf() })).status).toBe(201);
    expect((await reader.client.post('/api/folders', { spaceId: 'company', parentId: common, name: 'Modèles' })).status).toBe(201);
  });

  it('un dossier officiel n’est modifiable que par les administrateurs, sous-dossiers compris', async () => {
    const common = await commonFolderId(ctx);
    const official = await admin.client.post('/api/folders', { spaceId: 'company', name: 'Règlement intérieur' });
    const child = await admin.client.post('/api/folders', { spaceId: 'company', parentId: official.body.id, name: 'Annexes' });
    expect((await reader.client.patch(`/api/admin/folders/${official.body.id}`, { restricted: true })).status).toBe(403);
    expect((await admin.client.patch(`/api/admin/folders/${official.body.id}`, { restricted: true })).status).toBe(200);
    expect((await upload(owner.client, { spaceId: 'company', folderId: child.body.id, name: 'x.pdf', content: pdf() })).status).toBe(403);
    expect((await upload(admin.client, { spaceId: 'company', folderId: child.body.id, name: 'annexe.pdf', content: pdf() })).status).toBe(201);
    // Impossible de contourner en déplaçant un fichier vers le dossier officiel.
    const mine = await upload(owner.client, { spaceId: 'company', folderId: common, name: 'a-glisser.pdf', content: pdf() });
    expect((await owner.client.patch(`/api/files/${mine.body.fileId}`, { folderId: official.body.id })).status).toBe(403);
  });
});

describe('suppression administrative et archivage', () => {
  it('l’administrateur supprime avec un motif obligatoire, et l’opération est journalisée', async () => {
    const file = await upload(editor.client, { spaceId: shared, name: 'inapproprie.pdf', content: pdf() });
    const id = file.body.fileId;
    expect((await owner.client.del(`/api/admin/files/${id}`, { reason: 'pas admin' })).status).toBe(403);
    expect((await admin.client.del(`/api/admin/files/${id}`, {})).status).toBe(400);
    expect((await admin.client.del(`/api/admin/files/${id}`, { reason: 'Contenu inapproprié signalé' })).status).toBe(200);
    expect((await editor.client.get(`/api/files/${id}`)).status).toBe(404);
    const log = await ctx.db.activityLog.findFirstOrThrow({ where: { action: 'admin.file_delete', targetId: id } });
    expect(log.actorId).toBe(admin.user.id);
    expect((log.metadata as any).reason).toBe('Contenu inapproprié signalé');
    expect((await admin.client.post(`/api/admin/files/${id}/restore`)).status).toBe(200);
    expect((await editor.client.get(`/api/files/${id}`)).status).toBe(200);
  });

  it('archiver un espace le masque sans rien détruire ; seul l’admin peut le restaurer ou le purger', async () => {
    const spaceId = (await owner.client.post('/api/spaces', { name: 'Éphémère' })).body.id;
    await invite(owner, spaceId, editor, 'EDITOR');
    const file = await upload(editor.client, { spaceId, name: 'reste.pdf', content: pdf('reste') });
    const key = (await ctx.db.fileVersion.findFirstOrThrow({ where: { fileId: file.body.fileId } })).storageKey;

    expect((await owner.client.del(`/api/spaces/${spaceId}`)).status).toBe(200);
    expect((await editor.client.get(`/api/spaces/${spaceId}/contents`)).status).toBe(404);
    expect((await editor.client.get(`/api/files/${file.body.fileId}/download`)).status).toBe(404);
    expect(await ctx.storage.head(key)).not.toBeNull();

    expect((await admin.client.post(`/api/admin/spaces/${spaceId}/restore`)).status).toBe(200);
    expect((await download(editor.client, file.body.fileId)).status).toBe(200);

    // Purge : refusée sans archivage préalable, sans motif ou sans confirmation du nom.
    expect((await admin.client.del(`/api/admin/spaces/${spaceId}`, { reason: 'Projet terminé', confirmName: 'Éphémère' })).status).toBe(400);
    await admin.client.post(`/api/admin/spaces/${spaceId}/archive`);
    expect((await admin.client.del(`/api/admin/spaces/${spaceId}`, { reason: 'Projet terminé', confirmName: 'Autre' })).status).toBe(400);
    expect((await owner.client.del(`/api/admin/spaces/${spaceId}`, { reason: 'Projet terminé', confirmName: 'Éphémère' })).status).toBe(403);
    const purge = await admin.client.del(`/api/admin/spaces/${spaceId}`, { reason: 'Projet terminé', confirmName: 'Éphémère' });
    expect(purge.status).toBe(200);
    expect(await ctx.storage.head(key)).toBeNull();
    expect(await ctx.db.activityLog.count({ where: { action: 'admin.space_purge', targetId: spaceId } })).toBe(1);
  });

  it('l’administrateur gère les membres et transfère la propriété', async () => {
    expect((await admin.client.put(`/api/admin/spaces/${shared}/members/${outsider.user.id}`, { role: 'READER' })).status).toBe(200);
    expect((await outsider.client.get(`/api/spaces/${shared}/contents`)).status).toBe(200);
    expect((await admin.client.del(`/api/admin/spaces/${shared}/members/${owner.user.id}`)).status).toBe(403);
    expect((await admin.client.put(`/api/admin/spaces/${shared}/members/${manager.user.id}`, { role: 'OWNER' })).status).toBe(200);
    const members = (await admin.client.get(`/api/admin/spaces/${shared}/members`)).body.members;
    expect(members.filter((m: any) => m.role === 'OWNER').map((m: any) => m.email)).toEqual(['manager@stf.test']);
    expect(members.find((m: any) => m.email === 'owner@stf.test').role).toBe('MANAGER');
  });
});
