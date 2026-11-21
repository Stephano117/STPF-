import { describe, expect, it } from 'vitest';
// L'étirement du navigateur et celui du serveur (script create-admin, tests) doivent
// produire exactement la même clé, sinon plus personne ne peut se connecter.
import { clientStretchPassword } from '../../../api/src/lib/crypto.ts';
import { formatBytes } from './format';
import { passwordProblem, stretchPassword } from './password';

describe('mot de passe', () => {
  it('le navigateur et le serveur dérivent la même clé', async () => {
    for (const [email, password] of [
      ['awa.diop@stf.test', 'Mot-de-passe-solide-1'],
      ['  Awa.Diop@STF.test ', 'Mot-de-passe-solide-1'],
      ['x@y.z', 'accents-éàü-ｆｕｌｌ-12345'],
    ] as const) {
      const key = await stretchPassword(email, password);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toBe(await clientStretchPassword(email, password));
    }
  });

  it('la clé dépend de l’e-mail et du mot de passe', async () => {
    const a = await stretchPassword('a@stf.test', 'Mot-de-passe-solide-1');
    expect(a).not.toBe(await stretchPassword('b@stf.test', 'Mot-de-passe-solide-1'));
    expect(a).not.toBe(await stretchPassword('a@stf.test', 'Mot-de-passe-solide-2'));
  });

  it('refuse les mots de passe faibles', () => {
    expect(passwordProblem('court1')).not.toBeNull();
    expect(passwordProblem('quelettresquelettres')).not.toBeNull();
    expect(passwordProblem('123456789012')).not.toBeNull();
    expect(passwordProblem('Mot-de-passe-2026')).toBeNull();
  });
});

describe('affichage', () => {
  it('formate les tailles', () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(1536)).toBe('1,5 Ko');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 Mo');
  });
});
