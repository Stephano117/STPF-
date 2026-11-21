// Choix d'une destination pour déplacer ou copier un fichier ou un dossier,
// dans le même espace ou vers un autre (entreprise, mon espace, espaces partagés).

import { useQuery } from '@tanstack/react-query';
import { Building2, FolderLock, Home, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import type { SharedSpace } from '@/lib/types';
import { FolderIcon } from './files';
import { Button, Dialog, DialogFooter, ErrorNote, PageLoader } from './ui';

interface TreeFolder { id: string; name: string; parentId: string | null; canWrite: boolean }
interface SpacesList { companySpaceId: string; personalSpaceId: string; shared: SharedSpace[] }

export interface TransferTarget { spaceId: string; folderId: string | null }

export function TransferDialog({
  open, onOpenChange, mode, itemName, currentSpaceId, currentParentId, excludeFolderId, allowOtherSpaces, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: 'move' | 'copy';
  itemName: string;
  currentSpaceId: string;
  currentParentId: string | null;
  /** Dossier déplacé ou copié : lui-même et ses sous-dossiers ne sont pas des destinations valides. */
  excludeFolderId?: string;
  /** Faux quand l'utilisateur ne peut déplacer l'élément qu'à l'intérieur de son espace. */
  allowOtherSpaces: boolean;
  onConfirm: (target: TransferTarget) => Promise<unknown>;
}) {
  const [spaceId, setSpaceId] = useState(currentSpaceId);
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setSpaceId(currentSpaceId); setTarget(undefined); }
  }, [open, currentSpaceId]);

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api<SpacesList>('/spaces'), enabled: open && allowOtherSpaces });
  const tree = useQuery({ queryKey: ['tree', spaceId], queryFn: () => api<{ rootWritable: boolean; folders: TreeFolder[] }>(`/spaces/${spaceId}/tree`), enabled: open });

  const choices = spaces.data
    ? [
        { id: spaces.data.companySpaceId, name: 'Espace entreprise', icon: Building2 },
        { id: spaces.data.personalSpaceId, name: 'Mon espace', icon: FolderLock },
        ...spaces.data.shared.filter((s) => s.role !== 'READER').map((s) => ({ id: s.id, name: s.name, icon: Users })),
      ]
    : [];

  const sameSpace = spaceId === currentSpaceId;
  const children = (parentId: string | null) => (tree.data?.folders ?? []).filter((f) => f.parentId === parentId && !(sameSpace && f.id === excludeFolderId));
  const row = (id: string | null, name: string, depth: number, selectable: boolean, icon: (selected: boolean) => React.ReactNode) => {
    // Déplacer vers l'emplacement actuel n'a pas de sens ; y copier crée un double, c'est permis.
    const isCurrent = sameSpace && id === currentParentId;
    const disabled = !selectable || (isCurrent && mode === 'move');
    return (
      <button key={id ?? 'root'} type="button" disabled={disabled} onClick={() => setTarget(id)}
        className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', target === id ? 'bg-petrol text-white' : 'hover:bg-surface', disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
        style={{ paddingLeft: 8 + depth * 18 }}>
        {icon(target === id)}
        <span className="truncate">{name}</span>
        {isCurrent && <span className="ml-auto shrink-0 text-xs">emplacement actuel</span>}
      </button>
    );
  };
  const renderLevel = (parentId: string | null, depth: number): React.ReactNode[] =>
    children(parentId).flatMap((f) => [row(f.id, f.name, depth, f.canWrite, (selected) => <FolderIcon className={cn('h-4 w-4', selected && 'fill-white/25 text-white')} />), ...renderLevel(f.id, depth + 1)]);

  const verb = mode === 'move' ? 'Déplacer' : 'Copier';
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} title={`${verb} « ${itemName} »`} description="Choisissez la destination.">
      {allowOtherSpaces && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Espace de destination">
          {spaces.isLoading && <span className="text-sm text-muted">Chargement des espaces…</span>}
          {choices.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === spaceId} onClick={() => { setSpaceId(s.id); setTarget(undefined); }}
              className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium', s.id === spaceId ? 'border-petrol bg-petrol-soft text-petrol' : 'border-line text-ink hover:bg-surface')}>
              <s.icon className="h-3.5 w-3.5" />
              <span className="max-w-40 truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      {!allowOtherSpaces && mode === 'move' && (
        <p className="mb-3 text-[13px] text-muted">Seul l’auteur de cet élément peut le déplacer vers un autre espace. Utilisez « Copier vers… » pour en placer une copie ailleurs.</p>
      )}
      {tree.isLoading ? <PageLoader /> : tree.error ? <ErrorNote message={errorMessage(tree.error)} onRetry={() => tree.refetch()} /> : (
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-line p-1.5">
          {row(null, 'Racine de l’espace', 0, tree.data!.rootWritable, () => <Home className="h-4 w-4" />)}
          {renderLevel(null, 1)}
        </div>
      )}
      <DialogFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
        <Button disabled={target === undefined} loading={busy} onClick={async () => {
          setBusy(true);
          try { await onConfirm({ spaceId, folderId: target! }); onOpenChange(false); } catch { /* message affiché par l'appelant */ } finally { setBusy(false); }
        }}>{verb} ici</Button>
      </DialogFooter>
    </Dialog>
  );
}
