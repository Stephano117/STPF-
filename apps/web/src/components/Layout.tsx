import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, Building2, CheckCircle2, ChevronDown, Clock, FolderLock, Home, Loader2, LogOut, Menu, RotateCw, Search, Settings, Star, Trash2, User, Users, X, XCircle } from 'lucide-react';
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, reportClientError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRefreshFiles } from '@/lib/files';
import { cn, formatBytes } from '@/lib/format';
import { cancelUpload, clearFinishedUploads, onUploadDone, retryUpload, useUploads } from '@/lib/uploads';
import { ActionMenu, Button, ProgressBar } from './ui';

const NAV = [
  { to: '/', label: 'Accueil', icon: Home, end: true },
  { to: '/entreprise', label: 'Espace entreprise', icon: Building2 },
  { to: '/partages', label: 'Espaces partagés', icon: Users },
  { to: '/mon-espace', label: 'Mon espace', icon: FolderLock },
  { to: '/favoris', label: 'Favoris', icon: Star },
  { to: '/recents', label: 'Récents', icon: Clock },
  { to: '/corbeille', label: 'Corbeille', icon: Trash2 },
];

export function Logo({ light, large }: { light?: boolean; large?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <span className={cn('flex shrink-0 items-center justify-center rounded-xl bg-white', large ? 'h-24 w-24 p-2' : 'h-14 w-14 p-1', !light && 'border border-line')}>
        <img src="/logo.png" alt="" className="h-full w-full object-contain" />
      </span>
      <span className={cn('font-bold tracking-wide', large ? 'text-3xl' : 'text-xl', light ? 'text-white' : 'text-ink')}>SPTF</span>
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = useAuth();
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<{ personal: { used: number; quota: number } }>('/auth/usage'), staleTime: 30_000 });
  const ratio = usage.data && usage.data.personal.quota > 0 ? usage.data.personal.used / usage.data.personal.quota : 0;
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors', isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white');
  return (
    <div className="flex h-full w-64 flex-col bg-deep">
      <Link to="/" className="px-5 py-5" onClick={onNavigate}><Logo light /></Link>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label="Navigation principale">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={link} onClick={onNavigate}>
            <item.icon className="h-[18px] w-[18px]" aria-hidden />{item.label}
          </NavLink>
        ))}
        {me.user.role === 'ADMIN' && (
          <>
            <div className="my-3 border-t border-white/10" />
            <NavLink to="/admin" className={link} onClick={onNavigate}><Settings className="h-[18px] w-[18px]" aria-hidden />Administration</NavLink>
          </>
        )}
      </nav>
      {usage.data && (
        <div className="m-3 rounded-xl bg-white/10 p-3.5 text-white">
          <div className="mb-2 flex justify-between text-xs"><span className="text-white/70">Mon espace</span><span>{Math.round(ratio * 100)} %</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/20"><div className={cn('h-full rounded-full', ratio >= 0.9 ? 'bg-red-300' : 'bg-white')} style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
          <p className="mt-2 text-xs text-white/70">{formatBytes(usage.data.personal.used)} sur {formatBytes(usage.data.personal.quota)}</p>
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [value, setValue] = useState(location.pathname === '/recherche' ? (params.get('q') ?? '') : '');
  useEffect(() => { if (location.pathname !== '/recherche') setValue(''); }, [location.pathname]);
  return (
    <form role="search" className="relative w-full max-w-xl" onSubmit={(e) => { e.preventDefault(); if (value.trim()) navigate(`/recherche?q=${encodeURIComponent(value.trim())}`); }}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Rechercher un fichier ou un dossier…"
        aria-label="Rechercher"
        className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm placeholder:text-muted/80 focus:border-petrol focus:bg-white focus:outline-none focus:ring-2 focus:ring-petrol/20"
      />
    </form>
  );
}

/** Panneau discret de suivi des imports (bas de l'écran). */
function UploadPanel() {
  const tasks = useUploads();
  const refresh = useRefreshFiles();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => onUploadDone(() => void refresh()), [refresh]);
  if (tasks.length === 0) return null;
  const active = tasks.filter((t) => ['queued', 'uploading', 'finalizing'].includes(t.status)).length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  return (
    <div className="fixed bottom-4 right-4 z-30 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-white shadow-xl" role="region" aria-label="Imports">
      <div className="flex items-center justify-between bg-deep px-4 py-2.5 text-white">
        <button className="flex flex-1 items-center gap-2 text-left text-sm font-medium" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {active > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : failed > 0 ? <AlertTriangle className="h-4 w-4 text-amber-300" /> : <CheckCircle2 className="h-4 w-4 text-emerald-300" />}
          {active > 0 ? `${active} import(s) en cours` : failed > 0 ? `${failed} import(s) à reprendre` : 'Imports terminés'}
          <ChevronDown className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
        </button>
        {active === 0 && <button onClick={clearFinishedUploads} aria-label="Fermer" className="rounded p-1 hover:bg-white/15"><X className="h-4 w-4" /></button>}
      </div>
      {!collapsed && (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto">
          {tasks.map((t) => (
            <li key={t.id} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink" title={t.name}>{t.name}</span>
                {t.status === 'done' && <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-label="Terminé" />}
                {t.status === 'canceled' && <span className="text-xs text-muted">Annulé</span>}
                {t.status === 'error' && <button onClick={() => retryUpload(t.id)} className="flex shrink-0 items-center gap-1 text-xs font-medium text-petrol hover:underline"><RotateCw className="h-3.5 w-3.5" />{t.resumable ? 'Reprendre' : 'Réessayer'}</button>}
                {['queued', 'uploading', 'finalizing', 'error'].includes(t.status) && <button onClick={() => cancelUpload(t.id)} aria-label={`Annuler ${t.name}`} className="shrink-0 rounded p-0.5 text-muted hover:text-danger"><XCircle className="h-4 w-4" /></button>}
              </div>
              {['queued', 'uploading', 'finalizing'].includes(t.status) && (
                <div className="mt-1.5 flex items-center gap-2">
                  <ProgressBar value={t.progress} />
                  <span className="w-20 shrink-0 text-right text-xs text-muted">{t.status === 'queued' ? 'En attente' : t.status === 'finalizing' ? 'Vérification' : `${Math.round(t.progress * 100)} %`}</span>
                </div>
              )}
              {t.status === 'error' && <p className="mt-1 text-xs text-danger">{t.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AppLayout() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [location.pathname]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    navigate('/connexion', { replace: true });
  };

  return (
    <div className="flex h-full">
      <aside className="hidden lg:block"><Sidebar /></aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="anim-overlay absolute inset-0 bg-deep/50" onClick={() => setDrawer(false)} />
          <div className="relative h-full w-64"><Sidebar onNavigate={() => setDrawer(false)} /></div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-white px-4 lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Ouvrir le menu"><Menu className="h-5 w-5" /></Button>
          <SearchBox />
          <div className="ml-auto flex items-center gap-1">
            <Link to="/partages" className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink hover:bg-black/5" aria-label={me.pendingInvitations > 0 ? `${me.pendingInvitations} invitation(s) en attente` : 'Invitations'} title="Invitations">
              <Bell className="h-[18px] w-[18px]" />
              {me.pendingInvitations > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">{me.pendingInvitations}</span>}
            </Link>
            <ActionMenu
              actions={[
                { label: 'Profil', icon: User, onSelect: () => navigate('/profil') },
                { label: 'Administration', icon: Settings, hidden: me.user.role !== 'ADMIN', onSelect: () => navigate('/admin') },
                { label: 'Se déconnecter', icon: LogOut, separatorBefore: true, onSelect: logout },
              ]}
            >
              <button className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-black/5" aria-label="Menu du compte">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-petrol text-xs font-semibold text-white">{(me.user.firstName[0] ?? '') + (me.user.lastName[0] ?? '')}</span>
                <span className="hidden text-sm font-medium text-ink sm:block">{me.user.firstName}</span>
                <ChevronDown className="hidden h-4 w-4 text-muted sm:block" />
              </button>
            </ActionMenu>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
          <ErrorBoundary key={location.pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>
      <UploadPanel />
    </div>
  );
}

/** Empêche une erreur d'affichage de faire disparaître toute l'application. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(Object.assign(error, { stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` }));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-soft text-danger"><AlertTriangle className="h-7 w-7" /></div>
        <h2 className="text-lg font-semibold text-ink">Cette page a rencontré un problème</h2>
        <p className="mt-1 text-sm text-muted">Vos fichiers ne sont pas affectés. L’incident a été signalé à l’administrateur.</p>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>Réessayer</Button>
          <Button onClick={() => location.assign('/')}>Retour à l’accueil</Button>
        </div>
      </div>
    );
  }
}
