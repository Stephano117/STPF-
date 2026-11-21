import type { DbOrTx } from './db.ts';

export const COMPANY_SPACE_ID = 'company';
export const SYSTEM_ACTOR = 'system';

/** Crée l'espace entreprise et son dossier commun s'ils n'existent pas (idempotent). */
export async function ensureCompanySpace(db: DbOrTx): Promise<void> {
  await db.space.upsert({
    where: { id: COMPANY_SPACE_ID },
    update: {},
    create: { id: COMPANY_SPACE_ID, type: 'COMPANY', name: 'Espace entreprise', description: 'Documents communs de l’entreprise' },
  });
  const anyFolder = await db.folder.findFirst({ where: { spaceId: COMPANY_SPACE_ID, parentId: null } });
  if (!anyFolder) {
    await db.folder.create({
      data: { spaceId: COMPANY_SPACE_ID, name: 'Documents communs', createdById: SYSTEM_ACTOR },
    });
  }
}

/** Crée l'espace personnel d'un utilisateur s'il n'existe pas (idempotent). */
export async function ensurePersonalSpace(db: DbOrTx, userId: string): Promise<string> {
  const existing = await db.space.findFirst({ where: { type: 'PERSONAL', ownerId: userId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.space.create({
    data: { type: 'PERSONAL', name: 'Mon espace', ownerId: userId },
    select: { id: true },
  });
  return created.id;
}

