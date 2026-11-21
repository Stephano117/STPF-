import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto.ts';
import { runMaintenance } from '../src/lib/maintenance.ts';
import { bytes, Client, createTestContext, createUser, download, pdf, resetDatabase, upload, type TestContext } from './helpers.ts';

let ctx: TestContext;
let alice: Awaited<ReturnType<typeof createUser>>;
let space: string;

beforeAll(async () => {
  ctx = createTestContext({ maxFileSizeBytes: 5 * 1024 * 1024, userQuotaBytes: 8 * 1024 * 1024 });
  await resetDatabase(ctx.db);
  alice = await createUser(ctx, { email: 'alice@stf.test' });
  space = alice.personalSpaceId;
});
afterAll(() => ctx.close());

const list = async (client: Client, spaceId: string, folderId?: string) =>
  (await client.get(`/api/spaces/${spaceId}/contents${folderId ? `?folderId=${folderId}` : ''}`)).body;

describe('import et téléchargement', () => {
  it('importe un fichier puis le restitue à l’identique via une URL signée', async () => {
    const content = pdf('rapport annuel');
    const res = await upload(alice.client, { spaceId: space, name: 'rapport.pdf', content });
    expect(res.status).toBe(201);
    const got = await download(alice.client, res.body.fileId);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.data!).equals(Buffer.from(content))).toBe(true);
    // Téléchargement : servi en binaire avec le nom d'origine, jamais interprété.
    expect(got.headers!.get('content-type')).toBe('application/octet-stream');
    expect(got.headers!.get('content-disposition')).toContain('attachment');
    expect(got.headers!.get('content-disposition')).toContain('rapport.pdf');
    const detail = await alice.client.get(`/api/files/${res.body.fileId}`);
    expect(detail.body.file.mimeType).toBe('application/pdf');
    expect(detail.body.versions[0].sha256).toBe(await sha256Hex(content));
  });

  it('l’URL signée est temporaire et le stockage refuse tout accès non signé', async () => {
    const res = await upload(alice.client, { spaceId: space, name: 'secret.pdf', content: pdf('secret') });
    const { body } = await alice.client.get(`/api/files/${res.body.fileId}/download`);
    const url = new URL(body.url);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(body.url).not.toContain('test-secret');
    expect((await fetch(`${url.origin}${url.pathname}`)).status).toBe(403);
  });

  it('prévisualise en ligne les types sûrs, et jamais le HTML', async () => {
    const pdfFile = await upload(alice.client, { spaceId: space, name: 'apercu.pdf', content: pdf() });
    const inline = await download(alice.client, pdfFile.body.fileId, '?inline=1');
    expect(inline.headers!.get('content-type')).toBe('application/pdf');
    expect(inline.headers!.get('content-disposition')).toContain('inline');

    const html = await upload(alice.client, { spaceId: space, name: 'page.html', content: bytes('<script>alert(1)</script>') });
    expect(html.status).toBe(201);
    const forced = await download(alice.client, html.body.fileId, '?inline=1');
    expect(forced.body.inline).toBe(false);
    expect(forced.headers!.get('content-type')).toBe('application/octet-stream');
    expect(forced.headers!.get('content-disposition')).toContain('attachment');
  });

  it('fournit un aperçu texte', async () => {
    const txt = await upload(alice.client, { spaceId: space, name: 'notes.txt', content: bytes('Bonjour SPT — accents éàü') });
    const res = await alice.client.get(`/api/files/${txt.body.fileId}/text`);
    expect(res.body.text).toBe('Bonjour SPT — accents éàü');
    expect(res.body.truncated).toBe(false);
  });

  it('renomme automatiquement en cas de doublon de nom', async () => {
    const a = await upload(alice.client, { spaceId: space, name: 'doublon.txt', content: bytes('a') });
    const b = await upload(alice.client, { spaceId: space, name: 'doublon.txt', content: bytes('b') });
    expect(a.body.name).toBe('doublon.txt');
    expect(b.body.name).toBe('doublon (2).txt');
  });
});

