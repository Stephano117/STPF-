import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFile } from '../src/lib/mime.ts';
import { clientStretchPassword, hashAuthKey, verifyAuthKey } from '../src/lib/crypto.ts';
import { nameProblem } from '../src/lib/access.ts';
import { loadConfig } from '../src/config.ts';
import { bytes, Client, commonFolderId, createTestContext, createUser, ORIGIN, pdf, resetDatabase, testEnv, upload, type TestContext } from './helpers.ts';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof createUser>>;
let user: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  ctx = createTestContext({ storageQuotaBytes: 1000 });
  await resetDatabase(ctx.db);
  admin = await createUser(ctx, { email: 'admin@stf.test', role: 'ADMIN' });
  user = await createUser(ctx, { email: 'user@stf.test' });
});
afterAll(() => ctx.close());

describe('administration', () => {
  it('toutes les routes d’administration refusent un non-administrateur', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/spaces'], ['GET', '/api/admin/files'], ['GET', '/api/admin/quotas'],
      ['GET', '/api/admin/logs'], ['GET', '/api/admin/status'], ['POST', '/api/admin/maintenance'],
    ];
    for (const [method, path] of routes) {
      expect((await user.client.request(method, path, method === 'GET' ? undefined : {})).status, `${method} ${path}`).toBe(403);
      expect((await new Client(ctx).request(method, path, method === 'GET' ? undefined : {})).status, `${method} ${path} anonyme`).toBe(401);
    }
  });

  it('la notion de service n’existe plus : aucune route, aucun champ', async () => {
    expect((await admin.client.get('/api/admin/departments')).status).toBe(404);
    expect((await admin.client.get('/api/departments')).status).toBe(404);
    const me = (await user.client.get('/api/auth/me')).body.user;
    expect(me.department).toBeUndefined();
    expect(me.jobTitle).toBeUndefined();
  });

  it('applique la capacité globale du stockage et signale la saturation', async () => {
    const common = await commonFolderId(ctx);
    // Capacité de test : 1000 octets.
    expect((await upload(user.client, { spaceId: 'company', folderId: common, name: 'gros.txt', content: bytes('x'.repeat(800)) })).status).toBe(201);
    const full = await upload(user.client, { spaceId: 'company', folderId: common, name: 'trop.txt', content: bytes('x'.repeat(300)) });
    expect(full.status).toBe(413);
    expect(full.body.error.code).toBe('STORAGE_FULL');
    const quotas = (await admin.client.get('/api/admin/quotas')).body;
    expect(quotas.global.usedBytes).toBe(800);
    expect(quotas.global.level).toBe('warning');
    const status = (await admin.client.get('/api/admin/status')).body;
    expect(status.database.ok).toBe(true);
    expect(status.storage.ok).toBe(true);
    expect(status.alerts.some((a: any) => /Stockage/.test(a.message))).toBe(true);
    expect(status.counts.activeUsers).toBe(2);
  });

  it('ajuste le quota personnel d’un utilisateur', async () => {
    expect((await admin.client.patch(`/api/admin/users/${user.user.id}`, { quotaBytes: 10 })).status).toBe(200);
    const res = await upload(user.client, { spaceId: user.personalSpaceId, name: 'perso.txt', content: bytes('x'.repeat(50)) });
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('expose le journal d’activité avec filtres et pagination', async () => {
    const all = (await admin.client.get('/api/admin/logs?limit=2')).body;
    expect(all.logs).toHaveLength(2);
    expect(all.nextCursor).toBeTruthy();
    const next = (await admin.client.get(`/api/admin/logs?limit=2&cursor=${all.nextCursor}`)).body;
    expect(next.logs[0].id).not.toBe(all.logs[0].id);
    const filtered = (await admin.client.get('/api/admin/logs?action=auth.login')).body.logs;
    expect(filtered.length).toBeGreaterThanOrEqual(2);
    expect(filtered.every((l: any) => l.action.startsWith('auth.login'))).toBe(true);
  });

  it('enregistre les erreurs remontées par le navigateur', async () => {
    expect((await user.client.post('/api/client-errors', { message: 'TypeError: test', path: '/accueil' })).status).toBe(201);
    const status = (await admin.client.get('/api/admin/status')).body;
    expect(status.recentErrors[0].message).toBe('TypeError: test');
  });
});

