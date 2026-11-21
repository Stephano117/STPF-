import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto.ts';
import { createTestContext, createUser, download, resetDatabase, upload, type TestContext } from './helpers.ts';

let ctx: TestContext;
let alice: Awaited<ReturnType<typeof createUser>>;
const PART = 64 * 1024;

beforeAll(async () => {
  // Seuils abaissés pour exercer l'envoi en plusieurs parties avec de petits fichiers.
  ctx = createTestContext({ multipartThresholdBytes: 100 * 1024, partSizeBytes: PART });
  await resetDatabase(ctx.db);
  alice = await createUser(ctx, { email: 'alice@stf.test' });
});
afterAll(() => ctx.close());

/** Fichier volumineux (ici 300 Ko = 5 parties) commençant par une signature PDF. */
function bigFile(size = 300 * 1024): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(randomBytes(size));
  data.set(new TextEncoder().encode('%PDF-1.7\n'));
  return data;
}

async function putParts(initBody: any, content: Uint8Array<ArrayBuffer>, numbers: number[]) {
  const { body } = await alice.client.post(`/api/uploads/${initBody.id}/parts`, { partNumbers: numbers });
  for (const { partNumber, url } of body.urls) {
    const res = await fetch(url, { method: 'PUT', body: content.slice((partNumber - 1) * PART, partNumber * PART) });
    expect(res.ok).toBe(true);
  }
}

describe('gros fichiers : envoi en plusieurs parties', () => {
  it('assemble les parties et restitue le fichier à l’identique', async () => {
    const content = bigFile();
    const res = await upload(alice.client, { spaceId: alice.personalSpaceId, name: 'video-formation.pdf', content });
    expect(res.status).toBe(201);
    const got = await download(alice.client, res.body.fileId);
    expect(got.data!.length).toBe(content.length);
    expect(await sha256Hex(new Uint8Array(got.data!))).toBe(await sha256Hex(content));
  });

  it('reprend un transfert interrompu sans renvoyer les parties déjà reçues', async () => {
    const content = bigFile();
    const init = (await alice.client.post('/api/uploads', { spaceId: alice.personalSpaceId, name: 'interrompu.pdf', size: content.length })).body;
    expect(init.mode).toBe('multipart');
    expect(init.partCount).toBe(5);

    // La connexion tombe après les parties 1 et 2.
    await putParts(init, content, [1, 2]);
    const early = await alice.client.post(`/api/uploads/${init.id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(await ctx.db.file.count({ where: { name: 'interrompu.pdf' } })).toBe(0);

    // Reprise : le serveur indique ce qui est déjà arrivé.
    const state = (await alice.client.get(`/api/uploads/${init.id}`)).body;
    expect(state.uploadedParts.map((p: any) => p.partNumber)).toEqual([1, 2]);
    const missing = [1, 2, 3, 4, 5].filter((n) => !state.uploadedParts.some((p: any) => p.partNumber === n));
    await putParts(init, content, missing);

    const done = await alice.client.post(`/api/uploads/${init.id}/complete`, { sha256: await sha256Hex(content) });
    expect(done.status).toBe(201);
    const got = await download(alice.client, done.body.fileId);
    expect(await sha256Hex(new Uint8Array(got.data!))).toBe(await sha256Hex(content));
  });

  it('détecte une partie manquante au milieu du fichier', async () => {
    const content = bigFile();
    const init = (await alice.client.post('/api/uploads', { spaceId: alice.personalSpaceId, name: 'troue.pdf', size: content.length })).body;
    await putParts(init, content, [1, 2, 4, 5]);
    const res = await alice.client.post(`/api/uploads/${init.id}/complete`);
    expect(res.status).toBe(409);
    expect(await ctx.db.file.count({ where: { name: 'troue.pdf' } })).toBe(0);
  });

  it('l’annulation efface les parties déjà envoyées et libère le quota', async () => {
    const content = bigFile();
    const init = (await alice.client.post('/api/uploads', { spaceId: alice.personalSpaceId, name: 'annule.pdf', size: content.length })).body;
    await putParts(init, content, [1]);
    const before = (await alice.client.get('/api/auth/usage')).body.personal.used;
    expect((await alice.client.del(`/api/uploads/${init.id}`)).status).toBe(200);
    expect((await alice.client.get('/api/auth/usage')).body.personal.used).toBe(before - content.length);
    expect((await alice.client.post(`/api/uploads/${init.id}/complete`)).status).toBe(409);
    const row = await ctx.db.upload.findUniqueOrThrow({ where: { id: init.id } });
    await expect(ctx.storage.listParts(row.storageKey, row.multipartId!)).rejects.toThrow();
  });

  it('refuse les numéros de partie hors limites', async () => {
    const content = bigFile();
    const init = (await alice.client.post('/api/uploads', { spaceId: alice.personalSpaceId, name: 'bornes.pdf', size: content.length })).body;
    expect((await alice.client.post(`/api/uploads/${init.id}/parts`, { partNumbers: [6] })).status).toBe(400);
    expect((await alice.client.post(`/api/uploads/${init.id}/parts`, { partNumbers: [0] })).status).toBe(400);
  });

  it('plusieurs utilisateurs importent en même temps sans interférence', async () => {
    const users = await Promise.all([1, 2, 3, 4].map((i) => createUser(ctx, { email: `simultane${i}@stf.test` })));
    const contents = users.map(() => bigFile(150 * 1024));
    const results = await Promise.all(users.map((u, i) => upload(u.client, { spaceId: u.personalSpaceId, name: 'meme-nom.pdf', content: contents[i]! })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    for (let i = 0; i < users.length; i++) {
      const got = await download(users[i]!.client, results[i]!.body.fileId);
      expect(await sha256Hex(new Uint8Array(got.data!))).toBe(await sha256Hex(contents[i]!));
    }
  });
});