describe('contrôle des fichiers', () => {
  it('refuse les extensions exécutables dès la demande d’import', async () => {
    const res = await upload(alice.client, { spaceId: space, name: 'virus.exe', content: bytes('MZ....') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_REJECTED');
  });

  it('refuse un exécutable déguisé (contrôle du contenu réel) et efface l’objet', async () => {
    const res = await upload(alice.client, { spaceId: space, name: 'facture.pdf', content: bytes('MZ\x90\x00 faux pdf') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_REJECTED');
    const rejected = await ctx.db.upload.findFirstOrThrow({ where: { name: 'facture.pdf' } });
    expect(rejected.status).toBe('ABORTED');
    expect(await ctx.storage.head(rejected.storageKey)).toBeNull();
    expect((await list(alice.client, space)).files.some((f: any) => f.name === 'facture.pdf')).toBe(false);
  });

  it('refuse un contenu qui ne correspond pas à son extension', async () => {
    const res = await upload(alice.client, { spaceId: space, name: 'photo.png', content: bytes('ceci est du texte') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_REJECTED');
  });

  it('refuse un nom dangereux (traversée de chemin)', async () => {
    const res = await alice.client.post('/api/uploads', { spaceId: space, name: '../../etc/passwd', size: 10 });
    expect(res.status).toBe(400);
  });

  it('applique la taille maximale configurée', async () => {
    const res = await alice.client.post('/api/uploads', { spaceId: space, name: 'gros.zip', size: 6 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('applique le quota de l’espace personnel, imports en cours compris', async () => {
    const bob = await createUser(ctx, { email: 'quota@stf.test' });
    const mb4 = 4 * 1024 * 1024;
    expect((await bob.client.post('/api/uploads', { spaceId: bob.personalSpaceId, name: 'a.bin', size: mb4 })).status).toBe(201);
    // 4 Mo réservés + 4 Mo = 8 Mo : pile le quota, accepté. Un octet de plus est refusé.
    expect((await bob.client.post('/api/uploads', { spaceId: bob.personalSpaceId, name: 'b.bin', size: mb4 })).status).toBe(201);
    const over = await bob.client.post('/api/uploads', { spaceId: bob.personalSpaceId, name: 'c.bin', size: 1 });
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('transferts interrompus', () => {
  it('un import jamais envoyé ne crée aucun fichier', async () => {
    const init = await alice.client.post('/api/uploads', { spaceId: space, name: 'fantome.txt', size: 100 });
    const done = await alice.client.post(`/api/uploads/${init.body.id}/complete`);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect((await list(alice.client, space)).files.some((f: any) => f.name === 'fantome.txt')).toBe(false);
  });

  it('un envoi tronqué est détecté, rejeté et nettoyé', async () => {
    const init = await alice.client.post('/api/uploads', { spaceId: space, name: 'tronque.txt', size: 1000 });
    await fetch(init.body.url, { method: 'PUT', body: bytes('seulement le début') });
    const done = await alice.client.post(`/api/uploads/${init.body.id}/complete`);
    expect(done.status).toBe(400);
    expect(done.body.error.code).toBe('SIZE_MISMATCH');
    const row = await ctx.db.upload.findUniqueOrThrow({ where: { id: init.body.id } });
    expect(row.status).toBe('ABORTED');
    expect(await ctx.storage.head(row.storageKey)).toBeNull();
  });

  it('après une erreur réseau, le même import peut être repris et finalisé', async () => {
    const content = bytes('contenu complet du document');
    const init = await alice.client.post('/api/uploads', { spaceId: space, name: 'repris.txt', size: content.length });
    expect((await alice.client.post(`/api/uploads/${init.body.id}/complete`)).status).toBe(409);
    const fresh = await alice.client.post(`/api/uploads/${init.body.id}/url`);
    await fetch(fresh.body.url, { method: 'PUT', body: content });
    const done = await alice.client.post(`/api/uploads/${init.body.id}/complete`);
    expect(done.status).toBe(201);
    expect(Buffer.from((await download(alice.client, done.body.fileId)).data!).toString()).toBe('contenu complet du document');
  });

  it('deux finalisations simultanées ne créent qu’un seul fichier', async () => {
    const content = bytes('unique');
    const init = await alice.client.post('/api/uploads', { spaceId: space, name: 'unique.txt', size: content.length });
    await fetch(init.body.url, { method: 'PUT', body: content });
    const results = await Promise.all([1, 2, 3].map(() => alice.client.post(`/api/uploads/${init.body.id}/complete`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.db.file.count({ where: { name: { startsWith: 'unique' }, spaceId: space } })).toBe(1);
  });

  it('un import abandonné est annulé par la maintenance et libère le quota', async () => {
    const carl = await createUser(ctx, { email: 'abandon@stf.test' });
    const init = await carl.client.post('/api/uploads', { spaceId: carl.personalSpaceId, name: 'abandon.bin', size: 4 * 1024 * 1024 });
    await fetch(init.body.url, { method: 'PUT', body: bytes('partiel') });
    await ctx.db.upload.update({ where: { id: init.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await carl.client.post(`/api/uploads/${init.body.id}/complete`)).status).toBe(410);
    const summary = await runMaintenance(ctx);
    expect(summary.abortedUploads).toBeGreaterThanOrEqual(1);
    const row = await ctx.db.upload.findUniqueOrThrow({ where: { id: init.body.id } });
    expect(row.status).toBe('ABORTED');
    expect(await ctx.storage.head(row.storageKey)).toBeNull();
    expect((await carl.client.get('/api/auth/usage')).body.personal.used).toBe(0);
  });

  it('un import ne peut pas être finalisé par un autre utilisateur', async () => {
    const eve = await createUser(ctx, { email: 'eve-upload@stf.test' });
    const init = await alice.client.post('/api/uploads', { spaceId: space, name: 'a-moi.txt', size: 3 });
    expect((await eve.client.post(`/api/uploads/${init.body.id}/complete`)).status).toBe(404);
    expect((await eve.client.del(`/api/uploads/${init.body.id}`)).status).toBe(404);
  });
});

describe('organisation : dossiers, renommage, déplacement', () => {
  it('crée des dossiers et sous-dossiers, refuse les doublons', async () => {
    const parent = await alice.client.post('/api/folders', { spaceId: space, name: 'Projets' });
    expect(parent.status).toBe(201);
    const child = await alice.client.post('/api/folders', { spaceId: space, parentId: parent.body.id, name: '2026' });
    expect(child.status).toBe(201);
    expect((await alice.client.post('/api/folders', { spaceId: space, name: 'projets' })).status).toBe(409);
    const inside = await list(alice.client, space, child.body.id);
    expect(inside.breadcrumbs.map((b: any) => b.name)).toEqual(['Projets', '2026']);
  });

  it('renomme et déplace un fichier ; l’extension ne peut pas changer', async () => {
    const folder = await alice.client.post('/api/folders', { spaceId: space, name: 'Archives' });
    const file = await upload(alice.client, { spaceId: space, name: 'brouillon.txt', content: bytes('x') });
    expect((await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'final.txt' })).status).toBe(200);
    expect((await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'final.exe' })).status).toBe(400);
    expect((await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'final.pdf' })).body.error.code).toBe('EXTENSION_CHANGE');
    expect((await alice.client.patch(`/api/files/${file.body.fileId}`, { folderId: folder.body.id })).status).toBe(200);
    expect((await list(alice.client, space, folder.body.id)).files.map((f: any) => f.name)).toEqual(['final.txt']);
  });

  it('détecte les modifications concurrentes (verrou optimiste)', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'concurrent.txt', content: bytes('x') });
    const { body } = await alice.client.get(`/api/files/${file.body.fileId}`);
    const v = body.file.rowVersion;
    expect((await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'premier.txt', expectedRowVersion: v })).status).toBe(200);
    const stale = await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'second.txt', expectedRowVersion: v });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');
    expect((await alice.client.get(`/api/files/${file.body.fileId}`)).body.file.name).toBe('premier.txt');
  });

  it('refuse de déplacer un dossier dans lui-même ou vers un autre espace', async () => {
    const a = await alice.client.post('/api/folders', { spaceId: space, name: 'A' });
    const b = await alice.client.post('/api/folders', { spaceId: space, parentId: a.body.id, name: 'B' });
    expect((await alice.client.patch(`/api/folders/${a.body.id}`, { parentId: b.body.id })).status).toBe(400);
    const other = await createUser(ctx, { email: 'autre-espace@stf.test' });
    const foreign = await other.client.post('/api/folders', { spaceId: other.personalSpaceId, name: 'Chez moi' });
    expect((await alice.client.patch(`/api/folders/${a.body.id}`, { parentId: foreign.body.id })).status).toBe(404);
  });
});

describe('versionnement', () => {
  it('ajoute des versions, télécharge une ancienne version et la rétablit', async () => {
    const v1 = pdf('version 1');
    const v2 = pdf('version 2 plus longue');
    const file = await upload(alice.client, { spaceId: space, name: 'contrat.pdf', content: v1 });
    const added = await upload(alice.client, { spaceId: space, name: 'nouveau-nom.pdf', content: v2, fileId: file.body.fileId });
    expect(added.status).toBe(201);
    expect(added.body.version).toBe(2);
    expect(added.body.name).toBe('contrat.pdf');

    const detail = (await alice.client.get(`/api/files/${file.body.fileId}`)).body;
    expect(detail.versions.map((v: any) => v.number)).toEqual([2, 1]);
    expect(detail.file.size).toBe(v2.length);
    expect(Buffer.from((await download(alice.client, file.body.fileId)).data!).equals(Buffer.from(v2))).toBe(true);

    const old = detail.versions.find((v: any) => v.number === 1);
    const oldDownload = await download(alice.client, file.body.fileId, `?versionId=${old.id}`);
    expect(Buffer.from(oldDownload.data!).equals(Buffer.from(v1))).toBe(true);

    expect((await alice.client.post(`/api/files/${file.body.fileId}/versions/${old.id}/restore`)).status).toBe(200);
    expect(Buffer.from((await download(alice.client, file.body.fileId)).data!).equals(Buffer.from(v1))).toBe(true);
    // Aucune version n'est détruite par le rétablissement.
    expect(await ctx.db.fileVersion.count({ where: { fileId: file.body.fileId } })).toBe(2);
  });

  it('refuse une nouvelle version d’un autre type', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'plan.pdf', content: pdf() });
    const res = await upload(alice.client, { spaceId: space, name: 'plan.txt', content: bytes('x'), fileId: file.body.fileId });
    expect(res.status).toBe(400);
  });

  it('numérote correctement deux versions importées en même temps', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'simultane.txt', content: bytes('v1') });
    const results = await Promise.all([
      upload(alice.client, { spaceId: space, name: 'simultane.txt', content: bytes('v2-a'), fileId: file.body.fileId }),
      upload(alice.client, { spaceId: space, name: 'simultane.txt', content: bytes('v2-b'), fileId: file.body.fileId }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([2, 3]);
  });

  it('conserve l’historique des opérations du fichier', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'historique.txt', content: bytes('x') });
    await alice.client.patch(`/api/files/${file.body.fileId}`, { name: 'historique-v2.txt' });
    const { body } = await alice.client.get(`/api/files/${file.body.fileId}/history`);
    expect(body.events.map((e: any) => e.action)).toEqual(['file.rename', 'file.upload']);
    expect(body.events[0].actorLabel).not.toContain('@');
  });
});

