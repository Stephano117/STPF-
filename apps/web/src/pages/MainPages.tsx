import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Clock, FolderLock, RotateCcw, Search, Star, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { FileBrowser } from '@/components/FileBrowser';
import { FileTable, FileTypeIcon, FolderIcon } from '@/components/files';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, Input, PageLoader, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { spacePath, useFileActions } from '@/lib/files';
import { formatBytes, formatRelative } from '@/lib/format';
import { passwordProblem, stretchPassword } from '@/lib/password';
import type { FileItem, SpaceType } from '@/lib/types';

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

// ───────────────────────────── Accueil ─────────────────────────────

export function HomePage() {
  const { me } = useAuth();
  const recents = useQuery({ queryKey: ['recents'], queryFn: () => api<{ files: FileItem[] }>('/recents') });
  const shortcuts = [
    { to: '/entreprise', icon: Building2, title: 'Espace entreprise', text: 'Les documents communs à tous les collaborateurs' },
    { to: '/partages', icon: Users, title: 'Espaces partagés', text: me.pendingInvitations > 0 ? `${me.pendingInvitations} invitation(s) en attente` : 'Travaillez à plusieurs sur un projet' },
    { to: '/mon-espace', icon: FolderLock, title: 'Mon espace', text: 'Vos fichiers privés, visibles de vous seul' },
  ];
  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title={`Bonjour ${me.user.firstName}`} subtitle="Où souhaitez-vous aller ?" />
      <div className="grid gap-4 sm:grid-cols-3">
        {shortcuts.map((s) => (
          <Link key={s.to} to={s.to} className="group rounded-xl border border-line bg-white p-5 transition-shadow hover:shadow-md">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-petrol-soft text-petrol group-hover:bg-petrol group-hover:text-white"><s.icon className="h-5 w-5" /></div>
            <div className="font-semibold text-ink">{s.title}</div>
            <div className="mt-0.5 text-sm text-muted">{s.text}</div>
          </Link>
        ))}
      </div>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">Consultés récemment</h2>
        <Link to="/recents" className="text-sm font-medium text-petrol hover:underline">Tout voir</Link>
      </div>
      {recents.isLoading ? <PageLoader />
        : recents.error ? <ErrorNote message={errorMessage(recents.error)} onRetry={() => recents.refetch()} />
        : recents.data!.files.length === 0 ? <Card><EmptyState icon={Clock} title="Rien pour l’instant" text="Les fichiers que vous ouvrez ou téléchargez apparaîtront ici." /></Card>
        : <FileTable files={recents.data!.files.slice(0, 8)} dateLabel="Consulté" dateOf={(f) => f.accessedAt ?? f.updatedAt} />}
    </div>
  );
}

// ───────────────────────────── Espaces entreprise et personnel ─────────────────────────────

export function CompanyPage() {
  const { folderId } = useParams();
  return <FileBrowser spaceId="company" folderId={folderId} basePath="/entreprise" rootLabel="Espace entreprise" />;
}

export function PersonalPage() {
  const { me } = useAuth();
  const { folderId } = useParams();
  if (!me.personalSpaceId) return <ErrorNote message="Votre espace personnel n’est pas encore disponible. Rechargez la page." />;
  return <FileBrowser spaceId={me.personalSpaceId} folderId={folderId} basePath="/mon-espace" rootLabel="Mon espace" />;
}

// ───────────────────────────── Listes ─────────────────────────────

export function FavoritesPage() {
  const q = useQuery({ queryKey: ['favorites'], queryFn: () => api<{ files: FileItem[] }>('/favorites') });
  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title="Favoris" />
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : q.data!.files.length === 0 ? <Card><EmptyState icon={Star} title="Aucun favori" text="Ajoutez un fichier à vos favoris depuis son menu pour le retrouver ici." /></Card>
        : <FileTable files={q.data!.files} />}
    </div>
  );
}

export function RecentsPage() {
  const q = useQuery({ queryKey: ['recents'], queryFn: () => api<{ files: FileItem[] }>('/recents') });
  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title="Récents" subtitle="Les fichiers que vous avez consultés ou téléchargés." />
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : q.data!.files.length === 0 ? <Card><EmptyState icon={Clock} title="Rien pour l’instant" /></Card>
        : <FileTable files={q.data!.files} dateLabel="Consulté" dateOf={(f) => f.accessedAt ?? f.updatedAt} />}
    </div>
  );
}

// ───────────────────────────── Corbeille ─────────────────────────────

interface TrashData {
  retentionDays: number;
  folders: { id: string; name: string; deletedAt: string; spaceName: string }[];
  files: FileItem[];
}

