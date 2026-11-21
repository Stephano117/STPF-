import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || Number.isInteger(v) ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const relFmt = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

/** « il y a 5 minutes », « hier », puis la date au-delà d'une semaine. */
export function formatRelative(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'à l’instant';
  if (abs < 3600) return relFmt.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return relFmt.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return relFmt.format(Math.round(diff / 86_400), 'day');
  return formatDate(iso);
}

export const ROLE_LABEL: Record<string, string> = { OWNER: 'Propriétaire', MANAGER: 'Gestionnaire', EDITOR: 'Éditeur', READER: 'Lecteur' };
export const STATUS_LABEL: Record<string, string> = { PENDING: 'En attente', ACTIVE: 'Actif', REJECTED: 'Refusé', SUSPENDED: 'Suspendu' };

const ACTIONS: Record<string, string> = {
  'file.upload': 'Import du fichier',
  'file.version_add': 'Nouvelle version',
  'file.version_restore': 'Version rétablie',
  'file.rename': 'Renommage',
  'file.move': 'Déplacement',
  'file.copy': 'Copie',
  'folder.copy': 'Copie de dossier',
  'system.password_reset': 'Mot de passe réinitialisé (script)',
  'file.trash': 'Mise à la corbeille',
  'file.restore': 'Restauration',
  'file.purge': 'Suppression définitive',
  'file.download': 'Téléchargement',
  'file.preview': 'Consultation',
  'folder.create': 'Création de dossier',
  'folder.rename': 'Renommage de dossier',
  'folder.move': 'Déplacement de dossier',
  'folder.trash': 'Dossier mis à la corbeille',
  'folder.restore': 'Dossier restauré',
  'space.create': 'Création d’espace',
  'space.update': 'Modification d’espace',
  'space.archive': 'Archivage d’espace',
  'space.invite': 'Invitation envoyée',
  'space.invite_cancel': 'Invitation annulée',
  'space.invite_accept': 'Invitation acceptée',
  'space.invite_decline': 'Invitation refusée',
  'space.member_role': 'Changement de rôle',
  'space.member_remove': 'Membre retiré',
  'space.leave': 'Départ d’un espace',
  'auth.login': 'Connexion',
  'auth.login_failed': 'Échec de connexion',
  'auth.password_change': 'Changement de mot de passe',
  'user.register': 'Demande d’inscription',
  'user.profile_update': 'Profil modifié',
  'admin.user_approve': 'Compte validé',
  'admin.user_reject': 'Inscription refusée',
  'admin.user_suspend': 'Compte suspendu',
  'admin.user_reactivate': 'Compte réactivé',
  'admin.user_update': 'Compte modifié',
  'admin.user_password_reset': 'Mot de passe réinitialisé',
  'admin.member_set': 'Rôle attribué (admin)',
  'admin.member_remove': 'Membre retiré (admin)',
  'admin.space_archive': 'Espace archivé (admin)',
  'admin.space_restore': 'Espace restauré (admin)',
  'admin.space_purge': 'Espace supprimé définitivement',
  'admin.folder_policy': 'Permissions de dossier',
  'admin.folder_delete': 'Dossier supprimé (admin)',
  'admin.file_delete': 'Suppression administrative',
  'admin.file_restore': 'Restauration (admin)',
  'admin.file_purge': 'Suppression définitive (admin)',
  'admin.maintenance_run': 'Maintenance lancée',
  'system.maintenance': 'Maintenance automatique',
  'system.trash_purge': 'Purge de la corbeille',
  'system.admin_create': 'Administrateur créé',
  'system.admin_promote': 'Administrateur promu',
};
export const actionLabel = (action: string) => ACTIONS[action] ?? action;