describe('favoris, récents, recherche', () => {
  it('gère les favoris et les fichiers récents', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'favori.pdf', content: pdf() });
    expect((await alice.client.put(`/api/files/${file.body.fileId}/favorite`)).status).toBe(200);
    expect((await alice.client.get('/api/favorites')).body.files.map((f: any) => f.id)).toContain(file.body.fileId);
    await download(alice.client, file.body.fileId);
    expect((await alice.client.get('/api/recents')).body.files[0].id).toBe(file.body.fileId);
    await alice.client.del(`/api/files/${file.body.fileId}/favorite`);
    expect((await alice.client.get('/api/favorites')).body.files.map((f: any) => f.id)).not.toContain(file.body.fileId);
  });

  it('recherche par nom (insensible à la casse) et filtre par type', async () => {
    await upload(alice.client, { spaceId: space, name: 'Budget-Prévisionnel.pdf', content: pdf() });
    await upload(alice.client, { spaceId: space, name: 'budget-notes.txt', content: bytes('n') });
    const all = (await alice.client.get('/api/search?q=BUDGET')).body.files.map((f: any) => f.name).sort();
    expect(all).toEqual(['Budget-Prévisionnel.pdf', 'budget-notes.txt']);
    const pdfs = (await alice.client.get('/api/search?q=budget&category=pdf')).body.files.map((f: any) => f.name);
    expect(pdfs).toEqual(['Budget-Prévisionnel.pdf']);
    const docs = (await alice.client.get('/api/search?q=budget&category=document')).body.files.map((f: any) => f.name);
    expect(docs).toEqual(['budget-notes.txt']);
    // Les caractères spéciaux SQL sont traités comme du texte.
    expect((await alice.client.get(`/api/search?q=${encodeURIComponent("%' OR 1=1 --")}`)).body.files).toEqual([]);
  });
});

