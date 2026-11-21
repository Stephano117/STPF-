import { inject } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/node/client.ts';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { withResilience, type Db } from '../src/lib/db.ts';
import { S3Storage } from '../src/lib/storage.ts';
import { clientStretchPassword, hashAuthKey, sha256Hex } from '../src/lib/crypto.ts';
import { ensureCompanySpace, ensurePersonalSpace } from '../src/lib/bootstrap.ts';

export const ORIGIN = 'http://stf.test';
export const PASSWORD = 'Mot-de-passe-solide-1';

export function testEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    APP_ORIGIN: ORIGIN,
    COOKIE_SECURE: 'false',
    PASSWORD_ITERATIONS: '1000',
    S3_ENDPOINT: inject('s3Endpoint'),
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'stf-test',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    MAINTENANCE_TOKEN: 'jeton-de-maintenance-de-test-0123456789',
    ...overrides,
  };
}

export interface TestContext {
  db: Db;
  config: Config;
  storage: S3Storage;
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}

export function createTestContext(configOverrides: Partial<Config> = {}): TestContext {
  const config = { ...loadConfig(testEnv()), ...configOverrides };
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }) });
  const db = withResilience(prisma);
  const storage = new S3Storage(config.s3);
  const app = createApp({ config, storage, getDb: () => db, getIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1' });
  return { db, config, storage, app, close: () => prisma.$disconnect() };
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "ActivityLog","ErrorLog","RateLimit","RecentAccess","Favorite","Upload","FileVersion","File","Folder","SpaceInvitation","SpaceMember","Space","Session","User" CASCADE',
  );
  await ensureCompanySpace(db);
}

let ipCounter = 0;
const stretchCache = new Map<string, Promise<string>>();
export function authKeyFor(email: string, password = PASSWORD): Promise<string> {
  const key = `${email}|${password}`;
  if (!stretchCache.has(key)) stretchCache.set(key, clientStretchPassword(email, password));
  return stretchCache.get(key)!;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

/** Client HTTP de test : conserve le cookie de session, comme un navigateur. */
export class Client {
  cookie = '';
  ip = `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  constructor(private ctx: TestContext) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    const res = await this.ctx.app.request(path, {
      method,
      headers: {
        ...(method !== 'GET' ? { origin: ORIGIN, 'x-stf-request': '1', 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        'x-test-ip': this.ip,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* réponse non JSON */
    }
    return { status: res.status, body: parsed as T };
  }
  get = <T = any>(path: string) => this.request<T>('GET', path);
  post = <T = any>(path: string, body: unknown = {}) => this.request<T>('POST', path, body);
  patch = <T = any>(path: string, body: unknown = {}) => this.request<T>('PATCH', path, body);
  put = <T = any>(path: string, body: unknown = {}) => this.request<T>('PUT', path, body);
  del = <T = any>(path: string, body: unknown = {}) => this.request<T>('DELETE', path, body);

  async login(email: string, password = PASSWORD): Promise<ApiResult> {
    return this.post('/api/auth/login', { email, authKey: await authKeyFor(email, password) });
  }
}

/** Crée directement un compte (équivalent du script create-admin) et renvoie un client connecté. */
export async function createUser(
  ctx: TestContext,
  opts: { email: string; role?: 'USER' | 'ADMIN'; status?: 'ACTIVE' | 'PENDING'; firstName?: string },
) {
  const user = await ctx.db.user.create({
    data: {
      email: opts.email,
      firstName: opts.firstName ?? opts.email.split('@')[0]!,
      lastName: 'Test',
      passwordHash: await hashAuthKey(await authKeyFor(opts.email), ctx.config.passwordIterations),
      role: opts.role ?? 'USER',
      status: opts.status ?? 'ACTIVE',
    },
  });
  const personalSpaceId = await ensurePersonalSpace(ctx.db, user.id);
  const client = new Client(ctx);
  if ((opts.status ?? 'ACTIVE') === 'ACTIVE') {
    const res = await client.login(opts.email);
    if (res.status !== 200) throw new Error(`Connexion de test impossible : ${JSON.stringify(res.body)}`);
  }
  return { user, client, personalSpaceId };
}

export function bytes(content: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
}

/** Contenu PDF minimal valide du point de vue de la signature. */
export const pdf = (text = 'contenu') => bytes(`%PDF-1.4\n${text}\n%%EOF`);

export async function upload(
  client: Client,
  opts: { spaceId: string; folderId?: string | null; name: string; content: Uint8Array<ArrayBuffer>; fileId?: string },
): Promise<ApiResult> {
  const init = await client.post('/api/uploads', {
    spaceId: opts.spaceId,
    folderId: opts.folderId ?? null,
    name: opts.name,
    size: opts.content.length,
    mimeType: 'application/octet-stream',
    fileId: opts.fileId,
  });
  if (init.status !== 201) return init;
  if (init.body.mode === 'single') {
    const put = await fetch(init.body.url, { method: 'PUT', body: opts.content });
    if (!put.ok) throw new Error(`PUT stockage : ${put.status}`);
  } else {
    const numbers = Array.from({ length: init.body.partCount }, (_, i) => i + 1);
    const { body } = await client.post(`/api/uploads/${init.body.id}/parts`, { partNumbers: numbers });
    for (const { partNumber, url } of body.urls as { partNumber: number; url: string }[]) {
      const start = (partNumber - 1) * init.body.partSize;
      const put = await fetch(url, { method: 'PUT', body: opts.content.slice(start, start + init.body.partSize) });
      if (!put.ok) throw new Error(`PUT partie ${partNumber} : ${put.status}`);
    }
  }
  return client.post(`/api/uploads/${init.body.id}/complete`, { sha256: await sha256Hex(opts.content) });
}

export async function download(client: Client, fileId: string, query = ''): Promise<{ status: number; data?: Uint8Array; headers?: Headers; body: any }> {
  const res = await client.get(`/api/files/${fileId}/download${query}`);
  if (res.status !== 200) return { status: res.status, body: res.body };
  const got = await fetch(res.body.url);
  return { status: got.status, data: new Uint8Array(await got.arrayBuffer()), headers: got.headers, body: res.body };
}

export async function commonFolderId(ctx: TestContext): Promise<string> {
  const folder = await ctx.db.folder.findFirstOrThrow({ where: { spaceId: 'company', name: 'Documents communs' } });
  return folder.id;
}
