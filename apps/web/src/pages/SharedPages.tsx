import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, LogOut, Mail, Plus, Search, Settings2, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { FileBrowser } from '@/components/FileBrowser';
import { Badge, Button, Card, ConfirmDialog, Dialog, DialogFooter, EmptyState, ErrorNote, Field, Input, PageLoader, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, formatRelative, ROLE_LABEL } from '@/lib/format';
import type { Person, Role, SharedSpace } from '@/lib/types';
import { PageTitle } from './MainPages';

interface Invitation { id: string; role: Role; createdAt: string; space: { id: string; name: string; description: string }; invitedBy: Person }

function SpaceFormDialog({ open, onOpenChange, initial, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: { name: string; description: string }; onSubmit: (data: { name: string; description: string }) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setName(initial?.name ?? ''); setDescription(initial?.description ?? ''); setError(''); }
  }, [open, initial?.name, initial?.description]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={initial ? 'Modifier l’espace' : 'Nouvel espace partagé'} description={initial ? undefined : 'Vous en serez le propriétaire et pourrez y inviter des collaborateurs.'}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setError('Le nom est requis.');
        setBusy(true);
        try { await onSubmit({ name: name.trim(), description: description.trim() }); onOpenChange(false); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>
        <Field label="Nom de l’espace" error={error} htmlFor="space-name"><Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder="Ex. : Projet Alpha" /></Field>
        <Field label="Description (facultative)" htmlFor="space-desc"><Input id="space-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button type="submit" loading={busy}>{initial ? 'Enregistrer' : 'Créer l’espace'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function SharedListPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api<{ shared: SharedSpace[] }>('/spaces') });
  const invitations = useQuery({ queryKey: ['invitations'], queryFn: () => api<{ invitations: Invitation[] }>('/invitations') });

  const answer = async (inv: Invitation, accept: boolean) => {
    try {
      await api(`/invitations/${inv.id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      toast.success(accept ? `Vous avez rejoint « ${inv.space.name} »` : 'Invitation refusée');
      await Promise.all([qc.invalidateQueries({ queryKey: ['spaces'] }), qc.invalidateQueries({ queryKey: ['invitations'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
      if (accept) navigate(`/partages/${inv.space.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <PageTitle title="Espaces partagés" subtitle="Des espaces de travail à plusieurs, sur invitation." />
        {me.user.canCreateSpaces && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Nouvel espace</Button>}
      </div>

      {(invitations.data?.invitations.length ?? 0) > 0 && (
        <div className="mb-6 space-y-2">
          {invitations.data!.invitations.map((inv) => (
            <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-petrol/30 bg-petrol-soft px-4 py-3">
              <Mail className="h-5 w-5 shrink-0 text-petrol" />
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium text-ink">{inv.invitedBy.firstName} {inv.invitedBy.lastName}</span> vous invite à rejoindre <span className="font-medium text-ink">« {inv.space.name} »</span> en tant que {ROLE_LABEL[inv.role]!.toLowerCase()}.
              </div>
              <Button size="sm" variant="secondary" onClick={() => answer(inv, false)}><X className="h-4 w-4" />Refuser</Button>
              <Button size="sm" onClick={() => answer(inv, true)}><Check className="h-4 w-4" />Accepter</Button>
            </div>
          ))}
        </div>
      )}

      {spaces.isLoading ? <PageLoader /> : spaces.error ? <ErrorNote message={errorMessage(spaces.error)} onRetry={() => spaces.refetch()} />
        : spaces.data!.shared.length === 0 ? (
          <Card><EmptyState icon={Users} title="Aucun espace partagé" text="Créez un espace pour collaborer sur un projet, ou attendez une invitation."
            action={me.user.canCreateSpaces ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Créer un espace</Button> : undefined} /></Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {spaces.data!.shared.map((s) => (
              <Link key={s.id} to={`/partages/${s.id}`} className="group rounded-xl border border-line bg-white p-5 transition-shadow hover:shadow-md">
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-petrol-soft text-petrol group-hover:bg-petrol group-hover:text-white"><Users className="h-5 w-5" /></div>
                  <Badge tone={s.role === 'OWNER' ? 'petrol' : 'neutral'}>{ROLE_LABEL[s.role]}</Badge>
                </div>
                <div className="truncate font-semibold text-ink">{s.name}</div>
                <div className="mt-0.5 line-clamp-2 min-h-5 text-sm text-muted">{s.description}</div>
                <div className="mt-3 text-xs text-muted">{s.memberCount} membre(s){s.owner ? ` · ${s.owner.firstName} ${s.owner.lastName}` : ''}</div>
              </Link>
            ))}
          </div>
        )}

      <SpaceFormDialog open={creating} onOpenChange={setCreating} onSubmit={async (data) => {
        const { id } = await api<{ id: string }>('/spaces', { method: 'POST', body: data });
        await qc.invalidateQueries({ queryKey: ['spaces'] });
        toast.success('Espace créé');
        navigate(`/partages/${id}`);
      }} />
    </div>
  );
}

interface SpaceDetail {
  space: { id: string; name: string; description: string; role: Role };
  members: (Person & { role: Role; since: string })[];
  invitations: { id: string; role: Role; createdAt: string; invitee: Person }[];
  usage: number;
}

export function SharedSpacePage() {
  const { spaceId, folderId } = useParams();
  const [managing, setManaging] = useState(false);
  return (
    <>
      <FileBrowser
        spaceId={spaceId!}
        folderId={folderId}
        basePath={`/partages/${spaceId}`}
        headerExtra={<Button variant="secondary" onClick={() => setManaging(true)}><Users className="h-4 w-4" /><span className="hidden sm:inline">Membres</span></Button>}
      />
      {managing && <MembersDialog spaceId={spaceId!} onClose={() => setManaging(false)} />}
    </>
  );
}

function MembersDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ['space', spaceId], queryFn: () => api<SpaceDetail>(`/spaces/${spaceId}`) });
  const [search, setSearch] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('EDITOR');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'leave' | null>(null);
  const directory = useQuery({
    queryKey: ['directory', search],
    queryFn: () => api<{ users: Person[] }>(`/directory?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['space', spaceId] }), qc.invalidateQueries({ queryKey: ['spaces'] }), qc.invalidateQueries({ queryKey: ['contents', spaceId] })]);
  const act = async (fn: () => Promise<unknown>, success: string) => {
    try { await fn(); toast.success(success); await refresh(); } catch (err) { toast.error(errorMessage(err)); throw err; }
  };

  const d = detail.data;
  const role = d?.space.role;
  const canManage = role === 'OWNER' || role === 'MANAGER';
  const memberIds = new Set(d?.members.map((m) => m.id));
  const invitedIds = new Set(d?.invitations.map((i) => i.invitee.id));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={d?.space.name ?? 'Espace'} description={d ? `${d.members.length} membre(s) · ${formatBytes(d.usage)} utilisés` : undefined} size="lg">
      {detail.isLoading ? <PageLoader /> : detail.error || !d ? <ErrorNote message={errorMessage(detail.error)} /> : (
        <div className="space-y-6">
          {canManage && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Inviter un collaborateur</h3>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <Input className="pl-9" placeholder="Nom ou e-mail…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher un collaborateur" />
                </div>
                <Select className="w-40" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Rôle">
                  <option value="READER">Lecteur</option>
                  <option value="EDITOR">Éditeur</option>
                  {role === 'OWNER' && <option value="MANAGER">Gestionnaire</option>}
                </Select>
              </div>
              {search.trim().length >= 2 && (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {directory.isLoading ? <li className="p-3 text-sm text-muted">Recherche…</li>
                    : (directory.data?.users.length ?? 0) === 0 ? <li className="p-3 text-sm text-muted">Aucun collaborateur trouvé.</li>
                    : directory.data!.users.map((u) => (
                      <li key={u.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="truncate font-medium text-ink">{u.firstName} {u.lastName}</div>
                          <div className="truncate text-[13px] text-muted">{u.email}</div>
                        </div>
                        {memberIds.has(u.id) ? <Badge>Déjà membre</Badge> : invitedIds.has(u.id) ? <Badge tone="warn">Invité</Badge>
                          : <Button size="sm" onClick={() => act(() => api(`/spaces/${spaceId}/invitations`, { method: 'POST', body: { userId: u.id, role: inviteRole } }), 'Invitation envoyée').catch(() => undefined)}><UserPlus className="h-4 w-4" />Inviter</Button>}
                      </li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-[13px] text-muted">Lecteur : consulter et télécharger. Éditeur : importer et modifier. Gestionnaire : gérer aussi les membres.</p>
            </section>
          )}

          {d.invitations.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Invitations en attente</h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {d.invitations.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{i.invitee.firstName} {i.invitee.lastName} <span className="text-muted">· {ROLE_LABEL[i.role]} · {formatRelative(i.createdAt)}</span></span>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api(`/spaces/${spaceId}/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation annulée').catch(() => undefined)}>Annuler</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Membres</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {d.members.map((m) => {
                const editable = canManage && m.role !== 'OWNER' && m.id !== me.user.id && (role === 'OWNER' || m.role !== 'MANAGER');
                return (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="truncate font-medium text-ink">{m.firstName} {m.lastName}{m.id === me.user.id && <span className="font-normal text-muted"> (vous)</span>}</div>
                      <div className="truncate text-[13px] text-muted">{m.email}</div>
                    </div>
                    {editable ? (
                      <>
                        <Select className="h-8 w-36 text-[13px]" value={m.role} aria-label={`Rôle de ${m.firstName} ${m.lastName}`}
                          onChange={(e) => act(() => api(`/spaces/${spaceId}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Rôle mis à jour').catch(() => undefined)}>
                          <option value="READER">Lecteur</option>
                          <option value="EDITOR">Éditeur</option>
                          {role === 'OWNER' && <option value="MANAGER">Gestionnaire</option>}
                        </Select>
                        <Button size="icon" variant="ghost" aria-label={`Retirer ${m.firstName} ${m.lastName}`} onClick={() => act(() => api(`/spaces/${spaceId}/members/${m.id}`, { method: 'DELETE' }), 'Membre retiré').catch(() => undefined)}><X className="h-4 w-4" /></Button>
                      </>
                    ) : <Badge tone={m.role === 'OWNER' ? 'petrol' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            {canManage && <Button variant="secondary" onClick={() => setEditing(true)}><Settings2 className="h-4 w-4" />Modifier l’espace</Button>}
            {role !== 'OWNER' && <Button variant="secondary" onClick={() => setConfirm('leave')}><LogOut className="h-4 w-4" />Quitter l’espace</Button>}
            {role === 'OWNER' && <Button variant="secondary" className="text-danger" onClick={() => setConfirm('archive')}><Archive className="h-4 w-4" />Archiver l’espace</Button>}
          </div>

          <SpaceFormDialog open={editing} onOpenChange={setEditing} initial={d.space} onSubmit={(data) => act(() => api(`/spaces/${spaceId}`, { method: 'PATCH', body: data }), 'Espace modifié')} />
          <ConfirmDialog
            open={!!confirm}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={confirm === 'archive' ? 'Archiver cet espace ?' : 'Quitter cet espace ?'}
            text={confirm === 'archive'
              ? 'L’espace et ses fichiers ne seront plus accessibles aux membres. Rien n’est supprimé : un administrateur pourra le restaurer.'
              : 'Vous n’aurez plus accès aux fichiers de cet espace. Les fichiers que vous y avez importés y resteront.'}
            confirmLabel={confirm === 'archive' ? 'Archiver' : 'Quitter'}
            danger
            onConfirm={async () => {
              await act(() => api(confirm === 'archive' ? `/spaces/${spaceId}` : `/spaces/${spaceId}/members/${me.user.id}`, { method: 'DELETE' }), confirm === 'archive' ? 'Espace archivé' : 'Vous avez quitté l’espace');
              navigate('/partages');
            }}
          />
        </div>
      )}
    </Dialog>
  );
}