describe('santé et maintenance', () => {
  it('/health répond sans authentification, avec contrôle du stockage à la demande', async () => {
    const basic = await new Client(ctx).get('/health');
    expect(basic.status).toBe(200);
    expect(basic.body.status).toBe('ok');
    expect(basic.body.checks.database.ok).toBe(true);
    expect(basic.body.checks.storage).toBeUndefined();
    const deep = await new Client(ctx).get('/api/health?deep=1');
    expect(deep.body.checks.storage.ok).toBe(true);
  });

  it('/health signale un stockage en panne par un code 503', async () => {
    const broken = createTestContext();
    const down = createTestContext({ s3: { ...broken.config.s3, endpoint: 'http://127.0.0.1:9', internalEndpoint: 'http://127.0.0.1:9' } });
    const res = await new Client(down).get('/health?deep=1');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.storage.ok).toBe(false);
    await broken.close();
    await down.close();
  });

  it('la maintenance par cron exige son jeton', async () => {
    const call = (token?: string) =>
      ctx.app.request('/api/maintenance/run', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await call()).status).toBe(403);
    expect((await call('mauvais-jeton')).status).toBe(403);
    const ok = await call('jeton-de-maintenance-de-test-0123456789');
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).summary.storageQuotaBytes).toBe(1000);
  });

  it('une erreur interne ne divulgue aucun détail technique et est journalisée', async () => {
    const failing = createTestContext({ s3: { ...ctx.config.s3, endpoint: 'http://127.0.0.1:9', internalEndpoint: 'http://127.0.0.1:9' } });
    const client = new Client(failing);
    await client.login('admin@stf.test');
    const res = await client.get('/api/admin/status');
    expect(res.status).toBe(200); // l'état est rendu même si le stockage est en panne
    expect(res.body.storage.ok).toBe(false);
    const big = await client.post('/api/uploads', { spaceId: admin.personalSpaceId, name: 'x.pdf', size: 20 * 1024 * 1024 });
    expect(big.status).toBe(502);
    expect(big.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(JSON.stringify(big.body)).not.toMatch(/127\.0\.0\.1|stack|ECONN/);
    expect(await ctx.db.errorLog.count({ where: { source: 'storage' } })).toBeGreaterThanOrEqual(1);
    await failing.close();
  }, 120_000);

  it('les réponses portent les en-têtes de sécurité', async () => {
    const res = await ctx.app.request('/health');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Route inconnue : 401 pour un anonyme (rien n'est révélé), 404 une fois connecté.
    expect((await ctx.app.request('/api/inexistant', { headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await user.client.get('/api/inexistant')).status).toBe(404);
  });
});

describe('fonctions de sécurité (unitaires)', () => {
  it('le hachage du mot de passe est salé, vérifiable et sensible à la moindre différence', async () => {
    const key = await clientStretchPassword('A@Stf.Test ', 'secret-123456');
    expect(key).toBe(await clientStretchPassword('a@stf.test', 'secret-123456')); // e-mail normalisé
    const h1 = await hashAuthKey(key, 1000);
    const h2 = await hashAuthKey(key, 1000);
    expect(h1).not.toBe(h2);
    expect(await verifyAuthKey(key, h1)).toBe(true);
    expect(await verifyAuthKey(await clientStretchPassword('a@stf.test', 'secret-123457'), h1)).toBe(false);
    expect(await verifyAuthKey(key, 'format-invalide')).toBe(false);
  });

  it('le contrôle de contenu reconnaît les signatures et bloque les exécutables', () => {
    expect(inspectFile('a.pdf', pdf())).toEqual({ ok: true, mime: 'application/pdf' });
    expect(inspectFile('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ ok: true, mime: 'image/png' });
    expect(inspectFile('a.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toMatchObject({ ok: true });
    expect(inspectFile('a.docx', bytes('pas un zip')).ok).toBe(false);
    expect(inspectFile('a.txt', new Uint8Array([0x4d, 0x5a, 0x90])).ok).toBe(false);
    expect(inspectFile('script.txt', bytes('#!/bin/sh\nrm -rf /')).ok).toBe(false);
    expect(inspectFile('a.EXE', bytes('x')).ok).toBe(false);
    expect(inspectFile('inconnu.xyz', bytes('données'))).toEqual({ ok: true, mime: 'application/octet-stream' });
  });

  it('valide les noms de fichiers', () => {
    expect(nameProblem('Rapport 2026 (final).pdf')).toBeNull();
    for (const bad of ['', ' espace', 'a/b', 'a\\b', '..', 'a:b', 'a\u0000b', 'x'.repeat(201)]) expect(nameProblem(bad)).not.toBeNull();
  });

  it('refuse de démarrer sans configuration complète', () => {
    const env = testEnv();
    expect(() => loadConfig({ ...env, S3_SECRET_ACCESS_KEY: '' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig({ ...env, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...env, MAX_FILE_SIZE_BYTES: 'abc' })).toThrow(/MAX_FILE_SIZE_BYTES/);
  });
});