export function TrashPage() {
  const q = useQuery({ queryKey: ['trash'], queryFn: () => api<TrashData>('/trash') });
  const { run } = useFileActions();
  const [purge, setPurge] = useState<FileItem | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [space, setSpace] = useState('');
  const [since, setSince] = useState('');
  const empty = q.data && q.data.files.length === 0 && q.data.folders.length === 0;

  // Filtrage instantané, côté navigateur : la corbeille est déjà chargée en entier.
  const needle = search.trim().toLowerCase();
  const recent = (iso: string | null) => !since || (!!iso && Date.now() - new Date(iso).getTime() <= Number(since) * 86_400_000);
  const folders = (q.data?.folders ?? []).filter(
    (f) => (!category || category === 'folder') && (!space || f.spaceName === space) && (!needle || f.name.toLowerCase().includes(needle)) && recent(f.deletedAt),
  );
  const files = (q.data?.files ?? []).filter(
    (f) => (!category || f.category === category) && (!space || f.spaceName === space) && (!needle || f.name.toLowerCase().includes(needle)) && recent(f.deletedAt),
  );
  const spaceNames = [...new Set([...(q.data?.folders ?? []).map((f) => f.spaceName), ...(q.data?.files ?? []).map((f) => f.spaceName ?? '')])].filter(Boolean).sort();
  const filtering = !!(needle || category || space || since);

  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title="Corbeille" subtitle={q.data ? `Les éléments sont supprimés définitivement après ${q.data.retentionDays} jours.` : undefined} />
      {q.data && !empty && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input type="search" className="pl-9" placeholder="Rechercher dans la corbeille…" aria-label="Rechercher dans la corbeille" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select aria-label="Type" className="w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Tous les types</option>
            <option value="folder">Dossiers</option>
            <option value="document">Documents</option>
            <option value="pdf">PDF</option>
            <option value="image">Images</option>
            <option value="video">Vidéos</option>
            <option value="audio">Audio</option>
            <option value="archive">Archives</option>
            <option value="other">Autres</option>
          </Select>
          <Select aria-label="Espace d’origine" className="w-auto" value={space} onChange={(e) => setSpace(e.target.value)}>
            <option value="">Tous les espaces</option>
            {spaceNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
          <Select aria-label="Date de suppression" className="w-auto" value={since} onChange={(e) => setSince(e.target.value)}>
            <option value="">Toutes les dates</option>
            <option value="1">Supprimés aujourd’hui</option>
            <option value="7">7 derniers jours</option>
            <option value="30">30 derniers jours</option>
          </Select>
          {filtering && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setCategory(''); setSpace(''); setSince(''); }}>Effacer les filtres</Button>}
          {filtering && <span className="text-[13px] text-muted">{folders.length + files.length} élément(s)</span>}
        </div>
      )}
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : empty ? <Card><EmptyState icon={Trash2} title="La corbeille est vide" /></Card>
        : folders.length + files.length === 0 ? <Card><EmptyState icon={Search} title="Aucun élément ne correspond" text="Modifiez la recherche ou les filtres." /></Card>
        : (
          <Card className="divide-y divide-line overflow-hidden">
            {folders.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                <FolderIcon className="h-5 w-5" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{f.name}</div>
                  <div className="text-[13px] text-muted">Dossier · {f.spaceName} · supprimé {formatRelative(f.deletedAt)}</div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => run(() => api(`/folders/${f.id}/restore`, { method: 'POST' }), 'Dossier restauré').catch(() => undefined)}><RotateCcw className="h-4 w-4" />Restaurer</Button>
              </div>
            ))}
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                <FileTypeIcon file={f} className="h-5 w-5" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{f.name}</div>
                  <div className="text-[13px] text-muted">{formatBytes(f.size)} · {f.spaceName} · supprimé {formatRelative(f.deletedAt!)}</div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => run(() => api(`/files/${f.id}/restore`, { method: 'POST' }), 'Fichier restauré').catch(() => undefined)}><RotateCcw className="h-4 w-4" />Restaurer</Button>
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPurge(f)} aria-label={`Supprimer définitivement ${f.name}`}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </Card>
        )}
      <ConfirmDialog
        open={!!purge}
        onOpenChange={(o) => !o && setPurge(null)}
        title="Supprimer définitivement ?"
        text={<>« {purge?.name} » et toutes ses versions seront effacés. <strong>Cette action est irréversible.</strong></>}
        confirmLabel="Supprimer définitivement"
        danger
        onConfirm={() => run(() => api(`/files/${purge!.id}/permanent`, { method: 'DELETE' }), 'Fichier supprimé définitivement')}
      />
    </div>
  );
}

// ───────────────────────────── Recherche ─────────────────────────────

