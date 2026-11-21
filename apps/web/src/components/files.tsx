import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight, Download, Eye, File as FileIcn, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo,
  Folder, FolderOpen, Home, Info, MoreVertical, Presentation, RotateCcw, Star, StarOff, Trash2, Upload,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { downloadFile, pickFiles, spacePath, useFileActions } from '@/lib/files';
import { actionLabel, cn, formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { FileItem } from '@/lib/types';
import { enqueueUploads } from '@/lib/uploads';
import { PreviewDialog } from './Preview';
import { ActionContext, ActionMenu, Badge, Button, ConfirmDialog, Dialog, DialogFooter, ErrorNote, Field, Input, PageLoader, type MenuAction } from './ui';

// ───────────────────────────── Icônes ─────────────────────────────

export function FileTypeIcon({ file, className }: { file: { name: string; category: string; mimeType: string }; className?: string }) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const [Icon, color] =
    file.category === 'image' ? [FileImage, 'text-violet-600']
    : file.category === 'video' ? [FileVideo, 'text-pink-600']
    : file.category === 'audio' ? [FileAudio, 'text-amber-600']
    : file.category === 'pdf' ? [FileText, 'text-red-600']
    : file.category === 'archive' ? [FileArchive, 'text-yellow-700']
    : ['xls', 'xlsx', 'ods', 'csv'].includes(ext) ? [FileSpreadsheet, 'text-emerald-600']
    : ['ppt', 'pptx', 'odp'].includes(ext) ? [Presentation, 'text-orange-600']
    : file.category === 'document' ? [FileText, 'text-sky-700']
    : [FileIcn, 'text-muted'];
  return <Icon className={cn('shrink-0', color, className)} aria-hidden />;
}

export function FolderIcon({ className }: { className?: string }) {
  return <Folder className={cn('shrink-0 fill-petrol/15 text-petrol', className)} aria-hidden />;
}

// ───────────────────────────── Nom (création / renommage) ─────────────────────────────

