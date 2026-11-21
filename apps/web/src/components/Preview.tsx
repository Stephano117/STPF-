// Aperçu des documents directement dans l'application, sans téléchargement :
// images, PDF, vidéo, audio, texte, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument (.odt).
// Les documents bureautiques sont rendus dans le navigateur : rien n'est envoyé à un service tiers.

import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { downloadFile } from '@/lib/files';
import { cn, formatBytes, formatRelative } from '@/lib/format';
import type { FileItem } from '@/lib/types';
import { FileTypeIcon } from './files';
import { Button, Dialog, DialogFooter, ErrorNote, Spinner } from './ui';

const MAX_OFFICE_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_COLS = 60;

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'none';

export function previewKind(file: { name: string; mimeType: string; category: string }): Kind {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'odt') return 'odt';
  if (/^text\/(plain|csv)/.test(file.mimeType) || file.mimeType === 'application/json') return 'text';
  if (file.mimeType === 'image/svg+xml') return 'none';
  if (file.category === 'image' || file.category === 'pdf' || file.category === 'video' || file.category === 'audio') return file.category;
  return 'none';
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Le document n’a pas pu être chargé depuis le stockage.');
  return res.blob();
}

// ───────────────────────────── PDF ─────────────────────────────

/**
 * Charge un PDF en deux requêtes partielles (le premier octet, puis le reste) réassemblées ici.
 * Certains gestionnaires de téléchargement installés sur les postes interceptent toute réponse
 * qui commence par la signature « %PDF » et la remplacent par un téléchargement : aucune des deux
 * réponses ne commence ainsi, l'aperçu fonctionne donc aussi sur ces postes.
 */
async function fetchPdfBytes(url: string): Promise<Uint8Array> {
  const part = async (range: string) => {
    const res = await fetch(url, { headers: { Range: range } });
    if (!res.ok) throw new Error('Le document n’a pas pu être chargé depuis le stockage.');
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  const [head, tail] = await Promise.all([part('bytes=0-0'), part('bytes=1-')]);
  // Un stockage qui ignorerait l'en-tête Range renvoie le fichier entier (200) : on l'utilise tel quel.
  if (head.status === 200) return head.bytes;
  if (tail.status === 200) return tail.bytes;
  const all = new Uint8Array(head.bytes.length + tail.bytes.length);
  all.set(head.bytes);
  all.set(tail.bytes, head.bytes.length);
  return all;
}

/**
 * Rendu du PDF par l'application elle-même (pdf.js), page par page : l'aperçu ne dépend ni
 * du lecteur PDF du navigateur ni d'un gestionnaire de téléchargement, et rien n'est téléchargé.
 */
function PdfView({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; pages: number; done: number }>({ status: 'loading', pages: 0, done: 0 });
  useEffect(() => {
    let cancelled = false;
    let doc: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const [pdfjs, worker, data] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'), fetchPdfBytes(url)]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ data });
        doc = task;
        const pdf = await task.promise;
        if (cancelled || !host.current) return;
        host.current.innerHTML = '';
        setState({ status: 'ready', pages: pdf.numPages, done: 0 });
        // La zone est encore masquée à cet instant : la largeur se mesure sur son conteneur.
        const width = Math.max(320, Math.min((host.current.parentElement?.clientWidth ?? 900) - 32, 1000));
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
          canvas.className = 'mx-auto mb-4 block bg-white shadow';
          canvas.setAttribute('aria-label', `Page ${n}`);
          host.current?.appendChild(canvas);
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          if (!cancelled) setState((s) => ({ ...s, done: n }));
        }
      } catch {
        if (!cancelled) setState({ status: 'error', pages: 0, done: 0 });
      }
    })();
    return () => { cancelled = true; void doc?.destroy().catch(() => undefined); };
  }, [url]);
  return (
    <div className="w-full self-stretch">
      {state.status === 'loading' && <div className="flex h-[50vh] items-center justify-center"><Spinner className="h-7 w-7" /></div>}
      {state.status === 'error' && <div className="p-6"><ErrorNote message="Ce PDF ne peut pas être affiché (fichier protégé ou endommagé)." /></div>}
      {state.status === 'ready' && <p className="border-b border-line bg-white px-4 py-2 text-xs text-muted">{state.pages} page(s){state.done < state.pages ? ` — affichage en cours (${state.done}/${state.pages})` : ''}</p>}
      <div ref={host} className={cn('max-h-[68vh] overflow-auto p-4', state.status !== 'ready' && 'hidden')} />
    </div>
  );
}

// ───────────────────────────── Word ─────────────────────────────