describe('corbeille', () => {
  it('supprime vers la corbeille, restaure, puis supprime définitivement (objet effacé du stockage)', async () => {
    const file = await upload(alice.client, { spaceId: space, name: 'a-jeter.txt', content: bytes('poubelle') });
    const id = file.body.fileId;
    const version = await ctx.db.fileVersion.findFirstOrThrow({ where: { fileId: id } });

    expect((await alice.client.del(`/api/files/${id}/permanent`)).status).toBe(400); // pas sans passer par la corbeille
    expect((await alice.client.del(`/api/files/${id}`)).status).toBe(200);
    expect((await alice.client.get(`/api/files/${id}`)).status).toBe(404);
    expect((await alice.client.get(`/api/files/${id}/download`)).status).toBe(404);
    expect((await alice.client.get('/api/trash')).body.files.map((f: any) => f.id)).toContain(id);
    expect(await ctx.storage.head(version.storageKey)).not.toBeNull(); // rien n'est détruit à ce stade

    expect((await alice.client.post(`/api/files/${id}/restore`)).status).toBe(200);
    expect((await alice.client.get(`/api/files/${id}`)).status).toBe(200);

    await alice.client.del(`/api/files/${id}`);
    expect((await alice.client.del(`/api/files/${id}/permanent`)).status).toBe(200);
    expect(await ctx.db.file.count({ where: { id } })).toBe(0);
    expect(await ctx.storage.head(version.storageKey)).toBeNull();
    const log = await ctx.db.activityLog.findFirst({ where: { action: 'file.purge', targetId: id } });
    expect(log).not.toBeNull();
  });

  it('supprimer un dossier emporte son contenu ; le restaurer le rétablit entièrement', async () => {
    const folder = await alice.client.post('/api/folders', { spaceId: space, name: 'Lot' });
    const sub = await alice.client.post('/api/folders', { spaceId: space, parentId: folder.body.id, name: 'Sous-lot' });
    const f1 = await upload(alice.client, { spaceId: space, folderId: folder.body.id, name: 'un.txt', content: bytes('1') });
    const f2 = await upload(alice.client, { spaceId: space, folderId: sub.body.id, name: 'deux.txt', content: bytes('2') });
    expect((await alice.client.del(`/api/folders/${folder.body.id}`)).status).toBe(200);
    expect((await alice.client.get(`/api/files/${f2.body.fileId}`)).status).toBe(404);
    const trash = (await alice.client.get('/api/trash')).body;
    expect(trash.folders.map((f: any) => f.id)).toEqual([folder.body.id]); // seule la racine du lot est listée
    expect(trash.files.map((f: any) => f.id)).not.toContain(f1.body.fileId);
    expect((await alice.client.post(`/api/folders/${folder.body.id}/restore`)).status).toBe(200);
    expect((await alice.client.get(`/api/files/${f1.body.fileId}`)).status).toBe(200);
    expect((await list(alice.client, space, sub.body.id)).files.map((f: any) => f.name)).toEqual(['deux.txt']);
  });

  it('la maintenance purge la corbeille après le délai de conservation, et pas avant', async () => {
    const old = await upload(alice.client, { spaceId: space, name: 'ancien.txt', content: bytes('vieux') });
    const recent = await upload(alice.client, { spaceId: space, name: 'recent.txt', content: bytes('neuf') });
    await alice.client.del(`/api/files/${old.body.fileId}`);
    await alice.client.del(`/api/files/${recent.body.fileId}`);
    const key = (await ctx.db.fileVersion.findFirstOrThrow({ where: { fileId: old.body.fileId } })).storageKey;
    await ctx.db.file.update({ where: { id: old.body.fileId }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const summary = await runMaintenance(ctx);
    expect(summary.purgedFiles).toBe(1);
    expect(await ctx.db.file.count({ where: { id: old.body.fileId } })).toBe(0);
    expect(await ctx.storage.head(key)).toBeNull();
    expect(await ctx.db.file.count({ where: { id: recent.body.fileId } })).toBe(1);
    expect(await ctx.db.activityLog.count({ where: { action: 'system.trash_purge', targetId: old.body.fileId } })).toBe(1);
  });
});
