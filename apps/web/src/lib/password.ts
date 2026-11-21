// Étirement du mot de passe dans le navigateur (PBKDF2-SHA-256 × 600 000, recommandation
// OWASP). Le mot de passe en clair ne quitte jamais l'appareil ; le serveur re-hache la clé
// obtenue avec un sel aléatoire. Doit rester identique à apps/api/src/lib/crypto.ts.

const ITERATIONS = 600_000;

export async function stretchPassword(email: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`stf-v1:${email.trim().toLowerCase()}`), iterations: ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Renvoie un message si le mot de passe est trop faible, sinon null. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Au moins 12 caractères.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Mélangez des lettres et des chiffres.';
  if (/^(.)\1+$/.test(password)) return 'Mot de passe trop simple.';
  return null;
}
