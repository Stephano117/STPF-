// Gestionnaire d'imports : file d'attente, progression, reprise après coupure.
// Les fichiers sont lus par tranches (jamais chargés entièrement en mémoire) et envoyés
// directement au stockage par URL signée.

import { createSHA256 } from 'hash-wasm';
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

export type UploadStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'canceled';

export interface UploadTask {
  id: number;
  file: File;
  name: string;
  spaceId: string;
  folderId: string | null;
  /** Renseigné pour une nouvelle version d'un fichier existant. */
  fileId?: string;
  status: UploadStatus;
  progress: number; // 0..1
  error?: string;
  /** Vrai si l'erreur est passagère : le bouton « Reprendre » continue le même transfert. */
  resumable?: boolean;
  uploadId?: string;
  abort?: AbortController;
}

interface InitResponse {
  id: string;
  mode: 'single' | 'multipart';
  url?: string;
  partSize?: number;
  partCount?: number;
}

const CONCURRENCY = 2;
const HASH_CHUNK = 4 * 1024 * 1024;
const BACKOFF_MS = [1000, 3000, 8000];

let tasks: UploadTask[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const doneListeners = new Set<(task: UploadTask) => void>();

function emit() {
  tasks = [...tasks];
  listeners.forEach((l) => l());
}
function patch(task: UploadTask, changes: Partial<UploadTask>) {
  Object.assign(task, changes);
  emit();
}

export function useUploads(): UploadTask[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => tasks,
  );
}

export function onUploadDone(fn: (task: UploadTask) => void) {
  doneListeners.add(fn);
  return () => void doneListeners.delete(fn);
}

export function enqueueUploads(files: File[], target: { spaceId: string; folderId: string | null; fileId?: string }) {
  for (const file of files) {
    tasks.push({ id: nextId++, file, name: file.name, ...target, status: 'queued', progress: 0 });
  }
  emit();
  pump();
}

export function retryUpload(id: number) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.status !== 'error') return;
  if (!task.resumable) task.uploadId = undefined;
  patch(task, { status: 'queued', error: undefined });
  pump();
}

export function cancelUpload(id: number) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.abort?.abort();
  if (task.uploadId && task.status !== 'done') void api(`/uploads/${task.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
  patch(task, { status: 'canceled' });
  pump();
}

export function clearFinishedUploads() {
  tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'finalizing' || t.status === 'error');
  emit();
}

export const hasActiveUploads = () => tasks.some((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'finalizing');

function pump() {
  const running = tasks.filter((t) => t.status === 'uploading' || t.status === 'finalizing').length;
  const waiting = tasks.filter((t) => t.status === 'queued');
  for (const task of waiting.slice(0, Math.max(0, CONCURRENCY - running))) void run(task);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PUT avec progression (XMLHttpRequest : fetch ne sait pas suivre l'envoi). */
function put(url: string, body: Blob, signal: AbortSignal, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status >= 500 ? 503 : xhr.status, 'STORAGE', xhr.status === 403 ? 'Lien d’envoi expiré.' : 'Le stockage a refusé l’envoi.')));
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Connexion interrompue pendant l’envoi.'));
    xhr.onabort = () => reject(new DOMException('Annulé', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ApiError && (err.retryable || err.status === 403);
      if (signal.aborted || !retryable || attempt >= BACKOFF_MS.length) throw err;
      await sleep(BACKOFF_MS[attempt]!);
    }
  }
}

async function sha256(file: File, signal: AbortSignal): Promise<string> {
  const hasher = await createSHA256();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK) {
    if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
    hasher.update(new Uint8Array(await file.slice(offset, offset + HASH_CHUNK).arrayBuffer()));
  }
  return hasher.digest('hex');
}

async function run(task: UploadTask) {
  const abort = new AbortController();
  patch(task, { status: 'uploading', abort, error: undefined });
  const { file } = task;
  try {
    // Reprise : on réutilise la session d'import existante quand le serveur la connaît encore.
    let init: InitResponse | null = null;
    let alreadyUploaded = new Map<number, number>();
    if (task.uploadId) {
      try {
        const state = await api<{ mode: 'single' | 'multipart'; partSize: number | null; uploadedParts: { partNumber: number; size: number }[] }>(`/uploads/${task.uploadId}`);
        alreadyUploaded = new Map(state.uploadedParts.map((p) => [p.partNumber, p.size]));
        init =
          state.mode === 'multipart'
            ? { id: task.uploadId, mode: 'multipart', partSize: state.partSize!, partCount: Math.ceil(file.size / state.partSize!) }
            : { id: task.uploadId, mode: 'single', url: (await api<{ url: string }>(`/uploads/${task.uploadId}/url`, { method: 'POST' })).url };
      } catch {
        task.uploadId = undefined;
      }
    }
    if (!init) {
      init = await api<InitResponse>('/uploads', {
        method: 'POST',
        body: { spaceId: task.spaceId, folderId: task.folderId, fileId: task.fileId, name: file.name, size: file.size, mimeType: file.type },
      });
      task.uploadId = init.id;
    }
    const uploadId = init.id;

    if (init.mode === 'single') {
      let url = init.url!;
      await withRetry(async () => {
        try {
          await put(url, file, abort.signal, (sent) => patch(task, { progress: (sent / file.size) * 0.97 }));
        } catch (err) {
          // Lien expiré : on en demande un nouveau avant la tentative suivante.
          if (err instanceof ApiError && err.status === 403) url = (await api<{ url: string }>(`/uploads/${uploadId}/url`, { method: 'POST' })).url;
          throw err;
        }
      }, abort.signal);
    } else {
      const partSize = init.partSize!;
      const sent = new Map<number, number>(alreadyUploaded);
      const report = () => patch(task, { progress: ([...sent.values()].reduce((a, b) => a + b, 0) / file.size) * 0.97 });
      report();
      for (let n = 1; n <= init.partCount!; n++) {
        const blob = file.slice((n - 1) * partSize, n * partSize);
        if (alreadyUploaded.get(n) === blob.size) continue;
        await withRetry(async () => {
          // L'URL de chaque partie est demandée juste avant l'envoi : elle ne peut pas avoir expiré.
          const { urls } = await api<{ urls: { partNumber: number; url: string }[] }>(`/uploads/${uploadId}/parts`, { method: 'POST', body: { partNumbers: [n] } });
          await put(urls[0]!.url, blob, abort.signal, (loaded) => {
            sent.set(n, loaded);
            report();
          });
          sent.set(n, blob.size);
        }, abort.signal);
      }
    }

    patch(task, { status: 'finalizing', progress: 0.98 });
    const digest = await sha256(file, abort.signal);
    await withRetry(() => api(`/uploads/${uploadId}/complete`, { method: 'POST', body: { sha256: digest } }), abort.signal);
    patch(task, { status: 'done', progress: 1 });
    doneListeners.forEach((l) => l(task));
  } catch (err) {
    if (abort.signal.aborted) return;
    const e = err as ApiError;
    const resumable = e instanceof ApiError && (e.retryable || e.code === 'UPLOAD_INCOMPLETE');
    patch(task, { status: 'error', error: e.message || 'Échec de l’import.', resumable });
  } finally {
    pump();
  }
}

// Avertit avant de quitter la page pendant un transfert.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (hasActiveUploads()) e.preventDefault();
  });
}
