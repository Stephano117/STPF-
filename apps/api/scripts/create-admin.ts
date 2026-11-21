// Création sécurisée du premier administrateur (ou promotion d'un compte existant).
//
//   npm run create-admin
//   npm run create-admin -- --email a@b.fr --first-name Ada --last-name Lovelace
//   npm run create-admin -- --email a@b.fr --reset-password     (mot de passe oublié)
//
// Le mot de passe est demandé au clavier (jamais en argument : il resterait dans
// l'historique du terminal). En contexte non interactif, utilisez ADMIN_PASSWORD.
// Le script s'exécute hors ligne contre DATABASE_URL : aucune route HTTP ne permet
// de créer un administrateur.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { arg, flag, openDb } from './_shared.ts';
import { clientStretchPassword, hashAuthKey } from '../src/lib/crypto.ts';
import { ensureCompanySpace, ensurePersonalSpace } from '../src/lib/bootstrap.ts';

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (hidden) {
    // Masque la saisie.
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      }
    };
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) stdout.write('\n');
  return answer.trim();
}

const email = (arg('email') || process.env.ADMIN_EMAIL || (await ask('E-mail professionnel : '))).toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('✗ Adresse e-mail invalide.');
  process.exit(1);
}

const { db, close } = openDb();
try {
  await ensureCompanySpace(db);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && flag('reset-password')) {
    // Secours : un administrateur a oublié son mot de passe.
    const password = process.env.ADMIN_PASSWORD || (await ask('Nouveau mot de passe (12 caractères minimum) : ', true));
    if (password.length < 12) {
      console.error('✗ Mot de passe trop court (12 caractères minimum).');
      process.exit(1);
    }
    const hash = await hashAuthKey(await clientStretchPassword(email, password), Number(process.env.PASSWORD_ITERATIONS || 100_000));
    await db.user.update({ where: { id: existing.id }, data: { passwordHash: hash } });
    await db.session.deleteMany({ where: { userId: existing.id } });
    await db.activityLog.create({ data: { action: 'system.password_reset', actorLabel: 'Script create-admin', targetType: 'user', targetId: existing.id, targetLabel: email } });
    console.log(`✓ Mot de passe de ${email} réinitialisé. Ses sessions ont été fermées.`);
  } else if (existing) {
    if (existing.role === 'ADMIN' && existing.status === 'ACTIVE') {
      console.log(`✓ ${email} est déjà administrateur actif. Rien à faire.`);
    } else {
      const answer = arg('promote') ?? (await ask(`Le compte ${email} existe. Le promouvoir administrateur et l'activer ? (oui/non) `));
      if (!/^o(ui)?$/i.test(answer) && answer !== 'yes') {
        console.log('Annulé.');
        process.exit(1);
      }
      await db.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', status: 'ACTIVE', reviewedAt: new Date() } });
      await ensurePersonalSpace(db, existing.id);
      await db.activityLog.create({ data: { action: 'system.admin_promote', actorLabel: 'Script create-admin', targetType: 'user', targetId: existing.id, targetLabel: email } });
      console.log(`✓ ${email} est maintenant administrateur.`);
    }
  } else {
    const firstName = arg('first-name') || process.env.ADMIN_FIRST_NAME || (await ask('Prénom : '));
    const lastName = arg('last-name') || process.env.ADMIN_LAST_NAME || (await ask('Nom : '));
    const password = process.env.ADMIN_PASSWORD || (await ask('Mot de passe (12 caractères minimum) : ', true));
    if (password.length < 12) {
      console.error('✗ Mot de passe trop court (12 caractères minimum).');
      process.exit(1);
    }
    if (!process.env.ADMIN_PASSWORD) {
      const confirm = await ask('Confirmez le mot de passe : ', true);
      if (confirm !== password) {
        console.error('✗ Les mots de passe ne correspondent pas.');
        process.exit(1);
      }
    }
    const authKey = await clientStretchPassword(email, password);
    const user = await db.user.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash: await hashAuthKey(authKey, Number(process.env.PASSWORD_ITERATIONS || 100_000)),
        role: 'ADMIN',
        status: 'ACTIVE',
        reviewedAt: new Date(),
      },
    });
    await ensurePersonalSpace(db, user.id);
    await db.activityLog.create({ data: { action: 'system.admin_create', actorLabel: 'Script create-admin', targetType: 'user', targetId: user.id, targetLabel: email } });
    console.log(`✓ Administrateur créé : ${firstName} ${lastName} <${email}>`);
  }
} finally {
  await close();
}