function DocxView({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ renderAsync }, blob] = await Promise.all([import('docx-preview'), fetchBlob(url)]);
        if (cancelled || !host.current) return;
        host.current.innerHTML = '';
        await renderAsync(blob, host.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderHeaders: true, renderFooters: true });
        if (!cancelled) setState('ready');
      } catch (err) {
        if (!cancelled) setState(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  return (
    <div className="w-full self-stretch">
      {state === 'loading' && <div className="flex h-[50vh] items-center justify-center"><Spinner className="h-7 w-7" /></div>}
      {state !== 'loading' && state !== 'ready' && <div className="p-6"><ErrorNote message="Ce document Word ne peut pas être affiché. Téléchargez-le pour l’ouvrir." /></div>}
      <div ref={host} className={cn('docx-host max-h-[70vh] overflow-auto', state !== 'ready' && 'hidden')} />
    </div>
  );
}

// ───────────────────────────── Excel ─────────────────────────────

type Cell = string | number | boolean | Date | null;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleDateString('fr-FR');
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toLocaleString('fr-FR', { maximumFractionDigits: 4 });
  if (typeof value === 'boolean') return value ? 'VRAI' : 'FAUX';
  return String(value);
}

function XlsxView({ url }: { url: string }) {
  const sheets = useQuery({
    queryKey: ['preview-xlsx', url],
    queryFn: async () => {
      const [{ default: readXlsxFile }, blob] = await Promise.all([import('read-excel-file/browser'), fetchBlob(url)]);
      const all = await readXlsxFile(blob);
      return all.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }));
    },
    gcTime: 0,
    retry: false,
  });
  const [active, setActive] = useState(0);
  if (sheets.isLoading) return <Spinner className="h-7 w-7" />;
  if (sheets.error || !sheets.data) return <div className="p-6"><ErrorNote message="Ce classeur ne peut pas être affiché. Téléchargez-le pour l’ouvrir." /></div>;
  const sheet = sheets.data[Math.min(active, sheets.data.length - 1)];
  if (!sheet) return <p className="p-10 text-sm text-muted">Ce classeur est vide.</p>;
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const cols = Math.min(MAX_COLS, rows.reduce((max, r) => Math.max(max, r.length), 0));
  const letter = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  return (
    <div className="flex w-full flex-col self-stretch">
      {sheets.data.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line bg-white px-2 pt-2" role="tablist">
          {sheets.data.map((s, i) => (
            <button key={s.name} role="tab" aria-selected={i === active} onClick={() => setActive(i)}
              className={cn('shrink-0 rounded-t-lg border border-b-0 px-3 py-1.5 text-[13px]', i === active ? 'border-line bg-surface font-medium text-petrol' : 'border-transparent text-muted hover:text-ink')}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[65vh] overflow-auto bg-white">
        {rows.length === 0 ? <p className="p-10 text-center text-sm text-muted">Cette feuille est vide.</p> : (
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border border-line bg-surface px-2 py-1" />
                {Array.from({ length: cols }, (_, i) => <th key={i} className="sticky top-0 z-10 min-w-24 border border-line bg-surface px-2 py-1 font-medium text-muted">{letter(i)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  <th className="sticky left-0 border border-line bg-surface px-2 py-1 text-right font-medium text-muted">{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} className={cn('max-w-80 truncate border border-line px-2 py-1', typeof row[c] === 'number' && 'text-right tabular-nums')} title={formatCell(row[c])}>{formatCell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(sheet.rows.length > MAX_ROWS || cols === MAX_COLS) && <p className="border-t border-line bg-white px-4 py-2 text-xs text-muted">Aperçu limité aux {MAX_ROWS} premières lignes et {MAX_COLS} premières colonnes.</p>}
    </div>
  );
}

// ───────────────────────────── PowerPoint et OpenDocument (texte) ─────────────────────────────

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function readSlides(blob: Blob): Promise<string[][]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const slides: string[][] = [];
  for (const name of names) {
    const xml = await zip.files[name]!.async('string');
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join(''))
      .filter((line) => line.trim() !== '');
    slides.push(paragraphs);
  }
  return slides;
}

async function readOdtParagraphs(blob: Blob): Promise<string[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const content = zip.files['content.xml'];
  if (!content) throw new Error('Document invalide.');
  const xml = await content.async('string');
  return [...xml.matchAll(/<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)]
    .map((m) => decodeXml(m[1]!.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s\/>/g, ' ').replace(/<[^>]+>/g, '')))
    .filter((p) => p.trim() !== '');
}

function PptxView({ url }: { url: string }) {
  const slides = useQuery({ queryKey: ['preview-pptx', url], queryFn: async () => readSlides(await fetchBlob(url)), gcTime: 0, retry: false });
  if (slides.isLoading) return <Spinner className="h-7 w-7" />;
  if (slides.error || !slides.data) return <div className="p-6"><ErrorNote message="Cette présentation ne peut pas être affichée. Téléchargez-la pour l’ouvrir." /></div>;
  return (
    <div className="w-full self-stretch">
      <p className="border-b border-line bg-white px-4 py-2 text-xs text-muted">Aperçu du texte des {slides.data.length} diapositive(s). Images et mise en page : téléchargez la présentation.</p>
      <div className="max-h-[65vh] space-y-3 overflow-auto p-4">
        {slides.data.map((lines, i) => (
          <section key={i} className="rounded-xl border border-line bg-white p-5 shadow-sm">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Diapositive {i + 1}</div>
            {lines.length === 0 ? <p className="text-sm italic text-muted">Sans texte</p> : (
              <>
                <h3 className="text-base font-semibold text-ink">{lines[0]}</h3>
                {lines.slice(1).map((line, j) => <p key={j} className="mt-1.5 text-sm text-ink">{line}</p>)}
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function OdtView({ url }: { url: string }) {
  const doc = useQuery({ queryKey: ['preview-odt', url], queryFn: async () => readOdtParagraphs(await fetchBlob(url)), gcTime: 0, retry: false });
  if (doc.isLoading) return <Spinner className="h-7 w-7" />;
  if (doc.error || !doc.data) return <div className="p-6"><ErrorNote message="Ce document ne peut pas être affiché. Téléchargez-le pour l’ouvrir." /></div>;
  return (
    <div className="w-full self-stretch">
      <p className="border-b border-line bg-white px-4 py-2 text-xs text-muted">Aperçu du texte. Mise en page et images : téléchargez le document.</p>
      <div className="mx-auto max-h-[65vh] max-w-3xl overflow-auto bg-white p-8">
        {doc.data.map((p, i) => <p key={i} className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">{p}</p>)}
      </div>
    </div>
  );
}

// ───────────────────────────── Dialogue ─────────────────────────────

export function PreviewDialog({ file, onClose }: { file: FileItem | null; onClose: () => void }) {
  const kind = file ? previewKind(file) : 'none';
  const office = kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'odt';
  const tooBig = office && !!file && file.size > MAX_OFFICE_BYTES;
  const link = useQuery({
    queryKey: ['preview', file?.id, file?.rowVersion, kind],
    queryFn: () => api<{ url: string; inline: boolean }>(`/files/${file!.id}/download?inline=1${office || kind === 'pdf' ? '&raw=1' : ''}`),
    enabled: !!file && kind !== 'none' && kind !== 'text' && !tooBig,
    staleTime: 4 * 60_000,
    gcTime: 0,
  });
  const text = useQuery({
    queryKey: ['preview-text', file?.id, file?.rowVersion],
    queryFn: () => api<{ text: string; truncated: boolean }>(`/files/${file!.id}/text`),
    enabled: !!file && kind === 'text',
    gcTime: 0,
  });
  if (!file) return null;
  const url = link.data?.url;
  const loading = link.isLoading || text.isLoading;
  const error = link.error ?? text.error;
  const unavailable = (message: string) => (
    <div className="p-10 text-center">
      <FileTypeIcon file={file} className="mx-auto h-12 w-12" />
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={file.name} description={`${formatBytes(file.size)} · modifié ${formatRelative(file.updatedAt)}`} size="xl">
      <div className="flex min-h-[50vh] items-center justify-center overflow-hidden rounded-xl bg-surface">
        {loading ? <Spinner className="h-7 w-7" />
        : error ? <div className="p-6"><ErrorNote message={errorMessage(error)} /></div>
        : tooBig ? unavailable(`Document trop volumineux pour l’aperçu (plus de ${formatBytes(MAX_OFFICE_BYTES)}). Téléchargez-le pour l’ouvrir.`)
        : kind === 'text' ? (
          <div className="w-full self-stretch">
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-4 text-[13px] leading-relaxed text-ink">{text.data?.text}</pre>
            {text.data?.truncated && <p className="border-t border-line px-4 py-2 text-xs text-muted">Aperçu limité au début du fichier.</p>}
          </div>
        )
        : !url ? unavailable(/\.(doc|xls|ppt)$/i.test(file.name) ? 'Les anciens formats Office (.doc, .xls, .ppt) ne peuvent pas être affichés. Enregistrez le document au format récent (.docx, .xlsx, .pptx) pour bénéficier de l’aperçu.' : 'Aperçu non disponible pour ce type de fichier.')
        : kind === 'image' ? <img src={url} alt={file.name} className="max-h-[70vh] max-w-full object-contain" />
        : kind === 'pdf' ? <PdfView url={url} />
        : kind === 'video' ? <video src={url} controls className="max-h-[70vh] max-w-full" />
        : kind === 'audio' ? <audio src={url} controls className="w-full max-w-lg" />
        : kind === 'docx' ? <DocxView url={url} />
        : kind === 'xlsx' ? <XlsxView url={url} />
        : kind === 'pptx' ? <PptxView url={url} />
        : kind === 'odt' ? <OdtView url={url} />
        : unavailable('Aperçu non disponible pour ce type de fichier.')}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Fermer</Button>
        <Button onClick={() => downloadFile(file.id)}><Download className="h-4 w-4" />Télécharger</Button>
      </DialogFooter>
    </Dialog>
  );
}
