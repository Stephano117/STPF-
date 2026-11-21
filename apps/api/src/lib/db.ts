import type { PrismaClient } from '../generated/node/client.ts';

// Erreurs « connexion non établie » : la requête n'a pas atteint PostgreSQL, la rejouer
// est sans danger même pour une écriture. (Neon met la base en veille après 5 minutes
// d'inactivité : le premier appel peut échouer ou expirer pendant le réveil.)
const SAFE_RETRY_CODES = new Set(['P1001', 'P1002', 'P2024']);
// Conflits de sérialisation / interblocages : la transaction entière a été annulée.
const TX_RETRY_CODES = new Set(['P2034']);
const TRANSIENT_MESSAGE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|Can't reach database|fetch failed|socket hang up|WebSocket|terminating connection/i;
const READ_OPERATIONS = /^(find|count|aggregate|groupBy|\$queryRaw)/;

const BACKOFF_MS = [150, 500, 1500];

function errorCode(err: unknown): string {
  return (err as { code?: string })?.code ?? '';
}

function isTransient(err: unknown): boolean {
  return TRANSIENT_MESSAGE.test(String((err as Error)?.message ?? ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= BACKOFF_MS.length || !shouldRetry(err)) throw err;
      await sleep(BACKOFF_MS[attempt]! + Math.random() * 100);
    }
  }
}

/** Ajoute la reprise automatique (backoff exponentiel) sur les erreurs temporaires. */
export function withResilience(client: PrismaClient) {
  return client.$extends({
    query: {
      $allOperations({ operation, args, query }) {
        return retry(
          () => query(args),
          (err) => SAFE_RETRY_CODES.has(errorCode(err)) || (READ_OPERATIONS.test(operation) && isTransient(err)),
        );
      },
    },
  });
}

export type Db = ReturnType<typeof withResilience>;
/** Client disponible à l'intérieur d'une transaction interactive. */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** Transaction interactive rejouée en cas de conflit de sérialisation ou d'interblocage. */
export function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return retry(
    () => db.$transaction(fn, { maxWait: 8000, timeout: 15000 }),
    (err) => TX_RETRY_CODES.has(errorCode(err)) || SAFE_RETRY_CODES.has(errorCode(err)),
  );
}
