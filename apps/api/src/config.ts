// Configuration lue depuis l'environnement. Aucune dépendance à un fournisseur :
// les mêmes variables servent sous Node.js (process.env) et sous Workers (bindings).

export interface Config {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  /** Origines autorisées pour les requêtes modifiantes (protection CSRF). */
  appOrigins: string[];
  cookieSecure: boolean;
  /** Domaines d'e-mail acceptés à l'inscription (vide = tous). */
  allowedEmailDomains: string[];
  sessionTtlDays: number;
  /** Itérations PBKDF2 côté serveur (le navigateur applique déjà un étirement fort). */
  passwordIterations: number;
  s3: {
    endpoint: string;
    internalEndpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  maxFileSizeBytes: number;
  /** Capacité totale autorisée du stockage (reste sous le quota gratuit du fournisseur). */
  storageQuotaBytes: number;
  /** Taille maximale de la base (1 Go sur Neon Free) : sert aux alertes de saturation. */
  databaseQuotaBytes: number;
  /** Quota par défaut d'un espace personnel. */
  userQuotaBytes: number;
  multipartThresholdBytes: number;
  partSizeBytes: number;
  uploadTtlHours: number;
  downloadUrlTtlSeconds: number;
  trashRetentionDays: number;
  maintenanceToken: string;
  version: string;
}

type Env = Record<string, string | undefined>;

const MB = 1024 * 1024;
const GB = 1024 * MB;

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Variable ${key} invalide : ${raw}`);
  return Math.floor(n);
}

function required(env: Env, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Variable d'environnement manquante : ${key}`);
  return v;
}

export function loadConfig(env: Env): Config {
  const mode = (env.NODE_ENV as Config['env']) || 'production';
  const endpoint = required(env, 'S3_ENDPOINT').replace(/\/+$/, '');
  const appOrigins = required(env, 'APP_ORIGIN')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return {
    env: mode,
    databaseUrl: required(env, 'DATABASE_URL'),
    appOrigins,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : mode === 'production',
    allowedEmailDomains: (env.ALLOWED_EMAIL_DOMAINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 7),
    passwordIterations: int(env, 'PASSWORD_ITERATIONS', 100_000),
    s3: {
      endpoint,
      internalEndpoint: (env.S3_INTERNAL_ENDPOINT || endpoint).replace(/\/+$/, ''),
      region: env.S3_REGION || 'us-east-1',
      bucket: required(env, 'S3_BUCKET'),
      accessKeyId: required(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY'),
    },
    maxFileSizeBytes: int(env, 'MAX_FILE_SIZE_BYTES', 200 * MB),
    storageQuotaBytes: int(env, 'STORAGE_QUOTA_BYTES', 9 * GB),
    databaseQuotaBytes: int(env, 'DATABASE_QUOTA_BYTES', 1 * GB),
    userQuotaBytes: int(env, 'USER_QUOTA_BYTES', 500 * MB),
    multipartThresholdBytes: int(env, 'MULTIPART_THRESHOLD_BYTES', 16 * MB),
    partSizeBytes: Math.max(5 * MB, int(env, 'PART_SIZE_BYTES', 8 * MB)),
    uploadTtlHours: int(env, 'UPLOAD_TTL_HOURS', 24),
    downloadUrlTtlSeconds: int(env, 'DOWNLOAD_URL_TTL_SECONDS', 300),
    trashRetentionDays: int(env, 'TRASH_RETENTION_DAYS', 30),
    maintenanceToken: env.MAINTENANCE_TOKEN || '',
    version: env.APP_VERSION || '1.0.0',
  };
}
