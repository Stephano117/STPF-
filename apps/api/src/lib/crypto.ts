// Primitives cryptographiques fondées sur WebCrypto : identiques sous Node.js et Workers,
// ce qui garantit que les empreintes restent vérifiables après une migration.

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return toHex(buf);
}

async function pbkdf2(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Étirement appliqué par le client (navigateur, script create-admin) AVANT l'envoi.
 * Le serveur ne voit jamais le mot de passe en clair et n'a plus qu'un hachage léger à
 * faire, ce qui tient dans le budget CPU d'un hébergement gratuit (10 ms sur Workers Free).
 * Doit rester strictement identique à apps/web/src/lib/password.ts.
 */
export const CLIENT_KDF_ITERATIONS = 600_000;
export async function clientStretchPassword(email: string, password: string): Promise<string> {
  const salt = enc.encode(`stf-v1:${email.trim().toLowerCase()}`);
  return toHex(await pbkdf2(enc.encode(password.normalize('NFKC')), salt, CLIENT_KDF_ITERATIONS));
}

/** `authKey` : sortie hexadécimale (64 caractères) de clientStretchPassword. */
export async function hashAuthKey(authKey: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(fromHex(authKey), salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyAuthKey(authKey: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !saltHex || !hashHex) return false;
  const hash = await pbkdf2(fromHex(authKey), fromHex(saltHex), Number(iter));
  return timingSafeEqual(hash, fromHex(hashHex));
}

export function needsRehash(stored: string, iterations: number): boolean {
  return Number(stored.split('$')[1]) !== iterations;
}
