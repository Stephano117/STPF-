import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Archive, Check, CheckCircle2, Database, FileStack, HardDrive, Pencil, RotateCcw, ScrollText, Trash2, UserCheck, Users, UsersRound, Wrench, X, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useParams } from 'react-router';
import { toast } from 'sonner';
import { FileTypeIcon } from '@/components/files';
import { Badge, Button, Card, ConfirmDialog, Dialog, DialogFooter, EmptyState, ErrorNote, Field, Input, PageLoader, ProgressBar, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { passwordProblem, stretchPassword } from '@/lib/password';
import { useAuth } from '@/lib/auth';
import { actionLabel, cn, formatBytes, formatDate, formatDateTime, formatRelative, ROLE_LABEL, STATUS_LABEL } from '@/lib/format';
import type { FileItem, Person, Role } from '@/lib/types';
import { PageTitle } from './MainPages';

const TABS = [
  { id: 'inscriptions', label: 'Inscriptions', icon: UserCheck },
  { id: 'utilisateurs', label: 'Utilisateurs', icon: Users },
  { id: 'espaces', label: 'Espaces', icon: UsersRound },
  { id: 'fichiers', label: 'Fichiers', icon: FileStack },
  { id: 'quotas', label: 'Quotas', icon: HardDrive },
  { id: 'journaux', label: 'Journaux', icon: ScrollText },
  { id: 'etat', label: 'État', icon: Activity },
] as const;

interface AdminUser {
  id: string; email: string; firstName: string; lastName: string; role: 'USER' | 'ADMIN';
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED'; canCreateSpaces: boolean; quotaBytes: number | null;
  createdAt: string; lastLoginAt: string | null;
}

function useAdminAction() {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    } finally {
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('admin') || q.queryKey[0] === 'contents' });
    }
  };
}

function Section<T>({ query, children, empty }: { query: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (data: T) => ReactNode; empty?: ReactNode }) {
  if (query.isLoading) return <PageLoader />;
  if (query.error || query.data === undefined) return <ErrorNote message={errorMessage(query.error)} onRetry={() => query.refetch()} />;
  return <>{children(query.data) ?? empty}</>;
}

const th = 'px-4 py-2.5 font-medium';
const td = 'px-4 py-2.5';
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>{head.map((h, i) => <th key={i} className={th}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </Card>
  );
}

const statusTone = { PENDING: 'warn', ACTIVE: 'ok', REJECTED: 'danger', SUSPENDED: 'danger' } as const;
const levelTone = { ok: 'petrol', warning: 'warn', critical: 'danger' } as const;

// ───────────────────────────── Inscriptions ─────────────────────────────

