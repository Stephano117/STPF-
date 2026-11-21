import type { Context } from 'hono';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db, DbOrTx } from './db.ts';
import type { StorageAdapter } from './storage.ts';
import { badRequest } from './errors.ts';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'USER' | 'ADMIN';
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
  canCreateSpaces: boolean;
  quotaBytes: bigint | null;
}

export type AppEnv = {
  Variables: {
    db: Db;
    config: Config;
    storage: StorageAdapter;
    user: AuthUser;
    sessionId: string;
    ip: string;
  };
};

export type Ctx = Context<AppEnv>;

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Corps de requête JSON invalide.');
  }
  return validate(schema, raw);
}

export function query<T extends z.ZodType>(c: Ctx, schema: T): z.infer<T> {
  return validate(schema, c.req.query());
}

export function validate<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(details[0] ? `${details[0].path || 'requête'} : ${details[0].message}` : 'Requête invalide.', 'VALIDATION', details);
  }
  return result.data;
}

export function fullName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

export interface ActivityInput {
  action: string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string;
  spaceId?: string | null;
  /** Vrai pour toute opération dans un espace personnel. */
  private?: boolean;
  metadata?: Record<string, unknown>;
  /** Acteur explicite quand aucun utilisateur n'est encore authentifié (inscription, connexion). */
  actor?: { id: string | null; label: string };
}

/** Écrit une ligne du journal d'activité. Accepte une transaction pour rester atomique. */
export async function logActivity(db: DbOrTx, c: Ctx, input: ActivityInput): Promise<void> {
  const user = c.get('user') as AuthUser | undefined;
  await db.activityLog.create({
    data: {
      actorId: input.actor ? input.actor.id : (user?.id ?? null),
      actorLabel: input.actor ? input.actor.label : user ? `${fullName(user)} <${user.email}>` : 'Système',
      action: input.action,
      targetType: input.targetType ?? '',
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? '',
      spaceId: input.spaceId ?? null,
      private: input.private ?? false,
      metadata: (input.metadata as object | undefined) ?? undefined,
      ip: c.get('ip') ?? null,
    },
  });
}
