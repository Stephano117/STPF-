// Adaptateur de stockage. Le code métier ne connaît que l'interface StorageAdapter ;
// l'implémentation S3 fonctionne avec Backblaze B2, Cloudflare R2, MinIO, Neon Object
// Storage ou AWS S3 : changer de fournisseur = changer quatre variables d'environnement.

import { AwsClient } from 'aws4fetch';
import type { Config } from '../config.ts';

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface StorageAdapter {
  presignPut(key: string, expiresSeconds: number): Promise<string>;
  presignGet(
    key: string,
    expiresSeconds: number,
    opts: { filename: string; contentType: string; inline: boolean },
  ): Promise<string>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;
  get(key: string): Promise<Response>;
  put(key: string, body: BodyInit, contentLength: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Copie côté serveur (aucun octet ne transite par l'application). */
  copy(sourceKey: string, targetKey: string): Promise<void>;
  createMultipart(key: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<StoredPart[]>;
  completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** Vérifie que le bucket répond (utilisé par /health?deep=1 et l'admin). */
  check(): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function xmlValue(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function contentDisposition(filename: string, inline: boolean): string {
  if (!filename) return inline ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class S3Storage implements StorageAdapter {
  private client: AwsClient;
  private publicBase: string;
  private internalBase: string;
  private bucket: string;

  constructor(cfg: Config['s3']) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: cfg.region,
      retries: 3, // backoff exponentiel intégré sur 5xx / 429 (dont 503 SlowDown)
    });
    // Style « chemin » : accepté par tous les fournisseurs compatibles S3 visés.
    this.bucket = cfg.bucket;
    this.publicBase = `${cfg.endpoint}/${cfg.bucket}`;
    this.internalBase = `${cfg.internalEndpoint}/${cfg.bucket}`;
  }

  private url(key: string, base = this.internalBase): URL {
    return new URL(`${base}/${encodeKey(key)}`);
  }

  private async request(url: URL | string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    let res: Response;
    try {
      res = await this.client.fetch(url.toString(), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new StorageError(`Stockage injoignable : ${(err as Error).message}`, 503);
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const body = await res.text().catch(() => '');
      throw new StorageError(
        `Erreur du stockage (${res.status}) ${xmlValue(body, 'Code') ?? ''} ${xmlValue(body, 'Message') ?? ''}`.trim(),
        res.status,
      );
    }
    return res;
  }

  private async presign(url: URL, method: string, expiresSeconds: number): Promise<string> {
    url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
    const signed = await this.client.sign(url.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }

  presignPut(key: string, expiresSeconds: number) {
    return this.presign(this.url(key, this.publicBase), 'PUT', expiresSeconds);
  }

  presignGet(key: string, expiresSeconds: number, opts: { filename: string; contentType: string; inline: boolean }) {
    const url = this.url(key, this.publicBase);
    url.searchParams.set('response-content-disposition', contentDisposition(opts.filename, opts.inline));
    url.searchParams.set('response-content-type', opts.contentType);
    return this.presign(url, 'GET', expiresSeconds);
  }

  async head(key: string) {
    const res = await this.request(this.url(key), { method: 'HEAD' }, [404]);
    if (res.status === 404) return null;
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    };
  }

  async readRange(key: string, start: number, end: number) {
    const res = await this.request(this.url(key), { headers: { Range: `bytes=${start}-${end}` } }, [416]);
    if (res.status === 416) return new Uint8Array();
    return new Uint8Array(await res.arrayBuffer());
  }

  get(key: string) {
    return this.request(this.url(key));
  }

  async put(key: string, body: BodyInit, contentLength: number) {
    const res = await this.request(this.url(key), {
      method: 'PUT',
      body,
      headers: { 'content-length': String(contentLength), 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      // @ts-expect-error requis par fetch (Node) pour un corps en flux
      duplex: 'half',
    });
    await res.arrayBuffer();
  }

  async delete(key: string) {
    const res = await this.request(this.url(key), { method: 'DELETE' }, [404]);
    await res.arrayBuffer();
  }

  async copy(sourceKey: string, targetKey: string) {
    const res = await this.request(this.url(targetKey), {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `/${this.bucket}/${encodeKey(sourceKey)}` },
    });
    // S3 peut répondre 200 avec une erreur dans le corps.
    const xml = await res.text();
    if (/<Error>/.test(xml)) throw new StorageError(`Copie refusée : ${xmlValue(xml, 'Message') ?? ''}`, 502);
  }

  async createMultipart(key: string) {
    const url = this.url(key);
    url.searchParams.set('uploads', '');
    const res = await this.request(url, { method: 'POST' });
    const id = xmlValue(await res.text(), 'UploadId');
    if (!id) throw new StorageError('Réponse multipart invalide.', 502);
    return id;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number) {
    const url = this.url(key, this.publicBase);
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);
    return this.presign(url, 'PUT', expiresSeconds);
  }

  async listParts(key: string, uploadId: string) {
    const parts: StoredPart[] = [];
    let marker = '';
    for (;;) {
      const url = this.url(key);
      url.searchParams.set('uploadId', uploadId);
      if (marker) url.searchParams.set('part-number-marker', marker);
      const xml = await (await this.request(url)).text();
      for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
        parts.push({
          partNumber: Number(xmlValue(m[1]!, 'PartNumber')),
          etag: (xmlValue(m[1]!, 'ETag') ?? '').replace(/"/g, ''),
          size: Number(xmlValue(m[1]!, 'Size')),
        });
      }
      if (xmlValue(xml, 'IsTruncated') !== 'true') break;
      marker = xmlValue(xml, 'NextPartNumberMarker') ?? '';
      if (!marker) break;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: StoredPart[]) {
    const url = this.url(key);
    url.searchParams.set('uploadId', uploadId);
    const body =
      '<CompleteMultipartUpload>' +
      parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>';
    const res = await this.request(url, { method: 'POST', body, headers: { 'content-type': 'application/xml' } });
    // S3 peut répondre 200 avec une erreur dans le corps.
    const xml = await res.text();
    if (/<Error>/.test(xml)) throw new StorageError(`Assemblage refusé : ${xmlValue(xml, 'Message') ?? ''}`, 502);
  }

  async abortMultipart(key: string, uploadId: string) {
    const url = this.url(key);
    url.searchParams.set('uploadId', uploadId);
    const res = await this.request(url, { method: 'DELETE' }, [404]);
    await res.arrayBuffer();
  }

  async check() {
    const url = new URL(this.internalBase);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', '1');
    const res = await this.request(url);
    await res.arrayBuffer();
  }
}
