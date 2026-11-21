import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authKeyFor, Client, createTestContext, createUser, ORIGIN, resetDatabase, type TestContext } from './helpers.ts';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  ctx = createTestContext();
  await resetDatabase(ctx.db);
  admin = await createUser(ctx, { email: 'admin@stf.test', role: 'ADMIN' });
});
afterAll(() => ctx.close());

async function register(client: Client, email: string) {
  return client.post('/api/auth/register', {
    firstName: 'Awa',
    lastName: 'Diop',
    email,
    authKey: await authKeyFor(email),
  });
}

describe('inscription et validation des comptes', () => {
  it('crée un compte en attente, inutilisable avant validation', async () => {
    const client = new Client(ctx);
    const res = await register(client, 'awa@stf.test');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: 'awa@stf.test' } });
    expect(user.status).toBe('PENDING');
    expect(user.role).toBe('USER');
    expect(user.passwordHash).not.toContain(await authKeyFor('awa@stf.test'));

    const login = await client.login('awa@stf.test');
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_PENDING');
    expect(client.cookie).toBe('');
  });

  it('ne révèle pas qu’une adresse est déjà inscrite et ne crée pas de doublon', async () => {
    const res = await register(new Client(ctx), 'awa@stf.test');
    expect(res.status).toBe(201);
    expect(await ctx.db.user.count({ where: { email: 'awa@stf.test' } })).toBe(1);
  });

  it('refuse une inscription invalide', async () => {
    const client = new Client(ctx);
    const bad = await client.post('/api/auth/register', { firstName: '', lastName: 'X', email: 'pas-un-email', authKey: 'abc' });
    expect(bad.status).toBe(400);
  });

  it('ne permet pas de s’attribuer un rôle ou un statut à l’inscription', async () => {
    const client = new Client(ctx);
    await client.post('/api/auth/register', {
      firstName: 'M', lastName: 'Malin', email: 'malin@stf.test',
      authKey: await authKeyFor('malin@stf.test'), role: 'ADMIN', status: 'ACTIVE',
    });
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: 'malin@stf.test' } });
    expect(user.role).toBe('USER');
    expect(user.status).toBe('PENDING');
  });

  it('seul un administrateur peut valider ; le compte validé peut se connecter', async () => {
    const awa = await ctx.db.user.findUniqueOrThrow({ where: { email: 'awa@stf.test' } });
    const other = await createUser(ctx, { email: 'simple@stf.test' });
    expect((await other.client.post(`/api/admin/users/${awa.id}/approve`)).status).toBe(403);
    expect((await new Client(ctx).post(`/api/admin/users/${awa.id}/approve`)).status).toBe(401);

    expect((await admin.client.post(`/api/admin/users/${awa.id}/approve`)).status).toBe(200);
    const client = new Client(ctx);
    expect((await client.login('awa@stf.test')).status).toBe(200);
    const me = await client.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('awa@stf.test');
    expect(me.body.personalSpaceId).toBeTruthy();
    expect(me.body.user.passwordHash).toBeUndefined();
  });

  it('deux validations simultanées : une seule aboutit', async () => {
    const client = new Client(ctx);
    await register(client, 'double@stf.test');
    const target = await ctx.db.user.findUniqueOrThrow({ where: { email: 'double@stf.test' } });
    const results = await Promise.all([
      admin.client.post(`/api/admin/users/${target.id}/reject`),
      admin.client.post(`/api/admin/users/${target.id}/reject`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await client.login('double@stf.test')).body.error.code).toBe('ACCOUNT_REJECTED');
  });
});