interface SearchData {
  files: FileItem[];
  folders: { id: string; name: string; spaceId: string; spaceName: string; spaceType: SpaceType }[];
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const since = params.get('since') ?? '';
  const mine = params.get('mine') ?? '0';
  const search = useQuery({
    queryKey: ['search', q, category, since, mine],
    queryFn: () => api<SearchData>(`/search?${new URLSearchParams({ q, category, since, mine })}`),
    enabled: !!(q || category || since || mine === '1'),
  });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== '0') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const total = (search.data?.files.length ?? 0) + (search.data?.folders.length ?? 0);
  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title={q ? `Résultats pour « ${q} »` : 'Recherche'} subtitle={search.data ? `${total} élément(s) trouvé(s)` : undefined} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Type de fichier" className="w-auto" value={category} onChange={(e) => set('category', e.target.value)}>
          <option value="">Tous les types</option>
          <option value="document">Documents</option>
          <option value="pdf">PDF</option>
          <option value="image">Images</option>
          <option value="video">Vidéos</option>
          <option value="audio">Audio</option>
          <option value="archive">Archives</option>
          <option value="other">Autres</option>
        </Select>
        <Select aria-label="Date de modification" className="w-auto" value={since} onChange={(e) => set('since', e.target.value)}>
          <option value="">Toutes les dates</option>
          <option value="7">7 derniers jours</option>
          <option value="30">30 derniers jours</option>
          <option value="365">12 derniers mois</option>
        </Select>
        <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm">
          <input type="checkbox" className="accent-petrol" checked={mine === '1'} onChange={(e) => set('mine', e.target.checked ? '1' : '0')} />
          Importés par moi
        </label>
      </div>
      {!search.isEnabled ? <Card><EmptyState icon={Search} title="Que cherchez-vous ?" text="Saisissez un nom de fichier ou de dossier dans la barre de recherche." /></Card>
        : search.isLoading ? <PageLoader />
        : search.error ? <ErrorNote message={errorMessage(search.error)} onRetry={() => search.refetch()} />
        : total === 0 ? <Card><EmptyState icon={Search} title="Aucun résultat" text="Vérifiez l’orthographe ou élargissez les filtres." /></Card>
        : (
          <div className="space-y-4">
            {search.data!.folders.length > 0 && (
              <Card className="divide-y divide-line overflow-hidden">
                {search.data!.folders.map((f) => (
                  <Link key={f.id} to={spacePath(f.spaceType, f.spaceId, f.id)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface/60">
                    <FolderIcon className="h-5 w-5" />
                    <span className="truncate text-sm font-medium text-ink">{f.name}</span>
                    <Badge>{f.spaceName}</Badge>
                  </Link>
                ))}
              </Card>
            )}
            {search.data!.files.length > 0 && <FileTable files={search.data!.files} />}
          </div>
        )}
    </div>
  );
}

// ───────────────────────────── Profil ─────────────────────────────

const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'Prénom requis.').max(80),
  lastName: z.string().trim().min(1, 'Nom requis.').max(80),
});
const passwordSchema = z
  .object({
    current: z.string().min(1, 'Mot de passe actuel requis.'),
    next: z.string().refine((p) => passwordProblem(p) === null, { error: (iss) => passwordProblem(String(iss.input)) ?? '' }),
    confirm: z.string(),
  })
  .refine((d) => d.next === d.confirm, { path: ['confirm'], error: 'Les mots de passe ne correspondent pas.' });

export function ProfilePage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const profile = useForm({ resolver: zodResolver(profileSchema), defaultValues: { firstName: me.user.firstName, lastName: me.user.lastName } });
  const password = useForm({ resolver: zodResolver(passwordSchema) });

  const saveProfile = profile.handleSubmit(async (data) => {
    try {
      await api('/auth/profile', { method: 'PATCH', body: data });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Profil mis à jour');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });
  const savePassword = password.handleSubmit(async (data) => {
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { currentAuthKey: await stretchPassword(me.user.email, data.current), newAuthKey: await stretchPassword(me.user.email, data.next) },
      });
      password.reset({ current: '', next: '', confirm: '' });
      toast.success('Mot de passe modifié. Vos autres appareils ont été déconnectés.');
    } catch (err) {
      password.setError('current', { message: errorMessage(err) });
    }
  });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageTitle title="Profil" />
      <Card className="p-5">
        <h2 className="mb-4 font-semibold text-ink">Informations</h2>
        <form onSubmit={saveProfile} className="space-y-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prénom" error={profile.formState.errors.firstName?.message} htmlFor="p-first"><Input id="p-first" {...profile.register('firstName')} /></Field>
            <Field label="Nom" error={profile.formState.errors.lastName?.message} htmlFor="p-last"><Input id="p-last" {...profile.register('lastName')} /></Field>
          </div>
          <Field label="E-mail" htmlFor="p-email"><Input id="p-email" value={me.user.email} disabled readOnly /></Field>
          <div className="flex justify-end"><Button type="submit" loading={profile.formState.isSubmitting}>Enregistrer</Button></div>
        </form>
      </Card>
      <Card className="p-5">
        <h2 className="mb-4 font-semibold text-ink">Mot de passe</h2>
        <form onSubmit={savePassword} className="space-y-4" noValidate>
          <Field label="Mot de passe actuel" error={password.formState.errors.current?.message} htmlFor="pw-current"><Input id="pw-current" type="password" autoComplete="current-password" {...password.register('current')} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nouveau mot de passe" error={password.formState.errors.next?.message} hint="12 caractères minimum." htmlFor="pw-next"><Input id="pw-next" type="password" autoComplete="new-password" {...password.register('next')} /></Field>
            <Field label="Confirmer" error={password.formState.errors.confirm?.message} htmlFor="pw-confirm"><Input id="pw-confirm" type="password" autoComplete="new-password" {...password.register('confirm')} /></Field>
          </div>
          <div className="flex justify-end"><Button type="submit" loading={password.formState.isSubmitting}>Changer le mot de passe</Button></div>
        </form>
      </Card>
    </div>
  );
}
