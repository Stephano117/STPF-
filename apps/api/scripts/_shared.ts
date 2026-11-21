import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/node/client.ts';
import { withResilience } from '../src/lib/db.ts';
import { S3Storage } from '../src/lib/storage.ts';

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`✗ Variable d'environnement manquante : ${key} (voir .env.example)`);
    process.exit(2);
  }
  return value;
}

export function openDb(url = process.env.DIRECT_URL || requireEnv('DATABASE_URL')) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }) });
  return { db: withResilience(prisma), close: () => prisma.$disconnect() };
}

export function openStorage() {
  const endpoint = requireEnv('S3_ENDPOINT').replace(/\/+$/, '');
  return new S3Storage({
    endpoint,
    internalEndpoint: (process.env.S3_INTERNAL_ENDPOINT || endpoint).replace(/\/+$/, ''),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: requireEnv('S3_BUCKET'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  });
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const flag = (name: string) => process.argv.includes(`--${name}`);

/** Tables exportées, dans l'ordre d'insertion compatible avec les clés étrangères. */
export const BACKUP_TABLES = [
  'user',
  'space',
  'spaceMember',
  'spaceInvitation',
  'folder',
  'file',
  'fileVersion',
  'favorite',
  'recentAccess',
  'activityLog',
] as const;
// Non exportées : Session, RateLimit, Upload, ErrorLog (données techniques éphémères).

/** Encode une ligne en JSON en préservant les types BigInt et Date. */
export function encodeRow(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = { $bigint: v.toString() };
    else if (v instanceof Date) out[k] = { $date: v.toISOString() };
    else out[k] = v;
  }
  return JSON.stringify(out);
}

export function decodeRow(line: string): Record<string, unknown> {
  const row = JSON.parse(line) as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && '$bigint' in v) row[k] = BigInt((v as { $bigint: string }).$bigint);
    else if (v && typeof v === 'object' && '$date' in v) row[k] = new Date((v as { $date: string }).$date);
  }
  return row;
}

export interface Manifest {
  format: 'stf-backup-v1';
  createdAt: string;
  tables: Record<string, { rows: number; sha256: string }>;
  objects: { key: string; size: number; sha256: string; versionId: string; fileId: string }[];
  complete: boolean;
  problems: string[];
}