export function NameDialog({
  open, onOpenChange, title, label, initial = '', confirmLabel, lockedExtension, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Extension non modifiable (renommage d'un fichier). */
  lockedExtension?: string;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError('');
    }
  }, [open, initial]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = value.trim() + (lockedExtension ?? '');
    if (!value.trim()) return setError('Le nom est requis.');
    if (/[\\/:*?"<>|]/.test(name)) return setError('Caractères interdits : \\ / : * ? " < > |');
    setBusy(true);
    try {
      await onSubmit(name);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm">
      <form onSubmit={submit}>
        <Field label={label} error={error} htmlFor="name-input">
          <div className="flex items-center gap-2">
            <Input id="name-input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={190} aria-invalid={!!error} onFocus={(e) => e.target.select()} />
            {lockedExtension && <span className="text-sm text-muted">{lockedExtension}</span>}
          </div>
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button type="submit" loading={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── Détails, versions, historique ─────────────────────────────

interface FileDetail {
  file: FileItem & { canEdit: boolean };
  space: { id: string; type: 'COMPANY' | 'SHARED' | 'PERSONAL'; name: string };
  breadcrumbs: { id: string; name: string }[];
  versions: { id: string; number: number; size: number; createdAt: string; uploadedBy: string; current: boolean; sha256: string | null }[];
}

export function DetailsDialog({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const { run } = useFileActions();
  const [tab, setTab] = useState<'versions' | 'history'>('versions');
  const detail = useQuery({ queryKey: ['file', fileId], queryFn: () => api<FileDetail>(`/files/${fileId}`), enabled: !!fileId });
  const history = useQuery({
    queryKey: ['file', fileId, 'history'],
    queryFn: () => api<{ events: { id: string; createdAt: string; action: string; actorLabel: string; metadata: any }[] }>(`/files/${fileId}/history`),
    enabled: !!fileId && tab === 'history',
  });
  if (!fileId) return null;
  const d = detail.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={d?.file.name ?? 'Détails'} size="lg">
      {detail.isLoading ? <PageLoader /> : detail.error || !d ? <ErrorNote message={errorMessage(detail.error)} /> : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div><dt className="text-muted">Taille</dt><dd className="font-medium">{formatBytes(d.file.size)}</dd></div>
            <div><dt className="text-muted">Importé par</dt><dd className="font-medium">{d.file.uploader?.name ?? '—'}</dd></div>
            <div><dt className="text-muted">Modifié</dt><dd className="font-medium">{formatDateTime(d.file.updatedAt)}</dd></div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-muted">Emplacement</dt>
              <dd className="font-medium">{[d.space.name, ...d.breadcrumbs.map((b) => b.name)].join(' › ')}</dd>
            </div>
          </dl>

          <div className="mt-5 flex items-center justify-between border-b border-line">
            <div className="flex gap-1" role="tablist">
              {(['versions', 'history'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-petrol text-petrol' : 'border-transparent text-muted hover:text-ink')}>
                  {t === 'versions' ? `Versions (${d.versions.length})` : 'Historique'}
                </button>
              ))}
            </div>
            {d.file.canEdit && tab === 'versions' && (
              <Button size="sm" variant="secondary" className="mb-1.5"
                onClick={() => pickFiles(false, (files) => { enqueueUploads(files, { spaceId: d.file.spaceId, folderId: d.file.folderId, fileId: d.file.id }); toast.info('Import de la nouvelle version en cours…'); onClose(); })}>
                <Upload className="h-4 w-4" />Nouvelle version
              </Button>
            )}
          </div>

          {tab === 'versions' ? (
            <ul className="divide-y divide-line">
              {d.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">Version {v.number}{v.current && <Badge tone="petrol">Actuelle</Badge>}</div>
                    <div className="truncate text-[13px] text-muted">{v.uploadedBy} · {formatDateTime(v.createdAt)} · {formatBytes(v.size)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => downloadFile(d.file.id, v.id)} aria-label={`Télécharger la version ${v.number}`}><Download className="h-4 w-4" /></Button>
                  {!v.current && d.file.canEdit && (
                    <Button size="sm" variant="secondary" onClick={() => run(() => api(`/files/${d.file.id}/versions/${v.id}/restore`, { method: 'POST' }), `Version ${v.number} rétablie`).catch(() => undefined)}>
                      <RotateCcw className="h-4 w-4" />Rétablir
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : history.isLoading ? <PageLoader /> : (
            <ul className="divide-y divide-line">
              {(history.data?.events ?? []).map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
                  <span><span className="font-medium">{actionLabel(e.action)}</span>{e.metadata?.version ? ` (v${e.metadata.version})` : ''}{e.metadata?.from && e.action === 'file.rename' ? ` — ancien nom : ${e.metadata.from}` : ''}<span className="text-muted"> · {e.actorLabel}</span></span>
                  <time className="shrink-0 text-[13px] text-muted">{formatDateTime(e.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}

// ───────────────────────────── Liste transversale (favoris, récents, recherche) ─────────────────────────────

export function FileTable({ files, dateLabel = 'Modifié', dateOf }: { files: FileItem[]; dateLabel?: string; dateOf?: (f: FileItem) => string }) {
  const actions = useFileActions();
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [toTrash, setToTrash] = useState<FileItem | null>(null);

  const menu = (file: FileItem): MenuAction[] => [
    { label: 'Aperçu', icon: Eye, onSelect: () => setPreview(file) },
    { label: 'Télécharger', icon: Download, onSelect: () => downloadFile(file.id) },
    { label: file.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: file.isFavorite ? StarOff : Star, onSelect: () => actions.toggleFavorite(file) },
    { label: 'Détails et versions', icon: Info, onSelect: () => setDetails(file.id) },
    { label: 'Supprimer', icon: Trash2, danger: true, separatorBefore: true, hidden: !file.canDelete, onSelect: () => setToTrash(file) },
  ];

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Nom</th>
              <th className="hidden px-4 py-2.5 font-medium md:table-cell">Emplacement</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">{dateLabel}</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Taille</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {files.map((file) => (
              <ActionContext key={file.id} actions={menu(file)}>
                <tr className="group hover:bg-surface/60">
                  <td className="max-w-0 px-4 py-2.5">
                    <button className="flex w-full items-center gap-3 text-left" onClick={() => setPreview(file)}>
                      <FileTypeIcon file={file} className="h-5 w-5" />
                      <span className="truncate font-medium text-ink group-hover:text-petrol">{file.name}</span>
                      {file.isFavorite && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favori" />}
                    </button>
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    <Link to={spacePath(file.spaceType, file.spaceId, file.folderId)} className="inline-flex max-w-56 items-center gap-1.5 truncate text-muted hover:text-petrol">
                      <FolderOpen className="h-4 w-4 shrink-0" />
                      <span className="truncate">{file.spaceName}{file.folderName ? ` › ${file.folderName}` : ''}</span>
                    </Link>
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 text-muted sm:table-cell">{formatRelative(dateOf ? dateOf(file) : file.updatedAt)}</td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 text-right text-muted sm:table-cell">{formatBytes(file.size)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <ActionMenu actions={menu(file)}>
                      <Button variant="ghost" size="icon" aria-label={`Actions pour ${file.name}`}><MoreVertical className="h-4 w-4" /></Button>
                    </ActionMenu>
                  </td>
                </tr>
              </ActionContext>
            ))}
          </tbody>
        </table>
      </div>
      <PreviewDialog file={preview} onClose={() => setPreview(null)} />
      <DetailsDialog fileId={details} onClose={() => setDetails(null)} />
      <ConfirmDialog
        open={!!toTrash}
        onOpenChange={(o) => !o && setToTrash(null)}
        title="Supprimer ce fichier ?"
        text={<>« {toTrash?.name} » sera placé dans la corbeille. Vous pourrez le restaurer.</>}
        confirmLabel="Supprimer"
        danger
        onConfirm={() => actions.trash(toTrash!)}
      />
    </>
  );
}

export function Breadcrumbs({ root, rootTo, items }: { root: string; rootTo: string; items: { id: string; name: string; to: string }[] }) {
  return (
    <nav aria-label="Fil d’Ariane" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      {items.length === 0 ? (
        <h1 className="truncate text-xl font-semibold text-ink">{root}</h1>
      ) : (
        <Link to={rootTo} className="rounded px-1 text-muted hover:text-petrol">{root}</Link>
      )}
      {items.map((item, i) => (
        <span key={item.id} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="h-4 w-4 shrink-0 text-muted/60" aria-hidden />
          {i === items.length - 1 ? <h1 className="truncate text-xl font-semibold text-ink">{item.name}</h1> : <Link to={item.to} className="truncate rounded px-1 text-muted hover:text-petrol">{item.name}</Link>}
        </span>
      ))}
    </nav>
  );
}

