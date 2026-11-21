// Lancement local entièrement automatique : `npm run local` (ou double-clic sur lancer.bat).
//
// Sans aucune intervention, ce script :
//   1. démarre PostgreSQL embarqué et le stockage local (s'ils ne tournent pas déjà) ;
//   2. applique les migrations ;
//   3. crée un administrateur de test au premier lancement (identifiants affichés et
//      enregistrés dans apps/api/.local/identifiants-admin.txt) ;
//   4. compile l'interface si nécessaire ;
//   5. démarre l'application sur http://localhost:8787 et ouvre le navigateur.
//
// Réservé à l'essai local : en production, suivez docs/DEPLOIEMENT.md.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { startLocalS3 } from './local-s3.ts';

const PORT = Number(process.env.PORT || 8787);
const URL = `http://localhost:${PORT}`;
const localDir = resolve('.local');
mkdirSync(localDir, { recursive: true });

// Valeurs locales par défaut : un fichier .env n'est pas nécessaire pour l'essai.
const defaults: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(PORT),
  DATABASE_URL: 'postgresql://stf:stf@localhost:5432/stf',
  APP_ORIGIN: `${URL},http://localhost:5173`,
  COOKIE_SECURE: 'false',
  PASSWORD_ITERATIONS: '100000',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'stf-files',
  S3_ACCESS_KEY_ID: 'local-dev',
  S3_SECRET_ACCESS_KEY: 'local-dev-secret',
  MAINTENANCE_TOKEN: randomBytes(32).toString('hex'),
};
for (const [key, value] of Object.entries(defaults)) if (!process.env[key]) process.env[key] = value;
// L'application doit accepter sa propre adresse, même si .env ne la mentionne pas.
if (!process.env.APP_ORIGIN!.split(',').includes(URL)) process.env.APP_ORIGIN += `,${URL}`;

const step = (text: string) => console.log(`\n▸ ${text}`);
const portOpen = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => { socket.destroy(); done(false); });
  });

if (await portOpen(PORT)) {
  console.log(`\n✓ SPTF tourne déjà sur ${URL}`);
  openBrowser();
  process.exit(0);
}

// ── 1. Services ──────────────────────────────────────────────────────────────
let pg: EmbeddedPostgres | null = null;
let s3: Awaited<ReturnType<typeof startLocalS3>> | null = null;

step('Base de données PostgreSQL');
if (await portOpen(5432)) {
  console.log('  déjà démarrée (port 5432)');
} else {
  const dataDir = join(localDir, 'pg');
  const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
  if (fresh) console.log('  première initialisation (quelques secondes)…');
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'stf', password: 'stf', port: 5432, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('stf');
  console.log('  démarrée');
}

step('Stockage local des fichiers');
if (await portOpen(9000)) console.log('  déjà démarré (port 9000)');
else {
  s3 = await startLocalS3({ dir: join(localDir, 's3'), port: 9000, bucket: process.env.S3_BUCKET! });
  console.log('  démarré');
}

let api: ReturnType<typeof spawn> | null = null;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nArrêt de SPT…');
  api?.kill();
  await s3?.close().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  // ── 2. Migrations ──────────────────────────────────────────────────────────
  step('Schéma de la base');
  execFileSync(process.execPath, [resolve('../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, DIRECT_URL: '' },
    stdio: 'pipe',
  });
  console.log('  à jour');

  // ── 3. Administrateur de test ──────────────────────────────────────────────
  step('Compte administrateur');
  const { openDb } = await import('./_shared.ts');
  const { clientStretchPassword, hashAuthKey } = await import('../src/lib/crypto.ts');
  const { ensureCompanySpace, ensurePersonalSpace } = await import('../src/lib/bootstrap.ts');
  const credentialsFile = join(localDir, 'identifiants-admin.txt');
  const { db, close } = openDb(process.env.DATABASE_URL);
  try {
    await ensureCompanySpace(db);
    if ((await db.user.count({ where: { role: 'ADMIN' } })) === 0) {
      const email = 'admin@spt.local';
      const password = `Stf-${randomBytes(9).toString('base64url')}-1`;
      const user = await db.user.create({
        data: {
          email, firstName: 'Admin', lastName: 'SPTF', role: 'ADMIN', status: 'ACTIVE', reviewedAt: new Date(),
          passwordHash: await hashAuthKey(await clientStretchPassword(email, password), Number(process.env.PASSWORD_ITERATIONS)),
        },
      });
      await ensurePersonalSpace(db, user.id);
      writeFileSync(credentialsFile, `SPTF — compte administrateur local (essai uniquement)\n\nAdresse  : ${URL}\nE-mail   : ${email}\nMot de passe : ${password}\n`);
      console.log(`  créé : ${email}  /  ${password}`);
    } else {
      console.log(existsSync(credentialsFile) ? `  existant (identifiants : ${credentialsFile})` : '  existant');
    }
  } finally {
    await close();
  }

  // ── 4. Interface ───────────────────────────────────────────────────────────
  step('Interface web');
  const webDir = resolve('../web');
  const built = join(webDir, 'dist', 'index.html');
  if (!existsSync(built) || newestMtime(join(webDir, 'src')) > statSync(built).mtimeMs) {
    console.log('  compilation (environ une minute)…');
    execFileSync(process.execPath, [resolve('../../node_modules/vite/bin/vite.js'), 'build'], { cwd: webDir, stdio: 'pipe' });
    console.log('  compilée');
  } else console.log('  à jour');

  // ── 5. Application ─────────────────────────────────────────────────────────
  step('Démarrage de l’application');
  api = spawn(process.execPath, ['--import', 'tsx', 'src/node.ts'], { env: { ...process.env, WEB_DIST: join(webDir, 'dist') }, stdio: ['ignore', 'inherit', 'inherit'] });
  api.on('exit', (code) => { if (!stopping) { console.error(`\n✗ L’application s’est arrêtée (code ${code}).`); void stop(1); } });

  for (let i = 0; i < 60 && !(await portOpen(PORT)); i++) await new Promise((r) => setTimeout(r, 500));
  const health = await fetch(`${URL}/health?deep=1`).then((r) => r.json() as Promise<{ status: string }>).catch(() => null);
  if (health?.status !== 'ok') throw new Error('L’application ne répond pas correctement sur /health.');

  console.log(`\n══════════════════════════════════════════════════════════\n  ✓ SPTF est prêt : ${URL}`);
  if (existsSync(credentialsFile)) console.log(`  Identifiants administrateur : ${credentialsFile}`);
  console.log('  Arrêt : Ctrl+C dans cette fenêtre\n══════════════════════════════════════════════════════════\n');
  if (!process.argv.includes('--no-open')) openBrowser();
} catch (err) {
  const e = err as { message: string; stderr?: Buffer };
  console.error(`\n✗ Échec du lancement : ${e.message}\n${e.stderr?.toString() ?? ''}`);
  await stop(1);
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function openBrowser() {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]] : process.platform === 'darwin' ? ['open', [URL]] : ['xdg-open', [URL]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* pas de navigateur disponible : l'adresse est affichée */
  }
}