describe('connexion et sessions', () => {
  it('refuse un mauvais mot de passe sans distinguer compte inconnu et mot de passe faux', async () => {
    const wrong = await new Client(ctx).login('admin@stf.test', 'mauvais-mot-de-passe');
    const unknown = await new Client(ctx).login('personne@stf.test');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('pose un cookie de session HttpOnly et ne stocke que son empreinte', async () => {
    const res = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-stf-request': '1', 'content-type': 'application/json', 'x-test-ip': '10.9.9.1' },
      body: JSON.stringify({ email: 'admin@stf.test', authKey: await authKeyFor('admin@stf.test') }),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = /stf_session=([0-9a-f]+)/.exec(cookie)![1]!;
    expect(await ctx.db.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('bloque les requêtes modifiantes sans origine autorisée ni en-tête dédié (CSRF)', async () => {
    const send = (headers: Record<string, string>) =>
      ctx.app.request('/api/auth/logout', { method: 'POST', headers: { cookie: admin.client.cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
    expect((await send({})).status).toBe(403);
    expect((await send({ origin: 'https://attaquant.example', 'x-stf-request': '1' })).status).toBe(403);
    expect((await send({ origin: ORIGIN })).status).toBe(403);
    // La session de l'administrateur n'a pas été détruite par ces tentatives.
    expect((await admin.client.get('/api/auth/me')).status).toBe(200);
  });

  it('limite les tentatives de connexion par compte', async () => {
    await createUser(ctx, { email: 'cible@stf.test' });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await new Client(ctx).login('cible@stf.test', `faux-${i}`)).status);
    // La connexion initiale de createUser compte pour une tentative : 8 autorisées au total.
    expect(statuses.slice(0, 7).every((s) => s === 401)).toBe(true);
    expect(statuses[7]).toBe(429);
    // Même le bon mot de passe est refusé pendant le blocage.
    expect((await new Client(ctx).login('cible@stf.test')).status).toBe(429);
  });

  it('la déconnexion invalide la session côté serveur', async () => {
    const { client } = await createUser(ctx, { email: 'logout@stf.test' });
    const cookie = client.cookie;
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    client.cookie = cookie;
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('une session expirée est refusée', async () => {
    const { client, user } = await createUser(ctx, { email: 'expire@stf.test' });
    await ctx.db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('le changement de mot de passe exige l’ancien et révoque les autres sessions', async () => {
    const { client } = await createUser(ctx, { email: 'mdp@stf.test' });
    const second = new Client(ctx);
    await second.login('mdp@stf.test');
    const newKey = await authKeyFor('mdp@stf.test', 'Nouveau-mot-de-passe-2');
    const bad = await client.post('/api/auth/password', { currentAuthKey: await authKeyFor('mdp@stf.test', 'faux'), newAuthKey: newKey });
    expect(bad.status).toBe(400);
    const ok = await client.post('/api/auth/password', { currentAuthKey: await authKeyFor('mdp@stf.test'), newAuthKey: newKey });
    expect(ok.status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await second.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(ctx).login('mdp@stf.test')).status).toBe(401);
    expect((await new Client(ctx).login('mdp@stf.test', 'Nouveau-mot-de-passe-2')).status).toBe(200);
  });
});

describe('suspension et garde-fous administrateur', () => {
  it('la suspension coupe immédiatement l’accès ; la réactivation le rétablit', async () => {
    const { client, user } = await createUser(ctx, { email: 'suspendu@stf.test' });
    expect((await admin.client.post(`/api/admin/users/${user.id}/suspend`)).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(ctx).login('suspendu@stf.test')).body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await admin.client.post(`/api/admin/users/${user.id}/reactivate`)).status).toBe(200);
    expect((await new Client(ctx).login('suspendu@stf.test')).status).toBe(200);
  });

  it('l’administrateur réinitialise un mot de passe oublié : anciennes sessions fermées, opération journalisée', async () => {
    const { client, user } = await createUser(ctx, { email: 'oubli@stf.test' });
    const authKey = await authKeyFor('oubli@stf.test', 'Provisoire-2026-xyz');
    expect((await client.post(`/api/admin/users/${user.id}/password`, { authKey })).status).toBe(403);
    expect((await admin.client.post(`/api/admin/users/${user.id}/password`, { authKey })).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(ctx).login('oubli@stf.test')).status).toBe(401);
    expect((await new Client(ctx).login('oubli@stf.test', 'Provisoire-2026-xyz')).status).toBe(200);
    expect(await ctx.db.activityLog.count({ where: { action: 'admin.user_password_reset', targetId: user.id } })).toBe(1);
  });

  it('un administrateur ne peut ni se suspendre ni se rétrograder', async () => {
    expect((await admin.client.post(`/api/admin/users/${admin.user.id}/suspend`)).status).toBe(403);
    expect((await admin.client.patch(`/api/admin/users/${admin.user.id}`, { role: 'USER' })).status).toBe(403);
  });

  it('le dernier administrateur actif ne peut pas être retiré', async () => {
    const second = await createUser(ctx, { email: 'admin2@stf.test', role: 'ADMIN' });
    // admin2 rétrograde admin : il reste un administrateur (admin2), c'est permis.
    expect((await second.client.patch(`/api/admin/users/${admin.user.id}`, { role: 'USER' })).status).toBe(200);
    // admin (désormais simple utilisateur) ne peut plus rien administrer.
    expect((await admin.client.get('/api/admin/users')).status).toBe(403);
    // On rétablit, puis on vérifie la protection du dernier administrateur via la base.
    expect((await second.client.patch(`/api/admin/users/${admin.user.id}`, { role: 'ADMIN' })).status).toBe(200);
    await ctx.db.user.update({ where: { id: second.user.id }, data: { status: 'SUSPENDED' } });
    const third = await createUser(ctx, { email: 'admin3@stf.test', role: 'ADMIN' });
    await ctx.db.user.update({ where: { id: third.user.id }, data: { role: 'USER' } });
    await ctx.db.user.update({ where: { id: second.user.id }, data: { status: 'ACTIVE' } });
    // Deux administrateurs actifs (admin, admin2) : en retirer un est permis, le dernier non.
    expect((await admin.client.patch(`/api/admin/users/${second.user.id}`, { role: 'USER' })).status).toBe(200);
    await ctx.db.user.update({ where: { id: third.user.id }, data: { role: 'ADMIN', status: 'SUSPENDED' } });
    const lone = await ctx.db.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
    expect(lone).toBe(1);
  });

  it('les opérations sensibles sont journalisées', async () => {
    const actions = (await ctx.db.activityLog.findMany({ select: { action: true } })).map((l) => l.action);
    for (const expected of ['user.register', 'auth.login', 'auth.login_failed', 'admin.user_approve', 'admin.user_reject', 'admin.user_suspend', 'auth.password_change']) {
      expect(actions).toContain(expected);
    }
  });
});
