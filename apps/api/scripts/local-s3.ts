// Émulateur S3 minimal pour le développement local et les tests automatisés.
// Stocke les objets sur le disque. NE PAS utiliser en production : il ne vérifie pas
// cryptographiquement les signatures (il exige seulement leur présence et leur validité
// temporelle). La compatibilité réelle se valide contre le fournisseur (npm run verify:prod).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const xml = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};
const fail = (res: ServerResponse, status: number, code: string, message = code) =>
  xml(res, status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`);

async function md5(path: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function parseAmzDate(v: string): number {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(v);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN;
}

export interface LocalS3 {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startLocalS3(opts: { dir: string; port?: number; bucket: string }): Promise<LocalS3> {
  const objects = join(opts.dir, 'objects');
  const uploads = join(opts.dir, 'multipart');
  await mkdir(objects, { recursive: true });
  await mkdir(uploads, { recursive: true });
  const file = (key: string) => join(objects, encodeURIComponent(key));

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, PUT, HEAD');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-expose-headers', 'ETag');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    const url = new URL(req.url ?? '/', 'http://local');
    const q = url.searchParams;
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (bucket !== opts.bucket) return fail(res, 404, 'NoSuchBucket');

    // Authentification : en-tête signé, ou URL présignée encore valide.
    if (q.has('X-Amz-Signature')) {
      const expires = parseAmzDate(q.get('X-Amz-Date') ?? '') + Number(q.get('X-Amz-Expires') ?? 0) * 1000;
      if (!(expires > Date.now())) return fail(res, 403, 'AccessDenied', 'Request has expired');
    } else if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization ?? '')) {
      return fail(res, 403, 'AccessDenied');
    }

    if (!key) {
      if (req.method === 'GET') return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`);
      return fail(res, 405, 'MethodNotAllowed');
    }

    const uploadId = q.get('uploadId');
    const partDir = uploadId && /^[a-f0-9]+$/.test(uploadId) ? join(uploads, uploadId) : null;

    if (req.method === 'POST' && q.has('uploads')) {
      const id = randomBytes(16).toString('hex');
      await mkdir(join(uploads, id));
      return xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }

    if (uploadId) {
      if (!partDir || !existsSync(partDir)) return fail(res, 404, 'NoSuchUpload');
      if (req.method === 'PUT') {
        const n = Number(q.get('partNumber'));
        if (!Number.isInteger(n) || n < 1) return fail(res, 400, 'InvalidPart');
        const tmp = join(partDir, `${n}.tmp`);
        await pipeline(req, createWriteStream(tmp));
        // Une partie n'existe que si elle est arrivée en entier.
        await rename(tmp, join(partDir, String(n)));
        res.writeHead(200, { etag: `"${await md5(join(partDir, String(n)))}"` });
        return void res.end();
      }
      if (req.method === 'GET') {
        const names = (await readdir(partDir)).filter((f) => /^\d+$/.test(f)).sort((a, b) => +a - +b);
        let parts = '';
        for (const name of names) {
          const p = join(partDir, name);
          parts += `<Part><PartNumber>${name}</PartNumber><ETag>"${await md5(p)}"</ETag><Size>${(await stat(p)).size}</Size></Part>`;
        }
        return xml(res, 200, `<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const numbers = [...Buffer.concat(chunks).toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => m[1]!);
        if (numbers.length === 0 || numbers.some((n) => !existsSync(join(partDir, n)))) return fail(res, 400, 'InvalidPart');
        const out = createWriteStream(file(key));
        out.setMaxListeners(0);
        for (const n of numbers) await pipeline(createReadStream(join(partDir, n)), out, { end: false });
        await new Promise<void>((r) => out.end(r));
        await rm(partDir, { recursive: true, force: true });
        return xml(res, 200, `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"${await md5(file(key))}-${numbers.length}"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === 'DELETE') {
        await rm(partDir, { recursive: true, force: true });
        return void res.writeHead(204).end();
      }
    }

    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      const source = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\//, '');
      const sourceKey = source.slice(source.indexOf('/') + 1);
      if (!source.startsWith(`${opts.bucket}/`) || !existsSync(file(sourceKey))) return fail(res, 404, 'NoSuchKey');
      await copyFile(file(sourceKey), file(key));
      return xml(res, 200, `<CopyObjectResult><ETag>"${await md5(file(key))}"</ETag></CopyObjectResult>`);
    }

    if (req.method === 'PUT') {
      const tmp = `${file(key)}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await pipeline(req, createWriteStream(tmp));
      } catch {
        await rm(tmp, { force: true }); // envoi interrompu : aucun objet partiel
        return;
      }
      const declared = req.headers['content-length'];
      if (declared !== undefined && Number(declared) !== (await stat(tmp)).size) {
        await rm(tmp, { force: true });
        return fail(res, 400, 'IncompleteBody');
      }
      await rename(tmp, file(key));
      res.writeHead(200, { etag: `"${await md5(file(key))}"` });
      return void res.end();
    }

    if (req.method === 'DELETE') {
      await rm(file(key), { force: true });
      return void res.writeHead(204).end();
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!existsSync(file(key))) return fail(res, 404, 'NoSuchKey');
      const size = (await stat(file(key))).size;
      const headers: Record<string, string> = {
        'content-type': q.get('response-content-type') ?? 'application/octet-stream',
        etag: `"${await md5(file(key))}"`,
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
      };
      if (q.get('response-content-disposition')) headers['content-disposition'] = q.get('response-content-disposition')!;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        if (start >= size) return fail(res, 416, 'InvalidRange');
        res.writeHead(206, { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` });
        if (req.method === 'HEAD') return void res.end();
        return void (await pipeline(createReadStream(file(key), { start, end }), res).catch(() => undefined));
      }
      res.writeHead(200, { ...headers, 'content-length': String(size) });
      if (req.method === 'HEAD') return void res.end();
      return void (await pipeline(createReadStream(file(key)), res).catch(() => undefined));
    }
    return fail(res, 405, 'MethodNotAllowed');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) fail(res, 500, 'InternalError', String(err?.message ?? err));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
