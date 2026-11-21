// Contrôle d'une instance déployée : ne déclare rien « en production » sans l'avoir mesuré.
//
//   npm run verify:prod -- https://stf.exemple.workers.dev
//
// Sans identifiants : santé de l'API, base, stockage, en-têtes de sécurité.
// Avec VERIFY_EMAIL / VERIFY_PASSWORD (un compte actif) : cycle complet réel —
// connexions répétées (détecte un dépassement de la limite CPU de l'hébergeur),
// import par URL signée, téléchargement, comparaison du contenu, suppression.
// Le fichier de test est créé dans l'espace personnel du compte puis effacé.

import { clientStretchPassword, sha256Hex } from '../src/lib/crypto.ts';

const base = (process.argv[2] || process.env.VERIFY_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage : npm run verify:prod -- https://adresse-de-l-application');
  process.exit(2);
}

let failures = 0;
let cookie = '';
const ok = (label: string, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const ko = (label: string, detail = '') => {
  failures++;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

async function call(method: string, path: string, body?: unknown) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-stf-request': '1', origin: base } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.startsWith('stf_session=')) cookie = setCookie.split(';')[0]!;
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* page d'erreur de l'hébergeur */
  }
  return { status: res.status, json, text, ms: Date.now() - started, headers: res.headers };
}

console.log(`\nContrôle de ${base}\n`);

// ── 1. Santé ─────────────────────────────────────────────────────────────────
const health = await call('GET', '/health?deep=1').catch((e) => ({ status: 0, json: null, text: String(e), ms: 0, headers: new Headers() }));
if (health.status === 200 && health.json?.status === 'ok') {
  ok('API joignable', `${health.ms} ms`);
  ok('Base de données', `${health.json.checks.database.ms} ms`);
  ok('Stockage des fichiers', `${health.json.checks.storage.ms} ms`);
} else {
  ko('Santé', `HTTP ${health.status} ${health.text.slice(0, 200)}`);
}
for (const header of ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options']) {
  if (health.headers.get(header)) ok(`En-tête ${header}`);
  else ko(`En-tête ${header} absent`);
}
const page = await call('GET', '/');
if (page.status === 200 && page.text.includes('<div id="root">')) ok('Interface web servie');
else ko('Interface web', `HTTP ${page.status}`);
const anonymous = await call('GET', '/api/spaces');
if (anonymous.status === 401) ok('API fermée aux anonymes');
else ko('API fermée aux anonymes', `HTTP ${anonymous.status} au lieu de 401`);

// ── 2. Cycle complet (facultatif) ────────────────────────────────────────────
const email = process.env.VERIFY_EMAIL;
const password = process.env.VERIFY_PASSWORD;
if (!email || !password) {
  console.log('\n  (Cycle complet non exécuté : définissez VERIFY_EMAIL et VERIFY_PASSWORD pour tester connexion, import et téléchargement.)');
} else {
  const authKey = await clientStretchPassword(email, password);
  // Cinq connexions : un hébergeur qui coupe sur dépassement CPU (erreur 1102 sur Workers) est détecté ici.
  const timings: number[] = [];
  let loginOk = true;
  for (let i = 0; i < 5; i++) {
    const res = await call('POST', '/api/auth/login', { email, authKey });
    timings.push(res.ms);
    if (res.status !== 200) {
      loginOk = false;
      ko(`Connexion n° ${i + 1}`, `HTTP ${res.status} ${res.text.slice(0, 160)}`);
      if (/1102|exceeded/i.test(res.text)) console.error('     → Limite CPU de l’hébergeur dépassée : réduisez PASSWORD_ITERATIONS ou changez d’offre (voir docs/DEPLOIEMENT.md).');
      break;
    }
  }
  if (loginOk) {
    ok('5 connexions consécutives', `${timings.join(', ')} ms`);
    const me = await call('GET', '/api/auth/me');
    const spaceId = me.json?.personalSpaceId;
    const content = new TextEncoder().encode(`SPTF verify-prod ${new Date().toISOString()} ${'x'.repeat(2000)}`);
    const init = await call('POST', '/api/uploads', { spaceId, name: `verification-${Date.now()}.txt`, size: content.length, mimeType: 'text/plain' });
    if (init.status !== 201) ko('Demande d’import', `HTTP ${init.status} ${init.text.slice(0, 160)}`);
    else {
      const put = await fetch(init.json.url, { method: 'PUT', body: content });
      if (!put.ok) ko('Envoi au stockage par URL signée', `HTTP ${put.status} ${(await put.text()).slice(0, 160)}`);
      else {
        ok('Envoi au stockage par URL signée');
        const done = await call('POST', `/api/uploads/${init.json.id}/complete`, { sha256: await sha256Hex(content) });
        if (done.status !== 201) ko('Finalisation de l’import', `HTTP ${done.status} ${done.text.slice(0, 160)}`);
        else {
          ok('Finalisation de l’import', `${done.ms} ms`);
          const link = await call('GET', `/api/files/${done.json.fileId}/download`);
          const got = link.status === 200 ? new Uint8Array(await (await fetch(link.json.url)).arrayBuffer()) : new Uint8Array();
          if ((await sha256Hex(got)) === (await sha256Hex(content))) ok('Téléchargement : contenu identique à l’envoi');
          else ko('Téléchargement', 'contenu différent ou inaccessible');
          const del = await call('DELETE', `/api/files/${done.json.fileId}`, {});
          const purge = await call('DELETE', `/api/files/${done.json.fileId}/permanent`, {});
          if (del.status === 200 && purge.status === 200) ok('Suppression du fichier de test');
          else ko('Suppression du fichier de test', `HTTP ${del.status}/${purge.status}`);
        }
      }
    }
    await call('POST', '/api/auth/logout', {});
  }
}

console.log(failures === 0 ? '\n✓ Tous les contrôles exécutés ont réussi.\n' : `\n✗ ${failures} contrôle(s) en échec.\n`);
process.exit(failures === 0 ? 0 : 1);
