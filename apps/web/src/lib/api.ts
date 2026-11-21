// Client de l'API. Même origine : le cookie de session HttpOnly est envoyé automatiquement,
// aucun jeton ni secret n'est manipulé par le code du navigateur.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Erreur passagère (réseau, service momentanément indisponible) : une nouvelle tentative a du sens. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const TIMEOUT_MS = 30_000;
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json', 'X-STF-Request': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? 'Le serveur met trop de temps à répondre.' : 'Connexion au serveur impossible. Vérifiez votre réseau.');
  }
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    /* réponse non JSON (panne en amont) */
  }
  if (!res.ok) {
    const error = new ApiError(res.status, payload?.error?.code ?? 'HTTP', payload?.error?.message ?? 'Le service est momentanément indisponible. Réessayez dans un instant.', payload?.error?.details);
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/me')) onUnauthorized?.();
    throw error;
  }
  return payload as T;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue.');

/** Signale une erreur d'interface au serveur (visible dans l'administration). Ne lève jamais. */
export function reportClientError(error: unknown) {
  const e = error as Error;
  void fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-STF-Request': '1' },
    body: JSON.stringify({ message: String(e?.message ?? error).slice(0, 1000), stack: String(e?.stack ?? '').slice(0, 8000), path: location.pathname }),
    keepalive: true,
  }).catch(() => undefined);
}
