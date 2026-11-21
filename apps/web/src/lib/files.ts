import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from './api';
import type { FileItem, SpaceType } from './types';

const FILE_QUERIES = new Set(['contents', 'favorites', 'recents', 'trash', 'search', 'usage', 'file', 'tree', 'admin-files', 'admin-quotas']);

/** Rafraîchit toutes les vues qui listent des fichiers. */
export function useRefreshFiles() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ predicate: (q) => FILE_QUERIES.has(String(q.queryKey[0])) }), [qc]);
}

export function spacePath(type: SpaceType | undefined, spaceId: string, folderId?: string | null): string {
  const base = type === 'COMPANY' ? '/entreprise' : type === 'PERSONAL' ? '/mon-espace' : `/partages/${spaceId}`;
  return folderId ? `${base}/${folderId}` : base;
}

/** Télécharge via une URL signée de courte durée (les octets ne passent pas par l'API). */
export async function downloadFile(fileId: string, versionId?: string) {
  try {
    const { url } = await api<{ url: string }>(`/files/${fileId}/download${versionId ? `?versionId=${versionId}` : ''}`);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function useFileActions() {
  const refresh = useRefreshFiles();
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        await fn();
        if (success) toast.success(success);
        await refresh();
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        await refresh();
        throw err;
      }
    },
    [refresh],
  );
  return {
    run,
    toggleFavorite: (file: FileItem) =>
      run(() => api(`/files/${file.id}/favorite`, { method: file.isFavorite ? 'DELETE' : 'PUT' }), file.isFavorite ? 'Retiré des favoris' : 'Ajouté aux favoris').catch(() => undefined),
    trash: (file: FileItem) => run(() => api(`/files/${file.id}`, { method: 'DELETE' }), 'Fichier placé dans la corbeille'),
  };
}

export function pickFiles(multiple: boolean, onPick: (files: File[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.onchange = () => {
    if (input.files?.length) onPick([...input.files]);
  };
  input.click();
}
