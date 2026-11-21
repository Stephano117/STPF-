import { useQuery } from '@tanstack/react-query';
import { Copy, Download, Eye, FolderInput, FolderPlus, Info, LayoutGrid, List, Lock, MoreVertical, Pencil, ShieldCheck, Star, StarOff, Trash2, Upload, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { downloadFile, pickFiles, useFileActions } from '@/lib/files';
import { cn, formatBytes, formatRelative } from '@/lib/format';
import type { Contents, FileItem, FolderItem } from '@/lib/types';
import { enqueueUploads } from '@/lib/uploads';
import { Breadcrumbs, DetailsDialog, FileTypeIcon, FolderIcon, NameDialog } from './files';
import { PreviewDialog } from './Preview';
import { TransferDialog } from './TransferDialog';
import { ActionContext, ActionMenu, Badge, Button, ConfirmDialog, Dialog, DialogFooter, EmptyState, ErrorNote, PageLoader, type MenuAction } from './ui';

type View = 'list' | 'grid';
const VIEW_KEY = 'stf.view';

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  return [view, (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* stockage local indisponible */ } }];
}

/** Explorateur d'un espace : navigation, import (bouton et glisser-déposer), actions sur les éléments. */
export function FileBrowser({ spaceId, folderId, basePath, rootLabel, headerExtra }: { spaceId: string; folderId?: string; basePath: string; rootLabel?: string; headerExtra?: ReactNode }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const actions = useFileActions();
  const [view, setView] = useView();
  const contents = useQuery({
    queryKey: ['contents', spaceId, folderId ?? null],
    queryFn: () => api<Contents>(`/spaces/${spaceId}/contents${folderId ? `?folderId=${folderId}` : ''}`),
  });

  const [preview, setPreview] = useState<FileItem | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [rename, setRename] = useState<{ kind: 'file'; item: FileItem } | { kind: 'folder'; item: FolderItem } | null>(null);
  const [transfer, setTransfer] = useState<(({ kind: 'file'; item: FileItem } | { kind: 'folder'; item: FolderItem }) & { mode: 'move' | 'copy' }) | null>(null);
  const [toTrash, setToTrash] = useState<{ kind: 'file'; item: FileItem } | { kind: 'folder'; item: FolderItem } | null>(null);
  const [policy, setPolicy] = useState<FolderItem | null>(null);

  const data = contents.data;
  const canWrite = data?.canWrite ?? false;
  const isAdminInCompany = me.user.role === 'ADMIN' && data?.space.type === 'COMPANY';
  const maxSize = me.limits.maxFileSizeBytes;

  const startUpload = useCallback(
    (files: File[]) => {
      const accepted = files.filter((f) => f.size > 0 && f.size <= maxSize);
      const rejected = files.length - accepted.length;
      if (rejected > 0) toast.error(`${rejected} fichier(s) ignoré(s) : vide ou supérieur à ${formatBytes(maxSize)}.`);
      if (accepted.length > 0) enqueueUploads(accepted, { spaceId, folderId: folderId ?? null });
    },
    [spaceId, folderId, maxSize],
  );

  // Glisser-déposer sur toute la zone.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => { dragDepth.current = 0; setDragging(false); }, [spaceId, folderId]);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); },
    onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
    onDragLeave: (e: React.DragEvent) => { if (!hasFiles(e)) return; if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!canWrite) return void toast.error('Vous ne pouvez pas importer de fichiers à cet emplacement.');
      // Les dossiers déposés n'ont pas de type et une taille nulle : ils sont écartés.
      startUpload([...e.dataTransfer.files].filter((f) => f.type !== '' || f.size > 0));
    },
  };

  if (contents.isLoading) return <PageLoader />;
  if (contents.error || !data) return <ErrorNote message={errorMessage(contents.error)} onRetry={() => contents.refetch()} />;

  const folderPath = (id: string) => `${basePath}/${id}`;
  const fileMenu = (file: FileItem): MenuAction[] => [
    { label: 'Aperçu', icon: Eye, onSelect: () => setPreview(file) },
    { label: 'Télécharger', icon: Download, onSelect: () => downloadFile(file.id) },
    { label: file.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: file.isFavorite ? StarOff : Star, onSelect: () => actions.toggleFavorite(file) },
    { label: 'Renommer', icon: Pencil, separatorBefore: true, hidden: !canWrite, onSelect: () => setRename({ kind: 'file', item: file }) },
    { label: 'Déplacer', icon: FolderInput, hidden: !canWrite && !file.canDelete, onSelect: () => setTransfer({ kind: 'file', item: file, mode: 'move' }) },
    { label: 'Copier vers…', icon: Copy, onSelect: () => setTransfer({ kind: 'file', item: file, mode: 'copy' }) },
    { label: 'Nouvelle version', icon: Upload, hidden: !canWrite, onSelect: () => pickFiles(false, (files) => enqueueUploads(files, { spaceId, folderId: file.folderId, fileId: file.id })) },
    { label: 'Détails et versions', icon: Info, onSelect: () => setDetails(file.id) },
    { label: 'Supprimer', icon: Trash2, danger: true, separatorBefore: true, hidden: !file.canDelete, onSelect: () => setToTrash({ kind: 'file', item: file }) },
  ];
  const folderMenu = (folder: FolderItem): MenuAction[] => [
    { label: 'Ouvrir', icon: Eye, onSelect: () => navigate(folderPath(folder.id)) },
    { label: 'Renommer', icon: Pencil, hidden: !(canWrite && folder.canWrite), onSelect: () => setRename({ kind: 'folder', item: folder }) },
    { label: 'Déplacer', icon: FolderInput, hidden: !(canWrite && folder.canWrite), onSelect: () => setTransfer({ kind: 'folder', item: folder, mode: 'move' }) },
    { label: 'Copier vers…', icon: Copy, onSelect: () => setTransfer({ kind: 'folder', item: folder, mode: 'copy' }) },
    { label: 'Permissions du dossier', icon: ShieldCheck, hidden: !isAdminInCompany, onSelect: () => setPolicy(folder) },
    { label: 'Supprimer', icon: Trash2, danger: true, separatorBefore: true, hidden: !folder.canDelete, onSelect: () => setToTrash({ kind: 'folder', item: folder }) },
  ];
  const folderBadge = (folder: FolderItem) =>
    folder.restricted ? <Badge tone="warn"><Lock className="mr-1 h-3 w-3" />Officiel</Badge>
    : null;

  const empty = data.folders.length === 0 && data.files.length === 0;

  return (
    <div className="relative flex min-h-full flex-col" {...dropProps}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs root={rootLabel ?? data.space.name} rootTo={basePath} items={data.breadcrumbs.map((b) => ({ ...b, to: folderPath(b.id) }))} />
        <div className="flex items-center gap-2">
          {headerExtra}
          <div className="flex rounded-lg border border-line bg-white p-0.5" role="group" aria-label="Affichage">
            {([['list', List, 'Liste'], ['grid', LayoutGrid, 'Grille']] as const).map(([v, Icon, label]) => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} aria-label={`Affichage ${label.toLowerCase()}`} title={label}
                className={cn('flex h-8 w-8 items-center justify-center rounded-md', view === v ? 'bg-petrol-soft text-petrol' : 'text-muted hover:text-ink')}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          {canWrite && (
            <>
              <Button variant="secondary" onClick={() => setNewFolder(true)}><FolderPlus className="h-4 w-4" /><span className="hidden sm:inline">Nouveau dossier</span></Button>
              <Button onClick={() => pickFiles(true, startUpload)}><Upload className="h-4 w-4" />Importer</Button>
            </>
          )}
        </div>
      </div>

      {!canWrite && data.space.type === 'COMPANY' && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-petrol-soft px-3 py-2 text-[13px] text-petrol">
          <Lock className="h-4 w-4 shrink-0" />
          {data.folder ? 'Ce dossier est en lecture seule pour vous.' : 'Ouvrez un dossier pour y importer vos documents.'}
        </p>
      )}

      {empty ? (
        <EmptyState
          icon={UploadCloud}
          title="Ce dossier est vide"
          text={canWrite ? 'Glissez-déposez des fichiers ici, ou utilisez le bouton Importer.' : 'Aucun document pour le moment.'}
          action={canWrite ? <Button onClick={() => pickFiles(true, startUpload)}><Upload className="h-4 w-4" />Importer des fichiers</Button> : undefined}
        />
      ) : view === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Nom</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Importé par</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Modifié</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Taille</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.folders.map((folder) => (
                <ActionContext key={folder.id} actions={folderMenu(folder)}>
                  <tr className="group hover:bg-surface/60">
                    <td className="max-w-0 px-4 py-2.5">
                      <Link to={folderPath(folder.id)} className="flex items-center gap-3">
                        <FolderIcon className="h-5 w-5" />
                        <span className="truncate font-medium text-ink group-hover:text-petrol">{folder.name}</span>
                        {folderBadge(folder)}
                      </Link>
                    </td>
                    <td className="hidden px-4 py-2.5 text-muted md:table-cell">—</td>
                    <td className="hidden whitespace-nowrap px-4 py-2.5 text-muted sm:table-cell">{formatRelative(folder.updatedAt)}</td>
                    <td className="hidden px-4 py-2.5 text-right text-muted sm:table-cell">—</td>
                    <td className="px-2 py-1.5 text-right">
                      <ActionMenu actions={folderMenu(folder)}><Button variant="ghost" size="icon" aria-label={`Actions pour ${folder.name}`}><MoreVertical className="h-4 w-4" /></Button></ActionMenu>
                    </td>
                  </tr>
                </ActionContext>
              ))}
              {data.files.map((file) => (
                <ActionContext key={file.id} actions={fileMenu(file)}>
                  <tr className="group hover:bg-surface/60">
                    <td className="max-w-0 px-4 py-2.5">
                      <button className="flex w-full items-center gap-3 text-left" onClick={() => setPreview(file)}>
                        <FileTypeIcon file={file} className="h-5 w-5" />
                        <span className="truncate font-medium text-ink group-hover:text-petrol">{file.name}</span>
                        {file.isFavorite && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favori" />}
                      </button>
                    </td>
                    <td className="hidden max-w-40 truncate px-4 py-2.5 text-muted md:table-cell">{file.uploader?.name ?? '—'}</td>
                    <td className="hidden whitespace-nowrap px-4 py-2.5 text-muted sm:table-cell">{formatRelative(file.updatedAt)}</td>
                    <td className="hidden whitespace-nowrap px-4 py-2.5 text-right text-muted sm:table-cell">{formatBytes(file.size)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <ActionMenu actions={fileMenu(file)}><Button variant="ghost" size="icon" aria-label={`Actions pour ${file.name}`}><MoreVertical className="h-4 w-4" /></Button></ActionMenu>
                    </td>
                  </tr>
                </ActionContext>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {data.folders.map((folder) => (
            <ActionContext key={folder.id} actions={folderMenu(folder)}>
              <div className="group relative rounded-xl border border-line bg-white transition-shadow hover:shadow-md">
                <Link to={folderPath(folder.id)} className="flex flex-col items-center gap-2 px-3 pb-3 pt-6 text-center">
                  <FolderIcon className="h-12 w-12" />
                  <span className="line-clamp-2 break-words text-sm font-medium text-ink">{folder.name}</span>
                  {folderBadge(folder)}
                </Link>
                <div className="absolute right-1 top-1">
                  <ActionMenu actions={folderMenu(folder)}><Button variant="ghost" size="icon" aria-label={`Actions pour ${folder.name}`}><MoreVertical className="h-4 w-4" /></Button></ActionMenu>
                </div>
              </div>
            </ActionContext>
          ))}
          {data.files.map((file) => (
            <ActionContext key={file.id} actions={fileMenu(file)}>
              <div className="group relative rounded-xl border border-line bg-white transition-shadow hover:shadow-md">
                <button className="flex w-full flex-col items-center gap-2 px-3 pb-3 pt-6 text-center" onClick={() => setPreview(file)}>
                  <FileTypeIcon file={file} className="h-12 w-12" />
                  <span className="line-clamp-2 break-all text-sm font-medium text-ink">{file.name}</span>
                  <span className="text-xs text-muted">{formatBytes(file.size)} · {formatRelative(file.updatedAt)}</span>
                </button>
                {file.isFavorite && <Star className="absolute left-2.5 top-2.5 h-4 w-4 fill-amber-400 text-amber-400" aria-label="Favori" />}
                <div className="absolute right-1 top-1">
                  <ActionMenu actions={fileMenu(file)}><Button variant="ghost" size="icon" aria-label={`Actions pour ${file.name}`}><MoreVertical className="h-4 w-4" /></Button></ActionMenu>
                </div>
              </div>
            </ActionContext>
          ))}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-petrol bg-petrol-soft/90">
          <div className="text-center text-petrol">
            <UploadCloud className="mx-auto h-10 w-10" />
            <p className="mt-2 font-semibold">{canWrite ? 'Déposez vos fichiers pour les importer' : 'Import impossible à cet emplacement'}</p>
          </div>
        </div>
      )}

      <PreviewDialog file={preview} onClose={() => setPreview(null)} />
      <DetailsDialog fileId={details} onClose={() => setDetails(null)} />

      <NameDialog open={newFolder} onOpenChange={setNewFolder} title="Nouveau dossier" label="Nom du dossier" confirmLabel="Créer"
        onSubmit={(name) => actions.run(() => api('/folders', { method: 'POST', body: { spaceId, parentId: folderId ?? null, name } }), 'Dossier créé')} />

      <NameDialog
        open={!!rename}
        onOpenChange={(o) => !o && setRename(null)}
        title="Renommer"
        label="Nouveau nom"
        confirmLabel="Renommer"
        initial={rename ? (rename.kind === 'file' ? stripExt(rename.item.name) : rename.item.name) : ''}
        lockedExtension={rename?.kind === 'file' ? extOf(rename.item.name) : undefined}
        onSubmit={(name) =>
          rename!.kind === 'file'
            ? actions.run(() => api(`/files/${rename!.item.id}`, { method: 'PATCH', body: { name, expectedRowVersion: (rename!.item as FileItem).rowVersion } }), 'Fichier renommé')
            : actions.run(() => api(`/folders/${rename!.item.id}`, { method: 'PATCH', body: { name } }), 'Dossier renommé')
        }
      />

      {transfer && (
        <TransferDialog
          open
          onOpenChange={(o) => !o && setTransfer(null)}
          mode={transfer.mode}
          itemName={transfer.item.name}
          currentSpaceId={spaceId}
          currentParentId={transfer.kind === 'file' ? transfer.item.folderId : transfer.item.parentId}
          excludeFolderId={transfer.kind === 'folder' ? transfer.item.id : undefined}
          // Changer d'espace en déplaçant : réservé à l'auteur de l'élément (règle de suppression).
          allowOtherSpaces={transfer.mode === 'copy' || transfer.item.canDelete}
          onConfirm={(target) =>
            actions.run(
              () => api(`/${transfer.kind === 'file' ? 'files' : 'folders'}/${transfer.item.id}/transfer`, { method: 'POST', body: { mode: transfer.mode, spaceId: target.spaceId, folderId: target.folderId } }),
              `${transfer.kind === 'file' ? 'Fichier' : 'Dossier'} ${transfer.mode === 'move' ? 'déplacé' : 'copié'}`,
            )
          }
        />
      )}

      <ConfirmDialog
        open={!!toTrash}
        onOpenChange={(o) => !o && setToTrash(null)}
        title={toTrash?.kind === 'folder' ? 'Supprimer ce dossier ?' : 'Supprimer ce fichier ?'}
        text={<>« {toTrash?.item.name} » {toTrash?.kind === 'folder' ? 'et son contenu seront placés' : 'sera placé'} dans la corbeille. Vous pourrez {toTrash?.kind === 'folder' ? 'les' : 'le'} restaurer.</>}
        confirmLabel="Supprimer"
        danger
        onConfirm={() =>
          toTrash!.kind === 'file' ? actions.trash(toTrash!.item as FileItem) : actions.run(() => api(`/folders/${toTrash!.item.id}`, { method: 'DELETE' }), 'Dossier placé dans la corbeille')
        }
      />

      {policy && <FolderPolicyDialog folder={policy} onClose={() => setPolicy(null)} />}
    </div>
  );
}

const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; };
const stripExt = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; };

/** Espace entreprise (administrateur) : dossier officiel, modifiable par les seuls administrateurs. */
function FolderPolicyDialog({ folder, onClose }: { folder: FolderItem; onClose: () => void }) {
  const actions = useFileActions();
  const [restricted, setRestricted] = useState(folder.restricted);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Permissions de « ${folder.name} »`} description="Tous les collaborateurs peuvent lire ce dossier." size="sm">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm">
        <input type="checkbox" className="mt-0.5 accent-petrol" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        <span>
          <span className="font-medium text-ink">Dossier officiel</span>
          <span className="mt-0.5 block text-[13px] text-muted">Seuls les administrateurs peuvent y ajouter ou modifier des documents. S’applique aussi aux sous-dossiers.</span>
        </span>
      </label>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Annuler</Button>
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          try {
            await actions.run(() => api(`/admin/folders/${folder.id}`, { method: 'PATCH', body: { restricted } }), 'Permissions mises à jour');
            onClose();
          } catch { /* erreur déjà affichée */ } finally { setBusy(false); }
        }}>Enregistrer</Button>
      </DialogFooter>
    </Dialog>
  );
}