function Registrations() {
  const act = useAdminAction();
  const q = useQuery({ queryKey: ['admin-users', 'PENDING'], queryFn: () => api<{ users: AdminUser[] }>('/admin/users?status=PENDING') });
  return (
    <Section query={q}>
      {({ users }) => users.length === 0 ? <Card><EmptyState icon={UserCheck} title="Aucune demande en attente" text="Les nouvelles demandes d’inscription apparaîtront ici." /></Card> : (
        <div className="space-y-3">
          {users.map((u) => (
            <Card key={u.id} className="flex flex-wrap items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink">{u.firstName} {u.lastName}</div>
                <div className="text-sm text-muted">{u.email}</div>
                <div className="mt-1 text-[13px] text-muted">Demande envoyée {formatRelative(u.createdAt)}</div>
              </div>
              <Button variant="secondary" onClick={() => act(() => api(`/admin/users/${u.id}/reject`, { method: 'POST' }), 'Inscription refusée').catch(() => undefined)}><X className="h-4 w-4" />Refuser</Button>
              <Button onClick={() => act(() => api(`/admin/users/${u.id}/approve`, { method: 'POST' }), `${u.firstName} ${u.lastName} peut maintenant se connecter`).catch(() => undefined)}><Check className="h-4 w-4" />Valider</Button>
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────── Utilisateurs ─────────────────────────────

function UsersTab() {
  const { me } = useAuth();
  const act = useAdminAction();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const q = useQuery({ queryKey: ['admin-users', status, search], queryFn: () => api<{ users: AdminUser[] }>(`/admin/users?${new URLSearchParams({ status, q: search })}`) });
  const transition = (u: AdminUser, op: string, label: string) => act(() => api(`/admin/users/${u.id}/${op}`, { method: 'POST' }), label).catch(() => undefined);
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Nom ou e-mail…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher un utilisateur" />
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
          <option value="">Tous les statuts</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      <Section query={q}>
        {({ users }) => (
          <Table head={['Utilisateur', 'Rôle', 'Statut', 'Dernière connexion', '']}>
            {users.map((u) => (
              <tr key={u.id}>
                <td className={td}><div className="font-medium text-ink">{u.firstName} {u.lastName}{u.id === me.user.id && <span className="font-normal text-muted"> (vous)</span>}</div><div className="text-[13px] text-muted">{u.email}</div></td>
                <td className={td}>{u.role === 'ADMIN' ? <Badge tone="petrol">Administrateur</Badge> : 'Utilisateur'}</td>
                <td className={td}><Badge tone={statusTone[u.status]}>{STATUS_LABEL[u.status]}</Badge></td>
                <td className={cn(td, 'whitespace-nowrap text-muted')}>{u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Jamais'}</td>
                <td className={cn(td, 'whitespace-nowrap text-right')}>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(u)}><Pencil className="h-4 w-4" />Modifier</Button>
                  {u.id !== me.user.id && u.status === 'ACTIVE' && <Button size="sm" variant="ghost" className="text-danger" onClick={() => transition(u, 'suspend', 'Compte suspendu')}>Suspendre</Button>}
                  {u.status === 'SUSPENDED' && <Button size="sm" variant="ghost" onClick={() => transition(u, 'reactivate', 'Compte réactivé')}>Réactiver</Button>}
                  {(u.status === 'PENDING' || u.status === 'REJECTED') && <Button size="sm" variant="ghost" onClick={() => transition(u, 'approve', 'Compte validé')}>Valider</Button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {editing && <UserDialog user={editing} self={editing.id === me.user.id} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserDialog({ user, self, onClose }: { user: AdminUser; self: boolean; onClose: () => void }) {
  const act = useAdminAction();
  const [role, setRole] = useState(user.role);
  const [canCreateSpaces, setCanCreateSpaces] = useState(user.canCreateSpaces);
  const [quotaMb, setQuotaMb] = useState(user.quotaBytes === null ? '' : String(Math.round(user.quotaBytes / 1048576)));
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetting, setResetting] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${user.firstName} ${user.lastName}`} description={user.email}>
      <div className="space-y-4">
          <Field label="Rôle" htmlFor="u-role" hint={self ? 'Vous ne pouvez pas modifier votre propre rôle.' : undefined}>
            <Select id="u-role" value={role} disabled={self} onChange={(e) => setRole(e.target.value as 'USER' | 'ADMIN')}><option value="USER">Utilisateur</option><option value="ADMIN">Administrateur</option></Select>
          </Field>
        <Field label="Quota de l’espace personnel (Mo)" htmlFor="u-quota" hint="Laissez vide pour appliquer le quota par défaut.">
          <Input id="u-quota" type="number" min={0} inputMode="numeric" value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} placeholder="Par défaut" />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="accent-petrol" checked={canCreateSpaces} onChange={(e) => setCanCreateSpaces(e.target.checked)} />Peut créer des espaces partagés</label>
        {!self && (
          <div className="border-t border-line pt-4">
            <Field label="Réinitialiser le mot de passe" htmlFor="u-reset" error={resetError} hint="Mot de passe provisoire (12 caractères min.) à communiquer de vive voix. Toutes ses sessions seront fermées.">
              <div className="flex gap-2">
                <Input id="u-reset" type="text" autoComplete="off" value={tempPassword} onChange={(e) => { setTempPassword(e.target.value); setResetError(''); }} placeholder="Nouveau mot de passe provisoire" />
                <Button variant="secondary" loading={resetting} disabled={!tempPassword} onClick={async () => {
                  const problem = passwordProblem(tempPassword);
                  if (problem) return setResetError(problem);
                  setResetting(true);
                  try {
                    await act(async () => api(`/admin/users/${user.id}/password`, { method: 'POST', body: { authKey: await stretchPassword(user.email, tempPassword) } }), 'Mot de passe réinitialisé');
                    setTempPassword('');
                  } catch { /* affiché */ } finally { setResetting(false); }
                }}>Réinitialiser</Button>
              </div>
            </Field>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Annuler</Button>
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          try {
            await act(() => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { ...(self ? {} : { role }), canCreateSpaces, quotaBytes: quotaMb.trim() === '' ? null : Math.round(Number(quotaMb) * 1048576) } }), 'Compte mis à jour');
            onClose();
          } catch { /* affiché */ } finally { setBusy(false); }
        }}>Enregistrer</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ───────────────────────────── Espaces ─────────────────────────────

interface AdminSpace { id: string; type: 'COMPANY' | 'SHARED'; name: string; owner: Person | null; memberCount: number; createdAt: string; archivedAt: string | null; fileCount: number; usedBytes: number }

function SpacesTab() {
  const act = useAdminAction();
  const q = useQuery({ queryKey: ['admin-spaces'], queryFn: () => api<{ spaces: AdminSpace[] }>('/admin/spaces') });
  const [members, setMembers] = useState<AdminSpace | null>(null);
  const [purging, setPurging] = useState<AdminSpace | null>(null);
  return (
    <>
      <Section query={q}>
        {({ spaces }) => (
          <Table head={['Espace', 'Propriétaire', 'Membres', 'Fichiers', 'Taille', '']}>
            {spaces.map((s) => (
              <tr key={s.id} className={s.archivedAt ? 'bg-surface/70' : undefined}>
                <td className={td}><span className="font-medium text-ink">{s.name}</span> {s.type === 'COMPANY' ? <Badge tone="petrol">Entreprise</Badge> : s.archivedAt ? <Badge tone="warn">Archivé</Badge> : null}</td>
                <td className={cn(td, 'text-muted')}>{s.owner ? `${s.owner.firstName} ${s.owner.lastName}` : '—'}</td>
                <td className={cn(td, 'text-muted')}>{s.type === 'COMPANY' ? 'Tous' : s.memberCount}</td>
                <td className={cn(td, 'text-muted')}>{s.fileCount}</td>
                <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatBytes(s.usedBytes)}</td>
                <td className={cn(td, 'whitespace-nowrap text-right')}>
                  {s.type === 'SHARED' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setMembers(s)}><Users className="h-4 w-4" />Membres</Button>
                      {s.archivedAt ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act(() => api(`/admin/spaces/${s.id}/restore`, { method: 'POST' }), 'Espace restauré').catch(() => undefined)}><RotateCcw className="h-4 w-4" />Restaurer</Button>
                          <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPurging(s)}><Trash2 className="h-4 w-4" />Supprimer</Button>
                        </>
                      ) : <Button size="sm" variant="ghost" onClick={() => act(() => api(`/admin/spaces/${s.id}/archive`, { method: 'POST' }), 'Espace archivé').catch(() => undefined)}><Archive className="h-4 w-4" />Archiver</Button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {members && <AdminMembersDialog space={members} onClose={() => setMembers(null)} />}
      {purging && <PurgeSpaceDialog space={purging} onClose={() => setPurging(null)} />}
    </>
  );
}

function AdminMembersDialog({ space, onClose }: { space: AdminSpace; onClose: () => void }) {
  const act = useAdminAction();
  const q = useQuery({ queryKey: ['admin-space-members', space.id], queryFn: () => api<{ members: (Person & { role: Role })[] }>(`/admin/spaces/${space.id}/members`) });
  const [search, setSearch] = useState('');
  const users = useQuery({ queryKey: ['admin-users', 'ACTIVE', search], queryFn: () => api<{ users: AdminUser[] }>(`/admin/users?status=ACTIVE&q=${encodeURIComponent(search)}`), enabled: search.trim().length >= 2 });
  const setRole = (userId: string, role: string, label: string) => act(() => api(`/admin/spaces/${space.id}/members/${userId}`, { method: 'PUT', body: { role } }), label).catch(() => undefined);
  const memberIds = new Set(q.data?.members.map((m) => m.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Permissions — ${space.name}`} description="Attribuez ou retirez des accès. Chaque modification est journalisée." size="lg">
      <Section query={q}>
        {({ members }) => (
          <div className="space-y-4">
            <ul className="divide-y divide-line rounded-xl border border-line">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1 text-sm"><div className="truncate font-medium text-ink">{m.firstName} {m.lastName}</div><div className="truncate text-[13px] text-muted">{m.email}</div></div>
                  <Select className="h-8 w-40 text-[13px]" value={m.role} aria-label={`Rôle de ${m.firstName} ${m.lastName}`} onChange={(e) => setRole(m.id, e.target.value, 'Rôle mis à jour')}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k} disabled={m.role === 'OWNER' && k !== 'OWNER'}>{v}</option>)}
                  </Select>
                  <Button size="icon" variant="ghost" disabled={m.role === 'OWNER'} aria-label="Retirer" onClick={() => act(() => api(`/admin/spaces/${space.id}/members/${m.id}`, { method: 'DELETE' }), 'Membre retiré').catch(() => undefined)}><X className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
            <Field label="Ajouter un membre" htmlFor="adm-add"><Input id="adm-add" placeholder="Nom ou e-mail…" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
            {search.trim().length >= 2 && (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {(users.data?.users ?? []).filter((u) => !memberIds.has(u.id)).slice(0, 8).map((u) => (
                  <li key={u.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{u.firstName} {u.lastName} <span className="text-muted">· {u.email}</span></span>
                    <Button size="sm" variant="secondary" onClick={() => setRole(u.id, 'READER', 'Membre ajouté comme lecteur')}>Ajouter</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
    </Dialog>
  );
}

function PurgeSpaceDialog({ space, onClose }: { space: AdminSpace; onClose: () => void }) {
  const act = useAdminAction();
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} title="Supprimer définitivement cet espace ?" size="sm">
      <p className="text-sm text-ink">« {space.name} » et ses <strong>{space.fileCount} fichier(s)</strong> ({formatBytes(space.usedBytes)}) seront effacés. <strong>Cette action est irréversible.</strong></p>
      <div className="mt-4 space-y-3">
        <Field label="Motif (consigné au journal)" htmlFor="purge-reason"><Input id="purge-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label={`Saisissez « ${space.name} » pour confirmer`} htmlFor="purge-name"><Input id="purge-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" /></Field>
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Annuler</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 5 || confirmName !== space.name} onClick={async () => {
          setBusy(true);
          try { await act(() => api(`/admin/spaces/${space.id}`, { method: 'DELETE', body: { reason: reason.trim(), confirmName } }), 'Espace supprimé définitivement'); onClose(); } catch { /* affiché */ } finally { setBusy(false); }
        }}>Supprimer définitivement</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ───────────────────────────── Fichiers ─────────────────────────────

function FilesTab() {
  const act = useAdminAction();
  const [search, setSearch] = useState('');
  const [deleted, setDeleted] = useState('0');
  const [confirm, setConfirm] = useState<{ file: FileItem; permanent: boolean } | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['admin-files', search, deleted],
    queryFn: ({ pageParam }) => api<{ files: FileItem[]; nextCursor: string | null }>(`/admin/files?${new URLSearchParams({ q: search, deleted, ...(pageParam ? { cursor: pageParam } : {}) })}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const files = q.data?.pages.flatMap((p) => p.files) ?? [];
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Nom de fichier…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher un fichier" />
        <Select className="w-auto" value={deleted} onChange={(e) => setDeleted(e.target.value)} aria-label="État"><option value="0">Fichiers actifs</option><option value="1">Corbeille</option></Select>
      </div>
      <p className="mb-3 text-[13px] text-muted">Espaces entreprise et partagés uniquement : les espaces personnels sont privés et n’apparaissent pas ici.</p>
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : files.length === 0 ? <Card><EmptyState icon={FileStack} title="Aucun fichier" /></Card> : (
          <>
            <Table head={['Fichier', 'Espace', 'Importé par', 'Modifié', 'Taille', '']}>
              {files.map((f) => (
                <tr key={f.id}>
                  <td className={cn(td, 'max-w-xs')}><span className="flex items-center gap-2.5"><FileTypeIcon file={f} className="h-5 w-5" /><span className="truncate font-medium text-ink">{f.name}</span></span></td>
                  <td className={cn(td, 'text-muted')}>{f.spaceName}{f.folderName ? ` › ${f.folderName}` : ''}</td>
                  <td className={cn(td, 'text-muted')}>{f.uploader?.name ?? '—'}</td>
                  <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatRelative(f.deletedAt ?? f.updatedAt)}</td>
                  <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatBytes(f.size)}</td>
                  <td className={cn(td, 'whitespace-nowrap text-right')}>
                    {f.deletedAt ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => act(() => api(`/admin/files/${f.id}/restore`, { method: 'POST' }), 'Fichier restauré').catch(() => undefined)}><RotateCcw className="h-4 w-4" />Restaurer</Button>
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm({ file: f, permanent: true })}>Purger</Button>
                      </>
                    ) : <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm({ file: f, permanent: false })}><Trash2 className="h-4 w-4" />Supprimer</Button>}
                  </td>
                </tr>
              ))}
            </Table>
            {q.hasNextPage && <div className="mt-4 text-center"><Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Afficher plus</Button></div>}
          </>
        )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.permanent ? 'Supprimer définitivement ?' : 'Suppression administrative'}
        text={confirm?.permanent
          ? <>« {confirm.file.name} » et toutes ses versions seront effacés. <strong>Irréversible.</strong></>
          : <>« {confirm?.file.name} » sera placé dans la corbeille. Cette opération exceptionnelle est consignée au journal avec votre nom.</>}
        confirmLabel={confirm?.permanent ? 'Supprimer définitivement' : 'Supprimer'}
        danger
        requireReason
        onConfirm={(reason) => act(() => api(`/admin/files/${confirm!.file.id}${confirm!.permanent ? '/permanent' : ''}`, { method: 'DELETE', body: { reason } }), confirm!.permanent ? 'Fichier supprimé définitivement' : 'Fichier placé dans la corbeille')}
      />
    </>
  );
}

// ───────────────────────────── Quotas ─────────────────────────────

interface Quotas {
  global: { usedBytes: number; pendingBytes: number; quotaBytes: number; level: 'ok' | 'warning' | 'critical' };
  defaults: { userQuotaBytes: number; maxFileSizeBytes: number };
  users: { id: string; name: string; email: string; usedBytes: number; quotaBytes: number; customQuota: boolean; level: 'ok' | 'warning' | 'critical' }[];
  spaces: { id: string; name: string; type: string; archived: boolean; usedBytes: number; fileCount: number }[];
}

function Meter({ used, quota, level }: { used: number; quota: number; level: 'ok' | 'warning' | 'critical' }) {
  return (
    <div>
      <ProgressBar value={quota > 0 ? used / quota : 0} tone={level === 'critical' ? 'danger' : level === 'warning' ? 'warn' : 'petrol'} />
      <div className="mt-1 text-xs text-muted">{formatBytes(used)} sur {formatBytes(quota)}</div>
    </div>
  );
}

function QuotasTab() {
  const q = useQuery({ queryKey: ['admin-quotas'], queryFn: () => api<Quotas>('/admin/quotas') });
  return (
    <Section query={q}>
      {(d) => (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-ink">Stockage de la plateforme</h2>
              <Badge tone={levelTone[d.global.level]}>{d.global.level === 'ok' ? 'Normal' : d.global.level === 'warning' ? 'À surveiller' : 'Saturation proche'}</Badge>
            </div>
            <Meter used={d.global.usedBytes + d.global.pendingBytes} quota={d.global.quotaBytes} level={d.global.level} />
            <p className="mt-3 text-[13px] text-muted">Taille maximale d’un fichier : {formatBytes(d.defaults.maxFileSizeBytes)} · Quota personnel par défaut : {formatBytes(d.defaults.userQuotaBytes)}{d.global.pendingBytes > 0 ? ` · ${formatBytes(d.global.pendingBytes)} réservés par des imports en cours` : ''}</p>
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 font-semibold text-ink">Espaces personnels</h2>
              <Card className="divide-y divide-line">
                {d.users.map((u) => (
                  <div key={u.id} className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-sm"><span className="truncate font-medium text-ink">{u.name}</span>{u.customQuota && <Badge>Quota personnalisé</Badge>}</div>
                    <Meter used={u.usedBytes} quota={u.quotaBytes} level={u.level} />
                  </div>
                ))}
              </Card>
              <p className="mt-2 text-[13px] text-muted">Le quota d’un utilisateur se modifie depuis l’onglet Utilisateurs.</p>
            </div>
            <div>
              <h2 className="mb-2 font-semibold text-ink">Espaces entreprise et partagés</h2>
              <Card className="divide-y divide-line">
                {d.spaces.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span className="truncate font-medium text-ink">{s.name}{s.archived && <span className="font-normal text-muted"> (archivé)</span>}</span>
                    <span className="shrink-0 text-muted">{s.fileCount} fichier(s) · {formatBytes(s.usedBytes)}</span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────── Journaux ─────────────────────────────

interface LogEntry { id: string; createdAt: string; actorLabel: string; action: string; targetLabel: string; metadata: Record<string, unknown> | null; ip: string | null }

function LogsTab() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin-logs', action, actor],
    queryFn: ({ pageParam }) => api<{ logs: LogEntry[]; nextCursor: string | null }>(`/admin/logs?${new URLSearchParams({ action, actor, ...(pageParam ? { cursor: pageParam } : {}) })}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const logs = q.data?.pages.flatMap((p) => p.logs) ?? [];
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-auto" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Type d’opération">
          <option value="">Toutes les opérations</option>
          <option value="auth.">Connexions</option>
          <option value="user.">Inscriptions et profils</option>
          <option value="file.">Fichiers</option>
          <option value="folder.">Dossiers</option>
          <option value="space.">Espaces</option>
          <option value="admin.">Actions d’administration</option>
          <option value="admin.file_">Suppressions administratives</option>
          <option value="system.">Système</option>
        </Select>
        <Input className="max-w-xs" placeholder="Filtrer par auteur…" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Auteur" />
      </div>
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : logs.length === 0 ? <Card><EmptyState icon={ScrollText} title="Aucune entrée" /></Card> : (
          <>
            <Table head={['Date', 'Auteur', 'Opération', 'Objet', 'Détail']}>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatDateTime(l.createdAt)}</td>
                  <td className={cn(td, 'max-w-48 truncate')} title={l.actorLabel}>{l.actorLabel.replace(/\s*<.*>$/, '') || '—'}</td>
                  <td className={td}><Badge tone={l.action.startsWith('admin.') ? 'warn' : l.action.endsWith('_failed') ? 'danger' : 'neutral'}>{actionLabel(l.action)}</Badge></td>
                  <td className={cn(td, 'max-w-56 truncate text-muted')} title={l.targetLabel}>{l.targetLabel || '—'}</td>
                  <td className={cn(td, 'max-w-64 truncate text-[13px] text-muted')}>{typeof l.metadata?.reason === 'string' ? `Motif : ${l.metadata.reason}` : l.ip ?? ''}</td>
                </tr>
              ))}
            </Table>
            {q.hasNextPage && <div className="mt-4 text-center"><Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Afficher plus</Button></div>}
          </>
        )}
    </>
  );
}

// ───────────────────────────── État de la plateforme ─────────────────────────────

interface Status {
  version: string;
  database: { ok: boolean; ms: number; usedBytes: number; quotaBytes: number; level: 'ok' | 'warning' | 'critical' };
  storage: { ok: boolean; ms?: number; error?: string; usedBytes: number; pendingBytes: number; quotaBytes: number; level: 'ok' | 'warning' | 'critical' };
  counts: { pendingUsers: number; activeUsers: number; files: number; pendingUploads: number; errors24h: number };
  lastMaintenance: { createdAt: string } | null;
  alerts: { level: 'warning' | 'critical'; message: string }[];
  recentErrors: { id: string; createdAt: string; source: string; message: string; path: string | null }[];
}

function StatusTab() {
  const act = useAdminAction();
  const q = useQuery({ queryKey: ['admin-status'], queryFn: () => api<Status>('/admin/status'), refetchInterval: 60_000 });
  const [running, setRunning] = useState(false);
  const Health = ({ ok, label, detail }: { ok: boolean; label: string; detail: string }) => (
    <div className="flex items-center gap-3">
      {ok ? <CheckCircle2 className="h-5 w-5 text-ok" /> : <XCircle className="h-5 w-5 text-danger" />}
      <div><div className="text-sm font-medium text-ink">{label}</div><div className="text-[13px] text-muted">{detail}</div></div>
    </div>
  );
  return (
    <Section query={q}>
      {(s) => (
        <div className="space-y-5">
          {s.alerts.length > 0 ? (
            <div className="space-y-2">
              {s.alerts.map((a, i) => (
                <div key={i} role="alert" className={cn('flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm', a.level === 'critical' ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>
                  <AlertTriangle className="h-4 w-4 shrink-0" />{a.message}
                </div>
              ))}
            </div>
          ) : <div className="flex items-center gap-2.5 rounded-xl bg-ok-soft px-4 py-3 text-sm text-ok"><CheckCircle2 className="h-4 w-4" />Tout fonctionne normalement.</div>}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2 font-semibold text-ink"><Database className="h-4 w-4 text-petrol" />Base de données</div>
              <Health ok={s.database.ok} label={s.database.ok ? 'Opérationnelle' : 'En panne'} detail={`Réponse en ${s.database.ms} ms`} />
              <Meter used={s.database.usedBytes} quota={s.database.quotaBytes} level={s.database.level} />
            </Card>
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2 font-semibold text-ink"><HardDrive className="h-4 w-4 text-petrol" />Stockage des fichiers</div>
              <Health ok={s.storage.ok} label={s.storage.ok ? 'Opérationnel' : 'Injoignable'} detail={s.storage.ok ? `Réponse en ${s.storage.ms} ms` : (s.storage.error ?? '')} />
              <Meter used={s.storage.usedBytes + s.storage.pendingBytes} quota={s.storage.quotaBytes} level={s.storage.level} />
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {([['Comptes actifs', s.counts.activeUsers], ['Inscriptions en attente', s.counts.pendingUsers], ['Fichiers', s.counts.files], ['Imports en cours', s.counts.pendingUploads], ['Erreurs (24 h)', s.counts.errors24h]] as const).map(([label, value]) => (
              <Card key={label} className="p-4"><div className="text-2xl font-semibold text-ink">{value}</div><div className="mt-0.5 text-[13px] text-muted">{label}</div></Card>
            ))}
          </div>

          <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div className="flex items-center gap-2 font-semibold text-ink"><Wrench className="h-4 w-4 text-petrol" />Maintenance</div>
              <p className="mt-1 text-[13px] text-muted">Nettoie les imports abandonnés, purge la corbeille expirée et les sessions périmées. Dernier passage : {s.lastMaintenance ? formatRelative(s.lastMaintenance.createdAt) : 'jamais'} · version {s.version}</p>
            </div>
            <Button variant="secondary" loading={running} onClick={async () => { setRunning(true); try { await act(() => api('/admin/maintenance', { method: 'POST' }), 'Maintenance effectuée'); } catch { /* affiché */ } finally { setRunning(false); } }}>Lancer maintenant</Button>
          </Card>

          <div>
            <h2 className="mb-2 font-semibold text-ink">Erreurs récentes</h2>
            {s.recentErrors.length === 0 ? <Card className="p-5 text-sm text-muted">Aucune erreur enregistrée.</Card> : (
              <Table head={['Date', 'Origine', 'Message', 'Contexte']}>
                {s.recentErrors.map((e) => (
                  <tr key={e.id}>
                    <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatDate(e.createdAt)} {new Date(e.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td className={td}><Badge>{e.source === 'web' ? 'Interface' : e.source === 'storage' ? 'Stockage' : 'Serveur'}</Badge></td>
                    <td className={cn(td, 'max-w-md truncate')} title={e.message}>{e.message}</td>
                    <td className={cn(td, 'max-w-48 truncate text-muted')}>{e.path ?? '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

export function AdminPage() {
  const { tab = 'inscriptions' } = useParams();
  const pending = useQuery({ queryKey: ['admin-users', 'PENDING'], queryFn: () => api<{ users: AdminUser[] }>('/admin/users?status=PENDING') });
  const count = pending.data?.users.length ?? 0;
  return (
    <div className="mx-auto max-w-7xl">
      <PageTitle title="Administration" />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Sections d’administration">
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/admin/${t.id}`} className={() => cn('-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium', tab === t.id ? 'border-petrol text-petrol' : 'border-transparent text-muted hover:text-ink')}>
            <t.icon className="h-4 w-4" />{t.label}
            {t.id === 'inscriptions' && count > 0 && <span className="rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">{count}</span>}
          </NavLink>
        ))}
      </nav>
      {tab === 'inscriptions' ? <Registrations /> : tab === 'utilisateurs' ? <UsersTab /> : tab === 'espaces' ? <SpacesTab />
        : tab === 'fichiers' ? <FilesTab /> : tab === 'quotas' ? <QuotasTab /> : tab === 'journaux' ? <LogsTab /> : <StatusTab />}
    </div>
  );
}
